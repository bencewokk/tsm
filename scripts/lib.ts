import type { Sim } from '../src/sim/sim';

/** Test line through the quarters, stations every ~14 cells (same as headless.ts). */
export function testLine(sim: Sim) {
  const vs = sim.g.villages.slice().sort((a, b) => a.y - b.y);
  const pts: [number, number][] = [];
  for (let k = 0; k < vs.length; k++) {
    if (k > 0) {
      const a = vs[k - 1], b = vs[k];
      const n = Math.floor(Math.hypot(a.x - b.x, a.y - b.y) / 14);
      for (let j = 1; j < n; j++) pts.push([Math.round(a.x + (b.x - a.x) * j / n), Math.round(a.y + (b.y - a.y) * j / n)]);
    }
    pts.push([vs[k].x, vs[k].y]);
  }
  const ids: number[] = [];
  for (const [x, y] of pts) {
    let ok = false;
    for (let r = 0; r < 4 && !ok; r++) for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r && !ok; dx++) {
      const before = sim.metro.stations.length;
      sim.apply({ type: 'placeStation', x: x + dx, y: y + dy });
      if (sim.metro.stations.length > before) { ids.push(sim.metro.stations[before].id); ok = true; }
    }
  }
  // terrain and money limit what can be built: take the longest prefix of the chain the sim accepts (grade / depth limit, budget)
  for (let n = ids.length; n >= 2; n--) {
    const q = sim.metro.quote(ids.slice(0, n));
    if (q.ok && q.cost + 2 * 2e6 <= sim.money) { sim.apply({ type: 'buildLine', stations: ids.slice(0, n) }); return; }
  }
}

