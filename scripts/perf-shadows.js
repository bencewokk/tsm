// Shadow / render-scale A/B helpers for the browser (dev server): await import('/scripts/perf-shadows.js')
// __legacyShadow(on): the pre-pass shadow setup (4096 map over a fixed +-4800 m box, fixed bias), for interleaved comparisons.
// __abShadow(rounds, frames): GPU and wall ms at the current view, legacy vs current, interleaved.
window.__legacyShadow = (on) => {
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
