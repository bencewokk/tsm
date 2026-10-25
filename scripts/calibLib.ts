import type { Sim } from '../src/sim/sim';
import { N } from '../src/sim/constants';

export type Pt = [number, number];
export function land(sim: Sim, x: number, y: number): Pt {
  for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const cx = Math.round(x) + dx, cy = Math.round(y) + dy;
    if (cx >= 0 && cy >= 0 && cx < N && cy < N && !sim.g.water[cy * N + cx]) return [cx, cy];
  }
  return [Math.round(x), Math.round(y)];
}
/** place (or reuse within 3 cells) a station at each point; build the line */
export function build(sim: Sim, pts: Pt[]) {
  const ids: number[] = [];
  for (const [x, y] of pts) {
    const near = sim.metro.stations.find((s) => Math.hypot(s.x - x, s.y - y) < 3.05);
    if (near) { if (!ids.includes(near.id)) ids.push(near.id); continue; }
    const before = sim.metro.stations.length;
    sim.apply({ type: 'placeStation', x, y });
    if (sim.metro.stations.length > before) ids.push(sim.metro.stations[before].id);
  }
  const n = sim.metro.lines.length;
  for (let k = ids.length; k >= 2; k--) {
    sim.apply({ type: 'buildLine', stations: ids.slice(0, k) });
    if (sim.metro.lines.length > n) return true;
  }
  return false;
}
export function starter(sim: Sim): Pt[] {
  const vs = sim.g.villages, o = vs[0];
  const near = vs.slice(1).sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0];
  const n = Math.max(1, Math.round(Math.hypot(near.x - o.x, near.y - o.y) / 14));
  const pts: Pt[] = [land(sim, o.x, o.y)];
  for (let j = 1; j < n; j++) pts.push(land(sim, o.x + (near.x - o.x) * j / n, o.y + (near.y - o.y) * j / n));
  pts.push(land(sim, near.x, near.y));
  return pts;
}
/** six stations 7.2 cells (360 m) apart, centred on the busiest spot, in the direction that covers most homes + jobs */
export function dense(sim: Sim): Pt[] {
  const act = (x: number, y: number) => { let s = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const cx = Math.round(x) + dx, cy = Math.round(y) + dy; if (cx >= 0 && cy >= 0 && cx < N && cy < N) s += sim.cHomes[cy * N + cx] + sim.cJobs[cy * N + cx]; } return s; };
  let bx = sim.centre.x, by = sim.centre.y, bv = -1;
  for (let y = 4; y < N - 4; y += 2) for (let x = 4; x < N - 4; x += 2) { const v = act(x, y); if (v > bv) { bv = v; bx = x; by = y; } }
  let best: Pt[] = [], bs = -1;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI, dx = Math.cos(a) * 7.2, dy = Math.sin(a) * 7.2;
    const pts: Pt[] = [];
    for (let j = -2.5; j <= 2.5; j++) pts.push(land(sim, bx + dx * j, by + dy * j));
    const s = pts.reduce((t, [x, y]) => t + act(x, y), 0);
    if (s > bs) { bs = s; best = pts; }
  }
  return best;
}
