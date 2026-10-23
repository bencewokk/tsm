/**
 * Road hierarchy by age and place.
 *  - The old core (within coreR of an original village or origin quarter) stays organic: no straightening, only junk is pruned.
 *  - Arterials stop at the core or wrap round it (a ring road on the old walls); inside the core they are ordinary main streets.
 *  - Outside the core the hierarchy is strict: streets follow the district grid, locals attach to collectors (not to arterials), junctions on an
 *    arterial are spaced out, and a yearly prune removes diagonals, short stubs and triangle leftovers that nobody built on.
 */
import { N, Flag } from './constants';
import { RC } from './roads';
import { angDiff } from './geom';
import { orientationAt, type TownCtx } from './town';
import { roadFaces } from './metrics';
import type { Sim } from './sim';

export const HIER = {
  on: true,             // false = the old unstructured growth (for before / after measurements)
  strictReg: 0.88,      // street regularity forced outside the old core
  ringGap: 1.7,         // ring road radius = coreR + this (cells)
  junctionGap: 5,       // cells between junctions on an arterial
  stubLen: 3.5,         // dead ends shorter than this are junk outside the core
  diagDev: 0.45,        // radians off the district grid that count as a diagonal
};

export const hierStats = { pruned: 0, prunedStub: 0, prunedDiag: 0, prunedTri: 0, rings: 0, downgraded: 0 };

/** Inside the old core of an original village or origin quarter (planned and garden quarters have no organic core). */
export function inCoreXY(c: TownCtx, x: number, y: number, scale = 1): boolean {
  for (const d of c.districts) {
    if (d.kind === 'planned' || d.kind === 'garden') continue;
    if (Math.hypot(d.x - x, d.y - y) < (d.coreR ?? 7.5) * scale) return true;
  }
  return false;
}

/** Arterials end at the core: inside it they are main streets (collectors). A ring road on the old walls takes their traffic. */
export function shapeHierarchy(c: TownCtx) {
  if (!HIER.on) return;
  const { roads, g } = c;
  // 1) arterial edges inside a core become collectors (historic main streets)
  for (const e of roads.aliveEdges()) {
    if (roads.ecls[e] !== RC.Arterial) continue;
    const mx = (roads.nx[roads.ea[e]] + roads.nx[roads.eb[e]]) / 2, my = (roads.ny[roads.ea[e]] + roads.ny[roads.eb[e]]) / 2;
    if (inCoreXY(c, mx, my, 0.9)) { roads.ecls[e] = RC.Collector; hierStats.downgraded++; }
  }
  // 2) a ring road round each old core of the origin and the larger old villages (only where the land allows a full circle)
  for (const d of c.districts) {
    if (d.kind !== 'origin') continue;
    const R0 = (d.coreR ?? 7.5) + HIER.ringGap, n = 28;
    const pts: [number, number][] = [];
    let bad = 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.3, x = d.x + Math.cos(a) * R0, y = d.y + Math.sin(a) * R0;
      const i = Math.floor(y) * N + Math.floor(x);
      const ok = x > 2 && y > 2 && x < N - 2 && y < N - 2 && !g.water[i] && !(g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Flood | Flag.Rail));
      if (!ok) bad++;
      pts.push([x, y]);
    }
    if (bad > 2) continue;
    // arcs between valid points, closed into a ring
    const valid = pts.map(([x, y]) => { const i = Math.floor(y) * N + Math.floor(x); return x > 2 && y > 2 && x < N - 2 && y < N - 2 && !g.water[i] && !(g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Flood | Flag.Rail)); });
    let run: [number, number][] = [];
    const flush = () => { if (run.length >= 2) roads.polyline(run, RC.Arterial, 0, 0.9); run = []; };
    for (let k = 0; k <= n; k++) {
      const q = k % n;
      if (valid[q]) run.push(pts[q]); else flush();
    }
    flush();
    hierStats.rings++;
  }
}

/** Junction (degree >= 3) on an arterial within r cells of a point. */
export function arterialJunctionNear(c: TownCtx, x: number, y: number, r: number): boolean {
  const { roads } = c;
  for (const e of roads.edgesNear(x, y, r + 1)) {
    if (roads.ecls[e] !== RC.Arterial) continue;
    for (const n of [roads.ea[e], roads.eb[e]]) {
      if (roads.degree(n) >= 3 && Math.hypot(roads.nx[n] - x, roads.ny[n] - y) < r) return true;
    }
  }
  return false;
}

/** Are a and b still joined if edge `skip` is removed (within maxHops)? */
function connectedWithout(sim: Sim, a: number, b: number, skip: number, maxHops = 60): boolean {
  const R = sim.roads;
  const seen = new Set<number>([a]);
  let frontier = [a];
  for (let h = 0; h < maxHops && frontier.length; h++) {
    const next: number[] = [];
    for (const n of frontier) for (const e of R.adj[n]) {
      if (e === skip) continue;
      const o = R.other(e, n);
      if (o === b) return true;
      if (!seen.has(o)) { seen.add(o); next.push(o); }
    }
    frontier = next;
  }
  return false;
}

/**
 * Yearly prune outside the old core: stubs, diagonals and triangle leftovers on streets with no building, no landmark and no assembly.
 * Returns how many streets were removed. The plots along a removed street go with it.
 */
export function pruneRoads(sim: Sim, budget = 10): number {
  if (!HIER.on) return 0;
  const R = sim.roads, c = sim.town;
  const triEdge = new Set<number>();
  for (const f of roadFaces(sim)) {
    let corners = 0;
    for (let k = 0; k < f.nodes.length; k++) {
      const p = f.nodes[(k + f.nodes.length - 1) % f.nodes.length], q0 = f.nodes[k], q = f.nodes[(k + 1) % f.nodes.length];
      const a1 = Math.atan2(R.ny[q0] - R.ny[p], R.nx[q0] - R.nx[p]), a2 = Math.atan2(R.ny[q] - R.ny[q0], R.nx[q] - R.nx[q0]);
      if (R.adj[q0].length >= 3 || angDiff(a1, a2) > 0.5) corners++;
    }
    if (corners <= 3 && f.area < 25) for (let k = 0; k < f.nodes.length; k++) {
      const a = f.nodes[k], b = f.nodes[(k + 1) % f.nodes.length];
      for (const e of R.adj[a]) if (R.other(e, a) === b) triEdge.add(e);
    }
  }
  type Cand = { e: number; score: number; len: number; why: 'stub' | 'diag' | 'tri' };
  const cands: Cand[] = [];
  for (const e of R.aliveEdges()) {
    if (R.ecls[e] === RC.Arterial) continue;
    const a = R.ea[e], b = R.eb[e];
    const mx = (R.nx[a] + R.nx[b]) / 2, my = (R.ny[a] + R.ny[b]) / 2;
    if (inCoreXY(c, mx, my)) continue;
    const L = R.edgeLen(e);
    const lots = (sim.lots.byEdge.get(e) ?? []).filter((l) => l.alive);
    if (lots.some((l) => l.type || l.constr || l.demo || l.asm || l.lm || (l.flags & (Flag.Docks | Flag.Planned | Flag.Core)))) continue;
    const stub = (R.adj[a].length === 1 || R.adj[b].length === 1) && L < HIER.stubLen && R.ecls[e] === RC.Local;
    let diag = false;
    if (L >= 1.2) {
      const th = orientationAt(c, mx, my), ang = R.edgeAngle(e, a);
      let dev = Infinity;
      for (let k = 0; k < 4; k++) dev = Math.min(dev, angDiff(ang, th + (k * Math.PI) / 2));
      diag = dev > HIER.diagDev;
    }
    const tri = triEdge.has(e) && R.ecls[e] !== RC.Collector;
    if (!stub && !diag && !tri) continue;
    cands.push({ e, score: (stub ? 3 : 0) + (diag ? 2 : 0) + (tri ? 1 : 0), len: L, why: stub ? 'stub' : diag ? 'diag' : 'tri' });
  }
  cands.sort((p, q) => q.score - p.score || p.len - q.len || p.e - q.e);
  let n = 0;
  for (const cd of cands) {
    if (n >= budget) break;
    const e = cd.e;
    if (!R.alive[e]) continue;
    const a = R.ea[e], b = R.eb[e];
    if (cd.why !== 'stub' && !connectedWithout(sim, a, b, e)) continue;
    for (const l of sim.lots.byEdge.get(e) ?? []) if (l.alive) sim.lots.remove(l);
    sim.lots.forgetEdge(e);
    R.closeEdge(e);
    n++; hierStats.pruned++;
    if (cd.why === 'stub') hierStats.prunedStub++; else if (cd.why === 'diag') hierStats.prunedDiag++; else hierStats.prunedTri++;
  }
  return n;
}

/**
 * A local street may not meet an arterial directly (outside the core): the stretch that touches the arterial becomes a collector, so every
 * junction on an arterial is arterial / collector. Returns the number of edges promoted.
 */
export function promoteJunctions(c: TownCtx): number {
  if (!HIER.on) return 0;
  const { roads } = c;
  let n = 0;
  for (let node = 0; node < roads.nx.length; node++) {
    if (roads.adj[node].length < 3) continue;
    if (!roads.adj[node].some((e) => roads.ecls[e] === RC.Arterial)) continue;
    if (inCoreXY(c, roads.nx[node], roads.ny[node])) continue;
    for (const e of roads.adj[node]) if (roads.ecls[e] === RC.Local) { roads.ecls[e] = RC.Collector; n++; }
  }
  if (n) roads.version++;
  return n;
}
