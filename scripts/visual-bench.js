// Visual pass helpers for the Browser pane: `await import('/scripts/visual-bench.js?x=N')` after the city is at the month you want.
// __cap(tag, only?) writes screenshots/visual-<tag>-<view>-<phase>.png for 3 views (overview, mid, street) x 3 phases (day, dusk, night).
// __bench(tag, opts) measures views on High and Auto with a GPU sync after each frame (tsm.perf.bench), best of `rounds`
// (the GPU is shared with other tabs, so the lowest of several rounds is the least contended sample). Results go to window.__benchOut[tag].
// __ab(setFlag, opts) interleaves a feature switch off / on (setFlag(bool)) and reports the GPU p50 of each.
const sl = (ms) => new Promise((r) => setTimeout(r, ms));
function cityViews() {
  const vs = tsm.init.villages;
  const cx = vs.reduce((a, v) => a + v.x, 0) / vs.length + 0.5, cy = vs.reduce((a, v) => a + v.y, 0) / vs.length + 0.5;
  const old = vs[0];
  return {
    overview: [cx, cy, 5200, 0.6, 1.0],
    mid: [old.x + 0.5, old.y + 0.5, 1700, 0.9, 0.95],
    street: [old.x + 0.5, old.y + 0.5, 420, 0.7, 1.28],
  };
}
// a hidden / resized pane can report a 0x0 canvas: fix it before measuring
window.__ensure = () => { const c = tsm.env.renderer.domElement; if (!c.width) window.dispatchEvent(new Event('resize')); if (!c.width) throw new Error('canvas is 0x0: set the viewport with resize_window first'); };
const PHASES = { day: 0.05, dusk: 0.745, night: 0.86 };
window.__cap = async (tag, only) => {
  __ensure();
  const views = cityViews();
  const out = [];
  for (const [vn, v] of Object.entries(views)) for (const [pn, p] of Object.entries(PHASES)) {
    if (only && !only.includes(`${vn}-${pn}`)) continue;
    tsm.phase(p); tsm.view(...v); tsm.env.controls.update();
    await tsm.shot(`visual-${tag}-${vn}-${pn}`); out.push(`${vn}-${pn}`);
  }
  tsm.phase(0.05); tsm.view(...views.overview);
  return out;
};
window.__bench = async (tag, o = {}) => {
  __ensure();
  const { modes = ['high', 'auto'], vnames = ['overview', 'mid', 'street'], phases = ['day'], frames = 60, rounds = 3 } = o;
  const views = cityViews();
  const best = {};
  for (let k = 0; k < rounds; k++) for (const mode of modes) {
    tsm.quality.setMode(mode);
    for (const vn of vnames) for (const pn of phases) {
      tsm.phase(PHASES[pn]); tsm.view(...views[vn]); tsm.env.controls.update();
      if (mode === 'auto') await tsm.perf.bench(frames); // settle the adaptive scale
      await tsm.perf.bench(10);
      const r = await tsm.perf.bench(frames);
      const key = `${mode}-${vn}-${pn}`, cur = { wall50: r.p50, gpu50: r.gpu50, calls: r.calls, kTris: Math.round(r.triangles / 1000), scale: +tsm.quality.scale.toFixed(2) };
      if (!best[key] || cur.gpu50 < best[key].gpu50) best[key] = cur;
    }
  }
  tsm.quality.setMode('auto');
  window.__benchOut = window.__benchOut || {};
  window.__benchOut[tag] = best;
  return best;
};
window.__ab = async (setFlag, o = {}) => {
  __ensure();
  const { vnames = ['overview', 'street'], phases = ['day'], frames = 50, rounds = 4 } = o;
  const views = cityViews();
  tsm.quality.setMode('high');
  const acc = {};
  for (let k = 0; k < rounds; k++) for (const on of [false, true]) {
    setFlag(on);
    for (const vn of vnames) for (const pn of phases) {
      tsm.phase(PHASES[pn]); tsm.view(...views[vn]); tsm.env.controls.update();
      await tsm.perf.bench(8);
      const r = await tsm.perf.bench(frames);
      const key = `${vn}-${pn}-${on ? 'on' : 'off'}`;
      (acc[key] = acc[key] || []).push({ g: r.gpu50, w: r.p50, calls: r.calls, k: Math.round(r.triangles / 1000) });
    }
  }
  setFlag(true);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const out = {};
  for (const [key, a] of Object.entries(acc)) out[key] = { gpu50: +med(a.map((x) => x.g)).toFixed(2), gpuMin: +Math.min(...a.map((x) => x.g)).toFixed(2), wall50: +med(a.map((x) => x.w)).toFixed(2), calls: a[0].calls, kTris: a[0].k };
  return out;
};
window.__sl = sl;
// __setup(month): demo line at month 24, then fast-forward (call again until it reports done; one call stays under ~40 s)
window.__setup = async (month = 120) => {
  __ensure();
  if (tsm.state.stats.month < 24) { await tsm.demo(0, 24); await sl(2500); }
  tsm.hud.setTool('view');
  await tsm.ff(Math.min(month, tsm.state.stats.month + 50), 0);
  return { month: tsm.state.stats.month, lines: tsm.state.lines.length, done: tsm.state.stats.month >= month };
};
