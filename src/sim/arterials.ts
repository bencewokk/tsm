/**
 * Road proposals (round 7, step 7): the city's highways department proposes arterials, bridges and bypasses where car and service demand
 * keeps pressing against a street network that goes the long way round; the player decides. The AI never builds a road on its own.
 *
 * Source: the car missing-link candidates of the demand pressure system (pressure.ts: zone pairs whose street route is 1.45x+ the
 * straight line, kept while they stay heavy). Twice a year the strongest of them are searched for the missing link: the short new street
 * between two arterial / collector nodes (up to 700 m) that cuts the pair's street distance most (a bridge over the river, a link past a
 * rail yard, a bypass round the old core). The best few links are laid out and scored, every term normalised to 0..1 and weighted:
 *
 *   arterialPressure = 0.30 car demand (the pair's daily car trips / 3000)
 *                    + 0.25 detour benefit (minutes saved x trips / 10000)
 *                    + 0.15 land unlocked (vacant buildable cells beside it with no street within two cells / 40)
 *                    + 0.10 freight / port access (one end in the port or heavy industry)
 *                    - 0.20 viable transit alternative (2x the pair's transit share, at most 1)
 *                    - 0.20 demolition (buildings in the way / 15)
 *                    - 0.35 historic core (old-core cells crossed / 6); a protected cell rules the layout out
 *
 * Above 0.25 the best layout goes to City hall with alternatives: the arterial (the regional road fund pays half), a transit street on
 * the same line (buses, trams, bikes and walkers only, cars kept out: a busway / tram reserve; over water a bridge for them with a bus
 * stop at each end), or no road (the congestion stays, trust in the quarters at both ends falls, and the department comes back after
 * two years if the pressure has grown). `ROADPLAN.on = false` turns proposals off.
 */
import { N, ZONE, ZONES, CELL, BT } from './constants';
import { RC } from './roads';
import { ENV } from './envelopes';
import { T } from './territory';
import type { Sim } from './sim';
import type { LinkCandidate } from './pressure';
import { MinHeap } from './heap';

export const ROADPLAN = {
  on: true,
  start: 24, every: 6, gap: 12,
  threshold: 0.25,
  /** a candidate must have been on the list this long (months) */
  standing: 6,
  costKm: 4e6, bridgeKm: 28e6, demolish: 0.5e6,
  /** the regional road fund pays this share of an arterial (not of a transit street) */
  region: 0.5,
  /** a transit street costs this share of the road (narrower, no junction works for cars) */
  transitShare: 0.6,
  retry: 24,
  w: { demand: 0.3, benefit: 0.25, land: 0.15, port: 0.1, transit: 0.2, demol: 0.2, historic: 0.35 },
};

export interface ProposalTerms { demand: number; benefit: number; land: number; port: number; transit: number; demol: number; historic: number }
export interface RoadProposal {
  id: number; a: number; b: number; kind: 'arterial' | 'bridge' | 'bypass';
  pts: [number, number][]; km: number; waterKm: number; buildings: number; historicCells: number; unlocked: number;
  trips: number; savedMin: number; terms: ProposalTerms; pressure: number;
  state: 'asked' | 'arterial' | 'transit' | 'rejected'; month: number; decided: number; name: string; returning: boolean;
}

export class RoadPlanner {
  list: RoadProposal[] = [];
  private queue: number[] = [];
  private nextId = 1;
  private lastAsk = -99;
  /** zone pair -> month and pressure of the last refusal */
  private refused = new Map<number, { month: number; pressure: number }>();
  /** street polylines kept for buses, trams, bikes and walkers (no cars); the edge set is re-found from them as the graph changes */
  transitStreets: [number, number][][] = [];
  noCars = new Set<number>();
  private ncVersion = -1;
  log: string[] = [];
  constructor(private sim: Sim) {}

  /** monthly, after the demand pressure tick */
  tick() {
    this.refreshNoCars();
    const sim = this.sim;
    if (!ROADPLAN.on || sim.month < ROADPLAN.start || sim.month % ROADPLAN.every !== 0) return;
    if (this.queue.length || sim.month - this.lastAsk < ROADPLAN.gap) return;
    const cands = sim.demand.cands.filter((c) => c.kind === 'car' && sim.month - c.seen <= 1);
    let best: RoadProposal | null = null;
    for (const c of cands.slice(0, 4)) {
      const key = Math.min(c.a, c.b) * ZONES + Math.max(c.a, c.b);
      if (this.list.some((p) => p.a * ZONES + p.b === key && p.state !== 'rejected')) continue;
      const ref = this.refused.get(key);
      const p = this.evaluate(c);
      if (!p) continue;
      if (ref && (sim.month - ref.month < ROADPLAN.retry || p.pressure < ref.pressure + 0.05)) continue;
      p.returning = !!ref;
      if (p.pressure >= ROADPLAN.threshold && (!best || p.pressure > best.pressure)) best = p;
    }
    if (!best) return;
    best.id = this.nextId++;
    this.list.push(best);
    this.queue.push(best.id);
    this.lastAsk = sim.month;
    this.log.push(`m${sim.month}\tproposal ${best.id}\t${best.kind}\t${best.name}\tpressure ${best.pressure.toFixed(2)}\t${best.km.toFixed(1)} km, water ${best.waterKm.toFixed(2)} km, ${best.buildings} buildings`);
  }

  private nearestWide(x: number, y: number, r: number) {
    const R = this.sim.roads;
    let n = -1, bd = r;
    for (let k = 0; k < R.nx.length; k++) {
      const d = Math.hypot(R.nx[k] - x, R.ny[k] - y);
      if (d < bd && R.adj[k].some((e) => R.alive[e] && R.ecls[e] !== RC.Local && !this.noCars.has(e))) { bd = d; n = k; }
    }
    return n;
  }

  /** street distance (cells) from node s to every node */
  private tree(s: number): Float64Array {
    const R = this.sim.roads, d = new Float64Array(R.nx.length).fill(Infinity), h = new MinHeap();
    d[s] = 0; h.push(s, 0);
    while (h.size) {
      const n = h.pop(), dn = d[n];
      for (const e of R.adj[n]) {
        if (!R.alive[e]) continue;
        const o = R.other(e, n), v = dn + R.edgeLen(e);
        if (v < d[o]) { d[o] = v; h.push(o, v); }
      }
    }
    return d;
  }

  /**
   * The missing link for a candidate pair: from the street node nearest each zone centre, a shortest-distance tree; every pair of nodes
   * (u, v) on wide streets (arterial or collector) up to 14 cells apart is a possible new link, and the ones that shorten the trip most
   * (dA[u] + |uv| + dB[v] against today's dA[B]) are laid out and scored; the best layout wins. Null if nothing saves 0.6 min.
   */
  evaluate(c: LinkCandidate): RoadProposal | null {
    const sim = this.sim, R = sim.roads, W = ROADPLAN.w;
    const na = R.nearestNode(c.ax, c.ay, ZONE), nb = R.nearestNode(c.bx, c.by, ZONE);
    if (na < 0 || nb < 0 || na === nb) return null;
    const dA = this.tree(na), dB = this.tree(nb), today = dA[nb];
    if (!(today < Infinity)) return null;
    const wide: number[] = [];
    for (let n = 0; n < R.nx.length; n++) if (R.adj[n].some((e) => R.alive[e] && R.ecls[e] !== RC.Local && !this.noCars.has(e))) wide.push(n);
    const links: { u: number; v: number; save: number }[] = [];
    for (const u of wide) {
      if (!(dA[u] < today)) continue;
      for (const v of wide) {
        if (u === v || !(dB[v] < today)) continue;
        const L = Math.hypot(R.nx[u] - R.nx[v], R.ny[u] - R.ny[v]);
        if (L < 2 || L > 14) continue;
        const save = today - (dA[u] + L * 1.05 + dB[v]);
        if (save > 3) links.push({ u, v, save });
      }
    }
    links.sort((x, y) => y.save - x.save);
    const a = Math.min(c.a, c.b), b = Math.max(c.a, c.b), k = a * ZONES + b;
    const pCar = sim.demand.pCar[k], pTr = sim.demand.pTr[k];
    // a viable transit alternative: transit already carries a good share of this pair (half the trips counts in full)
    const transit = pCar + pTr > 0 ? Math.min(1, 2 * pTr / (pCar + pTr)) : 0;
    const portAt = (x: number, y: number) => {
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
        if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
        const t = sim.town.terr[cy * N + cx];
        if (t === T.Port || t === T.Industry) n++;
      }
      return n >= 6;
    };
    let best: RoadProposal | null = null;
    const tried: { u: number; v: number }[] = [];
    for (const lk of links) {
      if (tried.length >= 8) break;
      // skip near-duplicates of a link already laid out
      if (tried.some((t) => Math.hypot(R.nx[t.u] - R.nx[lk.u], R.ny[t.u] - R.ny[lk.u]) + Math.hypot(R.nx[t.v] - R.nx[lk.v], R.ny[t.v] - R.ny[lk.v]) < 3)) continue;
      tried.push(lk);
      const ax = R.nx[lk.u], ay = R.ny[lk.u], bx = R.nx[lk.v], by = R.ny[lk.v];
      const pts: [number, number][] = [[ax, ay], [bx, by]];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 0.4));
      let water = 0, hist = 0, prot = false;
      const bld = new Set<number>(), unl = new Set<number>();
      for (let q = 0; q <= n; q++) {
        const x = ax + (bx - ax) * q / n, y = ay + (by - ay) * q / n, cx = Math.floor(x), cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
        const i = cy * N + cx;
        if (sim.g.water[i]) water++;
        const env = sim.envs.env[i];
        if (env === ENV.Protected) prot = true;
        if (env === ENV.Historic) hist++;
        for (const l of sim.lots.near(x, y, 0.5)) if (l.type !== BT.None && l.level > 0 && Math.hypot(l.x - x, l.y - y) < 0.45) bld.add(l.id);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const qx = cx + dx, qy = cy + dy;
          if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
          const j = qy * N + qx;
          if (!sim.g.water[j] && sim.roadDist[j] > 2 && sim.cHomes[j] + sim.cJobs[j] === 0) unl.add(j);
        }
      }
      if (prot) continue;
      const waterKm = water * 0.4 * CELL / 1000;
      if (waterKm > 0.9) continue;
      const savedMin = lk.save * CELL / 1000 / 35 * 60;
      if (savedMin < 0.6) continue;
      const port = portAt(ax, ay) || portAt(bx, by) ? 1 : 0;
      const terms: ProposalTerms = {
        demand: Math.min(1, c.trips / 3000), benefit: Math.min(1, savedMin * c.trips / 10000), land: Math.min(1, unl.size / 40), port,
        transit, demol: Math.min(1, bld.size / 15), historic: Math.min(1, hist / 6),
      };
      const pressure = W.demand * terms.demand + W.benefit * terms.benefit + W.land * terms.land + W.port * terms.port
        - W.transit * terms.transit - W.demol * terms.demol - W.historic * terms.historic;
      if (!best || pressure > best.pressure) {
        // a bypass: the link runs round the old core (both ends outside it, the straight line between the zone centres through it)
        let coreOnLine = 0;
        for (let q = 0; q <= 20; q++) { const x = c.ax + (c.bx - c.ax) * q / 20, y = c.ay + (c.by - c.ay) * q / 20; const e2 = sim.envs.env[Math.floor(y) * N + Math.floor(x)]; if (e2 === ENV.Historic || e2 === ENV.Protected) coreOnLine++; }
        const kind = waterKm > 0.02 ? 'bridge' : coreOnLine >= 3 && hist === 0 ? 'bypass' : 'arterial';
        best = { id: 0, a, b, kind, pts, km: len * CELL / 1000, waterKm, buildings: bld.size, historicCells: hist, unlocked: unl.size, trips: c.trips, savedMin, terms, pressure,
          state: 'asked', month: sim.month, decided: -1, name: `${this.place(ax, ay)} to ${this.place(bx, by)}`, returning: false };
      }
    }
    return best;
  }

  /** a place name without its preposition ("Market station", "north-west Ashcombe") */
  private place(x: number, y: number) { return this.sim.projects.placeName(x, y).replace(/^(near|in) /, ''); }

  /** what each choice takes from the city account: the arterial (after the regional fund's half), the transit street, nothing */
  costs(p: RoadProposal): [number, number, number] {
    const road = p.km * ROADPLAN.costKm, bridge = p.waterKm * ROADPLAN.bridgeKm, demol = p.buildings * ROADPLAN.demolish;
    return [(road + bridge + demol) * (1 - ROADPLAN.region), road * ROADPLAN.transitShare + bridge * 0.7 + demol, 0];
  }
  cost(id: number, k: number) { const p = this.list.find((q) => q.id === id); return p ? this.costs(p)[k] ?? 0 : 0; }

  nextDecision(): { id: string; title: string; text: string; choices: { label: string; detail: string }[] } | null {
    const id = this.queue[0];
    const p = this.list.find((q) => q.id === id);
    if (!p) { if (id !== undefined) this.queue.shift(); return null; }
    const [cA, cT] = this.costs(p);
    const M = (v: number) => `$${(v / 1e6).toFixed(1)}M`;
    const what = p.kind === 'bridge' ? `a bridge (${Math.round(p.waterKm * 1000)} m over the water)` : p.kind === 'bypass' ? 'a bypass round the old streets' : 'a new arterial';
    const why = [
      `${Math.round(p.trips).toLocaleString('en-US')} car and van trips a day between these two areas go the long way round today; the new link saves them ${p.savedMin < 1.5 ? 'about a minute' : `about ${p.savedMin.toFixed(0)} minutes`}.`,
      p.unlocked > 6 ? ` It would open up ${p.unlocked} cells of empty land along its way.` : '',
      p.terms.port ? ' It also gives the port and the works a shorter way out for lorries.' : '',
      p.buildings ? ` ${p.buildings} building${p.buildings > 1 ? 's' : ''} would come down.` : '',
      p.historicCells ? ' It cuts through the edge of the old town.' : '',
      p.terms.transit > 0.3 ? ` Transit already carries ${Math.round(p.terms.transit * 50)}% of the trips between them.` : '',
    ].join('');
    return {
      id: 'road_' + p.id,
      title: `${p.returning ? 'Again: ' : ''}${what[0].toUpperCase()}${what.slice(1)}, ${p.name}?`,
      text: `The highways department proposes ${what} from ${p.name}. ${why}<br><br>The department wants ${p.km.toFixed(1)} km of road. You can build it for cars, keep the same line for buses, trams, bikes and walkers only, or leave the streets as they are.`,
      choices: [
        { label: `Build the ${p.kind === 'bridge' ? 'road bridge' : p.kind === 'bypass' ? 'bypass' : 'arterial'}`, detail: `${M(cA)} from the city (the regional road fund pays the other half). Drivers save time; more people will drive.` },
        { label: p.kind === 'bridge' ? 'A bridge for buses, trams, bikes and walkers only' : 'A transit street: buses, trams, bikes and walkers only', detail: `${M(cT)}. No cars: buses run at full speed on it, a tram fits later, and walks to the stations get shorter.${p.kind === 'bridge' ? ' A bus stop at each end.' : ''}` },
        { label: 'No new road', detail: 'Nothing is built. The traffic stays as it is and the quarters at both ends lose some trust; the department will come back if the pressure grows.' },
      ],
    };
  }

  choose(id: number, k: number) {
    const sim = this.sim, p = this.list.find((q) => q.id === id);
    this.queue = this.queue.filter((q) => q !== id);
    if (!p) return;
    p.decided = sim.month;
    const cost = this.costs(p)[k] ?? 0;
    if (k === 2) {
      p.state = 'rejected';
      this.refused.set(p.a * ZONES + p.b, { month: sim.month, pressure: p.pressure });
      for (const [x, y] of [p.pts[0], p.pts[p.pts.length - 1]]) { const ar = sim.projects.areaOf(x, y); if (sim.projects.trust[ar] !== undefined) sim.projects.trust[ar] = Math.max(0.3, sim.projects.trust[ar] - 0.08); }
      this.log.push(`m${sim.month}\tproposal ${p.id}\trejected`);
      return;
    }
    sim.money -= cost; sim.buildSpend += cost;
    p.state = k === 0 ? 'arterial' : 'transit';
    this.build(p, k === 1);
    this.log.push(`m${sim.month}\tproposal ${p.id}\t${p.state}\t-${(cost / 1e6).toFixed(1)}M`);
  }

  /** clear the plots in the way, lay the street (arterial, or a collector kept for transit), cut frontage plots along it */
  private build(p: RoadProposal, transit: boolean) {
    const sim = this.sim, R = sim.roads;
    for (let s = 1; s < p.pts.length; s++) {
      const [x0, y0] = p.pts[s - 1], [x1, y1] = p.pts[s];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.4));
      for (let q = 0; q <= n; q++) {
        const x = x0 + (x1 - x0) * q / n, y = y0 + (y1 - y0) * q / n;
        for (const l of sim.lots.near(x, y, 0.6)) if (Math.hypot(l.x - x, l.y - y) < 0.55 && !l.lm) sim.lots.remove(l);
      }
    }
    const year = 2030 + Math.floor(sim.month / 12);
    R.polyline(p.pts, transit ? RC.Collector : RC.Arterial, year, 1.1);
    if (transit) {
      this.transitStreets.push(p.pts.map(([x, y]) => [x, y] as [number, number]));
      this.ncVersion = -1;
      this.refreshNoCars();
      if (p.kind === 'bridge') for (const [x, y] of [p.pts[0], p.pts[p.pts.length - 1]]) sim.metro.addStop(x + 0.05, y + 0.05, sim.g.water);
    }
    R.rasterize(sim.g.road);
    sim.lots.frontageAll(R.drainFresh());
    sim.refreshTransit();
  }

  /** the edges along the transit streets (both ends within 0.35 cells of one of their polylines) */
  private refreshNoCars() {
    const R = this.sim.roads;
    if (R.version === this.ncVersion) return;
    this.ncVersion = R.version;
    this.noCars.clear();
    if (!this.transitStreets.length) return;
    const dSeg = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      return Math.hypot(x - ax - dx * t, y - ay - dy * t);
    };
    const on = (n: number) => this.transitStreets.some((pl) => pl.some((_, s) => s > 0 && dSeg(R.nx[n], R.ny[n], pl[s - 1][0], pl[s - 1][1], pl[s][0], pl[s][1]) < 0.35));
    for (let e = 0; e < R.ea.length; e++) if (R.alive[e] && on(R.ea[e]) && on(R.eb[e])) this.noCars.add(e);
  }

  info() {
    return {
      proposals: this.list.map((p) => ({ id: p.id, kind: p.kind, state: p.state, name: p.name, pts: p.pts.flat(), pressure: p.pressure, km: p.km })),
      transitStreets: this.transitStreets.map((pl) => pl.flat()),
    };
  }
}
