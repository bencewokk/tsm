import { N, CELL, Water, Flag } from './constants';
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
/** a dead end within this many cells of another street is joined to it by the repair pass */
const JOIN = 1.3;
/** dev switch for before / after comparisons (`?norepair=1`, `npm run graph -- --norepair`) */
export const REPAIR = { on: true };
export interface RepairHooks { canKill(e: number): boolean; onKill(e: number): void }
export interface RepairStats { merged: number; tSplit: number; crossed: number; dupKilled: number; joined: number; trimmed: number }
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

  /** Close a street (a development took its land). */
  closeEdge(e: number) { if (this.alive[e]) this.killEdge(e); }

  /** Are nodes a and b still joined by streets within `maxHops` edges? */
  connected(a: number, b: number, maxHops: number): boolean {
    if (a === b) return true;
    const seen = new Set<number>([a]);
    let frontier = [a];
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next: number[] = [];
      for (const n of frontier) for (const e of this.adj[n]) {
        const o = this.other(e, n);
        if (o === b) return true;
        if (!seen.has(o)) { seen.add(o); next.push(o); }
      }
      frontier = next;
    }
    return false;
  }

  /** Split edge e at (x,y) (or at the existing node `at`); returns the node. Both halves keep class and build year. */
  splitEdge(e: number, x: number, y: number, at = -1): number {
    const a = this.ea[e], b = this.eb[e], c = this.ecls[e], yr = this.eyear[e], imp = this.eimp[e];
    this.killEdge(e);
    const n = at >= 0 ? at : this.addNode(x, y);
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

  terrainOk(ax: number, ay: number, bx: number, by: number, allowWater: boolean): boolean {
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
  grow(from: number, tx: number, ty: number, cls: number, year: number, opts: { fromEdge?: { e: number; x: number; y: number }; allowWater?: boolean; snapScale?: number; minLen?: number; noParallel?: boolean } = {}): number {
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
    if (L < (opts.minLen ?? RULES.minLen * (endNode >= 0 || splitE ? 0.7 : 1))) return this.rej('short');
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
    if (!opts.noParallel && !this.parallelOk(ax, ay, ex, ey, ends)) return this.rej('parallel');
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

  // ------------------------------------------------------------ repair (the graph validator's defects, fixed at the source)
  /** Move every street of node `drop` onto node `keep` (same edge ids, so plots stay attached); streets that would become loops or duplicates are closed. */
  mergeNodes(keep: number, drop: number, hooks?: RepairHooks): void {
    for (const e of this.adj[drop].slice()) {
      const o = this.other(e, drop);
      if (o === keep || this.adj[keep].some((f) => f !== e && this.other(f, keep) === o)) {
        if (!hooks || hooks.canKill(e)) { hooks?.onKill(e); this.killEdge(e); }
        continue;
      }
      this.bucketsOf(e, (k) => { const l = this.eh.get(k); if (l) { const i = l.indexOf(e); if (i >= 0) l.splice(i, 1); } });
      if (this.ea[e] === drop) this.ea[e] = keep; else this.eb[e] = keep;
      this.adj[keep].push(e);
      this.bucketsOf(e, (k) => { let l = this.eh.get(k); if (!l) this.eh.set(k, (l = [])); l.push(e); });
    }
    this.adj[drop] = [];
    this.version++;
  }

  /** Would a and b stay joined if edge `skip` went? */
  private joinedWithout(a: number, b: number, skip: number, maxHops = 80): boolean {
    const seen = new Set<number>([a]);
    let frontier = [a];
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next: number[] = [];
      for (const n of frontier) for (const e of this.adj[n]) {
        if (e === skip) continue;
        const o = this.other(e, n);
        if (o === b) return true;
        if (!seen.has(o)) { seen.add(o); next.push(o); }
      }
      frontier = next;
    }
    return false;
  }

  nodesNear(x: number, y: number, r: number): number[] {
    const out: number[] = [];
    const x0 = Math.floor((x - r) / B), x1 = Math.floor((x + r) / B), y0 = Math.floor((y - r) / B), y1 = Math.floor((y + r) / B);
    for (let by = y0; by <= y1; by++) for (let bx = x0; bx <= x1; bx++)
      for (const n of this.nh.get(key(bx, by)) ?? []) if (this.adj[n].length && Math.hypot(this.nx[n] - x, this.ny[n] - y) < r) out.push(n);
    return out;
  }

  /**
   * Clean the graph: merge overlapping nodes, split an edge at a node lying on it, put a node on every crossing, remove duplicate edges,
   * join dead ends that nearly touch another street (a node, or the side of an edge: a real T-junction) and trim 5-way junctions.
   * Runs after generation and after every growth tick; returns what it did.
   */
  repair(year: number, hooks?: RepairHooks): RepairStats {
    const st: RepairStats = { merged: 0, tSplit: 0, crossed: 0, dupKilled: 0, joined: 0, trimmed: 0 };
    if (!REPAIR.on) return st;
    const kill = (e: number) => { if (!this.alive[e]) return false; if (hooks && !hooks.canKill(e)) return false; hooks?.onKill(e); this.killEdge(e); return true; };
    const total = () => st.merged + st.tSplit + st.crossed + st.dupKilled + st.joined + st.trimmed;
    for (let pass = 0; pass < 3; pass++) {
      const before = total();
      // 1) overlapping nodes, and edges of no length
      for (let a = 0; a < this.nx.length; a++) {
        if (!this.adj[a].length) continue;
        for (const b of this.nodesNear(this.nx[a], this.ny[a], 0.14)) {
          if (b <= a || !this.adj[a].length || !this.adj[b].length) continue;
          this.mergeNodes(a, b, hooks); st.merged++;
        }
      }
      // 2) a node lying on the interior of an edge it does not belong to
      for (let n = 0; n < this.nx.length; n++) {
        if (!this.adj[n].length) continue;
        for (const e of this.edgesNear(this.nx[n], this.ny[n], 0.1)) {
          if (!this.alive[e] || this.ea[e] === n || this.eb[e] === n) continue;
          const a = this.ea[e], b = this.eb[e];
          const p = pointSeg(this.nx[n], this.ny[n], this.nx[a], this.ny[a], this.nx[b], this.ny[b]);
          if (p.t > 0.001 && p.t < 0.999 && p.d < 0.05) { this.splitEdge(e, this.nx[n], this.ny[n], n); st.tSplit++; }
        }
      }
      // 3) crossings without a node
      for (let e = 0; e < this.ea.length; e++) {
        if (!this.alive[e]) continue;
        for (const f of this.edgesAlongSeg(this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]], 0.05)) {
          if (f <= e || !this.alive[f] || !this.alive[e]) continue;
          if (this.ea[e] === this.ea[f] || this.ea[e] === this.eb[f] || this.eb[e] === this.ea[f] || this.eb[e] === this.eb[f]) continue;
          const h = segIntersect(this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]], this.nx[this.ea[f]], this.ny[this.ea[f]], this.nx[this.eb[f]], this.ny[this.eb[f]]);
          if (!h || h.t <= 1e-3 || h.t >= 1 - 1e-3 || h.u <= 1e-3 || h.u >= 1 - 1e-3) continue;
          const x = this.nx[this.ea[e]] + (this.nx[this.eb[e]] - this.nx[this.ea[e]]) * h.t, y = this.ny[this.ea[e]] + (this.ny[this.eb[e]] - this.ny[this.ea[e]]) * h.t;
          const n = this.splitEdge(e, x, y);
          this.splitEdge(f, x, y, n);
          st.crossed++;
        }
      }
      // 4) duplicate edges between the same two nodes: keep the stronger class
      for (let n = 0; n < this.nx.length; n++) {
        const l = this.adj[n].slice();
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
          const e = l[i], f = l[j];
          if (!this.alive[e] || !this.alive[f] || this.other(e, n) !== this.other(f, n)) continue;
          const drop = this.ecls[e] > this.ecls[f] || (this.ecls[e] === this.ecls[f] && e > f) ? e : f, keep = drop === e ? f : e;
          if (kill(drop)) { this.ecls[keep] = Math.min(this.ecls[keep], this.ecls[drop]); st.dupKilled++; }
        }
      }
      // 5) dead ends that nearly touch another street become a junction (a short connector street, through the normal growth rules)
      for (let n = 0; n < this.nx.length; n++) {
        if (this.adj[n].length !== 1) continue;
        const e0 = this.adj[n][0], nb = this.other(e0, n);
        const x = this.nx[n], y = this.ny[n];
        // candidates: nearby nodes and the sides of nearby streets, nearest first (a refused join falls through to the next one)
        const cands: { d: number; x: number; y: number }[] = [];
        for (const m of this.nodesNear(x, y, JOIN)) {
          if (m === n || m === nb || this.adj[m].some((f) => this.other(f, m) === n) || this.adj[m].length >= RULES.maxDegree) continue;
          cands.push({ d: Math.hypot(this.nx[m] - x, this.ny[m] - y), x: this.nx[m], y: this.ny[m] });
        }
        for (const e of this.edgesNear(x, y, JOIN)) {
          if (!this.alive[e] || e === e0 || this.ea[e] === nb || this.eb[e] === nb || this.ea[e] === n || this.eb[e] === n) continue;
          const p = pointSeg(x, y, this.nx[this.ea[e]], this.ny[this.ea[e]], this.nx[this.eb[e]], this.ny[this.eb[e]]);
          const L = this.edgeLen(e);
          if (p.d < JOIN && p.t * L > 0.45 && (1 - p.t) * L > 0.45) cands.push({ d: p.d, x: p.x, y: p.y });
        }
        cands.sort((p, q) => p.d - q.d);
        for (const { d: td, x: tx, y: ty } of cands) {
          if (td <= 0.02) break;
          if (!this.alive[e0]) break;
          if (td < 0.35) {
            // practically touching: the dead end moves onto the other street (it becomes the junction node there)
            const ang = this.edgeAngle(e0, n);
            let m = -1;
            for (const c of this.nodesNear(tx, ty, 0.02)) if (c !== n) m = c;
            if (m < 0) {
              const pe = this.nearestEdge(tx, ty, 0.05, nb);
              if (!pe || this.ea[pe.e] === n || this.eb[pe.e] === n) continue;
              const ea = Math.atan2(this.ny[this.eb[pe.e]] - this.ny[this.ea[pe.e]], this.nx[this.eb[pe.e]] - this.nx[this.ea[pe.e]]);
              if (lineDiff(ea, ang) < 0.35) continue;
              m = this.splitEdge(pe.e, tx, ty);
            } else if (this.adj[m].length >= RULES.maxDegree || !this.angleOk(m, ang)) continue;
            this.mergeNodes(m, n, hooks);
            st.joined++;
            break;
          }
          // a short gap closer is not a new street: the block-spacing rule does not apply
          if (this.grow(n, tx, ty, this.ecls[e0], year, { snapScale: 1.6, minLen: 0.05, noParallel: td < 1 }) >= 0) { st.joined++; break; }
        }
        // still a dead end lying on the side of another street (nothing could join it): an empty stub is closed
        if (this.adj[n].length === 1 && cands.length && cands[0].d < 0.35 && this.ecls[e0] !== 0 && this.edgeLen(e0) < RULES.minLen * 2 && kill(e0)) st.trimmed++;
      }
      // 6) no five-way junctions: close the shortest street of the lowest class that leaves its ends joined
      for (let n = 0; n < this.nx.length; n++) {
        while (this.adj[n].length > RULES.maxDegree) {
          const es = this.adj[n].slice().sort((p, q) => this.ecls[q] - this.ecls[p] || this.edgeLen(p) - this.edgeLen(q));
          let done = false;
          for (const e of es) if (this.joinedWithout(this.ea[e], this.eb[e], e) && kill(e)) { st.trimmed++; done = true; break; }
          if (!done) break;
        }
      }
      // 7) dangling slivers: a dead-end street shorter than 0.7 x minLen (about 42 m)
      for (let n = 0; n < this.nx.length; n++) {
        if (this.adj[n].length !== 1) continue;
        const e = this.adj[n][0];
        if (this.ecls[e] !== 0 && this.edgeLen(e) < RULES.minLen * 0.7 && kill(e)) st.trimmed++;
      }
      // 8) sliver wedges: two streets leaving a junction less than 15 degrees apart; the shorter, weaker one closes if that leaves its ends joined
      for (let n = 0; n < this.nx.length; n++) {
        const l = this.adj[n];
        if (l.length < 2) continue;
        let hit = -1;
        for (let i = 0; i < l.length && hit < 0; i++) for (let j = i + 1; j < l.length && hit < 0; j++) {
          if (angDiff(this.edgeAngle(l[i], n), this.edgeAngle(l[j], n)) >= 0.26) continue;
          const a = l[i], b = l[j];
          hit = this.ecls[a] !== this.ecls[b] ? (this.ecls[a] > this.ecls[b] ? a : b) : this.edgeLen(a) < this.edgeLen(b) ? a : b;
        }
        if (hit >= 0 && this.joinedWithout(this.ea[hit], this.eb[hit], hit) && kill(hit)) st.trimmed++;
      }
      if (total() === before) break;
    }
    return st;
  }

  /** Mark raster cells that a road passes through (hidden raster for the maths). */
  rasterize(out: Uint8Array) {
    out.fill(0);
    for (let e = 0; e < this.ea.length; e++) {
      if (!this.alive[e]) continue;
      const ax = this.nx[this.ea[e]], ay = this.ny[this.ea[e]], bx = this.nx[this.eb[e]], by = this.ny[this.eb[e]];
      const L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / 0.35));
      const code = 3 - this.ecls[e];   // 3 arterial, 2 collector, 1 local (the busiest class wins in a cell)
      for (let k = 0; k <= steps; k++) {
        const x = Math.floor(ax + (bx - ax) * (k / steps)), y = Math.floor(ay + (by - ay) * (k / steps));
        if (x >= 0 && y >= 0 && x < N && y < N && out[y * N + x] < code) out[y * N + x] = code;
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
/** arterial route cost weights (the old behaviour was valley 0, climb 0, steep 6) */
export const ART = { valley: 0.035, climb: 2.5, steep: 14 };
const valleyCache = new WeakMap<Float32Array, Float32Array>();
/** How far a cell stands above the lowest ground within ~6 cells (0 on valley floors and in passes, large on ridges and hillsides). */
function valleyness(height: Float32Array): Float32Array {
  let v = valleyCache.get(height);
  if (v) return v;
  v = new Float32Array(N * N);
  const R = 6;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let lo = Infinity;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) lo = Math.min(lo, height[yy * N + xx]); }
    v[y * N + x] = Math.max(0, height[y * N + x] - lo);
  }
  valleyCache.set(height, v);
  return v;
}

export function arterialPath(t: TerrainView, road: Uint8Array, a: [number, number], b: [number, number], extra?: (cell: number) => number, trace?: number[]): [number, number][][] {
  const valley = valleyness(t.height);
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
      const grade = Math.abs(t.height[j] - t.height[c]) / (len * CELL);
      // arterials follow valleys and passes (low ground costs less), and a straight climb is expensive: they run along the contours and zigzag up
      let step = len * (1 + Math.abs(t.height[j] - t.height[c]) * 0.25 + Math.pow(grade / 0.1, 2) * ART.climb + valley[j] * ART.valley);
      if (t.water[j]) step += t.water[j] === Water.Sea ? 60 : 9; // bridge
      if (t.flags[j] & Flag.Steep) step += ART.steep;
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
  if (trace) trace.push(...cells);
  // split into runs off the existing network (with one cell of overlap to join it)
  const runs: [number, number][][] = [];
  let cur: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const on = road[cells[k]] > 0;
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
