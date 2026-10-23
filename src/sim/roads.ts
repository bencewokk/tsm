import { N, Water, Flag } from './constants';
import { segIntersect, pointSeg, angDiff, lineDiff, simplify, chaikin } from './geom';
import { MinHeap } from './heap';

/** Road classes. */
export const RC = { Arterial: 0, Collector: 1, Local: 2 } as const;
/** Half carriageway width per class, in cells. */
export const ROAD_HALF = [0.17, 0.13, 0.1];

export const RULES = {
  snapNode: 0.85,      // snap endpoints to a node within this radius
  snapEdge: 0.7,       // ...or onto an edge (T-junction) within this radius
  minAngle: (30 * Math.PI) / 180,
  minLen: 1.2,         // 60 m
  minSpacing: 1.9,     // parallel roads closer than ~95 m are rejected
  parallelAngle: (25 * Math.PI) / 180,
  maxDegree: 4,        // no 5-way junctions
};

export interface TerrainView { water: Uint8Array; flags: Uint8Array; height: Float32Array }

export interface Corridor {
  /** true if something (a building) blocks a road along this segment */
  blocked(ax: number, ay: number, bx: number, by: number): boolean;
  /** clear empty plots along the segment before the road is laid */
  clear(ax: number, ay: number, bx: number, by: number): void;
}

const B = 3; // spatial hash bucket size (cells)
const key = (bx: number, by: number) => by * 1000 + bx;

/** Planar road graph: nodes + straight edges (curves are chains of short edges). */
export class RoadGraph {
  nx: number[] = [];
  ny: number[] = [];
  adj: number[][] = [];
  ea: number[] = [];
  eb: number[] = [];
  ecls: number[] = [];
  eyear: number[] = [];
  alive: number[] = [];
  /** importance: grows with nearby station ridership; drives class upgrades */
  eimp: number[] = [];
  version = 0;
  /** raster flags that growth may not build roads across (the docks site) */
  blockFlags = 0;
  /** edges created since the last drain (for plot generation) */
  fresh: number[] = [];
  /** rejection counters by rule (debug / tuning) */
  rejects: Record<string, number> = {};
  private rej(r: string) { this.rejects[r] = (this.rejects[r] ?? 0) + 1; return -1; }
  private eh = new Map<number, number[]>();
  private nh = new Map<number, number[]>();

  constructor(private t: TerrainView, public corridor: Corridor | null = null) {}

  // ------------------------------------------------------------ basic ops
  addNode(x: number, y: number): number {
    const id = this.nx.length;
    this.nx.push(x); this.ny.push(y); this.adj.push([]);
    const k = key(Math.floor(x / B), Math.floor(y / B));
    let l = this.nh.get(k); if (!l) this.nh.set(k, (l = []));
    l.push(id);
    return id;
  }

  private bucketsOf(e: number, f: (k: number) => void) {
    const ax = this.nx[this.ea[e]], ay = this.ny[this.ea[e]], bx = this.nx[this.eb[e]], by = this.ny[this.eb[e]];
    const x0 = Math.floor(Math.min(ax, bx) / B), x1 = Math.floor(Math.max(ax, bx) / B);
    const y0 = Math.floor(Math.min(ay, by) / B), y1 = Math.floor(Math.max(ay, by) / B);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) f(key(x, y));
  }

  addEdge(a: number, b: number, cls: number, year: number): number {
    const id = this.ea.length;
    this.ea.push(a); this.eb.push(b); this.ecls.push(cls); this.eyear.push(year); this.alive.push(1); this.eimp.push(0);
    this.adj[a].push(id); this.adj[b].push(id);
    this.bucketsOf(id, (k) => { let l = this.eh.get(k); if (!l) this.eh.set(k, (l = [])); l.push(id); });
    this.version++;
    this.fresh.push(id);
    return id;
  }

  private killEdge(e: number) {
    this.alive[e] = 0;
    for (const n of [this.ea[e], this.eb[e]]) this.adj[n] = this.adj[n].filter((x) => x !== e);
    this.bucketsOf(e, (k) => { const l = this.eh.get(k); if (l) { const i = l.indexOf(e); if (i >= 0) l.splice(i, 1); } });
    this.version++;
  }

  /** Split edge e at (x,y); returns the new node. Both halves keep class and build year. */
  splitEdge(e: number, x: number, y: number): number {
    const a = this.ea[e], b = this.eb[e], c = this.ecls[e], yr = this.eyear[e], imp = this.eimp[e];
    this.killEdge(e);
    const n = this.addNode(x, y);
    this.eimp[this.addEdge(a, n, c, yr)] = imp;
    this.eimp[this.addEdge(n, b, c, yr)] = imp;
    // halves of an existing street do not need new plots
    this.fresh.splice(this.fresh.length - 2, 2);
    return n;
  }

  degree(n: number) { return this.adj[n].length; }
  other(e: number, n: number) { return this.ea[e] === n ? this.eb[e] : this.ea[e]; }
  edgeAngle(e: number, from: number) {
    const o = this.other(e, from);
    return Math.atan2(this.ny[o] - this.ny[from], this.nx[o] - this.nx[from]);
  }
  edgeLen(e: number) { return Math.hypot(this.nx[this.eb[e]] - this.nx[this.ea[e]], this.ny[this.eb[e]] - this.ny[this.ea[e]]); }

  edgesNear(x: number, y: number, r: number): number[] {
    const out = new Set<number>();
    const x0 = Math.floor((x - r) / B), x1 = Math.floor((x + r) / B), y0 = Math.floor((y - r) / B), y1 = Math.floor((y + r) / B);
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++) for (const e of this.eh.get(key(bx, by)) ?? []) out.add(e);
    return [...out].sort((a, b) => a - b);
  }

  edgesAlongSeg(ax: number, ay: number, bx: number, by: number, pad: number): number[] {
    const out = new Set<number>();
    const x0 = Math.floor((Math.min(ax, bx) - pad) / B), x1 = Math.floor((Math.max(ax, bx) + pad) / B);
    const y0 = Math.floor((Math.min(ay, by) - pad) / B), y1 = Math.floor((Math.max(ay, by) + pad) / B);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const e of this.eh.get(key(x, y)) ?? []) out.add(e);
    return [...out].sort((a, b) => a - b);
  }

  nearestNode(x: number, y: number, r: number, skip = -1): number {
    let best = -1, bd = r;
    const x0 = Math.floor((x - r) / B), x1 = Math.floor((x + r) / B), y0 = Math.floor((y - r) / B), y1 = Math.floor((y + r) / B);
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++)
      for (const n of this.nh.get(key(bx, by)) ?? []) {
        if (n === skip || !this.adj[n].length) continue;
        const d = Math.hypot(this.nx[n] - x, this.ny[n] - y);
        if (d < bd) { bd = d; best = n; }
      }
    return best;
  }

  nearestEdge(x: number, y: number, r: number, skipNode = -1): { e: number; x: number; y: number; d: number; t: number } | null {
    let best: { e: number; x: number; y: number; d: number; t: number } | null = null;
    for (const e of this.edgesNear(x, y, r)) {
      if (this.ea[e] === skipNode || this.eb[e] === skipNode) continue;
      const p = pointSeg(x, y, this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]]);
      if (p.d < r && (!best || p.d < best.d)) best = { e, x: p.x, y: p.y, d: p.d, t: p.t };
    }
    return best;
  }

  angleOk(n: number, ang: number): boolean {
    for (const e of this.adj[n]) if (angDiff(this.edgeAngle(e, n), ang) < RULES.minAngle) return false;
    return true;
  }

  private terrainOk(ax: number, ay: number, bx: number, by: number, allowWater: boolean): boolean {
    const L = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.ceil(L / 0.3));
    for (let k = 0; k <= steps; k++) {
      const x = Math.floor(ax + (bx - ax) * (k / steps)), y = Math.floor(ay + (by - ay) * (k / steps));
      if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) return false;
      const i = y * N + x;
      if (!allowWater && this.t.water[i]) return false;
      if (this.t.flags[i] & (Flag.Steep | this.blockFlags)) return false;
    }
    return true;
  }

  private parallelOk(ax: number, ay: number, bx: number, by: number, ends: number[]): boolean {
    const ang = Math.atan2(by - ay, bx - ax);
    const cand = this.edgesAlongSeg(ax, ay, bx, by, RULES.minSpacing);
    for (const t of [0.2, 0.5, 0.8]) {
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      for (const e of cand) {
        if (ends.includes(this.ea[e]) || ends.includes(this.eb[e])) continue;
        const ea = Math.atan2(this.ny[this.eb[e]] - this.ny[this.ea[e]], this.nx[this.eb[e]] - this.nx[this.ea[e]]);
        if (lineDiff(ang, ea) > RULES.parallelAngle) continue;
        if (pointSeg(px, py, this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]]).d < RULES.minSpacing) return false;
      }
    }
    return true;
  }

  /** First crossing of segment a->b with an existing edge (ignoring edges touching `ignore`). */
  private firstCrossing(ax: number, ay: number, bx: number, by: number, ignore: number[]) {
    let best: { e: number; t: number; x: number; y: number } | null = null;
    for (const e of this.edgesAlongSeg(ax, ay, bx, by, 0.1)) {
      if (ignore.includes(this.ea[e]) || ignore.includes(this.eb[e])) continue;
      const h = segIntersect(ax, ay, bx, by, this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]]);
      if (h && h.t > 1e-4 && (!best || h.t < best.t)) best = { e, t: h.t, x: ax + (bx - ax) * h.t, y: ay + (by - ay) * h.t };
    }
    return best;
  }

  /**
   * Grow a street from node `from` toward (tx,ty) under the geometry rules:
   * snap to a nearby node or edge (T-junction), stop and split at the first crossing,
   * minimum angle / length / parallel spacing, max degree, terrain and buildings.
   * `fromEdge` lets a street start mid-edge: (e, x, y) is split only if the street is accepted.
   * Returns the end node, or -1 if rejected.
   */
  grow(from: number, tx: number, ty: number, cls: number, year: number, opts: { fromEdge?: { e: number; x: number; y: number }; allowWater?: boolean; snapScale?: number } = {}): number {
    const ss = opts.snapScale ?? 1;
    let ax: number, ay: number;
    if (opts.fromEdge) { ax = opts.fromEdge.x; ay = opts.fromEdge.y; } else { ax = this.nx[from]; ay = this.ny[from]; }
    const startAng = Math.atan2(ty - ay, tx - ax);
    if (!opts.fromEdge) {
      if (this.degree(from) >= RULES.maxDegree || !this.angleOk(from, startAng)) return this.rej('startAngle');
    } else {
      const e = opts.fromEdge.e;
      const ea = Math.atan2(this.ny[this.eb[e]] - this.ny[this.ea[e]], this.nx[this.eb[e]] - this.nx[this.ea[e]]);
      if (lineDiff(ea, startAng) < RULES.minAngle) return this.rej('startAngle');
    }
    const ignoreStart = opts.fromEdge ? [this.ea[opts.fromEdge.e], this.eb[opts.fromEdge.e]] : [from];
    // 1) crossing: stop at the first road we hit (T-junction there)
    let ex = tx, ey = ty;
    let endNode = -1;
    let splitE: { e: number; x: number; y: number } | null = null;
    const hit = this.firstCrossing(ax, ay, tx, ty, ignoreStart);
    if (hit) { ex = hit.x; ey = hit.y; splitE = { e: hit.e, x: hit.x, y: hit.y }; }
    else {
      // 2) snap the free end to a node, else onto an edge
      const n = this.nearestNode(ex, ey, RULES.snapNode * ss, from);
      if (n >= 0 && !ignoreStart.includes(n)) { endNode = n; ex = this.nx[n]; ey = this.ny[n]; }
      else {
        const pe = this.nearestEdge(ex, ey, RULES.snapEdge * ss, from);
        if (pe && !ignoreStart.includes(this.ea[pe.e]) && !ignoreStart.includes(this.eb[pe.e])) { ex = pe.x; ey = pe.y; splitE = { e: pe.e, x: pe.x, y: pe.y }; }
      }
    }
    // snapped split points near an edge's endpoint become that node
    if (splitE) {
      const e = splitE.e;
      for (const n of [this.ea[e], this.eb[e]]) if (Math.hypot(this.nx[n] - ex, this.ny[n] - ey) < 0.5) { endNode = n; ex = this.nx[n]; ey = this.ny[n]; splitE = null; break; }
    }
    const L = Math.hypot(ex - ax, ey - ay);
    if (L < RULES.minLen * (endNode >= 0 || splitE ? 0.7 : 1)) return this.rej('short');
    if (endNode >= 0 && !opts.fromEdge && this.adj[from].some((e) => this.other(e, from) === endNode)) return this.rej('linked');
    const endAng = Math.atan2(ay - ey, ax - ex);
    if (endNode >= 0 && (this.degree(endNode) >= RULES.maxDegree || !this.angleOk(endNode, endAng))) return this.rej('endAngle');
    if (splitE) {
      const e = splitE.e;
      const ea = Math.atan2(this.ny[this.eb[e]] - this.ny[this.ea[e]], this.nx[this.eb[e]] - this.nx[this.ea[e]]);
      if (lineDiff(ea, endAng) < RULES.minAngle) return this.rej('endAngle');
    }
    // a second crossing check against the final segment (snapping may have moved it)
    const ends = [...ignoreStart, endNode, ...(splitE ? [this.ea[splitE.e], this.eb[splitE.e]] : [])].filter((n) => n >= 0);
    const hit2 = this.firstCrossing(ax, ay, ex, ey, ends);
    if (hit2 && hit2.t < 0.98) return this.rej('cross2');
    if (!this.terrainOk(ax, ay, ex, ey, !!opts.allowWater)) return this.rej('terrain');
    if (!this.parallelOk(ax, ay, ex, ey, ends)) return this.rej('parallel');
    if (this.corridor && this.corridor.blocked(ax, ay, ex, ey)) return this.rej('blocked');
    // ---- commit
    this.corridor?.clear(ax, ay, ex, ey);
    const start = opts.fromEdge ? this.splitEdge(opts.fromEdge.e, ax, ay) : from;
    if (splitE) {
      // the edge may have been split by the start already; find the live piece nearest the point
      let e = splitE.e;
      if (!this.alive[e]) { const pe = this.nearestEdge(ex, ey, 0.05, start); if (!pe) return -1; e = pe.e; }
      endNode = this.splitEdge(e, ex, ey);
    }
    if (endNode < 0) endNode = this.addNode(ex, ey);
    this.addEdge(start, endNode, cls, year);
    return endNode;
  }

  /**
   * Lay a polyline regardless of spacing rules (arterials): endpoints snap to nodes,
   * crossings split both roads so the graph stays planar.
   */
  polyline(pts: [number, number][], cls: number, year: number, endSnap = 1.1) {
    let prev = -1;
    for (let k = 0; k < pts.length; k++) {
      const [x, y] = pts[k];
      const end = k === 0 || k === pts.length - 1;
      let n = this.nearestNode(x, y, end ? endSnap : 0.6);
      if (n < 0) {
        const pe = this.nearestEdge(x, y, end ? endSnap : 0.35);
        n = pe ? this.splitEdge(pe.e, pe.x, pe.y) : this.addNode(x, y);
      }
      if (prev >= 0 && n !== prev) this.forceSeg(prev, n, cls, year);
      prev = n;
    }
  }

  private forceSeg(a: number, b: number, cls: number, year: number) {
    let cur = a;
    for (let guard = 0; guard < 50; guard++) {
      if (cur === b) return;
      if (this.adj[cur].some((e) => this.other(e, cur) === b)) return;
      const hit = this.firstCrossing(this.nx[cur], this.ny[cur], this.nx[b], this.ny[b], [cur, b]);
      if (!hit || hit.t > 0.999) { this.addEdge(cur, b, cls, year); return; }
      const near = [this.ea[hit.e], this.eb[hit.e]].find((n) => Math.hypot(this.nx[n] - hit.x, this.ny[n] - hit.y) < 0.3);
      const n = near ?? this.splitEdge(hit.e, hit.x, hit.y);
      if (n !== cur) this.addEdge(cur, n, cls, year);
      cur = n;
    }
  }

  /** Mark raster cells that a road passes through (hidden raster for the maths). */
  rasterize(out: Uint8Array) {
    out.fill(0);
    for (let e = 0; e < this.ea.length; e++) {
      if (!this.alive[e]) continue;
      const ax = this.nx[this.ea[e]], ay = this.ny[this.ea[e]], bx = this.nx[this.eb[e]], by = this.ny[this.eb[e]];
      const L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / 0.35));
      for (let k = 0; k <= steps; k++) {
        const x = Math.floor(ax + (bx - ax) * (k / steps)), y = Math.floor(ay + (by - ay) * (k / steps));
        if (x >= 0 && y >= 0 && x < N && y < N) out[y * N + x] = 1;
      }
    }
  }

  aliveEdges(): number[] {
    const out: number[] = [];
    for (let e = 0; e < this.ea.length; e++) if (this.alive[e]) out.push(e);
    return out;
  }

  drainFresh(): number[] { const f = this.fresh; this.fresh = []; return f.filter((e) => this.alive[e]); }
}

/**
 * Least-cost path on the hidden raster for arterials:
 * cost = distance * (1 + slope weight) + bridge cost on water + turn penalty; reuses existing roads cheaply.
 * Returns a smoothed polyline in cell units, split into runs that do not duplicate existing roads.
 */
export function arterialPath(t: TerrainView, road: Uint8Array, a: [number, number], b: [number, number], extra?: (cell: number) => number): [number, number][][] {
  const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const S = N * N * 8;
  const cost = new Float32Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const heap = new MinHeap();
  const ax = Math.floor(a[0]), ay = Math.floor(a[1]), bx = Math.floor(b[0]), by = Math.floor(b[1]);
  const h = (x: number, y: number) => Math.hypot(x - bx, y - by) * 0.45;
  for (let d = 0; d < 8; d++) { const s = (ay * N + ax) * 8 + d; cost[s] = 0; heap.push(s, h(ax, ay)); }
  let found = -1;
  while (heap.size) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const c = s >> 3, dir = s & 7, x = c % N, y = (c / N) | 0;
    if (x === bx && y === by) { found = s; break; }
    for (let d = 0; d < 8; d++) {
      const nx = x + D8[d][0], ny = y + D8[d][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      const len = d < 4 ? 1 : Math.SQRT2;
      let step = len * (1 + Math.abs(t.height[j] - t.height[c]) * 0.25);
      if (t.water[j]) step += t.water[j] === Water.Sea ? 60 : 9; // bridge
      if (t.flags[j] & Flag.Steep) step += 6;
      if (road[j]) step *= 0.45;
      if (extra) step += extra(j);
      if (d !== dir) step += 0.6 * angDiff(Math.atan2(D8[d][1], D8[d][0]), Math.atan2(D8[dir][1], D8[dir][0]));
      const ns = j * 8 + d, nc = cost[s] + step;
      if (nc < cost[ns]) { cost[ns] = nc; prev[ns] = s; heap.push(ns, nc + h(nx, ny)); }
    }
  }
  const cells: number[] = [];
  for (let s = found; s >= 0; s = prev[s]) cells.push(s >> 3);
  cells.reverse();
  // split into runs off the existing network (with one cell of overlap to join it)
  const runs: [number, number][][] = [];
  let cur: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const on = road[cells[k]] === 1;
    if (!on) { if (!cur.length && k > 0) cur.push(cells[k - 1]); cur.push(cells[k]); }
    else if (cur.length) { cur.push(cells[k]); runs.push(smoothRun(cur)); cur = []; }
  }
  if (cur.length > 1) runs.push(smoothRun(cur));
  return runs.filter((r) => r.length >= 2);
}

function smoothRun(cells: number[]): [number, number][] {
  const pts: [number, number][] = cells.map((c) => [(c % N) + 0.5, ((c / N) | 0) + 0.5]);
  const s = chaikin(simplify(pts, 0.6), 2);
  // resample so segments are at least ~1.3 cells
  const out: [number, number][] = [s[0]];
  for (let k = 1; k < s.length; k++) {
    const last = out[out.length - 1];
    if (Math.hypot(s[k][0] - last[0], s[k][1] - last[1]) >= 1.3 || k === s.length - 1) out.push(s[k]);
  }
  return out;
}
