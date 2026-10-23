import { N, Flag, BT } from './constants';
import { rectCorners, quadsOverlap, pointSeg } from './geom';
import { RoadGraph, ROAD_HALF } from './roads';

/** A building plot along road frontage: an oriented rectangle aligned to its street. */
export interface Lot {
  id: number;
  x: number; y: number;       // centre, cell units
  ang: number;                // along the street
  w: number; d: number;       // frontage width, depth (cells)
  cell: number;               // raster cell of the centre (for the maths)
  cls: number;                // class of the fronting road
  type: number; level: number; target: number; constr: number; constrTotal: number;
  age: number; low: number;
  flags: number;              // Flag.Planned | Flag.CarLocked | Flag.Docks
  planType: number; planLevel: number;
  alive: boolean;
  poly: number[];
}

const HB = 2; // hash bucket (cells)
const hk = (x: number, y: number) => y * 1000 + x;

export const LOT_W = 0.78;   // ~39 m frontage
export const LOT_D = 0.7;    // ~35 m deep
export const SETBACK = 0.1;  // ~5 m from the kerb

export class LotStore {
  lots: Lot[] = [];
  private hash = new Map<number, number[]>();

  constructor(private water: Uint8Array, private flags: Uint8Array, private roads: RoadGraph) {}

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

  /** Try to place a plot; checks water/steep, overlap with plots (spatial hash + SAT) and with roads. */
  tryAdd(x: number, y: number, ang: number, w: number, d: number, cls: number): Lot | null {
    const poly = rectCorners(x, y, ang, w / 2, d / 2);
    for (let k = -1; k < 4; k++) {
      const px = k < 0 ? x : poly[k * 2], py = k < 0 ? y : poly[k * 2 + 1];
      const cx = Math.floor(px), cy = Math.floor(py);
      if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) return null;
      const i = cy * N + cx;
      if (this.water[i] || (this.flags[i] & Flag.Steep)) return null;
    }
    for (const o of this.near(x, y, 1)) if (quadsOverlap(poly, o.poly)) return null;
    // keep clear of every carriageway
    for (const e of this.roads.edgesNear(x, y, 1.2)) {
      const g = this.roads;
      const ax = g.nx[g.ea[e]], ay = g.ny[g.ea[e]], bx = g.nx[g.eb[e]], by = g.ny[g.eb[e]];
      const clear = ROAD_HALF[g.ecls[e]] + 0.03;
      for (let k = -1; k < 4; k++) {
        const px = k < 0 ? x : poly[k * 2], py = k < 0 ? y : poly[k * 2 + 1];
        if (pointSeg(px, py, ax, ay, bx, by).d < clear) return null;
      }
      // an edge passing through the middle of the plot
      if (pointSeg(x, y, ax, ay, bx, by).d < d / 2 + clear - 0.05 && Math.abs(pointSegAlong(x, y, ax, ay, bx, by)) < 0.2) return null;
    }
    const cell = Math.floor(y) * N + Math.floor(x);
    const l: Lot = { id: this.lots.length, x, y, ang, w, d, cell, cls, type: BT.None, level: 0, target: 0, constr: 0, constrTotal: 0, age: 0, low: 0,
      flags: this.flags[cell] & Flag.Docks, planType: 0, planLevel: 0, alive: true, poly };
    this.lots.push(l);
    this.buckets(l, (k) => { let a = this.hash.get(k); if (!a) this.hash.set(k, (a = [])); a.push(l.id); });
    return l;
  }

  /** Lay plots along both sides of an edge, set back from the kerb and aligned to it. */
  frontage(e: number): Lot[] {
    const g = this.roads;
    const ax = g.nx[g.ea[e]], ay = g.ny[g.ea[e]], bx = g.nx[g.eb[e]], by = g.ny[g.eb[e]];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1) return [];
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const ang = Math.atan2(uy, ux);
    const off = ROAD_HALF[g.ecls[e]] + SETBACK + LOT_D / 2;
    const usable = L - 0.5;
    const n = Math.floor(usable / (LOT_W + 0.06));
    if (n < 1) return [];
    const pad = (L - n * (LOT_W + 0.06)) / 2 + (LOT_W + 0.06) / 2;
    const out: Lot[] = [];
    for (const side of [1, -1]) {
      for (let k = 0; k < n; k++) {
        const t = pad + k * (LOT_W + 0.06);
        const cx = ax + ux * t - uy * off * side, cy = ay + uy * t + ux * off * side;
        const l = this.tryAdd(cx, cy, ang, LOT_W, LOT_D, g.ecls[e]);
        if (l) out.push(l);
      }
    }
    return out;
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

function pointSegAlong(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const p = pointSeg(px, py, ax, ay, bx, by);
  return p.t <= 0 || p.t >= 1 ? 1 : 0;
}
