// Browser render benchmark scenarios (dev server): in the console or a browser tool run
//   await import('/scripts/perf-scenarios.js'); await __ff(60); await __scen();
// __scen renders each view back to back with a GPU sync after every frame (works in a hidden pane), __ff times the main-thread apply.
window.__scen = async (frames = 60) => {
  const out = {};
  window.__scenOut = out; window.__scenDone = false;
  const V = tsm.init.villages;
  const cx = V.reduce((a, v) => a + v.x, 0) / V.length, cy = V.reduce((a, v) => a + v.y, 0) / V.length;
  const o = V[0];
  const pause = () => new Promise((r) => setTimeout(r, 30));
  const run = async (name) => {
    await pause();
    await tsm.perf.bench(15);
    const b = await tsm.perf.bench(frames);
    out[name] = { p50: b.p50, p95: b.p95, gpu50: b.gpu50, gpu95: b.gpu95, calls: b.calls, ktris: Math.round(b.triangles / 1000), geo: b.geometries, tex: b.textures };
    window.__scenOut = out;
  };
  const reset = () => { for (const t of ['heat', 'xray', 'zones', 'night', 'desire']) tsm.hud.toggle(t, false); tsm.hud.setTool('view'); };
  reset();
  tsm.phase(0.05); tsm.view(cx, cy, 5200, 0.6, 0.85); await run('overview day');
  tsm.phase(0.86); tsm.view(cx, cy, 5200, 0.6, 0.85); await run('overview night');
  tsm.phase(0.05); tsm.view(o.x, o.y, 520, 0.6, 1.05); await run('street day');
  tsm.phase(0.86); tsm.view(o.x, o.y, 520, 0.6, 1.05); await run('street night');
  tsm.phase(0.05); tsm.view(cx, cy, 5200, 0.6, 0.85); tsm.hud.toggle('xray', true); await run('overview xray');
  tsm.hud.toggle('xray', false); tsm.hud.toggle('heat', true); await run('overview heatmap');
  tsm.hud.toggle('heat', false); tsm.hud.setTool('plan'); await run('plan mode');
  reset(); tsm.phase(0.05); tsm.view(cx, cy, 5200, 0.6, 0.85); await tsm.perf.bench(5);
  window.__scenDone = true;
  return out;
};
/** fast-forward with timing of the main-thread apply */
window.__ff = async (target) => {
  // one month per message (as the game sends them), the docks deal 0 and the first choice of other events
  const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(0); c.port2.postMessage(0); });
  const until = async (cond) => { const t0 = performance.now(); while (!cond() && performance.now() - t0 < 5000) await yieldNow(); };
  const P = tsm.perf.mon;
  P.apply.clear(); for (const r of P.steps.values()) r.clear(); P.worker.tick.clear(); P.worker.snap.clear(); P.msgSize.clear();
  P.sizes = true;
  const slices = [];
  tsm.send({ type: 'speed', speed: 0 });
  const t = performance.now();
  while (tsm.state.stats.month < target) {
    const before = tsm.state.stats.month;
    if (tsm.state.event) { const id = tsm.state.event.id; tsm.send({ type: 'choose', event: id, choice: 0 }); await until(() => !tsm.state.event || tsm.state.event.id !== id); continue; }
    tsm.send({ type: 'step', months: 1 });
    await until(() => tsm.state.stats.month !== before);
    // a hidden pane runs no animation frames: do the city's per-frame rebuild slices here (as the frame loop would), timed
    while (tsm.city && tsm.city.pending) { const t0 = performance.now(); tsm.city.pump(6); slices.push(performance.now() - t0); await yieldNow(); }
  }
  slices.sort((a, b) => a - b);
  const sl = slices.length ? { p50: +slices[Math.floor(slices.length / 2)].toFixed(2), p95: +slices[Math.floor(slices.length * 0.95)].toFixed(2), max: +slices[slices.length - 1].toFixed(2), n: slices.length } : null;
  const r = tsm.perf.report();
  return { month: tsm.state.stats.month, s: +((performance.now() - t) / 1000).toFixed(1), apply: r.apply, frameSlices: sl, steps: r.steps, wtick: r.worker.tick, wsnap: r.worker.snap, msgKB: r.msgKB, heap: r.heapMB };
};
/** test line through the villages (sorted by y, stations about every 14 cells), as scripts/lib.ts */
window.__line = async () => {
  const vs = tsm.init.villages.slice().sort((a, b) => a.y - b.y), pts = [];
  for (let k = 0; k < vs.length; k++) {
    if (k > 0) { const a = vs[k - 1], b = vs[k], n = Math.floor(Math.hypot(a.x - b.x, a.y - b.y) / 14); for (let j = 1; j < n; j++) pts.push([Math.round(a.x + (b.x - a.x) * j / n), Math.round(a.y + (b.y - a.y) * j / n)]); }
    pts.push([vs[k].x, vs[k].y]);
  }
  const wait = () => new Promise((r) => setTimeout(r, 60));
  for (const [x, y] of pts) { tsm.send({ type: 'placeStation', x: x + 0.3, y: y + 0.3 }); await wait(); }
  await new Promise((r) => setTimeout(r, 400));
  const ids = tsm.state.stations.map((s) => s.id);
  for (let n = ids.length; n >= 2; n--) { tsm.send({ type: 'buildLine', stations: ids.slice(0, n) }); await new Promise((r) => setTimeout(r, 400)); if (tsm.state.lines.length) break; }
  return { stations: ids.length, lines: tsm.state.lines.map((l) => [l.stations.length, l.lengthKm.toFixed(1)]) };
};
'ok';

/** Cost split at the current view: full frame, shadow map frozen (not re-rendered). */
window.__split = async (frames = 40) => {
  const r = tsm.env.renderer, out = {};
  const run = async (name) => { await tsm.perf.bench(10); const b = await tsm.perf.bench(frames); out[name] = { p50: b.p50, p95: b.p95, gpu50: b.gpu50, gpu95: b.gpu95, calls: b.calls, ktris: Math.round(b.triangles / 1000) }; };
  await run('full');
  r.shadowMap.autoUpdate = false; await run('shadow frozen'); r.shadowMap.autoUpdate = true;
  return out;
};

/** Interleaved A/B: for each experiment, alternate baseline and changed frames over several rounds (robust to GPU drift / contention). */
window.__ab = async (rounds = 5, frames = 8, only = null) => {
  const env = tsm.env, city = tsm.city, r = env.renderer;
  const vis = (o) => [() => { o.visible = false; }, () => { o.visible = true; }];
  const X = {
    'shadow map frozen': [() => { r.shadowMap.autoUpdate = false; }, () => { r.shadowMap.autoUpdate = true; }],
    'trees hidden': [() => { for (const o of city.group.children) if (o.isInstancedMesh && o.count > 1000) o.visible = false; }, () => { for (const o of city.group.children) if (o.isInstancedMesh) o.visible = true; }],
    'buildings hidden': vis(city.chunkGroup),
    'roads hidden': vis(city.roads),
    'water hidden': vis(env.scene.children[6]),
    'paper hidden': vis(env.scene.children[11]),
    'terrain hidden': vis(env.scene.getObjectByName('terrain')),
    'metro hidden': vis(env.scene.children[15]),
    'half res': [() => { r.setPixelRatio(0.5); window.dispatchEvent(new Event('resize')); }, () => { r.setPixelRatio(1); window.dispatchEvent(new Event('resize')); }],
  };
  const out = {};
  const g = async () => { const b = await tsm.perf.bench(frames); return b.gpu50 ?? NaN; };
  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  for (const [name, [on, off]] of Object.entries(X)) {
    if (only && !only.includes(name)) continue;
    const A = [], B = [];
    await tsm.perf.bench(4);
    for (let k = 0; k < rounds; k++) { A.push(await g()); on(); await tsm.perf.bench(2); B.push(await g()); off(); await tsm.perf.bench(2); }
    out[name] = { base: +med(A).toFixed(2), changed: +med(B).toFixed(2), saved: +(med(A) - med(B)).toFixed(2) };
    window.__abOut = out;
  }
  window.__abDone = true;
  return out;
};

/**
 * Live run: the sim plays at `speed` (10 = top speed, a month every 150 ms) while frames are rendered back to back (each with a GPU
 * sync, as in __scen), so message handling and the city's rebuild slices land between frames as they would in the browser's loop.
 * Reports the frame times (wall), months advanced and the main-thread apply per message.
 */
window.__live = async (seconds = 10, speed = 10) => {
  const P = tsm.perf.mon;
  P.apply.clear(); P.msgAt.clear(); for (const r of P.steps.values()) r.clear(); P.worker.tick.clear();
  const m0 = tsm.state.stats.month, frames = [];
  const gl = tsm.env.renderer.getContext(), px = new Uint8Array(4);
  const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(0); c.port2.postMessage(0); });
  tsm.send({ type: 'speed', speed });
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    if (tsm.state.event) tsm.send({ type: 'choose', event: tsm.state.event.id, choice: 0 });
    const t = performance.now();
    tsm.perf.frame();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    frames.push(performance.now() - t);
    await yieldNow();
  }
  tsm.send({ type: 'speed', speed: 0 });
  frames.sort((a, b) => a - b);
  const q = (p) => +frames[Math.min(frames.length - 1, Math.floor(p * frames.length))].toFixed(1);
  const r = tsm.perf.report();
  return { months: tsm.state.stats.month - m0, frames: frames.length, frameP50: q(0.5), frameP95: q(0.95), frameP99: q(0.99), frameMax: q(1), apply: r.apply, cityFrame: r.steps.city, msgPerSec: r.msgPerSec, workerTick: r.worker.tick };
};

/** Parity captures (screenshots/perf-<tag>-<view>.png) at fixed cameras. */
window.__shots = async (tag) => {
  const V = tsm.init.villages, o = V[0];
  const cx = V.reduce((a, v) => a + v.x, 0) / V.length, cy = V.reduce((a, v) => a + v.y, 0) / V.length;
  const reset = () => { for (const t of ['heat', 'xray', 'zones', 'night', 'desire']) tsm.hud.toggle(t, false); tsm.hud.setTool('view'); };
  const done = [];
  const shot = async (name) => { await tsm.perf.bench(3); done.push(await tsm.shot(`perf-${tag}-${name}`)); };
  reset();
  tsm.phase(0.05); tsm.view(cx, cy, 5200, 0.6, 0.85); await shot('overview-day');
  tsm.phase(0.86); tsm.view(cx, cy, 5200, 0.6, 0.85); await shot('overview-night');
  tsm.phase(0.70); tsm.view(cx, cy, 5200, 0.6, 0.85); await shot('overview-evening');
  tsm.phase(0.735); tsm.view(cx, cy, 5200, 0.6, 0.85); await shot('overview-dusk');
  tsm.phase(0.70); tsm.view(o.x, o.y, 520, 0.6, 1.05); await shot('street-evening');
  tsm.phase(0.735); tsm.view(o.x, o.y, 520, 0.6, 1.05); await shot('street-dusk');
  tsm.phase(0.05); tsm.view(o.x, o.y, 520, 0.6, 1.05); await shot('street-day');
  tsm.phase(0.05); tsm.view(cx, cy, 2400, 1.2, 0.95); await shot('mid-day');
  tsm.view(cx, cy, 5200, 0.6, 0.85); tsm.hud.toggle('xray', true); await shot('overview-xray'); tsm.hud.toggle('xray', false);
  tsm.hud.setTool('plan'); await tsm.perf.bench(40); await shot('plan'); reset();
  tsm.phase(0.05); tsm.view(cx, cy, 5200, 0.6, 0.85);
  return done;
};

