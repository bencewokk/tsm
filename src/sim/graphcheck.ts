import { RoadGraph, RULES, ROAD_HALF } from './roads';
import { pointSeg, segIntersect, angDiff } from './geom';

/** Counts of everything that makes the road graph not a clean planar network (all should be 0 unless noted). */
export interface GraphReport {
  nodes: number;          // live nodes (degree > 0)
  edges: number;
  dupNodes: number;       // live node pairs closer than 0.12 cells (overlapping)
  nearNodes: number;      // live node pairs 0.12 .. snap tolerance apart that are not neighbours (should have been merged)
  nearEnds: number;       // dead ends within the snap radius of a non-neighbour node
  openT: number;          // dead ends lying within 0.35 cells of another street's edge without being joined (T-junction not made)
  unsplitT: number;       // nodes lying on the interior of an edge they do not belong to (needs a split)
  crossings: number;      // pairs of edges that cross in their interiors with no node there
  dupEdges: number;       // two edges joining the same two nodes
  overlaps: number;       // collinear edges sharing a stretch (overlapping streets)
  zeroEdges: number;      // zero length edge or self loop
  slivers: number;        // dead-end stubs shorter than minLen, or angles between neighbouring edges under 15 degrees
  stubs: number;          // dead-end edges whose free end is less than 0.8 cells from their start (tiny stubs)
  components: number;     // connected pieces of the network
  smallComponents: number;// pieces with fewer than 4 edges (detached bits)
  degree5: number;        // nodes with more than four streets
  widthMismatch: number;  // junction nodes where the incident classes differ by two steps (arterial meeting local)
  info: { deadEnds: number; junctions: number; widthMismatchCore: number; waterGaps: number };
}

/** Dev switch: validate the road graph after generation and after every growth tick (the worker turns it on in dev builds; scripts can too). */
export const GRAPHCHECK = { on: false };

export const GRAPH_KEYS = ['dupNodes', 'nearNodes', 'nearEnds', 'openT', 'unsplitT', 'crossings', 'dupEdges', 'overlaps', 'zeroEdges', 'slivers', 'stubs', 'smallComponents', 'degree5', 'widthMismatch'] as const;
export const graphDefects = (r: GraphReport) => GRAPH_KEYS.reduce((a, k) => a + (r[k] as number), 0);

/** Validate the live road graph. O(E^2) restricted by a spatial hash, fine for ~3000 edges. */
export function validateGraph(R: RoadGraph, organic?: (x: number, y: number) => boolean): GraphReport {
  const live: number[] = [];
  for (let e = 0; e < R.ea.length; e++) if (R.alive[e]) live.push(e);
  const nodes: number[] = [];
  for (let n = 0; n < R.nx.length; n++) if (R.adj[n].length) nodes.push(n);
  const rep: GraphReport = { nodes: nodes.length, edges: live.length, dupNodes: 0, nearNodes: 0, nearEnds: 0, openT: 0, unsplitT: 0, crossings: 0, dupEdges: 0, overlaps: 0, zeroEdges: 0, slivers: 0, stubs: 0, components: 0, smallComponents: 0, degree5: 0, widthMismatch: 0, info: { deadEnds: 0, junctions: 0, widthMismatchCore: 0, waterGaps: 0 } };
  const deg = (n: number) => R.adj[n].length;
  const ax = (e: number) => R.nx[R.ea[e]], ay = (e: number) => R.ny[R.ea[e]], bx = (e: number) => R.nx[R.eb[e]], by = (e: number) => R.ny[R.eb[e]];
  // node pairs
  const NB = 2;
  const grid = new Map<number, number[]>();
  for (const n of nodes) { const k = Math.floor(R.ny[n] / NB) * 1000 + Math.floor(R.nx[n] / NB); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(n); }
  const adjacent = (a: number, b: number) => R.adj[a].some((e) => R.other(e, a) === b);
  const rad = RULES.snapNode;
  for (const a of nodes) {
    const gx = Math.floor(R.nx[a] / NB), gy = Math.floor(R.ny[a] / NB);
    for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) for (const b of grid.get(y * 1000 + x) ?? []) {
      if (b <= a) continue;
      const d = Math.hypot(R.nx[a] - R.nx[b], R.ny[a] - R.ny[b]);
      if (d < 0.12) rep.dupNodes++;
      else if (d < rad && !adjacent(a, b)) {
        // two nodes that nearly touch: a defect when one is a dead end (it should have snapped) or both are junction nodes of different streets within 0.35
        // (two ends facing each other across water or a cliff are a real gap, not a defect)
        if (deg(a) === 1 || deg(b) === 1) { if (R.terrainOk(R.nx[a], R.ny[a], R.nx[b], R.ny[b], false)) rep.nearEnds++; else rep.info.waterGaps++; }
        else if (d < 0.35) rep.nearNodes++;
      }
    }
  }
  // node vs edge interior (T-junctions)
  for (const n of nodes) {
    const x = R.nx[n], y = R.ny[n];
    for (const e of R.edgesNear(x, y, 0.4)) {
      if (!R.alive[e] || R.ea[e] === n || R.eb[e] === n) continue;
      const p = pointSeg(x, y, ax(e), ay(e), bx(e), by(e));
      if (p.t <= 0.001 || p.t >= 0.999) continue;
      if (p.d < 0.04) rep.unsplitT++;
      else if (p.d < 0.35 && deg(n) === 1 && !adjacent(n, R.ea[e]) && !adjacent(n, R.eb[e])) rep.openT++;
    }
  }
  // edge pairs
  const seenPair = new Set<number>();
  for (const e of live) {
    const L = Math.hypot(bx(e) - ax(e), by(e) - ay(e));
    if (L < 1e-3 || R.ea[e] === R.eb[e]) { rep.zeroEdges++; continue; }
    for (const f of R.edgesAlongSeg(ax(e), ay(e), bx(e), by(e), 0.05)) {
      if (f <= e || !R.alive[f]) continue;
      const key = e * 100003 + f;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const share = (R.ea[e] === R.ea[f] || R.ea[e] === R.eb[f] ? 1 : 0) + (R.eb[e] === R.ea[f] || R.eb[e] === R.eb[f] ? 1 : 0);
      if (share === 2) { rep.dupEdges++; continue; }
      const h = segIntersect(ax(e), ay(e), bx(e), by(e), ax(f), ay(f), bx(f), by(f));
      if (share === 0 && h && h.t > 1e-3 && h.t < 1 - 1e-3 && h.u > 1e-3 && h.u < 1 - 1e-3) { rep.crossings++; continue; }
      // collinear overlap: both endpoints of one lie within 0.03 of the other and they are nearly parallel
      const ang = Math.atan2(by(e) - ay(e), bx(e) - ax(e)), ang2 = Math.atan2(by(f) - ay(f), bx(f) - ax(f));
      const par = Math.min(angDiff(ang, ang2), Math.PI - angDiff(ang, ang2));
      if (par < 0.05) {
        const d1 = pointSeg(ax(f), ay(f), ax(e), ay(e), bx(e), by(e)), d2 = pointSeg(bx(f), by(f), ax(e), ay(e), bx(e), by(e));
        const d3 = pointSeg(ax(e), ay(e), ax(f), ay(f), bx(f), by(f)), d4 = pointSeg(bx(e), by(e), ax(f), ay(f), bx(f), by(f));
        const inside = [d1, d2, d3, d4].filter((d) => d.d < 0.03 && d.t > 0.001 && d.t < 0.999).length;
        if (inside >= 1 && share < 2) {
          // overlap length
          const t1 = Math.min(d1.t, d2.t), t2 = Math.max(d1.t, d2.t);
          const ov = d1.d < 0.03 && d2.d < 0.03 ? (t2 - t1) * L : inside >= 2 ? Math.min(L, Math.hypot(bx(f) - ax(f), by(f) - ay(f))) : 0;
          if (ov > 0.15 || inside >= 2) rep.overlaps++;
        }
      }
    }
  }
  // slivers, stubs, degree, class mismatch
  for (const n of nodes) {
    const d = deg(n);
    if (d === 1) rep.info.deadEnds++;
    if (d >= 3) rep.info.junctions++;
    if (d > RULES.maxDegree) rep.degree5++;
    if (d === 1) {
      const e = R.adj[n][0];
      const len = R.edgeLen(e);
      if (len < RULES.minLen * 0.7) rep.stubs++;
    }
    if (d >= 2) {
      const angs = R.adj[n].map((e) => R.edgeAngle(e, n));
      for (let i = 0; i < angs.length; i++) for (let j = i + 1; j < angs.length; j++) if (angDiff(angs[i], angs[j]) < 0.26) rep.slivers++;
    }
    if (d >= 3) {
      const cs = R.adj[n].map((e) => R.ecls[e]);
      // an arterial meeting a local lane is allowed inside the organic old core (its lanes keep their size); outside it is a hierarchy defect
      if (Math.max(...cs) - Math.min(...cs) >= 2) { if (organic?.(R.nx[n], R.ny[n])) rep.info.widthMismatchCore++; else rep.widthMismatch++; }
    }
  }
  // components
  const comp = new Int32Array(R.nx.length).fill(-1);
  const sizes: number[] = [];
  for (const n of nodes) {
    if (comp[n] >= 0) continue;
    const id = sizes.length; let edges = 0;
    const stack = [n]; comp[n] = id;
    while (stack.length) {
      const c = stack.pop()!;
      edges += deg(c);
      for (const e of R.adj[c]) { const o = R.other(e, c); if (comp[o] < 0) { comp[o] = id; stack.push(o); } }
    }
    sizes.push(edges / 2);
  }
  rep.components = sizes.length;
  rep.smallComponents = sizes.filter((s) => s < 4).length;
  void ROAD_HALF;
  return rep;
}

export function formatReport(r: GraphReport): string {
  return `nodes ${r.nodes} edges ${r.edges} | ` + GRAPH_KEYS.map((k) => `${k} ${r[k]}`).join(', ') + ` | comps ${r.components} | deadEnds ${r.info.deadEnds} junctions ${r.info.junctions} | arterial-local in old core ${r.info.widthMismatchCore}, ends facing across water ${r.info.waterGaps}`;
}
