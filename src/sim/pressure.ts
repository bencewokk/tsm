/**
 * Demand pressure (round 7, step 3): where the trips of the city push against the networks, split by mode, as an overlay. No behaviour
 * change yet: nothing in the sim reads these numbers; they are the groundwork for paths and footbridges (walking), road connectors and
 * upgrades (car / service) and the player's signal for where a line would win riders (transit opportunity). Freight comes later.
 *
 *   walking   short trips (under 2 km) made on foot, painted along their desire line
 *   car       car and service trips, painted along their desire line, weighted by the congestion where they run
 *   transit   car trips of 1.2-8 km with no station within walking distance at either end: painted at both ends (where a station would win them)
 *
 * The fields are a rolling history (each month 15% new, 85% the old: about six months of memory), so a one-off event day does not leave a
 * permanent mark. Missing links are found cheaply by route directness: each month a few of the heaviest zone pairs are routed over the
 * street graph and compared with the straight line; a pair whose network route is much longer than the crow flies (a river with no bridge,
 * a rail yard, a dead-end grid) becomes a candidate, and candidates that stay heavy month after month climb the list.
 */
import { N, ZONE, NZ, ZONES, CELL } from './constants';
import { MinHeap } from './heap';
import type { Sim } from './sim';

export type PressureKind = 'walk' | 'car' | 'transit';
export interface LinkCandidate { kind: PressureKind; a: number; b: number; ax: number; ay: number; bx: number; by: number; trips: number; ratio: number; score: number; seen: number }

const KEEP = 0.85;          // monthly memory of the fields
const TESTS = 6;            // zone pairs routed over the street graph each month
const RATIO = 1.45;         // network / straight-line distance from which a pair is a missing-link candidate

export class PressureSystem {
  walk = new Float32Array(N * N);
  car = new Float32Array(N * N);
  transit = new Float32Array(N * N);
  /** this month's zone-pair trips by mode, filled by computeRiders (both directions summed in a < b order) */
  pWalk = new Float32Array(ZONES * ZONES);
  pCar = new Float32Array(ZONES * ZONES);
  pOpp = new Float32Array(ZONES * ZONES);
  /** transit trips by zone pair (round 7 step 7: a viable transit alternative weighs against a new road) */
  pTr = new Float32Array(ZONES * ZONES);
  cands: LinkCandidate[] = [];
  /** month each pair was last routed (no retest for a year) */
  private tested = new Map<number, number>();
  constructor(private sim: Sim) {}

  /** called at the start of computeRiders */
  reset() { this.pWalk.fill(0); this.pCar.fill(0); this.pOpp.fill(0); this.pTr.fill(0); }
  /** from route(): one zone pair's daily trips by mode; `cov` = share of the trips with a station within walking distance at both ends */
  add(a: number, b: number, walk: number, car: number, dk: number, cov: number, tr = 0) {
    const k = a < b ? a * ZONES + b : b * ZONES + a;
    this.pTr[k] += tr;
    if (dk < 2) this.pWalk[k] += walk;
    this.pCar[k] += car;
    if (dk >= 1.2 && dk <= 8 && cov < 0.3) this.pOpp[k] += car * (1 - cov);
  }

  private centre(z: number): [number, number] { return [((z % NZ) + 0.5) * ZONE, (((z / NZ) | 0) + 0.5) * ZONE]; }

  /** paint a pair's trips along its straight line (per cell crossed), or at its two ends */
  private paint(f: Float32Array, k: number, v: number, ends: boolean) {
    const a = (k / ZONES) | 0, b = k % ZONES;
    const [ax, ay] = this.centre(a), [bx, by] = this.centre(b);
    if (ends) {
      for (const [x, y] of [[ax, ay], [bx, by]]) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
        if (cx >= 0 && cy >= 0 && cx < N && cy < N) f[cy * N + cx] += v * (1 - Math.hypot(dx, dy) / 4.5) / 20;
      }
      return;
    }
    const L = Math.max(1, Math.hypot(bx - ax, by - ay)), steps = Math.ceil(L);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, cx = Math.floor(ax + (bx - ax) * t), cy = Math.floor(ay + (by - ay) * t);
      if (cx >= 0 && cy >= 0 && cx < N && cy < N) f[cy * N + cx] += v / (steps + 1) * 4;
    }
  }

  /** street-network distance (cells) between the nodes nearest two points, or Infinity */
  private netDist(ax: number, ay: number, bx: number, by: number): number {
    const R = this.sim.roads;
    const s = R.nearestNode(ax, ay, 6), t = R.nearestNode(bx, by, 6);
    if (s < 0 || t < 0) return Infinity;
    const M = R.nx.length, d = new Float64Array(M).fill(Infinity), h = new MinHeap();
    d[s] = 0; h.push(s, 0);
    while (h.size) {
      const n = h.pop();
      if (n === t) break;
      const dn = d[n];
      for (const e of R.adj[n]) {
        if (!R.alive[e]) continue;
        const o = R.other(e, n), v = dn + R.edgeLen(e);
        if (v < d[o]) { d[o] = v; h.push(o, v + Math.hypot(R.nx[o] - R.nx[t], R.ny[o] - R.ny[t])); }
      }
    }
    // plus the walk from each point to its node
    return d[t] + Math.hypot(R.nx[s] - ax, R.ny[s] - ay) + Math.hypot(R.nx[t] - bx, R.ny[t] - by);
  }

  /** once a month, after computeRiders */
  tick() {
    const sim = this.sim, cong = sim.zCong;
    const cw = new Float32Array(N * N), cc = new Float32Array(N * N), ct = new Float32Array(N * N);
    const top = (p: Float32Array, n: number) => {
      const idx: number[] = [];
      for (let k = 0; k < p.length; k++) if (p[k] > 20) idx.push(k);
      idx.sort((x, y) => p[y] - p[x] || x - y);
      return idx.slice(0, n);
    };
    const tw = top(this.pWalk, 300), tc = top(this.pCar, 400), to = top(this.pOpp, 200);
    for (const k of tw) this.paint(cw, k, this.pWalk[k], false);
    for (const k of tc) {
      const a = (k / ZONES) | 0, b = k % ZONES;
      this.paint(cc, k, this.pCar[k] * (0.5 + Math.min(1.5, (cong[a] + cong[b]) / 2)), false);
    }
    for (const k of to) this.paint(ct, k, this.pOpp[k], true);
    for (let i = 0; i < N * N; i++) {
      this.walk[i] = this.walk[i] * KEEP + cw[i] * (1 - KEEP);
      this.car[i] = this.car[i] * KEEP + cc[i] * (1 - KEEP);
      this.transit[i] = this.transit[i] * KEEP + ct[i] * (1 - KEEP);
    }
    // missing links: route a few heavy pairs that have not been tested for a year; candidates decay unless they stay heavy
    for (const c of this.cands) c.score *= 0.9;
    let tests = 0;
    const tryPair = (k: number, kind: PressureKind, trips: number) => {
      const last = this.tested.get(k * 3 + (kind === 'walk' ? 0 : kind === 'car' ? 1 : 2));
      const old = this.cands.find((c) => c.kind === kind && c.a * ZONES + c.b === k);
      if (old) { old.trips = trips; old.score += trips * (old.ratio - 1) * 0.1; old.seen = sim.month; return; }
      if (last !== undefined && sim.month - last < 12) return;
      if (tests >= TESTS) return;
      tests++;
      this.tested.set(k * 3 + (kind === 'walk' ? 0 : kind === 'car' ? 1 : 2), sim.month);
      const a = (k / ZONES) | 0, b = k % ZONES;
      const [ax, ay] = this.centre(a), [bx, by] = this.centre(b);
      const straight = Math.hypot(bx - ax, by - ay);
      if (straight < 3) return;
      const net = this.netDist(ax, ay, bx, by), ratio = net / straight;
      if (ratio >= RATIO) this.cands.push({ kind, a, b, ax, ay, bx, by, trips, ratio: Math.min(ratio, 9), score: trips * (Math.min(ratio, 9) - 1), seen: sim.month });
    };
    for (const k of tw.slice(0, 40)) tryPair(k, 'walk', this.pWalk[k]);
    for (const k of tc.slice(0, 40)) tryPair(k, 'car', this.pCar[k]);
    this.cands = this.cands.filter((c) => c.score > 5).sort((x, y) => y.score - x.score).slice(0, 14);
    this.cache = null;
  }

  /** for the overlay: three channels 0..255 (walk, car, transit opportunity), each blurred over about 250 m and scaled to its own high end
   *  (3x the mean) (the fields are painted from 400 m zone pairs, so unblurred they are a few hot spots), and the candidates */
  info(): { field: Uint8Array; cands: LinkCandidate[] } { return this.cache ?? (this.cache = this.build()); }
  private cache: { field: Uint8Array; cands: LinkCandidate[] } | null = null;
  private build(): { field: Uint8Array; cands: LinkCandidate[] } {
    const out = new Uint8Array(N * N * 3);
    const tmp = new Float32Array(N * N), bl = new Float32Array(N * N);
    [this.walk, this.car, this.transit].forEach((f, ch) => {
      bl.set(f);
      // two passes of a 5-wide box blur, separable, as running sums (edges clamp)
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < N; y++) {
          const o = y * N;
          let s = bl[o] * 3 + bl[o + 1] + bl[o + 2];
          for (let x = 0; x < N; x++) { tmp[o + x] = s / 5; s += bl[o + Math.min(N - 1, x + 3)] - bl[o + Math.max(0, x - 2)]; }
        }
        for (let x = 0; x < N; x++) {
          let s = tmp[x] * 3 + tmp[N + x] + tmp[2 * N + x];
          for (let y = 0; y < N; y++) { bl[y * N + x] = s / 5; s += tmp[Math.min(N - 1, y + 3) * N + x] - tmp[Math.max(0, y - 2) * N + x]; }
        }
      }
      // reference: 3x the mean of the cells with any pressure (about the 95th percentile on these fields, without a sort)
      let sum = 0, n = 0;
      for (let i = 0; i < N * N; i++) if (bl[i] > 0.5) { sum += bl[i]; n++; }
      const ref = Math.max(1, n ? 3 * sum / n : 1);
      for (let i = 0; i < N * N; i++) out[i * 3 + ch] = Math.min(255, Math.round(255 * Math.sqrt(bl[i] / ref)));
    });
    return { field: out, cands: this.cands.map((c) => ({ ...c })) };
  }
}
void CELL;
