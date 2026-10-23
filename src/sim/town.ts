import { N, BT, Flag } from './constants';
import { Rng, fbm } from './rng';
import { RoadGraph, RC, arterialPath, RULES } from './roads';
import { LotStore } from './lots';
import { angDiff, lineDiff } from './geom';
import type { Grid } from './terrain';

/** Each village/district has its own street orientation; noise bends it, and districts meet irregularly. */
export interface District { x: number; y: number; ang: number }

export interface TownCtx {
  g: Grid;
  roads: RoadGraph;
  lots: LotStore;
  rng: Rng;
  districts: District[];
}

export function orientationAt(c: TownCtx, x: number, y: number): number {
  let best = c.districts[0], bd = Infinity;
  for (const d of c.districts) {
    const dd = Math.hypot(d.x - x, d.y - y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return (best?.ang ?? 0) + (fbm(x * 0.06, y * 0.06, c.g.seed + 71, 3) - 0.5) * 0.7;
}

/** Initial road network and buildings: village grids at their own angle, arterials between them, the docks road. */
export function layoutTown(c: TownCtx) {
  const { g, roads, lots, rng } = c;
  c.districts = g.villages.map((v) => ({ x: v.x + 0.5, y: v.y + 0.5, ang: rng.range(0, Math.PI / 2) }));
  const centres: number[] = [];
  for (const d of c.districts) {
    const centre = roads.addNode(d.x, d.y);
    centres.push(centre);
    const mainNodes: number[] = [centre];
    for (const dir of [0, Math.PI]) {
      let n = centre, a = d.ang + dir;
      for (let k = 0; k < 3; k++) {
        a += rng.range(-0.12, 0.12);
        const len = rng.range(2.1, 2.7);
        const m = roads.grow(n, roads.nx[n] + Math.cos(a) * len, roads.ny[n] + Math.sin(a) * len, RC.Collector, 0);
        if (m < 0) break;
        mainNodes.push(m); n = m;
      }
    }
    const crossEnds: number[] = [];
    for (const n of mainNodes) {
      for (const side of [1, -1]) {
        let a = d.ang + side * Math.PI / 2 + rng.range(-0.1, 0.1), cur = n;
        for (let k = 0; k < 2; k++) {
          const len = rng.range(2.4, 3.2);
          const m = roads.grow(cur, roads.nx[cur] + Math.cos(a) * len, roads.ny[cur] + Math.sin(a) * len, RC.Local, 0);
          if (m < 0) break;
          cur = m; a += rng.range(-0.15, 0.15);
          if (rng.next() < 0.4) break;
        }
        if (cur !== n) crossEnds.push(cur);
      }
    }
    // back streets parallel to the main street close some blocks
    for (const n of crossEnds) {
      if (rng.next() < 0.45) continue;
      const a = d.ang + (rng.next() < 0.5 ? 0 : Math.PI);
      const len = rng.range(2.4, 3.4);
      roads.grow(n, roads.nx[n] + Math.cos(a) * len, roads.ny[n] + Math.sin(a) * len, RC.Local, 0);
    }
  }
  roads.rasterize(g.road);
  // arterials: least-cost paths between villages (each to its nearest earlier one), then off the north edge
  const link = (a: [number, number], b: [number, number], extra?: (cell: number) => number) => {
    for (const run of arterialPath(g, g.road, a, b, extra)) roads.polyline(run, RC.Arterial, 0);
    roads.rasterize(g.road);
  };
  for (let k = 1; k < c.districts.length; k++) {
    let bj = 0, bd = Infinity;
    for (let j = 0; j < k; j++) {
      const dd = Math.hypot(c.districts[j].x - c.districts[k].x, c.districts[j].y - c.districts[k].y);
      if (dd < bd) { bd = dd; bj = j; }
    }
    link([c.districts[k].x, c.districts[k].y], [c.districts[bj].x, c.districts[bj].y]);
  }
  const north = c.districts.slice().sort((a, b) => a.y - b.y)[0];
  if (north) {
    let tx = Math.floor(north.x);
    while (tx < N - 2 && g.water[tx]) tx++;
    link([north.x, north.y], [tx + 0.5, 0.5]);
  }
  // the docks: a waterfront road along the strip, joined to the harbour village
  if (g.docksCells.length > 4) {
    const dc = g.docksCells.filter((i) => g.distWater[i] === 2);
    const pts = dc.length > 2 ? dc : g.docksCells;
    let a = pts[0], b = pts[0], bd = -1;
    for (const p of pts) for (const q of pts) {
      const dd = Math.hypot((p % N) - (q % N), ((p / N) | 0) - ((q / N) | 0));
      if (dd > bd) { bd = dd; a = p; b = q; }
    }
    const inDocks = new Uint8Array(N * N);
    for (const i of g.docksCells) inDocks[i] = 1;
    const P = (i: number): [number, number] => [(i % N) + 0.5, ((i / N) | 0) + 0.5];
    for (const run of arterialPath(g, g.road, P(a), P(b), (j) => (inDocks[j] ? (g.distWater[j] === 2 ? 0 : 0.6) : 8))) roads.polyline(run, RC.Collector, 0);
    roads.rasterize(g.road);
    const mid = pts[Math.floor(pts.length / 2)];
    link(P(mid), [c.districts[0].x, c.districts[0].y]);
  }
  roads.rasterize(g.road);
  for (const e of roads.drainFresh()) lots.frontage(e);

  // initial buildings: houses thinning out from each village centre, shops at the core, one green
  for (const d of c.districts) {
    let parkDone = false;
    for (const l of lots.near(d.x, d.y, 10)) {
      if (l.type || (l.flags & Flag.Docks)) continue;
      const dist = Math.hypot(l.x - d.x, l.y - d.y);
      if (dist > 9.5 || rng.next() > 1.08 - dist * 0.085) continue;
      if (!parkDone && dist < 4 && rng.next() < 0.25) { l.type = BT.Park; l.level = 1; parkDone = true; continue; }
      if (dist < 2.6 && rng.next() < 0.6) { l.type = BT.Com; l.level = 1; }
      else { l.type = BT.Res; l.level = 1; }
      l.age = 24;
    }
  }
  for (const l of lots.lots) if (l.alive && (l.flags & Flag.Docks)) { l.type = BT.Ind; l.level = rng.next() < 0.25 ? 2 : 1; l.age = 60; }
}

// ------------------------------------------------------------------ growth agents

export interface GrowthField {
  lvAt(x: number, y: number): number;
  /** ridership-weighted station pull at a point (0..1) */
  stationPull(x: number, y: number): number;
  pressure: number;
  spawnLV: number;
  year: number;
}

/** Score open land around a point: fraction of buildable cells without plots. */
function openness(c: TownCtx, x: number, y: number, r: number): number {
  let open = 0, tot = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const cx = Math.floor(x + dx), cy = Math.floor(y + dy);
    if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
    tot++;
    const i = cy * N + cx;
    if (!c.g.water[i] && !(c.g.flags[i] & Flag.Steep) && !c.g.road[i]) open++;
  }
  return tot ? open / tot : 0;
}

/** Pick the best of a few headings near `base`: terrain bias (follow contours, avoid water/steep) plus noise. */
function bestHeading(c: TownCtx, x: number, y: number, base: number, len: number): number {
  let best = base, bc = Infinity;
  for (const off of [0, 0.2, -0.2, 0.42, -0.42]) {
    const a = base + off;
    let cost = Math.abs(off) * 0.5 + c.rng.next() * 0.25;
    for (const t of [0.5, 1]) {
      const px = x + Math.cos(a) * len * t, py = y + Math.sin(a) * len * t;
      const cx = Math.floor(px), cy = Math.floor(py);
      if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) { cost += 99; continue; }
      const i = cy * N + cx, i0 = Math.floor(y) * N + Math.floor(x);
      if (c.g.water[i]) cost += 50;
      if (c.g.flags[i] & Flag.Steep) cost += 20;
      cost += Math.abs(c.g.height[i] - c.g.height[i0]) * 0.12; // prefer following contours
    }
    if (cost < bc) { bc = cost; best = a; }
  }
  return best;
}

/** Snap a heading toward the district grid (theta + k*90deg) when close, so neighbourhoods read as grids. */
function alignToGrid(c: TownCtx, x: number, y: number, a: number): number {
  const th = orientationAt(c, x, y);
  let best = a, bd = Infinity;
  for (let k = 0; k < 4; k++) {
    const g = th + (k * Math.PI) / 2;
    const d = angDiff(a, g);
    if (d < bd) { bd = d; best = g; }
  }
  if (bd >= 0.55) return a;
  const signed = Math.atan2(Math.sin(a - best), Math.cos(a - best));
  return best + signed * 0.25;
}

/**
 * Exploration at the urban edge: extend dead ends outward or branch off streets,
 * guided by the district orientation and the terrain.
 */
export const growthStats = { exploreOps: 0, exploreOk: 0, exploreNoCand: 0, densOps: 0, densOk: 0 };

export function explore(c: TownCtx, f: GrowthField, ops: number): number {
  const { roads, rng } = c;
  let built = 0;
  const nNodes = roads.nx.length, edges = roads.aliveEdges();
  if (!nNodes || !edges.length) return 0;
  for (let op = 0; op < ops; op++) {
    type Cand = { s: number; node: number; fromEdge?: { e: number; x: number; y: number }; base: number; x: number; y: number };
    let best: Cand | null = null;
    for (let k = 0; k < 70; k++) {
      let cand: Cand;
      if (rng.next() < 0.45) {
        const n = Math.floor(rng.next() * nNodes);
        if (roads.degree(n) !== 1) continue;
        const e = roads.adj[n][0];
        cand = { s: 0, node: n, base: roads.edgeAngle(e, roads.other(e, n)), x: roads.nx[n], y: roads.ny[n] };
      } else {
        const e = edges[Math.floor(rng.next() * edges.length)];
        if (!roads.alive[e] || roads.edgeLen(e) < 2.2) continue;
        const t = rng.range(0.3, 0.7);
        const ax = roads.nx[roads.ea[e]], ay = roads.ny[roads.ea[e]], bx = roads.nx[roads.eb[e]], by = roads.ny[roads.eb[e]];
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        const ea = Math.atan2(by - ay, bx - ax) + (rng.next() < 0.5 ? 1 : -1) * Math.PI / 2;
        cand = { s: 0, node: -1, fromEdge: { e, x, y }, base: ea, x, y };
      }
      const ahead = f.lvAt(cand.x + Math.cos(cand.base) * 2, cand.y + Math.sin(cand.base) * 2);
      const here = f.lvAt(cand.x, cand.y);
      if (here < f.spawnLV - 0.02 - 0.12 * f.pressure) continue;
      const open = openness(c, cand.x + Math.cos(cand.base) * 2.5, cand.y + Math.sin(cand.base) * 2.5, 1);
      cand.s = here + ahead * 0.6 + open * 0.5 + rng.next() * 0.2;
      if (!best || cand.s > best.s) best = cand;
    }
    growthStats.exploreOps++;
    if (!best) { growthStats.exploreNoCand++; continue; }
    const len = rng.range(2.4, 3.8);
    let a = alignToGrid(c, best.x, best.y, best.base);
    a = bestHeading(c, best.x, best.y, a, len);
    const cls = best.fromEdge && roads.ecls[best.fromEdge.e] === RC.Arterial && rng.next() < 0.4 ? RC.Collector : RC.Local;
    let r = roads.grow(best.node, best.x + Math.cos(a) * len, best.y + Math.sin(a) * len, cls, f.year, { fromEdge: best.fromEdge });
    if (r >= 0) { built++; growthStats.exploreOk++; }
    // keep going: streets usually run a few blocks before stopping
    for (let k = 0; k < 2 && r >= 0 && roads.degree(r) === 1 && rng.next() < 0.6; k++) {
      const x = roads.nx[r], y = roads.ny[r];
      if (f.lvAt(x, y) < f.spawnLV - 0.12 * f.pressure) break;
      const l2 = rng.range(2.2, 3.4);
      const a2 = bestHeading(c, x, y, alignToGrid(c, x, y, a), l2);
      r = roads.grow(r, x + Math.cos(a2) * l2, y + Math.sin(a2) * l2, cls, f.year);
      if (r >= 0) built++;
    }
  }
  return built;
}

/**
 * Densification: where value/density is high but access is poor, add a short connector between nearby nodes.
 * Biased toward busy stations so feeder streets appear around them.
 */
export function densify(c: TownCtx, f: GrowthField, roadDist: Uint8Array, ops: number): number {
  const { roads, rng, g } = c;
  let built = 0;
  for (let op = 0; op < ops; op++) {
    growthStats.densOps++;
    let bestCell = -1, bs = -Infinity;
    for (let k = 0; k < 90; k++) {
      const i = Math.floor(rng.next() * N * N);
      if (g.water[i] || (g.flags[i] & Flag.Steep) || roadDist[i] < 2 || roadDist[i] > 4) continue;
      const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
      const s = f.lvAt(x, y) + f.stationPull(x, y) * 0.8 + rng.next() * 0.1;
      if (s > bs) { bs = s; bestCell = i; }
    }
    if (bestCell < 0 || bs < f.spawnLV + 0.15) continue;
    const x = (bestCell % N) + 0.5, y = ((bestCell / N) | 0) + 0.5;
    // candidate node pairs whose connector passes near the poorly served spot
    const ns: number[] = [];
    for (let n = 0; n < roads.nx.length; n++) if (roads.degree(n) > 0 && roads.degree(n) < RULES.maxDegree && Math.abs(roads.nx[n] - x) < 4 && Math.abs(roads.ny[n] - y) < 4) ns.push(n);
    let done = false;
    for (const a of ns) {
      if (done) break;
      const dir = Math.atan2(y - roads.ny[a], x - roads.nx[a]);
      const dist = Math.hypot(x - roads.nx[a], y - roads.ny[a]);
      if (dist < 0.8 || dist > 3.5) continue;
      // go through the spot and on, to meet whatever is beyond (snaps / T-junction)
      const al = alignToGrid(c, roads.nx[a], roads.ny[a], dir);
      if (lineDiff(al, dir) > 0.6) continue;
      const len = Math.min(4.5, dist + 2);
      const r = roads.grow(a, roads.nx[a] + Math.cos(al) * len, roads.ny[a] + Math.sin(al) * len, RC.Local, f.year, { snapScale: 1.3 });
      if (r >= 0) { built++; done = true; growthStats.densOk++; }
    }
  }
  return built;
}
