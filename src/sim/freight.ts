/**
 * Freight (round 7, step 10). Goods move by lorry between the industry and the port and the rest of the world (through the motorway
 * junction when there is one, else the nearest road portal), and from them to every workplace and home as deliveries (6 vans or lorries a
 * day per 100 jobs, 1.5 per 100 homes). They are not residents' trips: they are counted apart and loaded on the streets at 2 cars each (a
 * mix of vans and lorries), with their own peak share (deliveries spread over
 * the day more than commuting). The player's levers come as City hall decisions:
 *
 *   a rail freight yard   on the railway near the port or the industry: the regional freight of the zones around it goes to the yard
 *                         instead of out over the roads (the city pays the sidings; the operator pays track access per load)
 *   old-town deliveries   when lorries crowd the historic core: deliveries at night (the lorries leave the peak; the shops grumble),
 *                         or a consolidation centre at the edge of the core (small electric vans: a fifth of the street load), or nothing
 *
 * `FREIGHT.on = false` turns freight off.
 */
import { N, ZONE, NZ, ZONES, CELL } from './constants';
import { ENV } from './envelopes';
import type { Sim } from './sim';

export const FREIGHT = {
  on: true,
  /** lorries a day per industrial plot level, and per port plot level (docks cells) */
  perInd: 1.1, perPort: 2.2,
  /** delivery vans / lorries a day per 100 jobs and per 100 homes (shops, offices, parcels) */
  perJobs: 6, perHomes: 1.5,
  /** share of industrial and port freight that goes to or comes from outside the city */
  regionShare: 0.6,
  pcu: 2.0, peak: 0.08,
  decay: 4,
  yard: { cost: 18e6, radius: 24, share: 0.7, feePerLoad: 25, needLorries: 600 },
  core: { needLorries: 300, needCong: 0.4, fromMonth: 48, consolidationCost: 8e6, consolidationMonth: 0.1e6, vanFactor: 0.2, nightPeak: 0.25,
    /** deliveries in the morning peak hour (share of the day's), and the peak-hour deliveries in a zone that halve its lanes' capacity
     *  (vans double-parked in narrow streets) */
    peakShare: 0.12, blockRef: 40 },
};

export class FreightSystem {
  stats = { lorries: 0, region: 0, local: 0, rail: 0, core: 0, fees: 0, coreCong: 0 };
  yard: { x: number; y: number; zone: number; ang: number; opened: number } | null = null;
  coreRule: 'none' | 'night' | 'consolidation' = 'none';
  private asked = { yard: -99, core: -99 };
  private queue: string[] = [];
  private coreZones = new Set<number>();
  /** per zone: the factor on the capacity of its local streets and collectors from deliveries at the kerb (1 = none), old town only */
  laneMul = new Float32Array(ZONES).fill(1);
  constructor(private sim: Sim) {}

  private zoneAt(x: number, y: number) { return Math.min(NZ - 1, Math.max(0, Math.floor(y / ZONE))) * NZ + Math.min(NZ - 1, Math.max(0, Math.floor(x / ZONE))); }

  /** zones that are mostly historic core (old-town delivery rules apply there) */
  private refreshCore() {
    const sim = this.sim, n = new Float64Array(ZONES), h = new Float64Array(ZONES);
    for (let i = 0; i < N * N; i++) { const z = sim.zoneOf(i); if (sim.cHomes[i] + sim.cJobs[i] > 0) { n[z]++; if (sim.envs.env[i] === ENV.Historic || sim.envs.env[i] === ENV.Protected) h[z]++; } }
    this.coreZones.clear();
    for (let z = 0; z < ZONES; z++) if (n[z] > 4 && h[z] / n[z] > 0.35) this.coreZones.add(z);
  }

  /** where regional freight leaves the city: the motorway junction if open, else the nearest road portal (else the nearest rail portal) */
  private exitZone(x: number, y: number): number {
    const sim = this.sim;
    const mw = sim.gateways.list.find((g) => g.id === 'motorway');
    if (mw) return mw.zone;
    const ps = sim.regional.portals.filter((p) => p.kind === 'road');
    const pool = ps.length ? ps : sim.regional.portals;
    if (!pool.length) return -1;
    return pool.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0].zone;
  }

  /** this month's lorries into sim.demand.pFreight (lorries a day by zone pair, both directions) */
  compute() {
    const sim = this.sim, pf = sim.demand.pFreight;
    pf.fill(0);
    this.stats = { lorries: 0, region: 0, local: 0, rail: 0, core: 0, fees: 0, coreCong: 0 };
    if (!FREIGHT.on) return;
    if (sim.month % 12 === 0) this.refreshCore();
    // generators: industry and the port
    const gen = new Float64Array(ZONES);
    const port = new Set(sim.g.docksCells);
    for (let i = 0; i < N * N; i++) if (sim.cInd[i]) gen[sim.zoneOf(i)] += sim.cInd[i] * (port.has(i) ? FREIGHT.perPort : FREIGHT.perInd);
    // destinations of local deliveries
    const att = new Float64Array(ZONES);
    let attSum = 0;
    for (let z = 0; z < ZONES; z++) { att[z] = sim.zJobs[z] + 0.3 * sim.zHomes[z]; attSum += att[z]; }
    const add = (a: number, b: number, v: number) => { if (a < 0 || b < 0 || a === b || v <= 0) return; pf[a < b ? a * ZONES + b : b * ZONES + a] += v; };
    const cz = (z: number) => [((z % NZ) + 0.5) * ZONE, (((z / NZ) | 0) + 0.5) * ZONE];
    let core = 0;
    const zDel = new Float64Array(ZONES);
    const coreF = this.coreRule === 'consolidation' ? FREIGHT.core.vanFactor : this.coreRule === 'night' ? FREIGHT.core.nightPeak : 1;
    for (let a = 0; a < ZONES; a++) {
      const G = gen[a];
      if (G <= 0) continue;
      const [ax, ay] = cz(a);
      // regional freight: out through the exit, or to the rail yard when one serves this zone
      const R = G * FREIGHT.regionShare;
      const yd = this.yard && Math.hypot(this.yard.x - ax, this.yard.y - ay) <= FREIGHT.yard.radius ? this.yard : null;
      if (yd) { const r = R * FREIGHT.yard.share; add(a, yd.zone, r); this.stats.rail += r; add(a, this.exitZone(ax, ay), R - r); }
      else add(a, this.exitZone(ax, ay), R);
      this.stats.region += R;
      // local: to workplaces and homes, with distance decay
      const L = G - R;
      let s = 0;
      const w = new Float64Array(ZONES);
      for (let b = 0; b < ZONES; b++) { if (att[b] <= 0 || b === a) continue; const [bx, by] = cz(b); w[b] = att[b] * Math.exp(-Math.hypot(bx - ax, by - ay) * CELL / 1000 / FREIGHT.decay); s += w[b]; }
      if (s > 0) for (let b = 0; b < ZONES; b++) {
        if (w[b] <= 0) continue;
        let v = L * w[b] / s;
        if (this.coreZones.has(b)) { core += v; zDel[b] += v; v *= coreF; }
        add(a, b, v);
      }
      this.stats.local += L;
    }
    // deliveries to shops, offices and homes from the wholesale belt (the industrial zones, or the city centre when there is none)
    let indSum = 0;
    for (let z = 0; z < ZONES; z++) indSum += gen[z];
    const dTot = (sim.jobs * FREIGHT.perJobs + sim.homes * FREIGHT.perHomes) / 100;
    if (dTot > 0 && attSum > 0) for (let b = 0; b < ZONES; b++) {
      if (att[b] <= 0) continue;
      const v0 = dTot * att[b] / attSum;
      let v = v0;
      if (this.coreZones.has(b)) { core += v; zDel[b] += v; v *= coreF; }
      if (indSum > 0) for (let a = 0; a < ZONES; a++) { if (gen[a] > 0) add(a, b, v * gen[a] / indSum); }
      else add(sim.zoneOf(Math.floor(sim.centre.y) * N + Math.floor(sim.centre.x)), b, v);
      this.stats.local += v0;
    }
    // the gateways' cargo: lorries from each gateway to the industrial zones (by rail into the yard for the zones it serves)
    for (const g of sim.gateways.list) {
      const t = (g as { stats: { cargo: number } }).stats.cargo;
      if (t <= 0 || indSum <= 0) continue;
      for (let a = 0; a < ZONES; a++) {
        if (gen[a] <= 0) continue;
        const v = t * gen[a] / indSum, [ax, ay] = cz(a);
        if (this.yard && Math.hypot(this.yard.x - ax, this.yard.y - ay) <= FREIGHT.yard.radius) { const r = v * FREIGHT.yard.share; add(this.yard.zone, a, r); add(g.zone, a, v - r); this.stats.rail += r; }
        else add(g.zone, a, v);
      }
      this.stats.region += t;
    }
    // vans and lorries unloading at the kerb in the old town's narrow streets take capacity from them in the peak hour
    this.laneMul.fill(1);
    for (const z of this.coreZones) this.laneMul[z] = 1 / (1 + zDel[z] * FREIGHT.core.peakShare * coreF / FREIGHT.core.blockRef);
    // congestion inside the old town (where the delivery rule acts)
    let cc = 0, cn = 0;
    for (const z of this.coreZones) { cc += sim.zCong[z]; cn++; }
    this.stats.coreCong = cn ? cc / cn : 0;
    this.stats.lorries = this.stats.region + this.stats.local;
    this.stats.core = core;
    this.stats.fees = this.stats.rail * FREIGHT.yard.feePerLoad * 30;
    this.check();
  }

  /** a decision when the conditions hold: the rail yard (a railway near busy freight), the old-town delivery rule (lorries in the core) */
  private check() {
    const sim = this.sim;
    if (!this.yard && this.stats.region > FREIGHT.yard.needLorries && sim.g.rail.length && sim.month - this.asked.yard > 36 && !this.queue.includes('yard') && this.yardSite()) { this.queue.push('yard'); this.asked.yard = sim.month; }
    if (this.coreRule === 'none' && this.stats.core > FREIGHT.core.needLorries && this.stats.coreCong > FREIGHT.core.needCong && sim.month >= FREIGHT.core.fromMonth && sim.month - this.asked.core > 36 && !this.queue.includes('core')) { this.queue.push('core'); this.asked.core = sim.month; }
  }

  /** the railway point nearest the centre of the freight generators, within 10 cells of it */
  private yardSite(): { x: number; y: number; ang: number } | null {
    const sim = this.sim;
    let gx = 0, gy = 0, gw = 0;
    const port = new Set(sim.g.docksCells);
    for (let i = 0; i < N * N; i++) if (sim.cInd[i]) { const w = sim.cInd[i] * (port.has(i) ? 2 : 1); gx += (i % N + 0.5) * w; gy += (((i / N) | 0) + 0.5) * w; gw += w; }
    if (!gw) return null;
    gx /= gw; gy /= gw;
    let best: { x: number; y: number; ang: number; d: number } | null = null;
    for (const pl of sim.g.rail) for (let k = 1; k < pl.length; k++) {
      const [ax, ay] = pl[k - 1], [bx, by] = pl[k];
      for (let q = 0; q <= 4; q++) { const x = ax + (bx - ax) * q / 4, y = ay + (by - ay) * q / 4, d = Math.hypot(x - gx, y - gy); if (!best || d < best.d) best = { x, y, ang: Math.atan2(by - ay, bx - ax), d }; }
    }
    return best && best.d <= 10 ? best : null;
  }

  nextDecision(): { id: string; title: string; text: string; choices: { label: string; detail: string }[] } | null {
    const id = this.queue[0];
    if (!id) return null;
    const M = (v: number) => `$${(v / 1e6).toFixed(0)}M`;
    if (id === 'yard') {
      const s = this.yardSite();
      if (!s) { this.queue.shift(); return null; }
      const near = Math.round(this.stats.region * FREIGHT.yard.share * 0.6);
      return {
        id: 'frt_yard', title: 'A rail freight yard by the works?',
        text: `${Math.round(this.stats.region).toLocaleString('en-US')} lorries a day carry the port's and the works' goods out of the city over the arterials. A freight operator offers to run trains from a yard on the railway ${this.sim.projects.placeName(s.x, s.y)}, if the city lays the sidings. Most of the regional freight within about 1.2 km of the yard would go by train (roughly ${near.toLocaleString('en-US')} lorries a day fewer on the way out), and the operator pays track access for every load.`,
        choices: [
          { label: 'Build the freight yard', detail: `${M(FREIGHT.yard.cost)}. Fewer lorries on the arterials to the edge of the city; $${FREIGHT.yard.feePerLoad} a load in track access.` },
          { label: 'Not now', detail: 'The lorries keep using the roads. The operator may ask again in a few years.' },
        ],
      };
    }
    return {
      id: 'frt_core', title: 'Lorries in the old town',
      text: `About ${Math.round(this.stats.core).toLocaleString('en-US')} delivery lorries and vans a day squeeze through the old town's lanes, most of them at the busiest hours, and while they unload at the kerb the lanes carry ${Math.round((1 - Math.min(...[...this.coreZones].map((z) => this.laneMul[z]), 1)) * 100)}% less traffic (buses included). The shopkeepers want their deliveries; the residents want the lanes back.`,
      choices: [
        { label: 'Deliveries at night only', detail: 'Free. Three in four of these lorries leave the rush hour; the shops grumble (trust falls a little in the old town).' },
        { label: 'A consolidation centre at the edge of the old town', detail: `${M(FREIGHT.core.consolidationCost)} and $${(FREIGHT.core.consolidationMonth / 1e3).toFixed(0)}k a month. Goods are sorted onto small electric vans: a fifth of the street load.` },
        { label: 'Leave it', detail: 'Nothing changes; the question will come back if it gets worse.' },
      ],
    };
  }

  cost(id: string, k: number) {
    if (id === 'yard' && k === 0) return FREIGHT.yard.cost;
    if (id === 'core' && k === 1) return FREIGHT.core.consolidationCost;
    return 0;
  }

  choose(id: string, k: number) {
    const sim = this.sim;
    this.queue = this.queue.filter((q) => q !== id);
    if (id === 'yard' && k === 0) {
      const s = this.yardSite();
      if (!s) return;
      sim.money -= FREIGHT.yard.cost; sim.buildSpend += FREIGHT.yard.cost;
      this.yard = { x: s.x, y: s.y, ang: s.ang, zone: this.zoneAt(s.x, s.y), opened: sim.month };
      sim.say(`Rail freight yard built ${sim.projects.placeName(s.x, s.y)}`);
    }
    if (id === 'core') {
      if (k === 0) {
        this.coreRule = 'night';
        // the shops grumble: trust in the old town's quarter falls a little
        const o = sim.g.villages[0], ar = sim.projects.areaOf(o.x, o.y);
        if (sim.projects.trust[ar] !== undefined) sim.projects.trust[ar] = Math.max(0.3, sim.projects.trust[ar] - 0.05);
      } else if (k === 1) {
        this.coreRule = 'consolidation';
        sim.money -= FREIGHT.core.consolidationCost; sim.buildSpend += FREIGHT.core.consolidationCost;
      }
    }
  }

  /** monthly money: track access from the yard in, the consolidation centre out */
  finance(): number { return this.stats.fees - (this.coreRule === 'consolidation' ? FREIGHT.core.consolidationMonth : 0); }

  info() { return { ...this.stats, yard: this.yard ? { x: this.yard.x, y: this.yard.y, ang: this.yard.ang } : null, coreRule: this.coreRule }; }
}
