/**
 * Development envelopes (round 7, step 2): zoning. Every cell belongs to one envelope that caps what may be built there; the density-and-height
 * field (field.ts) stays the measure of what the market would build, the envelope is a cap on top of it. The default city is low and mid-rise:
 *   historic core          2-4 floors, renovation and careful infill, no plot assembly
 *   outer residential      2-5 floors
 *   local centre / main st 4-8 floors, mixed use (arterial and collector frontage in the inner ring, the old villages' high streets)
 *   station growth district 6-15 floors, plot assembly allowed: only where the player's station area plan was approved
 *   CBD / landmark core    15+ on assembled major plots: a small core by the old town, sized by the CityProfile
 *   port / industrial      low sheds and yards
 *   protected old town     the historic core after a protection plan: 3 floors, no redevelopment, more visitors and value
 * A tower (36 m+) needs all of: an envelope that allows the height and plot assembly, high land value, major station access, demand in the
 * pool, and developer capital (`devCap`, refilled from the size of the city).
 *
 * The player's tool is the station area plan: propose upzoning the 8-minute walk of a station (or a CBD edge, or protecting the old town);
 * the council decides after a review. The outcome depends on the quarter's trust (projects.ts) and on local opposition (an old town or a
 * wealthy suburb pushes back, brownfield barely does); a doubtful plan comes back with conditions (only up to 8 floors, or only with a park),
 * a weak one is refused and can be tried again a year later. An approved plan pays the city a share of the value it creates (value capture:
 * a planning gain on every home or job added inside it). Data-driven: plan kinds are entries in PLAN_KINDS.
 */
import { N, BT, Flag, PERSONS_PER_HOME } from './constants';
import { T, TERR } from './territory';
import type { Sim } from './sim';
import type { Lot } from './lots';

export const ENV = { Outer: 0, Historic: 1, Main: 2, Station: 3, CBD: 4, Industrial: 5, Protected: 6 } as const;
export interface EnvDef { id: string; name: string; floors: string; maxH: number; assembly: boolean; color: [number, number, number] }
/** maxH in metres (0 = only the field decides); about 3.3 m a floor */
export const ENV_DEF: EnvDef[] = [
  { id: 'outer', name: 'Outer residential', floors: '2-5 floors', maxH: 17, assembly: false, color: [176, 196, 150] },
  { id: 'historic', name: 'Historic core', floors: '2-4 floors', maxH: 14, assembly: false, color: [200, 150, 100] },
  { id: 'main', name: 'Local centre / main street', floors: '4-8 floors, mixed use', maxH: 27, assembly: false, color: [222, 170, 92] },
  { id: 'station', name: 'Station growth district', floors: '6-15 floors', maxH: 50, assembly: true, color: [214, 96, 78] },
  { id: 'cbd', name: 'CBD / landmark core', floors: '15+ floors on assembled plots', maxH: 0, assembly: true, color: [150, 84, 150] },
  { id: 'industrial', name: 'Port / industrial', floors: 'sheds and yards', maxH: 15, assembly: false, color: [128, 136, 150] },
  { id: 'protected', name: 'Protected old town', floors: '3 floors, no redevelopment', maxH: 11, assembly: false, color: [176, 120, 72] },
];

/** dev switch: false = no envelopes (the field alone caps heights, as before round 7 step 2); `?noenv=1` */
export const ENVS = { on: true };

/** what the city pays out of each home or job added inside an approved plan (planning gain / betterment levy), $ */
export const CAPTURE_PER_UNIT = 10e3;

export type PlanKind = 'station' | 'cbd' | 'protect';
interface PlanKindDef { kind: PlanKind; title: string; to: number; cost: number; review: number; blurb: string }
export const PLAN_KINDS: PlanKindDef[] = [
  { kind: 'station', title: 'Station area plan', to: ENV.Station, cost: 3e6, review: 3, blurb: 'Upzone the streets within an 8-minute walk to a station growth district (6-15 floors, plots may be assembled).' },
  { kind: 'cbd', title: 'CBD edge plan', to: ENV.CBD, cost: 5e6, review: 4, blurb: 'Extend the business core over the station area: towers on assembled plots.' },
  { kind: 'protect', title: 'Protect the old town', to: ENV.Protected, cost: 2e6, review: 3, blurb: 'Freeze the historic core at three floors: more visitors and higher value, less room to grow.' },
];

export interface Plan {
  id: number; kind: PlanKind; station: number; name: string; x: number; y: number; area: number;
  state: 'review' | 'conditions' | 'approved' | 'refused' | 'withdrawn';
  month: number; decided: number; cells: number[];
  /** approved height cap (m, 0 = the envelope's own) and whether a park was a condition */
  cap: number; park: boolean;
  /** the council's verdict (0..1) and why */
  score: number; why: string;
  /** capacity (homes + jobs) inside the plan when it was approved, the highest seen since, and what it has paid */
  base: number; peak: number; paid: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const M = (v: number) => `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;

export class EnvelopeSystem {
  env = new Uint8Array(N * N);
  /** plan id + 1 that owns the cell (0 = the default rules apply) */
  lock = new Uint16Array(N * N);
  plans: Plan[] = [];
  /** developer capital, in homes + jobs of floor space that can be financed in towers (refilled each month) */
  devCap = 0;
  /** value capture paid this month ($) */
  capture = 0;
  /** the envelope a cell had before a plan changed it (value capture counts only the floors above what that allowed) */
  prior = new Uint8Array(N * N);
  /** conditional approvals waiting for the player's answer */
  queue: number[] = [];
  private nextId = 1;
  constructor(private sim: Sim) {}

  /** CBD radius (cells) by city type: an old port stays low with few exceptions, a planned capital has a broader core */
  private cbdR() {
    const cp = this.sim.cp;
    const base = cp.origin === 'planned-capital' ? 3.4 : cp.origin === 'rail-junction' ? 2.8 : cp.origin === 'port' ? 2.4 : cp.origin === 'mining' ? 1.8 : 2.2;
    return base + cp.wealth * 0.8 + Math.min(1.5, Math.sqrt(this.sim.homes * PERSONS_PER_HOME / 1000) * 0.08);
  }

  /** The starting envelopes (and the default for land that is not under a plan, re-read once a year as the city spreads). */
  defaults() {
    const sim = this.sim, g = sim.g, terr = sim.town.terr, main = sim.field.main;
    const cbdR = this.cbdR();
    const planned = sim.cp.origin === 'planned-capital' || sim.cp.history.some((h) => h.kind === 'planned');
    const innerR = sim.field.mainR * (planned ? 1.9 : 1.45);
    // high streets: frontage of arterials and collectors (g.road: 3 arterial, 2 collector)
    const front = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N) best = Math.max(best, g.road[yy * N + xx]);
      }
      front[y * N + x] = best;
    }
    const vs = sim.g.villages;
    for (let i = 0; i < N * N; i++) {
      if (this.lock[i]) continue;
      const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
      const t = TERR.on ? terr[i] : 0;
      const dm = Math.hypot(x - main.x, y - main.y);
      let e: number = ENV.Outer;
      // nearest settlement centre: the old town's core is historic, an old village's core is its local centre
      let nv = 0, nd = Infinity;
      for (let k = 0; k < vs.length; k++) { const d = Math.hypot(x - vs[k].x, y - vs[k].y); if (d < nd) { nd = d; nv = k; } }
      // the old docks: a working port until the redevelopment deal sets its envelope (high density = a growth district)
      if ((g.flags[i] & Flag.Docks) && sim.docks.deal) e = sim.docks.deal.density === 'high' ? ENV.Station : sim.docks.deal.density === 'mid' ? ENV.Main : ENV.Outer;
      else if (t === T.Port || t === T.Industry || (g.flags[i] & Flag.Docks)) e = ENV.Industrial;
      // the business core forms at the flank of the old town (field.ts main); its historic plots stay historic (lot pass below)
      else if (dm < cbdR) e = ENV.CBD;
      else if (t === T.Core) e = nv === 0 ? ENV.Historic : ENV.Main;
      else {
        // a main street: a collector or arterial frontage in the inner ring, or the high street of an old village (within 7 cells of its centre)
        let village = false;
        for (let k = 1; k < vs.length; k++) if (Math.hypot(x - vs[k].x, y - vs[k].y) < 7) { village = true; break; }
        const inner = dm < innerR * 1.6 || t === T.Inner;
        if ((front[i] >= 2 && (inner || village)) || (planned && front[i] >= 3 && dm < innerR * 2.2)) e = ENV.Main;
      }
      this.env[i] = e;
    }
    // core plots are historic wherever the territory raster has not caught up
    for (const l of sim.lots.lots) if (l.alive && (l.flags & Flag.Core) && !this.lock[l.cell]) this.env[l.cell] = ENV.Historic;
  }

  /** height cap (m) at a cell, 0 = none (the field decides) */
  capAt(i: number): number {
    if (!ENVS.on) return 0;
    const lk = this.lock[i];
    if (lk) { const p = this.plans[lk - 1]; if (p && p.cap > 0) return p.cap; }
    return ENV_DEF[this.env[i]].maxH;
  }
  /** may a plot here be part of an assembled tower site? */
  assemblyAt(i: number) { if (!ENVS.on) return true; const c = this.capAt(i); return ENV_DEF[this.env[i]].assembly && (c === 0 || c >= 36); }
  /** no redevelopment of standing buildings (protected old town) */
  frozen(l: Lot) { return ENVS.on && this.env[l.cell] === ENV.Protected && l.level > 0; }

  /**
   * Everything a tower needs besides the pool: an envelope that allows the height and assembly, high land value, major station access
   * and developer capital for the floor space it adds.
   */
  towerOk(l: Lot, h: number, add: number): boolean {
    if (!ENVS.on) return true;
    const i = l.cell, cap = this.capAt(i);
    if (!this.assemblyAt(i) || (cap > 0 && cap < h)) return false;
    const sim = this.sim;
    if (sim.fieldAt(sim.lvS, l.x, l.y) < 0.62) return false;
    if (sim.accCell[i] < 0.35) return false;
    return this.devCap >= add;
  }
  /** a tower started: it draws on developer capital */
  spend(add: number) { this.devCap = Math.max(0, this.devCap - add); }

  /** cells within an 8-minute walk of a station (matrix index k) */
  private walkCells(k: number): number[] {
    const f = this.sim.walk[k], out: number[] = [];
    if (!f) return out;
    for (let i = 0; i < N * N; i++) if (f[i] <= 8 && !this.sim.g.water[i]) out.push(i);
    return out;
  }

  /** what an area holds and what it could hold under an envelope cap (homes + jobs), and the opposition / support it meets */
  survey(cells: number[], toCap: number) {
    const sim = this.sim, set = new Set(cells);
    let now = 0, could = 0, hist = 0, wealthy = 0, brown = 0, n = 0;
    for (const l of sim.lots.lots) {
      if (!l.alive || !set.has(l.cell) || l.type === BT.Park || l.type === BT.Square || l.type === BT.Landmark) continue;
      n++;
      const cur = l.type === BT.Res ? sim.lotHomes(l) : sim.lotJobs(l);
      now += cur;
      const fh = sim.field.hmaxAt(l.x, l.y), h = toCap > 0 ? Math.min(toCap, Math.max(fh, 20)) : Math.max(fh, 36);
      const kind = l.type === BT.Com || l.type === BT.Ind ? BT.Com : BT.Res;
      could += Math.max(cur, sim.capacity(l, kind, h >= 24 ? 3 : 2, Math.round(h)));
      const e = this.env[l.cell];
      if (e === ENV.Historic || e === ENV.Protected || (l.flags & Flag.Core)) hist++;
      else if (l.type === BT.Res && l.level === 1 && sim.lvS[l.cell] > 0.55) wealthy++;
      else if (!l.type || l.type === BT.Ind || e === ENV.Industrial) brown++;
    }
    const k = Math.max(1, n);
    return { now, could, hist: hist / k, wealthy: wealthy / k, brown: brown / k, lots: n };
  }

  /** Propose a plan (player command). Returns a message for the ticker. */
  propose(stationId: number, kind: PlanKind): string {
    const sim = this.sim, m = sim.metro, st = m.station(stationId), def = PLAN_KINDS.find((p) => p.kind === kind);
    if (!st || !def) return 'No such station';
    const k = m.sIndex.get(st.id);
    if (k === undefined) return `${st.name} is not on a line yet: a plan needs a working station`;
    if (this.plans.some((p) => p.station === st.id && p.kind === kind && (p.state === 'review' || p.state === 'conditions' || p.state === 'approved'))) return `${st.name} already has a ${def.title.toLowerCase()}`;
    const last = this.plans.filter((p) => p.station === st.id && p.kind === kind && p.state === 'refused').pop();
    if (last && sim.month < last.decided + 12) return `The council refused this plan ${sim.month - last.decided} months ago: try again in ${last.decided + 12 - sim.month} months`;
    if (sim.money < def.cost) return `${def.title} costs ${M(def.cost)}: not enough money`;
    let cells = this.walkCells(k);
    if (kind === 'protect') {
      cells = [];
      for (let i = 0; i < N * N; i++) if (this.env[i] === ENV.Historic && !this.lock[i]) cells.push(i);
      if (!cells.length) return 'There is no unprotected historic core';
    } else {
      // a station plan never takes over the historic core or the working port; a CBD edge needs the core nearby
      cells = cells.filter((i) => this.env[i] !== ENV.Historic && this.env[i] !== ENV.Protected && this.env[i] !== ENV.Industrial && !this.lock[i]);
      if (kind === 'cbd') {
        const main = sim.field.main;
        if (Math.hypot(st.x - main.x, st.y - main.y) > this.cbdR() + 9) return `${st.name} is too far from the business core for a CBD edge`;
      }
      if (cells.length < 6) return `${st.name}: no land within its walk that a plan could change`;
    }
    sim.money -= def.cost; sim.buildSpend += def.cost;
    const p: Plan = { id: this.nextId++, kind, station: st.id, name: st.name, x: st.x, y: st.y, area: sim.projects.areaOf(st.x, st.y), state: 'review', month: sim.month, decided: -1, cells, cap: 0, park: false, score: 0, why: '', base: 0, peak: 0, paid: 0 };
    this.plans.push(p);
    for (const i of cells) if (!this.lock[i]) this.lock[i] = p.id;
    sim.say(`${def.title} for ${st.name} submitted to the council (${M(def.cost)}, decision in about ${def.review} months)`);
    return 'ok';
  }

  /** the council's verdict: trust in the quarter, opposition (old town, wealthy suburb) against support (brownfield, a busy station) */
  private verdict(p: Plan) {
    const sim = this.sim, st = sim.metro.station(p.station);
    const def = PLAN_KINDS.find((d) => d.kind === p.kind)!;
    const sv = this.survey(p.cells, ENV_DEF[def.to].maxH);
    const trust = sim.projects.trust[p.area] ?? 1;
    if (p.kind === 'protect') {
      // protection is popular with residents, opposed by developers in a growing city
      const score = clamp(0.62 + 0.3 * (trust - 1) - Math.min(0.25, sim.resDemand * 0.15) , 0, 1);
      return { score, why: score >= 0.6 ? 'residents and the civic society back it' : 'developers lobby against it in a growing city', sv };
    }
    const riders = st ? st.riders : 0;
    const opp = 0.75 * sv.hist + 0.45 * sv.wealthy;
    const sup = 0.3 * sv.brown + Math.min(0.2, riders / 25000) + (p.kind === 'cbd' ? -0.08 : 0);
    const score = clamp(0.5 + 0.35 * (trust - 1) - opp + sup, 0, 1);
    const why = [sv.hist > 0.15 ? 'the old town objects' : '', sv.wealthy > 0.2 ? 'house owners in the suburb object' : '', sv.brown > 0.25 ? 'most of it is brownfield or empty land' : '',
      riders > 4000 ? 'the station is busy' : riders < 800 ? 'few people use the station yet' : '', trust < 0.8 ? 'the quarter remembers broken promises' : trust > 1.15 ? 'the quarter trusts the council' : ''].filter(Boolean).join('; ');
    return { score, why: why || 'no strong feelings either way', sv };
  }

  private approve(p: Plan, cap: number, park: boolean) {
    const sim = this.sim, def = PLAN_KINDS.find((d) => d.kind === p.kind)!;
    p.state = 'approved'; p.decided = sim.month; p.cap = cap; p.park = park;
    for (const i of p.cells) { if (this.lock[i] === p.id || !this.lock[i]) { this.lock[i] = p.id; this.prior[i] = this.env[i]; this.env[i] = def.to; } }
    p.base = this.survey(p.cells, 0).now; p.peak = p.base;
    if (park) {
      // the condition: a few empty plots nearest the station become a public park
      const set = new Set(p.cells);
      const free = sim.lots.lots.filter((l) => l.alive && !l.type && !l.asm && !l.flags && set.has(l.cell)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y) || a.id - b.id).slice(0, 4);
      for (const l of free) { l.type = BT.Park; l.level = 1; }
    }
    const capTxt = cap > 0 ? ` up to ${Math.round(cap / 3.3)} floors` : '';
    sim.moment('news', p.kind === 'protect' ? 'The old town is protected' : `${p.name}: plan approved${capTxt}`,
      p.kind === 'protect' ? 'Three floors, no demolition. Visitors and value rise; the core will not grow.' : `Developers may now build${cap > 0 ? capTxt : ' 6-15 floors'} within an 8-minute walk of ${p.name}${park ? ', round a new park' : ''}. The city takes a share of the value it creates.`,
      '#2f7d5a', p.x, p.y, false, `plan:${p.id}`);
    sim.say(`${def.title} for ${p.name} approved${capTxt}${park ? ' with a park' : ''}`);
  }

  /** a conditional approval as a City hall decision (sim.checkEvents turns it into a dialog) */
  nextDecision(): { id: string; title: string; text: string; choices: { label: string; detail: string }[] } | null {
    while (this.queue.length) {
      const p = this.plans.find((q) => q.id === this.queue[0]);
      if (!p || p.state !== 'conditions') { this.queue.shift(); continue; }
      return {
        id: `plan_${p.id}`, title: `The council will approve the ${p.name} plan, with conditions`,
        text: `After the hearings (${p.why}) the planning committee will not approve 6-15 floors round ${p.name} as asked. It offers two ways forward.`,
        choices: [
          { label: 'Accept: only up to 8 floors', detail: 'Mid-rise blocks within the 8-minute walk; no towers.' },
          { label: 'Accept: full height, with a park', detail: 'Up to 15 floors, and four plots next to the station become a public park.' },
          { label: 'Withdraw the plan', detail: 'Nothing changes; the planning fee is spent.' },
        ],
      };
    }
    return null;
  }
  choose(id: number, k: number) {
    const p = this.plans.find((q) => q.id === id);
    this.queue = this.queue.filter((q) => q !== id);
    if (!p || p.state !== 'conditions') return;
    if (k === 0) this.approve(p, 27, false);
    else if (k === 1) this.approve(p, 0, true);
    else { p.state = 'withdrawn'; p.decided = this.sim.month; for (const i of p.cells) if (this.lock[i] === p.id) this.lock[i] = 0; this.sim.say(`${p.name} plan withdrawn`); }
  }

  tick() {
    const sim = this.sim;
    // developer capital: about 1.2% of the city's floor space a month can be financed in towers, saved up for a year at most
    const stock = sim.homes + sim.jobs;
    this.devCap = Math.min(this.devCap + stock * 0.012, stock * 0.15 + 400);
    if (sim.month % 12 === 1) this.defaults();
    // reviews
    for (const p of this.plans) {
      if (p.state !== 'review') continue;
      const def = PLAN_KINDS.find((d) => d.kind === p.kind)!;
      if (sim.month < p.month + def.review) continue;
      const v = this.verdict(p);
      p.score = v.score; p.why = v.why;
      if (v.score >= 0.6) this.approve(p, 0, false);
      else if (v.score >= 0.36 && p.kind !== 'protect') { p.state = 'conditions'; this.queue.push(p.id); }
      else {
        p.state = 'refused'; p.decided = sim.month;
        for (const i of p.cells) if (this.lock[i] === p.id) this.lock[i] = 0;
        sim.moment('news', `${p.name}: plan refused`, `The council turned the plan down (${v.why}). It can be submitted again in a year; trust in the quarter helps.`, '#c0503a', p.x, p.y, false, `plan:${p.id}`);
        sim.say(`${def.title} for ${p.name} refused: ${v.why}`);
      }
    }
    // what the approved plans hold now (for the station card); the value capture itself is paid as buildings complete (onBuilt)
    for (const p of this.plans) if (p.state === 'approved' && p.kind !== 'protect' && sim.month % 3 === 0) p.peak = Math.max(p.peak, this.survey(p.cells, 0).now);
  }

  /** start of a month: last month's value capture has been booked by finance() */
  resetCapture() { this.capture = 0; }
  /**
   * A building finished: inside an approved plan the city takes a planning gain on the floor space above what the old envelope allowed
   * (the uplift the upzoning created), CAPTURE_PER_UNIT per home or job of it.
   */
  onBuilt(l: Lot) {
    if (!ENVS.on || !this.lock[l.cell] || l.level < 2) return;
    const p = this.plans[this.lock[l.cell] - 1];
    if (!p || p.state !== 'approved' || p.kind === 'protect') return;
    const sim = this.sim, h = l.hgt || 12, was = ENV_DEF[this.prior[l.cell]].maxH;
    if (!was || h <= was) return;
    const units = l.type === BT.Res ? sim.lotHomes(l) : sim.lotJobs(l);
    const g = units * (1 - was / h) * CAPTURE_PER_UNIT;
    this.capture += g; p.paid += g;
  }

  /** for the HUD and the station card */
  infos() {
    return this.plans.map((p) => ({ id: p.id, kind: p.kind, station: p.station, name: p.name, state: p.state, month: p.month, decided: p.decided, cap: p.cap, park: p.park, score: p.score, why: p.why, paid: p.paid, added: Math.max(0, p.peak - p.base), x: p.x, y: p.y }));
  }

  /** what each plan kind would do at a station: cost, capacity now and under the plan, a ridership estimate, the likely reception */
  preview(stationId: number) {
    const sim = this.sim, m = sim.metro, st = m.station(stationId), k = st ? m.sIndex.get(st.id) : undefined;
    if (!st || k === undefined) return null;
    const cells = this.walkCells(k).filter((i) => this.env[i] !== ENV.Historic && this.env[i] !== ENV.Protected && this.env[i] !== ENV.Industrial);
    const main = sim.field.main, nearCore = Math.hypot(st.x - main.x, st.y - main.y) <= this.cbdR() + 9;
    const out = PLAN_KINDS.filter((d) => d.kind !== 'protect' && (d.kind !== 'cbd' || nearCore)).map((d) => {
      const sv = this.survey(cells, ENV_DEF[d.to].maxH);
      const svNow = this.survey(cells, 0);
      const trust = sim.projects.trust[sim.projects.areaOf(st.x, st.y)] ?? 1;
      const score = clamp(0.5 + 0.35 * (trust - 1) - 0.75 * sv.hist - 0.45 * sv.wealthy + 0.3 * sv.brown + Math.min(0.2, st.riders / 25000) + (d.kind === 'cbd' ? -0.08 : 0), 0, 1);
      // riders per resident at this station now, applied to the extra residents (jobs count as a third of a trip end)
      const resNow = Math.max(1, svNow.now * PERSONS_PER_HOME);
      const perRes = st.riders / resNow;
      return { kind: d.kind, title: d.title, cost: d.cost, blurb: d.blurb, now: svNow.now, could: sv.could, riders: Math.round(st.riders + Math.max(0, sv.could - svNow.now) * PERSONS_PER_HOME * perRes * 0.8), odds: score >= 0.6 ? 'likely' : score >= 0.36 ? 'with conditions' : 'unlikely' };
    });
    const env = cells.length ? this.env[cells[0]] : this.env[Math.floor(st.y) * N + Math.floor(st.x)];
    return { station: st.id, env: ENV_DEF[this.env[Math.floor(st.y) * N + Math.floor(st.x)]].name, envAround: ENV_DEF[env].name, kinds: out, plans: this.infos().filter((p) => p.station === st.id) };
  }
}
