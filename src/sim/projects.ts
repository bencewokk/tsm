/**
 * Dynamic, repeatable development projects (round 5 task 4).
 *
 * Every project TYPE is a data entry (PROJECT_TYPES below): a site finder, a trigger threshold on the city state at the site,
 * gates on the whole city (population, month, rating, money, demand), a cooldown, a monthly probability and a limit per area.
 * The same type fires again and again in different places, as often as the conditions allow. Each firing is an INSTANCE with its own
 * site, phase and outcome; several run at once. Instances go through the plot assembly pipeline (assembly.ts: hoardings -> demolition ->
 * site cleared, streets closed or rerouted -> foundations -> structure -> facade -> opening, with public space as plaza plots).
 *
 * Choices carry forward: deal terms (money, density, a service promise with a deadline, car-lock when unserved, clawbacks),
 * per-area TRUST (kept promises raise it, broken ones lower it; it scales every later deal in that area) and developer INTEREST
 * (good service and kept promises attract more proposals there; declines and broken promises scare developers off).
 * Text comes from templates filled with real place names and numbers, with words chosen by the CityProfile (site kind, history layers).
 * Pacing: a global budget of active projects, a minimum gap between new ones, a queue of decisions shown one at a time.
 */
import { BT, Flag, N, PERSONS_PER_HOME } from './constants';
import { hash01 } from './profiles';
import { T, TERR } from './territory';
import { LANDMARKS } from './landmarks';
import type { Sim } from './sim';
import type { Lot } from './lots';
import type { AsmPlan } from './assembly';
import type { Requires } from './events';

export type Finder = 'pressure' | 'station' | 'vacant' | 'aged' | 'industry' | 'waterfront' | 'institution';

/** What a choice does. Money is to the city (negative = the city pays); positive sums scale with trust, costs with 2 - trust. */
export interface ProjectChoice {
  label: string; detail: string;
  money?: number;
  /** what gets built on the assembled site */
  build?: { type: 'res' | 'com'; level: number; hgt: number; months: number };
  /** service promise: a station within the walk limit of the site within this many months of the deal, else the site goes car-first */
  deadline?: number;
  /** car-locked from day one (garages, no promise) */
  carLockAll?: boolean;
  /** money the developer claws back when the promise is broken (asked for in a follow-up) */
  clawback?: number;
  /** plots next to the site kept as a public square */
  plaza?: number;
  /** no assembly: the existing buildings are refurbished (cost in money) */
  refurbish?: boolean;
  decline?: boolean;
  trust?: number;
  interest?: number;
}

export interface ProjectType {
  id: string;
  /** short name for lists and the log */
  name: string;
  color: string;
  requires?: Requires & { terrain?: string[]; water?: boolean };
  gate: { pop?: number; month?: number; rating?: number; money?: number; resDemand?: number; indDemandBelow?: number; lines?: number };
  finder: Finder;
  /** finder score (0..1) needed at a site */
  threshold: number;
  /** site size in cells (a rectangle on the seed plot's frontage) */
  size: [number, number];
  /** months between two new instances of this type, city-wide */
  cooldown: number;
  /** at most one instance of this type per `radius` cells within `months` */
  area: { radius: number; months: number };
  /** chance per month once the conditions hold (times the area's developer interest) */
  prob: number;
  /** false: a private developer goes ahead without asking (choice `auto`), only a notification */
  decide: boolean;
  auto?: number;
  title: string;
  text: string;
  choices: ProjectChoice[];
}

/** Words picked by the city profile (site kind / history), so the same template reads right in a port, a rail town or a mining town. */
const WORDS: Record<string, Record<string, string>> = {
  harbour: { works: 'warehouses', worksOne: 'warehouse row', dev: 'Quayside', water: 'harbour front' },
  railyard: { works: 'engine sheds', worksOne: 'goods shed', dev: 'Railside', water: 'river bank' },
  mine: { works: 'pithead workshops', worksOne: 'winding house', dev: 'Deepshaft', water: 'canal side' },
};
const DEV_A = ['Meridian', 'Crown', 'Northgate', 'Parkway', 'Civic', 'Lantern', 'Oakfield', 'Harrow', 'Beacon', 'Fairway'];
const DEV_B = ['Estates', 'Partners', 'Homes', 'Developments', 'Housing Trust', 'Land Co.', 'Living', 'Properties'];

const M = (v: number) => `$${Math.round(Math.abs(v) / 1e6)}M`;

/** The project catalogue. A new kind of project is a new entry here (using one of the finders). */
export const PROJECT_TYPES: ProjectType[] = [
  {
    id: 'land_buyup', name: 'Land buy-up', color: '#d9824b',
    gate: { pop: 8000, month: 12, resDemand: -0.2 },
    finder: 'pressure', threshold: 0.42, size: [2.0, 1.4], cooldown: 8, area: { radius: 10, months: 36 }, prob: 0.25, decide: true,
    title: 'The city buys up land {place}',
    text: 'Land {place} is worth far more than the {buildings} low buildings on it ({lv}% land value, mostly {levelWord}). The council can buy the {plots} plots ' +
      '(about {homesLost} homes and {jobsLost} jobs move out first) and hand the site to a partner.{trustNote}<br><br>' +
      '<b>Brief:</b> a station within an <b>8-minute walk</b> of the site by the deadline, or it is built car-first for good. Who builds it?',
    choices: [
      { label: '{devA}: towers, fast', detail: '{m0} to the city now. A 50 m residential tower. Station needed within {d0} months, or a {c0} clawback and the tower goes car-first.', money: 22e6, build: { type: 'res', level: 3, hgt: 50, months: 9 }, deadline: 20, clawback: 12e6 },
      { label: '{devB}: mid-rise with a square', detail: 'The city pays {m1}. Mid-rise flats around a small square, {d1} months to bring the metro.', money: -8e6, build: { type: 'res', level: 2, hgt: 0, months: 7 }, deadline: 36, plaza: 2 },
      { label: '{devC}: houses with garages', detail: '{m2} to the city. Low-rise, no deadline, car-locked from day one.', money: 6e6, build: { type: 'res', level: 2, hgt: 0, months: 6 }, carLockAll: true },
    ],
  },
  {
    id: 'station_quarter', name: 'Station quarter', color: '#e2b13c',
    gate: { lines: 1, pop: 6000 },
    finder: 'station', threshold: 0.4, size: [1.7, 1.3], cooldown: 6, area: { radius: 7, months: 48 }, prob: 0.3, decide: true,
    title: '{devA} want to build at {station}',
    text: 'Since {station} station opened {since} months ago, the plots around it have become some of the best-connected land in the city, but they still hold {buildings} small buildings. ' +
      '{devA} propose a block of offices and flats on {plots} plots right by the entrance{streetNote}.{trustNote}',
    choices: [
      { label: 'Yes, with a square at the entrance', detail: 'No money changes hands. A 40 m office block and a public square on the station side.', money: 0, build: { type: 'com', level: 3, hgt: 40, months: 8 }, plaza: 2, trust: 0.05 },
      { label: 'Yes, as dense as they like', detail: '{m1} to the city. A 58 m tower, no square.', money: 10e6, build: { type: 'com', level: 3, hgt: 58, months: 11 } },
      { label: 'Decline', detail: 'Developers take note: fewer proposals here for a while.', decline: true, interest: -0.25 },
    ],
  },
  {
    id: 'vacant_infill', name: 'Infill housing', color: '#8db36a',
    gate: { resDemand: 0.05, month: 6 },
    finder: 'vacant', threshold: 0.45, size: [1.5, 1.1], cooldown: 4, area: { radius: 6, months: 30 }, prob: 0.2, decide: false, auto: 0,
    title: '{devA} build on the empty plots {place}',
    text: '{plots} plots {place} have stood empty or half-used while the city is short of homes. {devA} bought them and are building flats.',
    choices: [{ label: 'Go ahead', detail: '', money: 0, build: { type: 'res', level: 2, hgt: 0, months: 6 } }],
  },
  {
    id: 'estate_renewal', name: 'Estate renewal', color: '#b07a9c',
    gate: { month: 24, pop: 9000 },
    finder: 'aged', threshold: 0.5, size: [1.8, 1.3], cooldown: 10, area: { radius: 8, months: 60 }, prob: 0.2, decide: true,
    title: 'The old houses {place} are wearing out',
    text: 'The {buildings} buildings {place} are among the oldest in the city ({age} years on average) and land there is now worth {lv}%. {devA} offer to rebuild the block denser; ' +
      'the residents would rather see the houses repaired.{trustNote}',
    choices: [
      { label: 'Rebuild it denser', detail: '{m0} to the city. {homesLost} homes are cleared, then a 34 m block of flats rises.', money: 8e6, build: { type: 'res', level: 3, hgt: 34, months: 8 }, trust: -0.05 },
      { label: 'Fund a refurbishment', detail: 'The city pays {m1}. The houses stay and are done up; residents are pleased.', money: -6e6, refurbish: true, trust: 0.1 },
      { label: 'Leave it', detail: 'Nothing happens for now.', decline: true, interest: -0.1 },
    ],
  },
  {
    id: 'works_rezoning', name: 'Works rezoning', color: '#7d8fb3',
    gate: { pop: 10000, month: 30, indDemandBelow: 0.35 },
    finder: 'industry', threshold: 0.45, size: [2.2, 1.6], cooldown: 14, area: { radius: 10, months: 72 }, prob: 0.18, decide: true,
    title: 'The {works} {place} could become homes',
    text: 'Industry is moving out to the edge of town and the {works} {place} ({buildings} buildings on {plots} plots) are half empty. {devA} want them rezoned.{trustNote}<br><br>' +
      '<b>Brief:</b> without a station within an 8-minute walk by the deadline, the new homes are built car-first.',
    choices: [
      { label: 'Rezone with a park', detail: 'The city pays {m0}. Mid-rise homes round a public green, {d0} months to bring the metro.', money: -10e6, build: { type: 'res', level: 2, hgt: 0, months: 8 }, plaza: 3, deadline: 36, trust: 0.05 },
      { label: 'Rezone dense', detail: '{m1} to the city. A 45 m tower block, metro needed within {d1} months or a {c1} clawback.', money: 15e6, build: { type: 'res', level: 3, hgt: 45, months: 9 }, deadline: 24, clawback: 9e6 },
      { label: 'Keep it industrial', detail: 'The works stay; developers look elsewhere.', decline: true, interest: -0.15 },
    ],
  },
  {
    id: 'waterfront_regen', name: 'Waterfront scheme', color: '#4f9fc0',
    requires: { water: true },
    gate: { pop: 12000, month: 36 },
    finder: 'waterfront', threshold: 0.45, size: [2.4, 1.5], cooldown: 18, area: { radius: 14, months: 96 }, prob: 0.15, decide: true,
    title: 'A scheme for the {water} {place}',
    text: '{devA} have bought options on {plots} plots along the {water} {place} ({buildings} buildings, {homesLost} homes). They want to clear them for a waterfront quarter, ' +
      'the way the {oldSite} were redeveloped.{trustNote}<br><br><b>Brief:</b> a station within an 8-minute walk by the deadline, or the quarter is built car-first.',
    choices: [
      { label: 'Waterfront towers', detail: '{m0} to the city. A 55 m tower and a quayside square. Station within {d0} months or a {c0} clawback.', money: 25e6, build: { type: 'res', level: 3, hgt: 55, months: 11 }, plaza: 2, deadline: 26, clawback: 14e6 },
      { label: 'Mid-rise and a promenade', detail: 'The city pays {m1}. Mid-rise blocks and a public promenade, {d1} months for the metro.', money: -6e6, build: { type: 'res', level: 2, hgt: 0, months: 8 }, plaza: 3, deadline: 40, trust: 0.05 },
      { label: 'Not on our waterfront', detail: 'The plots stay as they are.', decline: true, interest: -0.2 },
    ],
  },
  {
    id: 'institution_expansion', name: 'Institution expansion', color: '#c75b5b',
    gate: { pop: 14000, month: 30 },
    finder: 'institution', threshold: 0.35, size: [1.8, 1.3], cooldown: 16, area: { radius: 8, months: 72 }, prob: 0.18, decide: true,
    title: 'The {institution} needs room to grow',
    text: 'The {institution} is full. It wants the {plots} plots next door ({buildings} buildings, {homesLost} homes) for a new wing that would add about {jobs} jobs.{trustNote}',
    choices: [
      { label: 'Give them city land', detail: 'The city pays {m0}. The new wing is built and a forecourt is laid out.', money: -12e6, build: { type: 'com', level: 3, hgt: 30, months: 10 }, plaza: 1, trust: 0.05 },
      { label: 'Let them buy the plots', detail: '{m1} to the city in land sales. The wing is built, no forecourt.', money: 5e6, build: { type: 'com', level: 3, hgt: 30, months: 10 } },
      { label: 'Refuse', detail: 'They will look for space elsewhere.', decline: true, interest: -0.1 },
    ],
  },
];

/** Global pacing (all instances together). */
export const PACE = {
  /** active projects at once: 1 + one per this many people, capped */
  perPop: 12000, maxActive: 5,
  /** months between two new instances (any type) */
  minGap: 2,
  /** months between two project decisions shown to the player */
  decisionGap: 2,
  /** each type looks for sites every this many months (staggered) */
  scanEvery: 2,
  /** candidate plots examined per scan */
  samples: 260,
};

export type ProjectStatus = 'proposed' | 'declined' | 'assembling' | 'building' | 'done' | 'refurbished' | 'aborted';

export interface Project {
  id: number; type: string; x: number; y: number; area: number; place: string;
  month: number; status: ProjectStatus; choice: number; asm: number; lot: number;
  /** month the service promise falls due (0 = none) */
  deadline: number;
  promise: 'none' | 'open' | 'kept' | 'broken';
  carLock: boolean; clawback: number;
  outcome: string;
  vars: Record<string, string | number>;
  plan: { cx: number; cy: number; ang: number; ld: number; plaza: number[] };
  ended: number;
}

export interface ProjectInfo {
  id: number; type: string; name: string; color: string; title: string; place: string; x: number; y: number;
  status: ProjectStatus; phase: string; pct: number; deadline: number; promise: string; carLock: boolean; month: number; outcome: string;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class ProjectSystem {
  list: Project[] = [];
  /** per area (quarter index): trust in the council's promises and developer interest, both around 1 */
  trust: number[] = [];
  interest: number[] = [];
  /** decisions waiting to be shown (instance ids) */
  queue: number[] = [];
  /** recent notifications for the HUD */
  notices: { month: number; text: string; x: number; y: number; color: string }[] = [];
  private nextId = 1;
  private lastStart = -99;
  private lastStartOf: Record<string, number> = {};
  lastDecision = -99;
  /** first month each station was on a line */
  stationSince = new Map<number, number>();
  log: string[] = [];

  constructor(private sim: Sim) {}

  private areaOf(x: number, y: number): number {
    const vs = this.sim.g.villages;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < vs.length; i++) { const d = Math.hypot(vs[i].x - x, vs[i].y - y); if (d < bd) { bd = d; bi = i; } }
    while (this.trust.length < vs.length) { this.trust.push(1); this.interest.push(1); }
    return bi;
  }

  /** "near Holloway station" when a station is close, else "in Brindle" (the quarter's name). */
  placeName(x: number, y: number): string {
    let st: { name: string } | null = null, bd = 5;
    const used = new Set(this.sim.metro.lines.flatMap((l) => l.stations));
    for (const s of this.sim.metro.stations) { const d = Math.hypot(s.x - x, s.y - y); if (used.has(s.id) && d < bd) { bd = d; st = s; } }
    if (st) return `near ${st.name} station`;
    const v = this.sim.g.villages[this.areaOf(x, y)];
    if (!v) return 'in town';
    const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy);
    if (d < 5) return `in central ${v.name}`;
    // compass part of the quarter (y grows southwards on the map)
    const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
    const k = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    return `in ${d > 14 ? 'outer ' : ''}${dirs[k]} ${v.name}`;
  }

  active(): Project[] { return this.list.filter((p) => p.status === 'proposed' || p.status === 'assembling' || p.status === 'building'); }
  budget(): number { return Math.min(PACE.maxActive, 1 + Math.floor((this.sim.homes * PERSONS_PER_HOME) / PACE.perPop)); }

  // ---------------------------------------------------------------- monthly
  tick() {
    const sim = this.sim;
    // stations opening (accessibility gains)
    for (const l of sim.metro.lines) for (const id of l.stations) if (!this.stationSince.has(id)) this.stationSince.set(id, sim.month);
    // developer interest follows service: areas whose homes are within walking distance of a station attract more proposals
    this.driftInterest();
    for (const p of this.list) this.follow(p);
    this.scan();
  }

  private driftInterest() {
    const sim = this.sim, n = sim.g.villages.length;
    if (sim.month % 6 !== 0 || !n) return;
    const homes = new Float64Array(n), served = new Float64Array(n);
    for (const l of sim.lots.lots) {
      if (!l.alive || l.type !== BT.Res || !l.level) continue;
      const a = this.areaOf(l.x, l.y), h = sim.lotHomes(l);
      homes[a] += h;
      if (sim.walkToStation(l.cell) <= 8) served[a] += h;
    }
    this.areaOf(0, 0);   // sizes the per-area arrays
    for (let a = 0; a < n; a++) {
      const target = 0.85 + 0.9 * (homes[a] ? served[a] / homes[a] : 0) + 0.25 * (this.trust[a] - 1);
      this.interest[a] = clamp(this.interest[a] + (target - this.interest[a]) * 0.15, 0.3, 2.2);
    }
  }

  // ---------------------------------------------------------------- finding sites
  private gateOk(t: ProjectType): boolean {
    const s = this.sim, g = t.gate, pop = s.homes * PERSONS_PER_HOME;
    if (g.pop !== undefined && pop < g.pop) return false;
    if (g.month !== undefined && s.month < g.month) return false;
    if (g.rating !== undefined && s.rating < g.rating) return false;
    if (g.money !== undefined && s.money < g.money) return false;
    if (g.resDemand !== undefined && s.resDemand < g.resDemand) return false;
    if (g.indDemandBelow !== undefined && s.indDemand > g.indDemandBelow) return false;
    if (g.lines !== undefined && s.metro.lines.length < g.lines) return false;
    const q = t.requires;
    if (q) {
      if (q.site && !q.site.includes(s.cp.site)) return false;
      if (q.origin && !q.origin.includes(s.cp.origin)) return false;
      if (q.history && !s.cp.history.some((h) => q.history!.includes(h.kind))) return false;
      if (q.terrain && !q.terrain.includes(s.cp.terrain)) return false;
    }
    return true;
  }

  private scan() {
    const sim = this.sim;
    if (this.active().length >= this.budget()) return;
    if (sim.month - this.lastStart < PACE.minGap) return;
    PROJECT_TYPES.forEach((t, ti) => {
      if ((sim.month + ti) % PACE.scanEvery !== 0) return;
      if (this.active().length >= this.budget() || sim.month - this.lastStart < PACE.minGap) return;
      if (sim.month - (this.lastStartOf[t.id] ?? -999) < t.cooldown) return;
      if (!this.gateOk(t)) return;
      const site = this.findSite(t, ti);
      if (!site) return;
      const a = this.areaOf(site.l.x, site.l.y);
      const p = t.prob * this.interest[a];
      if (hash01(sim.seed * 7 + ti * 131 + site.l.id, sim.month) >= p) return;
      this.propose(t, site);
    });
  }

  /** Scores 0..1 for a candidate seed plot; null = not a site of this kind. */
  private score(t: ProjectType, l: Lot): number | null {
    const sim = this.sim;
    if (!sim.asm.ok(l)) return null;
    const terr = TERR.on ? sim.town.terr[l.cell] : -1;
    const ring = sim.lots.near(l.x, l.y, 2.2).filter((o) => o.alive);
    if (ring.length < 4) return null;
    const lv = sim.fieldAt(sim.lvS, l.x, l.y);
    const blt = ring.filter((o) => o.type === BT.Res || o.type === BT.Com || o.type === BT.Ind);
    const meanLevel = blt.length ? blt.reduce((s, o) => s + o.level, 0) / blt.length : 0;
    const vac = ring.filter((o) => o.type === BT.None && !o.asm && !o.constr && !(o.flags & (Flag.Docks | Flag.Planned))).length / ring.length;
    switch (t.finder) {
      case 'pressure': {
        // land value well above what the buildings on it use (homes and shops, not industry)
        if (terr === T.Industry || terr === T.Port || terr === T.Core || l.type === BT.Ind) return null;
        if (meanLevel > 1.7) return null;
        // (land the city buys ahead of the metro: value from centrality and demand, no station yet, scores higher)
        return clamp((lv - 0.45) * 1.8 + (1.7 - meanLevel) * 0.25 + (sim.walkToStation(l.cell) > 8 ? 0.12 : 0), 0, 1);
      }
      case 'station': {
        let best = Infinity, since = 0;
        for (const st of sim.metro.stations) {
          const m0 = this.stationSince.get(st.id);
          if (m0 === undefined || sim.month - m0 > 60) continue;
          const d = Math.hypot(st.x - l.x, st.y - l.y);
          if (d < best) { best = d; since = sim.month - m0; }
        }
        if (best > 4 || sim.walkToStation(l.cell) > 6) return null;
        if (meanLevel > 2.2 || terr === T.Industry || terr === T.Port) return null;
        return clamp(0.9 - best * 0.12 - meanLevel * 0.12 + (since < 24 ? 0.1 : 0), 0, 1);
      }
      case 'vacant': {
        if (terr === T.Industry || terr === T.Port || terr === T.Green) return null;
        if (l.type !== BT.None || l.deco) return null;
        return clamp(vac * 1.3 + (lv - 0.3) * 0.6, 0, 1);
      }
      case 'aged': {
        if (terr === T.Industry || terr === T.Port || terr === T.Core) return null;
        const old = blt.filter((o) => o.type !== BT.Ind && o.level <= 2 && (o.built === 0 ? 120 + o.age : o.age) >= 150);
        if (old.length < 4 || meanLevel > 2) return null;
        return clamp((old.length / Math.max(1, blt.length)) * 0.7 + (lv - 0.4) * 0.8, 0, 1);
      }
      case 'industry': {
        if (l.type !== BT.Ind) return null;
        const ind = blt.filter((o) => o.type === BT.Ind).length;
        const dc = Math.hypot(l.x - sim.centre.x, l.y - sim.centre.y);
        if (ind < 3) return null;
        return clamp(0.25 + (lv - 0.25) * 0.9 + (dc < 30 ? 0.25 : 0) + (sim.walkToStation(l.cell) <= 10 ? 0.15 : 0), 0, 1);
      }
      case 'waterfront': {
        const dw = sim.g.distWater[l.cell];
        if (dw > 2 || (l.flags & Flag.Docks) || terr === T.Core) return null;
        if (terr === T.Port && sim.docks.state !== 'done') return null;
        return clamp(0.35 + (lv - 0.3) * 0.8 + (2 - meanLevel) * 0.12 + (dw <= 1 ? 0.1 : 0), 0, 1);
      }
      case 'institution': {
        const inst = this.institutionNear(l.x, l.y);
        if (!inst) return null;
        if (terr === T.Core) return null;
        return clamp(0.7 - inst.d * 0.07 + (meanLevel < 2 ? 0.1 : 0), 0, 1);
      }
    }
  }

  private institutionNear(x: number, y: number): { name: string; d: number } | null {
    let best: { name: string; d: number } | null = null;
    for (const st of this.sim.lm.states.values()) {
      if (st.state !== 'open') continue;
      const def = LANDMARKS[st.def];
      if (!def || !['education', 'health', 'culture'].includes(def.category)) continue;
      const L = this.sim.lots.lots[st.lot];
      if (!L) continue;
      const d = Math.hypot(L.x - x, L.y - y);
      if (d < 5 && (!best || d < best.d)) best = { name: def.name.toLowerCase().startsWith('the ') ? def.name : `${def.name.toLowerCase()}`, d };
    }
    return best;
  }

  private findSite(t: ProjectType, ti: number): { l: Lot; s: number; plan: AsmPlan } | null {
    const sim = this.sim, lots = sim.lots.lots;
    if (t.requires?.water && !sim.g.water.some((w) => w)) return null;
    const n = lots.length;
    if (!n) return null;
    const off = Math.floor(hash01(sim.seed + ti * 17, sim.month) * n);
    const step = Math.max(1, Math.floor(n / PACE.samples));
    const cands: { l: Lot; s: number }[] = [];
    for (let k = 0; k < n; k += step) {
      const l = lots[(off + k) % n];
      if (!l || !l.alive) continue;
      // area limit: no instance of this type nearby lately, and no other live project on top of it
      if (this.list.some((p) => (p.type === t.id && sim.month - p.month < t.area.months && Math.hypot(p.x - l.x, p.y - l.y) < t.area.radius)
        || ((p.status === 'proposed' || p.status === 'assembling' || p.status === 'building') && Math.hypot(p.x - l.x, p.y - l.y) < 3))) continue;
      const s = this.score(t, l);
      if (s === null || s < t.threshold) continue;
      cands.push({ l, s });
    }
    // the best few seeds: the site actually assembled must still be what the type is about
    cands.sort((a, b) => b.s - a.s || a.l.id - b.l.id);
    for (const c of cands.slice(0, 6)) {
      const plan = this.planAt(t, c.l.x, c.l.y, c.l.ang, c.l.d);
      if (plan && this.planFits(t, plan)) return { ...c, plan };
    }
    return null;
  }

  /** Is the assembled rectangle itself a site of this kind (not only the neighbourhood around its seed plot)? */
  private planFits(t: ProjectType, plan: AsmPlan): boolean {
    const m = plan.members;
    if (m.length < 2) return false;
    const blt = m.filter((o) => (o.type === BT.Res || o.type === BT.Com || o.type === BT.Ind) && o.level > 0);
    const vac = m.filter((o) => o.type === BT.None).length;
    const meanLevel = blt.length ? blt.reduce((s, o) => s + o.level, 0) / blt.length : 0;
    switch (t.finder) {
      case 'pressure': return blt.length >= 2 && meanLevel <= 1.8;
      case 'station': return meanLevel <= 2.2;
      case 'vacant': return vac >= Math.max(2, m.length * 0.5);
      case 'aged': return blt.filter((o) => o.type !== BT.Ind && o.level <= 2 && (o.built === 0 ? 120 + o.age : o.age) >= 150).length >= 3;
      case 'industry': return blt.filter((o) => o.type === BT.Ind).length >= 2;
      case 'waterfront': return blt.length >= 1;
      case 'institution': return true;
    }
  }

  private planAt(t: ProjectType, cx: number, cy: number, ang: number, ld: number): AsmPlan | null {
    const [w, d] = t.size;
    // the rectangle's front edge is the seed plot's frontage (the street is on the plot's -v side): the site reaches back into the block, not into the street
    const k = Math.max(0, (d - ld) / 2) + 0.03;
    return this.sim.asm.planRect(cx - Math.sin(ang) * k, cy + Math.cos(ang) * k, ang, w, d, false, 'project');
  }

  /** Plots next to the site that become a public square (cheapest first). */
  private plazaFor(plan: AsmPlan, n: number): Lot[] {
    if (n <= 0) return [];
    const sim = this.sim, cx = (plan.quad[0] + plan.quad[4]) / 2, cy = (plan.quad[1] + plan.quad[5]) / 2;
    const mem = new Set(plan.members);
    return sim.lots.near(cx, cy, 2.4).filter((o) => o.alive && !mem.has(o) && sim.asm.ok(o) && o.type !== BT.Ind)
      .sort((a, b) => sim.asm.cost(a) - sim.asm.cost(b) || Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy) || a.id - b.id)
      .slice(0, n);
  }

  // ---------------------------------------------------------------- proposals and choices
  private devName(id: number, k: number): string {
    const s = this.sim, w = WORDS[s.cp.site];
    const a = k === 0 && w && hash01(id, 3) < 0.4 ? w.dev : DEV_A[Math.floor(hash01(id * 7 + k, 11) * DEV_A.length)];
    return `${a} ${DEV_B[Math.floor(hash01(id * 13 + k, 5) * DEV_B.length)]}`;
  }

  private propose(t: ProjectType, site: { l: Lot; s: number; plan: AsmPlan }) {
    const sim = this.sim, plan = site.plan;
    const cx = (plan.quad[0] + plan.quad[4]) / 2, cy = (plan.quad[1] + plan.quad[5]) / 2;
    const area = this.areaOf(cx, cy), id = this.nextId++;
    const tr = this.trust[area];
    const blt = plan.members.filter((o) => o.type && o.level > 0);
    const levels = blt.map((o) => o.level);
    const mean = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
    const age = blt.length ? Math.round(blt.reduce((a, o) => a + (o.built === 0 ? 120 + o.age : o.age), 0) / blt.length / 12) : 0;
    let station = '', since = 0;
    { let bd = Infinity; for (const st of sim.metro.stations) { const m0 = this.stationSince.get(st.id); if (m0 === undefined) continue; const d = Math.hypot(st.x - cx, st.y - cy); if (d < bd) { bd = d; station = st.name; since = sim.month - m0; } } }
    const inst = this.institutionNear(cx, cy);
    const w = WORDS[sim.cp.site] ?? WORDS.harbour;
    const vars: Record<string, string | number> = {
      place: this.placeName(cx, cy), area: sim.g.villages[area]?.name ?? '', plots: plan.members.length, buildings: blt.length,
      homesLost: Math.round(plan.homes / 5) * 5, jobsLost: Math.round(plan.jobs / 5) * 5, lv: Math.round(sim.fieldAt(sim.lvS, cx, cy) * 100),
      levelWord: mean < 1.5 ? 'houses and sheds' : 'two- and three-storey blocks', age, station, since,
      streetNote: plan.closed.length ? `; ${plan.closed.length} side street${plan.closed.length > 1 ? 's' : ''} through the site would close` : '',
      institution: inst?.name ?? 'hospital', jobs: 300 + Math.round(plan.members.length * 60), works: w.works, water: w.water,
      oldSite: sim.cp.site === 'harbour' ? 'old docks' : sim.cp.site === 'railyard' ? 'old rail yards' : 'old pithead',
      devA: this.devName(id, 0), devB: this.devName(id, 1), devC: this.devName(id, 2),
      trustNote: tr < 0.8 ? ` Developers here remember the last broken promise and drive a harder bargain.` : tr > 1.2 ? ` After the promises kept here, developers offer good terms.` : '',
    };
    t.choices.forEach((c, k) => {
      vars['m' + k] = M(this.dealMoney(c, tr));
      if (c.deadline) vars['d' + k] = this.dealDeadline(c, tr);
      if (c.clawback) vars['c' + k] = M(c.clawback * (2 - tr));
    });
    const p: Project = {
      id, type: t.id, x: cx, y: cy, area, place: String(vars.place), month: sim.month, status: 'proposed', choice: -1, asm: 0, lot: -1,
      deadline: 0, promise: 'none', carLock: false, clawback: 0, outcome: '', vars,
      plan: { cx: site.l.x, cy: site.l.y, ang: site.l.ang, ld: site.l.d, plaza: [] }, ended: -1,
    };
    this.list.push(p);
    this.lastStart = sim.month; this.lastStartOf[t.id] = sim.month;
    this.logLine(p, 'proposed');
    if (t.decide) this.queue.push(p.id);
    else this.choose(p.id, t.auto ?? 0);
  }

  /** deals get worse where trust is low: the city receives less and pays more */
  private dealMoney(c: ProjectChoice, tr: number): number {
    const m = c.money ?? 0;
    return m >= 0 ? m * clamp(tr, 0.4, 1.6) : m * clamp(2 - tr, 0.5, 1.8);
  }
  private dealDeadline(c: ProjectChoice, tr: number): number { return Math.max(10, Math.round((c.deadline ?? 0) * clamp(0.75 + tr * 0.25, 0.8, 1.2))); }

  typeOf(p: Project): ProjectType { return PROJECT_TYPES.find((t) => t.id === p.type)!; }

  /** The next queued decision as an event definition for the sim's dialog (null if none is due). */
  nextDecision(): { id: string; title: string; text: string; choices: { label: string; detail: string }[] } | null {
    while (this.queue.length) {
      const p = this.list.find((q) => q.id === this.queue[0]);
      if (!p || p.status !== 'proposed') { this.queue.shift(); continue; }
      const t = this.typeOf(p);
      return { id: 'proj_' + p.id, title: t.title, text: t.text, choices: t.choices.map((c) => ({ label: c.label, detail: c.detail })) };
    }
    return null;
  }

  /** Apply a choice to a proposed instance (from the dialog or automatically). */
  choose(id: number, k: number) {
    const sim = this.sim, p = this.list.find((q) => q.id === id);
    if (!p || p.status !== 'proposed') return;
    this.queue = this.queue.filter((q) => q !== id);
    const t = this.typeOf(p), c = t.choices[k];
    if (!c) return;
    p.choice = k;
    const tr = this.trust[p.area];
    if (c.trust) this.trust[p.area] = clamp(this.trust[p.area] + c.trust, 0.3, 1.8);
    if (c.interest) this.interest[p.area] = clamp(this.interest[p.area] + c.interest, 0.3, 2.2);
    if (c.decline) { this.end(p, 'declined', 'declined'); return; }
    const money = this.dealMoney(c, tr);
    if (c.refurbish) {
      sim.money += money;
      const plan = this.planAt(t, p.plan.cx, p.plan.cy, p.plan.ang, p.plan.ld);
      for (const l of plan?.members ?? []) if (l.type && l.level) { l.age = 0; l.built = sim.month; l.low = 0; }
      this.end(p, 'refurbished', 'refurbished');
      return;
    }
    const plan = this.planAt(t, p.plan.cx, p.plan.cy, p.plan.ang, p.plan.ld);
    if (!plan || plan.members.length < 2) { this.end(p, 'aborted', 'site no longer available'); return; }
    plan.plaza = this.plazaFor(plan, c.plaza ?? 0);
    // density discipline: a project never builds above what the density-and-height field allows at the site (no towers without transit)
    const hm = sim.field.hmaxAt(p.x, p.y);
    const b = { ...c.build! };
    if (b.level === 3 && hm < 36) { b.level = 2; b.hgt = 0; }
    else if (b.level === 3) b.hgt = Math.round(Math.min(b.hgt, hm));
    const a = sim.asm.start(plan, { type: b.type === 'res' ? BT.Res : BT.Com, level: b.level, hgt: b.hgt, months: b.months, label: `${t.name} ${p.place}`, form: 'project' });
    // the developer captures regional demand, as the docks do
    const cap = plan.members.reduce((s, l) => s + sim.capacity(l, b.type === 'res' ? BT.Res : BT.Com, b.level, b.hgt), 0) * 0.6;
    if (b.type === 'res') sim.resPool -= cap; else sim.comPool -= cap;
    sim.money += money;
    p.asm = a.id; p.status = 'assembling';
    p.plan.plaza = plan.plaza.map((l) => l.id);
    if (c.carLockAll) p.carLock = true;
    // a promise is only made where the site still needs a station (a site already within the walk limit has nothing to wait for)
    const served = sim.walkToStation(Math.floor(p.y) * N + Math.floor(p.x)) <= 8;
    if (c.deadline && !served) { p.deadline = sim.month + this.dealDeadline(c, tr); p.promise = 'open'; p.clawback = (c.clawback ?? 0) * (2 - tr); }
    this.logLine(p, `deal ${k}: ${fillSimple(c.label, p.vars)}${p.deadline ? `, station due m${p.deadline}` : ''}${money ? `, ${money > 0 ? '+' : '-'}${M(money)}` : ''}`);
    this.notify(p, `${fillSimple(t.title, p.vars)}: ${fillSimple(c.label, p.vars)}`);
  }

  private end(p: Project, s: ProjectStatus, outcome: string) {
    p.status = s; p.outcome = outcome; p.ended = this.sim.month;
    this.logLine(p, outcome);
  }

  /** Follow an instance through the pipeline: phases, the service promise, car-lock, completion. */
  private follow(p: Project) {
    const sim = this.sim;
    if (p.status === 'assembling' || p.status === 'building') {
      const a = sim.asm.byId(p.asm);
      if (a) {
        if (a.merged >= 0) p.lot = a.merged;
        if (p.carLock && a.level > 2) { a.level = 2; a.hgt = 0; }   // a car-first site is built lower (no tower over a car park)
        p.status = a.phase >= 4 ? 'building' : 'assembling';
      } else {
        const L = p.lot >= 0 ? sim.lots.lots[p.lot] : null;
        if (L && L.alive && L.type && L.level > 0) {
          this.end(p, 'done', `${p.carLock ? 'opened car-first' : 'opened'}${p.promise === 'kept' ? ' (promise kept)' : p.promise === 'broken' ? ' (promise broken)' : ''}`);
          this.notify(p, `${this.typeOf(p).name} ${p.place} opened${p.carLock ? ', car-first' : ''}`);
        } else if (!L || !L.constr) { this.end(p, 'aborted', 'assembly failed'); return; }
      }
    }
    // the promise: a station within an 8-minute walk of the site by the deadline
    if (p.promise === 'open') {
      const cell = Math.floor(p.y) * N + Math.floor(p.x);
      if (sim.walkToStation(cell) <= 8) {
        p.promise = 'kept';
        this.trust[p.area] = clamp(this.trust[p.area] + 0.15, 0.3, 1.8);
        this.interest[p.area] = clamp(this.interest[p.area] + 0.25, 0.3, 2.2);
        this.logLine(p, 'promise kept');
        this.notify(p, `Promise kept ${p.place}: the station arrived in time, developers take note`);
      } else if (sim.month >= p.deadline) {
        p.promise = 'broken';
        p.carLock = true;
        this.trust[p.area] = clamp(this.trust[p.area] - 0.3, 0.3, 1.8);
        this.interest[p.area] = clamp(this.interest[p.area] - 0.15, 0.3, 2.2);
        if (p.clawback) sim.money -= p.clawback;
        this.logLine(p, `promise broken${p.clawback ? `, clawback -${M(p.clawback)}` : ''}, site goes car-first`);
        this.notify(p, `Deadline missed ${p.place}: the site goes car-first${p.clawback ? ` and the developer claws back ${M(p.clawback)}` : ''}; trust in the council falls`);
      }
    }
    // car-first sites: residents and workers own cars for good
    if (p.carLock && p.lot >= 0) {
      const L = sim.lots.lots[p.lot];
      if (L && L.alive) { L.flags |= Flag.CarLocked; if (L.constr && L.target > 2) { L.target = 2; L.nhgt = 0; } }
    }
  }

  private notify(p: Project, text: string) {
    this.notices.push({ month: this.sim.month, text, x: p.x, y: p.y, color: this.typeOf(p).color });
    if (this.notices.length > 12) this.notices.shift();
    this.sim.say(text);
  }

  private logLine(p: Project, what: string) {
    this.log.push(`m${this.sim.month}\t#${p.id}\t${p.type}\t${p.place} (${p.x.toFixed(0)},${p.y.toFixed(0)})\t${what}`);
  }

  // ---------------------------------------------------------------- HUD / renderer
  infos(): ProjectInfo[] {
    const sim = this.sim;
    const PH = ['buying plots', 'hoardings up', 'demolition', 'site cleared', 'foundations', 'structure', 'facade'];
    const live = this.list.filter((p) => p.status === 'proposed' || p.status === 'assembling' || p.status === 'building');
    const recent = this.list.filter((p) => p.ended >= 0 && sim.month - p.ended <= 12).slice(-4);
    return [...live, ...recent].map((p) => {
      const t = this.typeOf(p), a = p.asm ? sim.asm.byId(p.asm) : undefined;
      const info = a ? sim.asm.infos().find((i) => i.id === a.id) : undefined;
      return {
        id: p.id, type: p.type, name: t.name, color: t.color, title: fillSimple(t.title, p.vars), place: p.place, x: p.x, y: p.y, status: p.status,
        phase: p.status === 'proposed' ? 'awaiting decision' : a ? PH[a.phase] ?? '' : p.outcome, pct: info?.pct ?? 0,
        deadline: p.deadline, promise: p.promise, carLock: p.carLock, month: p.month, outcome: p.outcome,
      };
    });
  }
}

export function fillSimple(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}
