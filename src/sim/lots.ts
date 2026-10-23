import { N, Flag, BT } from './constants';
import { quadsOverlap, pointSeg, polyArea, isConvex } from './geom';
import { RoadGraph, ROAD_HALF } from './roads';
import { type DistrictProfile, densClass, hash01, lerpRange } from './profiles';

/**
 * A building plot along street frontage: a convex quad [F0, F1, B1, B0] (cell units).
 * F0->F1 is the street front, B1->B0 the rear; plots in a row share their side lines exactly (no gaps in dense zones).
 * Corner plots are cut by the cross street's kerb line, so wedge and trapezoid plots fall out of the street geometry.
 */
export interface Lot {
  id: number;
  x: number; y: number;       // centroid, cell units
  ang: number;                // front direction (street on the plot's -v side)
  w: number; d: number;       // mean frontage width, depth (cells)
  cell: number;               // raster cell of the centre (for the maths)
  cls: number;                // class of the fronting road
  type: number; level: number; target: number; constr: number; constrTotal: number;
  age: number; low: number;
  flags: number;              // Flag.Planned | Flag.CarLocked | Flag.Docks | Flag.Core
  planType: number; planLevel: number;
  alive: boolean;
  poly: number[];             // [F0, F1, B1, B0]
  dens: number;               // 0 detached, 1 terraced / mid, 2 dense core (class of the profile)
  prof: number;               // district profile index (profiles.ts)
  sides: number;              // bit0: start side (B0-F0) faces a cross street, bit1: end side (F1-B1) faces one
  back: number;               // 1 for back-row (backland) plots
  demo: number;               // months of demolition left before construction starts
  seed: number;               // visual seed: stable per plot
  built: number;              // month the current building was completed (0 = original)
  ntype: number;              // type the plot becomes once the old building is demolished
  lm: number;                 // landmark id + 1 (landmarks.ts), 0 = none
  edge: number;               // road edge whose frontage created the plot (-1 = carved); back rows inherit it
  hgt: number;                // height in metres of the current building (0 = default for its level)
  nhgt: number;               // height of the building under construction
  asm: number;                // large-plot assembly this plot belongs to (id), 0 = none
  astate: number;             // 0 pending, 1 acquired (hoarding), 2 holdout, 3 cleared
}

const HB = 2; // hash bucket (cells)
const hk = (x: number, y: number) => y * 1000 + x;

export const LOT_W = 0.78;   // ~39 m frontage (detached tier)
export const LOT_D = 0.7;    // ~35 m deep
export const SETBACK = 0.1;  // ~5 m from the kerb

interface Cut { tAt: (o: number) => number; street: boolean }

const norm = (a: number) => { const t = a % (Math.PI * 2); return t < 0 ? t + Math.PI * 2 : t; };

export class LotStore {
  lots: Lot[] = [];
  private hash = new Map<number, number[]>();
  private epCache = new Map<number, { prof: number; tier: number; w: number; d: number; sb: number; gap: number; rows: number }>();
  /** plots by the road edge that created them (including back rows) */
  byEdge = new Map<number, Lot[]>();
  /** district profile at a point (set by the sim: zoning around old centres, stations, land value, docks) */
  profileAt: (x: number, y: number) => number = () => 0;

  constructor(private water: Uint8Array, private flags: Uint8Array, private roads: RoadGraph, private profiles: DistrictProfile[]) {}

  private buckets(l: Lot, f: (k: number) => void) {
    const r = 0.6;
    for (let y = Math.floor((l.y - r) / HB); y <= Math.floor((l.y + r) / HB); y++)
      for (let x = Math.floor((l.x - r) / HB); x <= Math.floor((l.x + r) / HB); x++) f(hk(x, y));
  }

  near(x: number, y: number, r: number): Lot[] {
    const out: Lot[] = [];
    const seen = new Set<number>();
    for (let by = Math.floor((y - r) / HB); by <= Math.floor((y + r) / HB); by++)
      for (let bx = Math.floor((x - r) / HB); bx <= Math.floor((x + r) / HB); bx++)
        for (const id of this.hash.get(hk(bx, by)) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const l = this.lots[id];
          if (l.alive && Math.abs(l.x - x) <= r + 0.6 && Math.abs(l.y - y) <= r + 0.6) out.push(l);
        }
    return out.sort((a, b) => a.id - b.id);
  }

  remove(l: Lot) {
    l.alive = false;
    this.buckets(l, (k) => { const a = this.hash.get(k); if (a) { const i = a.indexOf(l.id); if (i >= 0) a.splice(i, 1); } });
  }

  /** Put a removed plot back (a failed assembly leaves its land vacant). */
  restore(l: Lot) {
    l.alive = true; l.type = BT.None; l.level = 0; l.demo = 0; l.constr = 0;
    this.buckets(l, (k) => { let a = this.hash.get(k); if (!a) this.hash.set(k, (a = [])); if (!a.includes(l.id)) a.push(l.id); });
  }

  private setGeom(l: Lot, q: number[]) {
    l.poly = q;
    l.x = (q[0] + q[2] + q[4] + q[6]) / 4; l.y = (q[1] + q[3] + q[5] + q[7]) / 4;
    const fw = Math.hypot(q[2] - q[0], q[3] - q[1]), bw = Math.hypot(q[4] - q[6], q[5] - q[7]);
    const sd = Math.hypot(q[6] - q[0], q[7] - q[1]), ed = Math.hypot(q[4] - q[2], q[5] - q[3]);
    l.w = (fw + bw) / 2; l.d = (sd + ed) / 2;
    l.ang = Math.atan2(q[3] - q[1], q[2] - q[0]);
    // street on the -v side: v = (-sin, cos); back centre must lie on +v
    const bx = (q[4] + q[6]) / 2 - (q[0] + q[2]) / 2, by = (q[5] + q[7]) / 2 - (q[1] + q[3]) / 2;
    if (-Math.sin(l.ang) * bx + Math.cos(l.ang) * by < 0) l.ang += Math.PI;
    l.cell = Math.floor(l.y) * N + Math.floor(l.x);
  }

  /** Try to place a convex quad plot; checks water/steep, overlap with plots (spatial hash + SAT) and with roads. */
  /** Water / steep / carriageway checks for a convex quad (no overlap test). */
  quadClear(q: number[]): boolean {
    if (!isConvex(q)) return false;
    const area = Math.abs(polyArea(q));
    if (area < 0.12) return false;
    const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
    for (let k = -1; k < 4; k++) {
      const px = k < 0 ? cx : q[k * 2], py = k < 0 ? cy : q[k * 2 + 1];
      const gx = Math.floor(px), gy = Math.floor(py);
      if (gx < 1 || gy < 1 || gx >= N - 1 || gy >= N - 1) return false;
      const i = gy * N + gx;
      if (this.water[i] || (this.flags[i] & (Flag.Steep | Flag.Rail | Flag.Flood))) return false;
    }
    // keep clear of every carriageway
    const g = this.roads;
    const reach = 0.6 + Math.hypot(q[2] - q[0], q[3] - q[1]) / 2 + Math.hypot(q[6] - q[0], q[7] - q[1]) / 2;
    for (const e of g.edgesNear(cx, cy, reach)) {
      const ax = g.nx[g.ea[e]], ay = g.ny[g.ea[e]], bx = g.nx[g.eb[e]], by = g.ny[g.eb[e]];
      const clear = ROAD_HALF[g.ecls[e]] + 0.03;
      for (let k = -1; k < 4; k++) {
        const px = k < 0 ? cx : q[k * 2], py = k < 0 ? cy : q[k * 2 + 1];
        if (pointSeg(px, py, ax, ay, bx, by).d < clear) return false;
      }
      // a street (or a dead-end tip) inside the plot
      const L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / 0.2));
      for (let k = 0; k <= steps; k++) {
        const px = ax + (bx - ax) * k / steps, py = ay + (by - ay) * k / steps;
        let inside = true, sgn = 0;
        for (let m = 0; m < 4 && inside; m++) {
          const x1 = q[m * 2], y1 = q[m * 2 + 1], x2 = q[((m + 1) % 4) * 2], y2 = q[((m + 1) % 4) * 2 + 1];
          const cr = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
          if (Math.abs(cr) < 1e-9) continue;
          const sg = cr > 0 ? 1 : -1;
          if (sgn && sg !== sgn) inside = false; else sgn = sg;
        }
        if (inside) return false;
      }
      // an edge passing through the plot
      for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
        const s0 = a / 4, t0 = b / 4;
        const px = (q[0] * (1 - s0) + q[2] * s0) * (1 - t0) + (q[6] * (1 - s0) + q[4] * s0) * t0;
        const py = (q[1] * (1 - s0) + q[3] * s0) * (1 - t0) + (q[7] * (1 - s0) + q[5] * s0) * t0;
        if (pointSeg(px, py, ax, ay, bx, by).d < clear) return false;
      }
    }
    return true;
  }

  tryAddQuad(q: number[], cls: number, prof: number, sides: number, back = 0, edge = -1): Lot | null {
    if (!this.quadClear(q)) return null;
    const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
    for (const o of this.near(cx, cy, 1)) if (quadsOverlap(q, o.poly)) return null;
    const l: Lot = {
      id: this.lots.length, x: 0, y: 0, ang: 0, w: 0, d: 0, cell: 0, cls, type: BT.None, level: 0, target: 0, constr: 0, constrTotal: 0, age: 0, low: 0,
      flags: 0, planType: 0, planLevel: 0, alive: true, poly: q, dens: densClass(this.profiles[prof]), prof, sides, back, demo: 0, seed: 0, built: 0, ntype: 0, lm: 0, edge, hgt: 0, nhgt: 0, asm: 0, astate: 0,
    };
    this.setGeom(l, q);
    l.flags = this.flags[l.cell] & Flag.Docks;
    l.seed = (l.id * 2654435761) >>> 0;
    this.lots.push(l);
    this.buckets(l, (k) => { let a = this.hash.get(k); if (!a) this.hash.set(k, (a = [])); a.push(l.id); });
    if (edge >= 0) { let a = this.byEdge.get(edge); if (!a) this.byEdge.set(edge, (a = [])); a.push(l); }
    return l;
  }

  // ---------------------------------------------------------------- frontage generation
  /** Plot parameters of a street: its district's profile, varied a little per street (edge) inside the profile's ranges. */
  edgeParams(e: number) {
    let p = this.epCache.get(e);
    if (p) return p;
    const g = this.roads;
    const mx = (g.nx[g.ea[e]] + g.nx[g.eb[e]]) / 2, my = (g.ny[g.ea[e]] + g.ny[g.eb[e]]) / 2;
    const prof = this.profileAt(mx, my);
    const P = this.profiles[prof];
    p = {
      prof, tier: densClass(P), rows: P.backRows,
      w: lerpRange(P.lotWidthRange, hash01(e, 1)), d: lerpRange(P.lotDepthRange, hash01(e, 2)),
      sb: lerpRange(P.setbackRange, hash01(e, 3)), gap: (1 - P.frontageContinuity) * 0.07,
    };
    this.epCache.set(e, p);
    return p;
  }

  /** profile index the street's plots were cut with (undefined until its frontage exists) */
  cachedProf(e: number): number | undefined { return this.epCache.get(e)?.prof; }
  forgetEdge(e: number) { this.epCache.delete(e); const a = this.byEdge.get(e); if (a) this.byEdge.set(e, a.filter((l) => l.alive)); }

  private owns(e: number, f: number) {
    const g = this.roads;
    return g.ecls[e] < g.ecls[f] || (g.ecls[e] === g.ecls[f] && e < f);
  }

  /** How the plot row on side `s` of edge `e` ends at node end `end` (0 = A, 1 = B). */
  private cutFor(e: number, end: number, s: number, A: [number, number], ux: number, uy: number, L: number): Cut {
    const g = this.roads;
    const X = end === 0 ? g.ea[e] : g.eb[e];
    const px = g.nx[X], py = g.ny[X];
    const P = this.edgeParams(e);
    const cap = (c: number): Cut => ({ tAt: () => (end === 0 ? c : L - c), street: false });
    const sbMin = ROAD_HALF[g.ecls[e]] + P.sb;
    const nbs = g.adj[X].filter((f) => f !== e);
    if (!nbs.length) return cap(0.04);
    const te = g.edgeAngle(e, X);
    const sigma = end === 0 ? s : -s;
    let best = -1, phi = Infinity;
    for (const f of nbs) {
      const d = norm(sigma * (g.edgeAngle(f, X) - te));
      if (d > 1e-4 && d < phi) { phi = d; best = f; }
    }
    if (best < 0) return cap(sbMin);
    const nxv = -uy * s, nyv = ux * s;
    const mk = (Qx: number, Qy: number, Dx: number, Dy: number, street: boolean): Cut => {
      const cr = ux * Dy - uy * Dx;
      if (Math.abs(cr) < 0.12) return cap(sbMin + 0.02);
      const t = (o: number) => ((Qx - A[0] - nxv * o) * Dy - (Qy - A[1] - nyv * o) * Dx) / cr;
      // sanity: the cut must lie inside the edge's span at the front offset
      const tf = t(sbMin);
      const ok = end === 0 ? tf > -0.35 && tf < L - 0.2 : tf < L + 0.35 && tf > 0.2;
      return ok ? { tAt: t, street } : cap(sbMin + 0.02);
    };
    const deg = (phi * 180) / Math.PI;
    if (deg >= 135) {
      // chain bend / straight-through: both edges share the bisector line through the node
      const th = te + sigma * phi / 2;
      return mk(px, py, Math.cos(th), Math.sin(th), false);
    }
    // corner against the neighbour `best`: the stronger street owns the corner plot
    const tf = g.edgeAngle(best, X);
    const Pf = this.edgeParams(best);
    const th = tf - sigma * Math.PI / 2; // normal of the neighbour on the side that faces `e`
    const nfx = Math.cos(th), nfy = Math.sin(th);
    const half = ROAD_HALF[g.ecls[best]];
    if (this.owns(e, best)) {
      const o = half + Pf.sb;
      return mk(px + nfx * o, py + nfy * o, Math.cos(tf), Math.sin(tf), true);
    }
    const o = half + Pf.sb + Pf.d;
    return mk(px + nfx * o, py + nfy * o, Math.cos(tf), Math.sin(tf), false);
  }

  /** Plots along both sides of an edge, flush to each other and to the corner cuts. */
  frontage(e: number): Lot[] {
    const g = this.roads;
    if (!g.alive[e]) return [];
    const a = g.ea[e], b = g.eb[e];
    const ax = g.nx[a], ay = g.ny[a], bx = g.nx[b], by = g.ny[b];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.9) return [];
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const P = this.edgeParams(e);
    const of = ROAD_HALF[g.ecls[e]] + P.sb, ob = of + P.d;
    const out: Lot[] = [];
    for (const s of [1, -1]) {
      const nx = -uy * s, ny = ux * s;
      const c0 = this.cutFor(e, 0, s, [ax, ay], ux, uy, L);
      const c1 = this.cutFor(e, 1, s, [ax, ay], ux, uy, L);
      const tf0 = c0.tAt(of), tb0 = c0.tAt(ob), tf1 = c1.tAt(of), tb1 = c1.tAt(ob);
      const Lf = tf1 - tf0;
      if (Lf < 0.4 * P.w || tb1 - tb0 < 0.25) continue;
      const pt = (t: number, o: number): [number, number] => [ax + ux * t + nx * o, ay + uy * t + ny * o];
      const F0 = pt(tf0, of), F1 = pt(tf1, of), B0 = pt(tb0, ob), B1 = pt(tb1, ob);
      const n = Math.max(1, Math.round(Lf / P.w));
      const dl = P.gap / 2 / Lf;
      for (let k = 0; k < n; k++) {
        const s0 = k / n + dl, s1 = (k + 1) / n - dl;
        const lerp = (p: [number, number], q: [number, number], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const f0 = lerp(F0, F1, s0), f1 = lerp(F0, F1, s1), b1 = lerp(B0, B1, s1), b0 = lerp(B0, B1, s0);
        const sides = (k === 0 && c0.street ? 1 : 0) | (k === n - 1 && c1.street ? 2 : 0);
        const l = this.tryAddQuad([f0[0], f0[1], f1[0], f1[1], b1[0], b1[1], b0[0], b0[1]], g.ecls[e], P.prof, sides, 0, e);
        if (l) out.push(l);
      }
    }
    return out;
  }

  /** Back-row plots behind the front rows (dense tiers): interior courtyards and rear ranges fill the blocks. */
  backland(parents: Lot[]): Lot[] {
    const out: Lot[] = [];
    let cur = parents.filter((l) => this.profiles[l.prof].backRows > 0 && !l.back);
    for (let row = 1; row <= 3 && cur.length; row++) {
      const next: Lot[] = [];
      for (const p of cur) {
        if (this.profiles[p.prof].backRows < row) continue;
        const q = p.poly;
        // extend from the rear line away from the street by the same depth; front of the new plot = the parent's rear line
        const b0x = q[6], b0y = q[7], b1x = q[4], b1y = q[5];
        const r0x = b0x + (b0x - q[0]), r0y = b0y + (b0y - q[1]);
        const r1x = b1x + (b1x - q[2]), r1y = b1y + (b1y - q[3]);
        const l = this.tryAddQuad([b0x, b0y, b1x, b1y, r1x, r1y, r0x, r0y], p.cls, p.prof, 0, 1, p.edge);
        if (l) { l.flags |= p.flags & Flag.Docks; next.push(l); out.push(l); }
      }
      cur = next;
    }
    return out;
  }

  /** Front rows for a set of new edges, then back rows. */
  frontageAll(edges: number[]): Lot[] {
    const fronts: Lot[] = [];
    for (const e of edges) for (const l of this.frontage(e)) fronts.push(l);
    return [...fronts, ...this.backland(fronts)];
  }

  /** Merge plot b into its row-neighbour a (a bigger building replaces both). Returns true if merged. */
  merge(a: Lot, b: Lot): boolean {
    const qa = a.poly, qb = b.poly;
    const close = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x1 - x2, y1 - y2) < 0.06;
    let q: number[] | null = null;
    let sides = 0;
    if (close(qa[2], qa[3], qb[0], qb[1]) && close(qa[4], qa[5], qb[6], qb[7])) {
      q = [qa[0], qa[1], qb[2], qb[3], qb[4], qb[5], qa[6], qa[7]]; sides = (a.sides & 1) | (b.sides & 2);
    } else if (close(qb[2], qb[3], qa[0], qa[1]) && close(qb[4], qb[5], qa[6], qa[7])) {
      q = [qb[0], qb[1], qa[2], qa[3], qa[4], qa[5], qb[6], qb[7]]; sides = (b.sides & 1) | (a.sides & 2);
    }
    if (!q || !isConvex(q)) return false;
    this.remove(b);
    this.buckets(a, (k) => { const arr = this.hash.get(k); if (arr) { const i = arr.indexOf(a.id); if (i >= 0) arr.splice(i, 1); } });
    a.sides = sides;
    this.setGeom(a, q);
    this.buckets(a, (k) => { let arr = this.hash.get(k); if (!arr) this.hash.set(k, (arr = [])); arr.push(a.id); });
    return true;
  }

  /** Merge the back-row plot behind `a` into it (deeper plot). */
  mergeDepth(a: Lot, only?: (o: Lot) => boolean): boolean {
    const qa = a.poly;
    const close = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x1 - x2, y1 - y2) < 0.06;
    for (const b of this.near(a.x, a.y, 1.2)) {
      if (b === a || !b.back || (only && !only(b))) continue;
      const qb = b.poly;
      if (close(qb[0], qb[1], qa[6], qa[7]) && close(qb[2], qb[3], qa[4], qa[5])) {
        const q = [qa[0], qa[1], qa[2], qa[3], qb[4], qb[5], qb[6], qb[7]];
        if (!isConvex(q)) continue;
        this.remove(b);
        this.buckets(a, (k) => { const arr = this.hash.get(k); if (arr) { const i = arr.indexOf(a.id); if (i >= 0) arr.splice(i, 1); } });
        this.setGeom(a, q);
        this.buckets(a, (k) => { let arr = this.hash.get(k); if (!arr) this.hash.set(k, (arr = [])); arr.push(a.id); });
        return true;
      }
    }
    return false;
  }

  /** Grow a plot toward a target size (cells) by absorbing row neighbours and back-row plots that pass `only`. */
  ensureSize(l: Lot, wCells: number, dCells: number, only: (o: Lot) => boolean = () => true) {
    for (let k = 0; k < 6 && l.w < wCells; k++) {
      const nb = this.near(l.x, l.y, 1.4).filter((o) => o !== l && o.back === l.back && o.cls === l.cls && only(o) && Math.hypot(o.x - l.x, o.y - l.y) < l.w + 0.5);
      let done = false;
      for (const o of nb) if (this.merge(l, o)) { done = true; break; }
      if (!done) break;
    }
    for (let k = 0; k < 3 && l.d < dCells; k++) if (!this.mergeDepth(l, only)) break;
  }

  /** Clear a rectangle (cells) of whatever plots overlap it and add one big plot there; null if it hits roads / water. */
  carve(cx: number, cy: number, ang: number, w: number, d: number, prof: number): { lot: Lot; cleared: Lot[] } | null {
    const c = Math.cos(ang), s = Math.sin(ang);
    // front edge on the -v side: local (u, v) -> world
    const P = (u: number, v: number): [number, number] => [cx + u * c - v * s, cy + u * s + v * c];
    const [f0x, f0y] = P(-w / 2, -d / 2), [f1x, f1y] = P(w / 2, -d / 2), [b1x, b1y] = P(w / 2, d / 2), [b0x, b0y] = P(-w / 2, d / 2);
    const q = [f0x, f0y, f1x, f1y, b1x, b1y, b0x, b0y];
    if (!this.quadClear(q)) return null;
    const cleared: Lot[] = [];
    for (const o of this.near(cx, cy, Math.max(w, d) + 0.8)) {
      if (!quadsOverlap(q, o.poly)) continue;
      if (o.lm || (o.flags & (Flag.Docks | Flag.Planned))) return null;
      cleared.push(o);
    }
    for (const o of cleared) this.remove(o);
    const l = this.tryAddQuad(q, 2, prof, 0, 0);
    if (!l) return null;
    return { lot: l, cleared };
  }

  /** Plots touching a road corridor. */
  inCorridor(ax: number, ay: number, bx: number, by: number, half: number): Lot[] {
    const mx = (ax + bx) / 2, my = (ay + by) / 2, r = Math.hypot(bx - ax, by - ay) / 2 + half + 0.6;
    const out: Lot[] = [];
    for (const l of this.near(mx, my, r)) {
      let hit = pointSeg(l.x, l.y, ax, ay, bx, by).d < half + 0.2;
      for (let k = 0; k < 4 && !hit; k++) hit = pointSeg(l.poly[k * 2], l.poly[k * 2 + 1], ax, ay, bx, by).d < half;
      if (hit) out.push(l);
    }
    return out;
  }
}
