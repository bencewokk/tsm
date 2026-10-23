/**
 * Deliberate empty structure: land that stays open because the city meant it to, drawn as parks, a green wedge and a campus lawn
 * (plots with a `deco` kind) rather than as leftover building land.
 *   deco 1  large park        formal: axial paths, a central bed, rows of trees
 *   deco 2  green wedge       a planted belt that runs from the countryside into the suburbs
 *   deco 3  campus lawn       a paved quad on a lawn, reserved for an institution
 *   deco 4  industrial yard   fenced, paved, with stacked containers (set on industrial plots in the industrial territory)
 *   deco 5  public square     a square that formed where pedestrian pressure was high (squares.ts)
 * The reserves are fixed when the city is laid out, from the city profile: richer, planned cities reserve more. Vacant plots inside a
 * reserve become the park at once; plots cut later (street growth) become it as they appear. Streets may still cross a reserve.
 */
import { N, BT, Flag } from './constants';
import { hash2 } from './rng';
import { T } from './territory';
import { inCoreXY } from './hierarchy';
import type { Sim } from './sim';
import type { Lot } from './lots';

export const RES = { on: true };

/** Reserve raster values: 0 none, 1 large park, 2 green wedge, 3 campus lawn. */
export function planReserves(sim: Sim): Uint8Array {
  const out = new Uint8Array(N * N);
  if (!RES.on) return out;
  const g = sim.g, c = sim.town, cp = sim.cp, o = c.districts[0];
  if (!o) return out;
  const free = (x: number, y: number) => {
    if (x < 3 || y < 3 || x >= N - 3 || y >= N - 3) return false;
    const i = Math.floor(y) * N + Math.floor(x);
    if (g.water[i] || (g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Flood | Flag.Rail))) return false;
    const t = c.terr[i];
    return t !== T.Port && t !== T.Industry && !inCoreXY(c, x, y, 1.05);
  };
  const taken: [number, number][] = [];
  const openness = (x: number, y: number, r: number) => { let ok = 0, tot = 0; for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) { tot++; if (free(x + dx, y + dy)) ok++; } return ok / tot; };
  /** best free spot on a ring round the old town */
  const spot = (rMin: number, rMax: number, rad: number, salt: number) => {
    let best: [number, number] | null = null, bs = -1;
    for (let k = 0; k < 120; k++) {
      const a = hash2(g.seed, k, salt) * Math.PI * 2, d = rMin + hash2(g.seed, k, salt + 1) * (rMax - rMin);
      const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d;
      if (!free(x, y) || taken.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < rad * 2.6)) continue;
      const s = openness(x, y, Math.ceil(rad)) + hash2(g.seed, k, salt + 2) * 0.15;
      if (s > bs) { bs = s; best = [x, y]; }
    }
    return best;
  };
  const stamp = (x: number, y: number, rad: number, v: number) => {
    for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++) for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
      const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N || dx * dx + dy * dy > rad * rad || !free(xx + 0.5, yy + 0.5)) continue;
      out[yy * N + xx] = v;
    }
    taken.push([x, y]);
  };
  // large parks in the ring just outside the old core (richer and planned cities reserve more)
  const nParks = 2 + Math.round(cp.wealth * 1.5 + cp.planningStrength);
  for (let k = 0; k < nParks; k++) {
    const rad = 2.1 + hash2(g.seed, k, 11) * 1.1;
    const s = spot(9, 20, rad, 100 + k * 7);
    if (s) stamp(s[0], s[1], rad, 1);
  }
  // a green wedge: a belt 2.6 cells wide from the outskirts in towards the ring, on the side away from the port / industry
  const away = (() => { const p = (() => { let ix = 0, iy = 0, n = 0; for (let i = 0; i < N * N; i++) if (c.terr[i] === T.Industry || c.terr[i] === T.Port) { ix += i % N; iy += (i / N) | 0; n++; } return n ? [ix / n, iy / n] : null; })(); return p ? Math.atan2(o.y - p[1], o.x - p[0]) : hash2(g.seed, 5, 19) * Math.PI * 2; })();
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = away + (attempt === 0 ? 0 : (attempt % 2 ? 1 : -1) * Math.ceil(attempt / 2) * 0.45);
    let n = 0; const cells: [number, number][] = [];
    for (let d = 11; d <= 30; d += 0.6) { const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d; if (free(x, y)) { n++; cells.push([x, y]); } }
    if (n < 24) continue;
    for (const [x, y] of cells) stamp(x, y, 1.3, 2);
    break;
  }
  // a campus lawn: one block-sized reserve in the transit-friendly belt for a future institution
  const cs = spot(11, 22, 1.6, 300);
  if (cs) stamp(cs[0], cs[1], 1.6, 3);
  return out;
}

/** Turn a vacant plot inside a reserve into its park (called for existing plots at the start and for every plot cut later). */
export function applyReserve(sim: Sim, l: Lot) {
  if (!RES.on || l.type || l.flags || l.asm) return;
  const v = sim.reserve[l.cell];
  if (!v) return;
  l.type = BT.Park; l.level = 1; l.deco = v;
}
