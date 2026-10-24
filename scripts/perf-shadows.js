// Shadow / render-scale A/B helpers for the browser (dev server): await import('/scripts/perf-shadows.js')
// __legacyShadow(on): the pre-pass shadow setup (4096 map over a fixed +-4800 m box, fixed bias), for interleaved comparisons.
// __abShadow(rounds, frames): GPU and wall ms at the current view, legacy vs current, interleaved.
window.__legacyShadow = (on) => {
  // (with the redraw policy, the legacy setup is also redrawn every frame)
  if (on) { tsm.__pol = tsm.__pol ?? tsm.shadowCfg.policy; tsm.shadowCfg.policy = false; } else if (tsm.__pol !== undefined) { tsm.shadowCfg.policy = tsm.__pol; delete tsm.__pol; }
  const sun = tsm.env.sun, sh = sun.shadow, ss = tsm.sunShadow;
  if (on) {
    if (!ss.__upd) { ss.__upd = ss.update; ss.update = () => false; }
    sh.mapSize.set(4096, 4096);
    const c = sh.camera; c.left = -4800; c.right = 4800; c.top = 4800; c.bottom = -4800; c.near = 100; c.far = 16000; c.updateProjectionMatrix();
    sh.bias = -0.0004; sh.normalBias = 1.5; sh.radius = 4;
    sun.target.position.set(3200, 0, 3200); sun.target.updateMatrixWorld();
    tsm.env.applyTime();
  } else {
    if (ss.__upd) { ss.update = ss.__upd; delete ss.__upd; }
    sh.mapSize.set(2048, 2048);
    ss.update(tsm.env.camera, true);
  }
  if (sh.map) { sh.map.dispose(); sh.map = null; }
  tsm.env.renderer.shadowMap.needsUpdate = true;
};
window.__abShadow = async (rounds = 4, frames = 8, a = () => __legacyShadow(true), b = () => __legacyShadow(false)) => {
  const med = (v) => v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const m = async () => { await tsm.perf.bench(3); const r = await tsm.perf.bench(frames); return [r.gpu50, r.p50, r.p95]; };
  const A = [], B = [];
  for (let k = 0; k < rounds; k++) { a(); A.push(await m()); b(); B.push(await m()); }
  const col = (X, i) => +med(X.map((x) => x[i])).toFixed(2);
  return { a: { gpu: col(A, 0), wall50: col(A, 1), wall95: col(A, 2) }, b: { gpu: col(B, 0), wall50: col(B, 1), wall95: col(B, 2) } };
};
window.__cam = (k) => {
  const V = tsm.init.villages, o = V[0];
  if (k === 'overview') tsm.view(V.reduce((s, v) => s + v.x, 0) / V.length, V.reduce((s, v) => s + v.y, 0) / V.length, 5200, 0.6, 0.85);
  else tsm.view(o.x, o.y, 520, 0.6, 1.05);
};
'ok';

/** Frames at a time of day with the redraw policy on or off: how often the shadow map is redrawn (and why), frame times. */
window.__policyRun = async (frames = 300, phase = 0.3, policy = true) => {
  const ss = tsm.sunShadow, cfg = tsm.shadowCfg, was = cfg.policy;
  cfg.policy = policy;
  tsm.phase(phase);
  await tsm.perf.bench(5);
  const r0 = ss.redraws, w0 = { ...ss.why };
  const b = await tsm.perf.bench(frames);
  const why = {}; for (const k of Object.keys(ss.why)) if (ss.why[k] - w0[k]) why[k] = ss.why[k] - w0[k];
  cfg.policy = was;
  return { phase, policy, redrawPct: +(100 * (ss.redraws - r0) / (frames + 1)).toFixed(1), why, gpu50: b.gpu50, gpu95: b.gpu95, wall50: b.p50, wall95: b.p95 };
};

/**
 * Dusk stepping check: render `frames` consecutive frames at a time of day with a fixed camera and measure, per frame, how much a
 * screen region changes (mean absolute RGB difference to the previous frame, 0..255). With the shadow redrawn every frame the change is
 * spread evenly; with the redraw policy it bunches up on redraw frames. Cars are hidden (they move every frame).
 */
window.__stepCheck = async (phase = 0.735, frames = 60, policy = true, region = [560, 300, 640, 400]) => {
  const cfg = tsm.shadowCfg, was = cfg.policy, gl = tsm.env.renderer.getContext(), life = tsm.life;
  cfg.policy = policy;
  tsm.phase(phase);
  await tsm.perf.bench(4);
  const [x, y, w, h] = region, buf = new Uint8Array(w * h * 4), prev = new Uint8Array(w * h * 4);
  const ch = [];
  for (let k = 0; k <= frames; k++) {
    // freeze what moves on its own (cars, crowds, crane jibs) so only the sun changes between frames
    life.animate = life.animate.__orig ? life.animate : Object.assign(() => {}, { __orig: life.animate });
    const city = tsm.city; if (!city.animate.__orig) { const o = city.animate.bind(city); city.animate = Object.assign((f) => o(f, 0), { __orig: o }); }
    tsm.perf.frame();
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    if (k) { let s = 0; for (let i = 0; i < buf.length; i += 4) s += Math.abs(buf[i] - prev[i]) + Math.abs(buf[i + 1] - prev[i + 1]) + Math.abs(buf[i + 2] - prev[i + 2]); ch.push(s / (w * h * 3)); }
    prev.set(buf);
    await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(0); c.port2.postMessage(0); });
  }
  if (life.animate.__orig) life.animate = life.animate.__orig;
  if (tsm.city.animate.__orig) delete tsm.city.animate;   // back to the prototype method
  cfg.policy = was;
  const mean = ch.reduce((a, b) => a + b, 0) / ch.length;
  return { phase, policy, maxStep: +Math.max(...ch).toFixed(3), meanStep: +mean.toFixed(3), steps: ch.map((v) => +v.toFixed(2)).join(' ') };
};
