/**
 * Zonal road congestion (round 7, step 4a). Last month's car trips between zones (from the trip model, `sim.demand.pCar`) are assigned to
 * the street graph: each zone loads at the street node nearest its activity centre, every origin builds a shortest-time tree, the peak-hour
 * flow of each pair is added to the streets on its path, and street times follow volume over capacity (a BPR curve). Three rounds of
 * the method of successive averages let traffic spread to the alternatives as the main roads fill. No individual cars. The result is
 * the zone-to-zone drive time the mode choice and car accessibility use, the congestion per zone (growth, pressure overlay), and a
 * per-street volume / capacity for the overlay and for buses (step 4b: buses run in this traffic unless they have priority).
 * `TRAFFIC.on = false` (`?notraffic=1`) gives the old zone formula (distance x circuity at zone-averaged speeds).
 */
import { N, ZONE, NZ, ZONES, CELL } from './constants';
import { RC } from './roads';
import { MinHeap } from './heap';
import { FREIGHT } from './freight';
import type { Sim } from './sim';

export const TRAFFIC = {
  on: true,
  /** free-flow km/h and peak-hour capacity (vehicles both ways) by class: arterial, collector, local */
  speed: [48, 38, 28],
  cap: [2600, 1300, 520],
  bprA: 0.8, bprB: 3,
  /** share of a day's trips in the peak hour, cars per car trip (occupancy 1.3) */
  peak: 0.11, perCar: 1 / 1.3,
  rounds: 3,
  /** later months warm-start from last month's volumes: one round a month, relaxed by this much (the cold start runs `rounds`); 0.5
   *  oscillated (mean v/c +-0.04 month to month on a fixed demand), 0.2 holds within +-0.01 (round 7 step 10) */
  relax: 0.2,
  /** km/h from a zone's activity centre to its street node (local access) */
  accessKmh: 18,
};

export class Traffic {
  /** per edge: peak-hour vehicles (both ways), minutes to drive it now, volume / capacity */
  vol = new Float32Array(0);
  time = new Float32Array(0);
  vc = new Float32Array(0);
  /** per zone: the street node trips load at (-1 none) and the access minutes to it */
  node = new Int32Array(ZONES).fill(-1);
  access = new Float32Array(ZONES);
  /** zone x zone drive minutes (street part only), Infinity if unreachable */
  dt = new Float32Array(ZONES * ZONES);
  stats = { vehKm: 0, meanVC: 0, meanSpeed: 0, overCap: 0 };
  constructor(private sim: Sim) {}

  /** the street edges of the shortest path (by length) between the nodes nearest two points, its km and its first node; null if none.
   *  wide: arterials and collectors only (a tram needs a street wide enough for track), from the nearest node on such a street */
  route(ax: number, ay: number, bx: number, by: number, wide = false): { edges: number[]; km: number; from: number } | null {
    const R = this.sim.roads;
    const ok = (e: number) => R.alive[e] && (!wide || R.ecls[e] !== RC.Local);
    const near = (x: number, y: number) => {
      if (!wide) return R.nearestNode(x, y, 4);
      let n = -1, bd = 3;
      for (let k = 0; k < R.nx.length; k++) {
        const d = Math.hypot(R.nx[k] - x, R.ny[k] - y);
        if (d < bd && R.adj[k].some(ok)) { bd = d; n = k; }
      }
      return n;
    };
    const s = near(ax, ay), t = near(bx, by);
    if (s < 0 || t < 0) return null;
    if (s === t) return { edges: [], km: Math.hypot(bx - ax, by - ay) * CELL / 1000, from: s };
    const M = R.nx.length, d = new Float64Array(M).fill(Infinity), via = new Int32Array(M).fill(-1), h = new MinHeap();
    d[s] = 0; h.push(s, 0);
    while (h.size) {
      const n = h.pop();
      if (n === t) break;
      for (const e of R.adj[n]) {
        if (!ok(e)) continue;
        const o = R.other(e, n), v = d[n] + R.edgeLen(e);
        if (v < d[o]) { d[o] = v; via[o] = e; h.push(o, v + Math.hypot(R.nx[o] - R.nx[t], R.ny[o] - R.ny[t])); }
      }
    }
    if (!(d[t] < Infinity)) return null;
    const edges: number[] = [];
    for (let n = t, g = 0; n !== s && g < 5000; g++) { const e = via[n]; if (e < 0) return null; edges.push(e); n = R.other(e, n); }
    edges.reverse();
    return { edges, km: d[t] * CELL / 1000, from: s };
  }

  /** minutes to drive an edge at free flow */
  free(e: number) { return this.freeTime(e); }

  private freeTime(e: number) {
    const R = this.sim.roads, c = R.ecls[e] as number;
    return (R.edgeLen(e) * CELL / 1000) / TRAFFIC.speed[c] * 60;
  }

  /** shortest-time tree from node s over current edge times: dist per node and the edge used to reach it */
  private tree(s: number, dist: Float64Array, via: Int32Array) {
    const R = this.sim.roads;
    dist.fill(Infinity); via.fill(-1);
    const h = new MinHeap();
    dist[s] = 0; h.push(s, 0);
    while (h.size) {
      const n = h.pop(), dn = dist[n];
      for (const e of R.adj[n]) {
        if (!R.alive[e]) continue;
        const o = R.other(e, n), v = dn + this.time[e];
        if (v < dist[o]) { dist[o] = v; via[o] = e; h.push(o, v); }
      }
    }
  }

  private warm = false;
  run() {
    const sim = this.sim, R = sim.roads, E = R.ea.length, M = R.nx.length;
    if (this.vol.length !== E) {
      // the street graph grew: keep the volumes of the streets that were there (new edges start empty)
      const ov = this.vol, ot = this.time;
      this.vol = new Float32Array(E); this.time = new Float32Array(E); this.vc = new Float32Array(E);
      this.vol.set(ov.subarray(0, Math.min(ov.length, E))); this.time.set(ot.subarray(0, Math.min(ot.length, E)));
    }
    // zone access nodes: nearest street node to the zone's activity centre
    const ax = new Float64Array(ZONES), ay = new Float64Array(ZONES), aw = new Float64Array(ZONES);
    for (let i = 0; i < N * N; i++) {
      const w = sim.cHomes[i] + sim.cJobs[i];
      if (!w) continue;
      const z = sim.zoneOf(i);
      ax[z] += w * (i % N + 0.5); ay[z] += w * (((i / N) | 0) + 0.5); aw[z] += w;
    }
    for (let z = 0; z < ZONES; z++) {
      this.node[z] = -1;
      if (!aw[z]) continue;
      const x = ax[z] / aw[z], y = ay[z] / aw[z];
      // load where the zone meets the main roads: the nearest node weighted by its best street class (an old-town lane would otherwise
      // carry every trip of its zone and jam at five times its capacity)
      let n = -1, best = Infinity;
      for (let k = 0; k < M; k++) {
        if (!R.adj[k].length) continue;
        const d = Math.hypot(R.nx[k] - x, R.ny[k] - y);
        if (d > ZONE) continue;
        let cls = 2;
        for (const e of R.adj[k]) if (R.alive[e]) cls = Math.min(cls, R.ecls[e] as number);
        const sc = (d + 0.5) * (cls === RC.Arterial ? 1 : cls === RC.Collector ? 1.5 : 2.6);
        if (sc < best) { best = sc; n = k; }
      }
      if (n < 0) n = R.nearestNode(x, y, ZONE);
      if (n < 0 || !R.adj[n].length) continue;
      this.node[z] = n;
      this.access[z] = (Math.hypot(R.nx[n] - x, R.ny[n] - y) * CELL / 1000) / TRAFFIC.accessKmh * 60;
    }
    // OD: last month's car trips by zone pair (both directions summed), as peak-hour vehicles each way
    const pc = sim.demand.pCar, pf = sim.demand.pFreight;
    // lorries (round 7 step 10): 2.5 cars each, with the freight peak share, expressed as car-trip equivalents
    const lorry = FREIGHT.on ? FREIGHT.pcu * (FREIGHT.peak / TRAFFIC.peak) / TRAFFIC.perCar : 0;
    const od: { a: number; b: number; v: number }[] = [];
    for (let a = 0; a < ZONES; a++) {
      if (this.node[a] < 0) continue;
      for (let b = a + 1; b < ZONES; b++) {
        const t = pc[a * ZONES + b] + lorry * pf[a * ZONES + b];
        if (t < 4 || this.node[b] < 0 || this.node[a] === this.node[b]) continue;
        od.push({ a, b, v: t * TRAFFIC.peak * TRAFFIC.perCar / 2 });
      }
    }
    const byOrigin = new Map<number, { b: number; v: number }[]>();
    for (const o of od) { (byOrigin.get(o.a) ?? byOrigin.set(o.a, []).get(o.a)!).push({ b: o.b, v: o.v }); }
    // cold start (the first month): the method of successive averages over a few rounds from free flow. Later months warm-start from
    // last month's volumes and run one round (the demand itself is last month's), which is also the pass the zone-to-zone times come from
    const cold = !this.warm;
    const noCars = sim.roadPlan.noCars, laneMul = sim.freight.laneMul;
    const zoneOfEdge = (e: number) => { const mx = (R.nx[R.ea[e]] + R.nx[R.eb[e]]) / 2, my = (R.ny[R.ea[e]] + R.ny[R.eb[e]]) / 2; return Math.min(NZ - 1, Math.max(0, Math.floor(my / ZONE))) * NZ + Math.min(NZ - 1, Math.max(0, Math.floor(mx / ZONE))); };
    for (let e = 0; e < E; e++) {
      // dead streets and transit streets (round 7 step 7: buses, trams, bikes and walkers only) carry no cars
      if (!R.alive[e] || noCars.has(e)) { this.vol[e] = 0; this.time[e] = Infinity; continue; }
      if (cold) this.vol[e] = 0;
      const c = R.ecls[e] as number, zm = c === RC.Arterial ? 1 : laneMul[zoneOfEdge(e)];
      this.time[e] = this.freeTime(e) * Math.min(5, 1 + TRAFFIC.bprA * Math.pow(this.vol[e] / (TRAFFIC.cap[c] * zm), TRAFFIC.bprB));
    }
    this.warm = true;
    const dist = new Float64Array(M), via = new Int32Array(M), load = new Float32Array(E);
    this.dt.fill(Infinity);
    const rounds = cold ? TRAFFIC.rounds : 1;
    for (let r = 0; r < rounds; r++) {
      load.fill(0);
      const last = r === rounds - 1;
      for (let a = 0; a < ZONES; a++) {
        const list = byOrigin.get(a);
        if (this.node[a] < 0 || (!list && !last)) continue;
        this.tree(this.node[a], dist, via);
        // zone-to-zone times from the last round's trees (street times as they stood at the start of the round)
        if (last) for (let b = 0; b < ZONES; b++) {
          if (this.node[b] < 0) continue;
          const d = a === b ? 0 : dist[this.node[b]];
          if (d < Infinity) this.dt[a * ZONES + b] = d + this.access[a] + this.access[b];
        }
        if (!list) continue;
        for (const { b, v } of list) {
          let n = this.node[b], guard = 0;
          if (!(dist[n] < Infinity)) continue;
          // both directions use the same streets (one way out, one back): the volume is for both ways
          while (n !== this.node[a] && guard++ < 2000) { const e = via[n]; if (e < 0) break; load[e] += 2 * v; n = R.other(e, n); }
        }
      }
      const k = cold ? 1 / (r + 1) : TRAFFIC.relax;
      for (let e = 0; e < E; e++) {
        if (!R.alive[e] || noCars.has(e)) continue;
        this.vol[e] += (load[e] - this.vol[e]) * k;
        // round 7 step 10: deliveries at the kerb take capacity from the old town's local streets and collectors (freight.ts laneMul)
        const c = R.ecls[e] as number, zm = c === RC.Arterial ? 1 : laneMul[zoneOfEdge(e)], vc = this.vol[e] / (TRAFFIC.cap[c] * zm);
        this.vc[e] = vc;
        // a jammed street crawls but moves: at most five times its free-flow time (queues spill to other routes instead)
        this.time[e] = this.freeTime(e) * Math.min(5, 1 + TRAFFIC.bprA * Math.pow(vc, TRAFFIC.bprB));
      }
    }
    // headline numbers and per-zone congestion (edge midpoints' zones, length-weighted)
    let vk = 0, vcw = 0, sp = 0, over = 0;
    sim.zCong.fill(0);
    const zl = new Float64Array(ZONES);
    for (let e = 0; e < E; e++) {
      if (!R.alive[e]) continue;
      const L = R.edgeLen(e) * CELL / 1000, v = this.vol[e];
      vk += v * L; vcw += v * L * this.vc[e]; sp += v * L * (L / (this.time[e] / 60));
      if (this.vc[e] > 1) over += L;
      const mx = (R.nx[R.ea[e]] + R.nx[R.eb[e]]) / 2, my = (R.ny[R.ea[e]] + R.ny[R.eb[e]]) / 2;
      const z = Math.min(NZ - 1, Math.max(0, Math.floor(my / ZONE))) * NZ + Math.min(NZ - 1, Math.max(0, Math.floor(mx / ZONE)));
      const w = R.ecls[e] === RC.Arterial ? 3 : 1; sim.zCong[z] += this.vc[e] * L * w; zl[z] += L * w;
    }
    for (let z = 0; z < ZONES; z++) { sim.zCong[z] = zl[z] ? sim.zCong[z] / zl[z] : 0; }
    this.stats = { vehKm: vk, meanVC: vk ? vcw / vk : 0, meanSpeed: vk ? sp / vk : TRAFFIC.speed[0], overCap: over };
  }
}
