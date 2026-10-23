import { N, CELL, ZONE, NZ, ZONES, BT, Flag, Water, isAmenity, HOMES, COM_JOBS, IND_JOBS, BUILD_MONTHS, PERSONS_PER_HOME, WORKERS_PER_HOME } from './constants';
import { STATION_COST, TRAIN_COST, START_MONEY, TRIPS_PER_HOME, PEAK_FACTOR, FARE, TRAIN_MONTH, STATION_UPKEEP, TRACK_UPKEEP_KM } from './constants';
import { Rng } from './rng';
import { generateTerrain, idx, inb, DIR4, type Grid } from './terrain';
import type { Command, InitMsg, StateMsg, Stats, DocksInfo, EventInfo, RoadsMsg, LotsMsg } from './protocol';
import { Metro } from './metro';
import { EVENTS, SITE_TEXT, fill, type EventDef, type Variant, type Effect, type DocksDeal } from './events';
import { RoadGraph, RC, ROAD_HALF } from './roads';
import { LotStore, LOT_W, type Lot } from './lots';
import { PROFILE_INDEX, ZONING, deriveProfiles, densClass, hash01, type DistrictProfile } from './profiles';
import { DensityField, FIELD } from './field';
import { LandmarkSystem } from './landmarkSys';
import { LANDMARKS, landmarkAt } from './landmarks';
import { makeCityProfile, type CityProfile } from './cityprofile';
import { layoutTown, explore, densify, type TownCtx, type GrowthField } from './town';
import { MinHeap } from './heap';

/** Tunable knobs for the growth model. */
export const TUNE = {
  tau: 10,               // minutes: accessibility decay (smooth, no cutoff)
  freeSpeed: 45,         // km/h
  circuity: 1.3,
  accessMin: 4,          // minutes to park/unpark
  roadCap: 260,          // car trip-ends per road cell per day before congestion bites
  bprA: 1.5,
  bprB: 2,
  wCar: 0.95,
  wTransit: 1.25,
  base: 0.12,
  wWater: 0.12,
  wPark: 0.05,
  wInd: 0.06,
  wCentre: 0.55,
  walkSpeed: 80,         // m per minute along streets
  walkCap: 15,           // minutes: walk fields are computed this far (faded out from walkFade)
  walkFade: 10,
  walkDecay: 7,          // minutes: how fast station value fades with walking time
  stationPrem: 0.3,      // walkable-station premium on land value
  premWalk: 9,           // minutes: premium reaches zero at this walk time
  serveWalk: 8,          // minutes: docks blocks count as served within this walk (~600 m)
  spawnLV: 0.24,
  upLV: [0, 0.6, 0.82],
  comUpLV: [0, 0.55, 0.88],
  downLV: [0, 0.1, 0.3, 0.5],
  lvLag: 0.3,            // per month: how fast the value buildings react to catches up with land value
  maxTowerStarts: 4,     // per month: towers rise over months, not all at once
  maxMidStarts: 30,
  distDecay: 2.6,
  parkMin: 9,
  modeBeta: 0.13,
  transitASC: 1.5,
  carLockASC: 14,
  growth: 0.032,
  minGrowth: 180,
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class Sim {
  rng: Rng;
  g: Grid;
  roads: RoadGraph;
  lots: LotStore;
  town: TownCtx;
  month = 0;
  speed = 1;
  // hidden raster fields (50 m cells) for the maths
  lv = new Float32Array(N * N);
  lvS = new Float32Array(N * N);          // lagged land value that buildings respond to
  roadDist = new Uint8Array(N * N);
  transitCell = new Float32Array(N * N);
  stationPrem = new Float32Array(N * N);
  cHomes = new Float32Array(N * N);
  cJobs = new Float32Array(N * N);
  cInd = new Float32Array(N * N);
  cPark = new Float32Array(N * N);
  cBuilt = new Float32Array(N * N);         // built (non-amenity) plots per cell
  accCell = new Float32Array(N * N);        // station access 0..1 (walk x reach)
  field = new DensityField();
  // zones (8x8 cells)
  zHomes = new Float64Array(ZONES);
  zJobs = new Float64Array(ZONES);
  zRoads = new Float64Array(ZONES);
  zCong = new Float64Array(ZONES);
  zSpeed = new Float64Array(ZONES);
  zCarAcc = new Float64Array(ZONES);
  zTransitShare = new Float64Array(ZONES);
  zCarLocked = new Float64Array(ZONES);
  driveTime = new Float64Array(ZONES * ZONES);
  // pools + headline numbers
  resPool = 0; comPool = 0; indPool = 0;
  resDemand = 0; comDemand = 0; indDemand = 0;
  homes = 0; jobs = 0;
  congestion = 0; pressure = 0; driveSpeed = 45;
  centre = { x: N / 2, y: N / 2 };
  money = START_MONEY;
  income = 0; expenses = 0; buildSpend = 0;
  // metro
  metro = new Metro();
  stAccess = new Float64Array(0);
  zoneNear: { s: number; w: number }[][] = [];
  egress = new Float64Array(0);
  egressVia = new Int32Array(0);
  /** per used station (matrix index): walk minutes over the street network to every cell */
  walk: Float32Array[] = [];
  private walkKey = '';
  transitTrips = 0; totalTrips = 0; rating = 0;
  desire: { a: number; b: number; trips: number }[] = [];
  // events + docks
  fired: Record<string, number> = {};
  resolved: Record<string, { month: number; choice: number }> = {};
  pending: { def: EventDef; variant: Variant | null; vars: Record<string, string | number> } | null = null;
  docks = { state: 'none' as 'none' | 'active' | 'done', deal: null as DocksDeal | null, start: 0, deadline: 0, roadRelief: false, lateLogged: false };
  log: string[] = [];
  actions: { month: number; cmd: Command }[] = [];

  cp: CityProfile;
  profiles: DistrictProfile[];
  lm!: LandmarkSystem;
  lastEventMonth = -99;

  constructor(public seed: number, force?: { terrain?: CityProfile['terrain']; origin?: CityProfile['origin'] }) {
    this.rng = new Rng(seed);
    this.cp = makeCityProfile(seed, force);
    this.profiles = deriveProfiles(this.cp);
    this.g = generateTerrain(seed, this.rng, this.cp);
    this.roads = new RoadGraph(this.g);
    this.lots = new LotStore(this.g.water, this.g.flags, this.roads, this.profiles);
    this.lots.profileAt = (x, y) => this.profileAt(x, y);
    this.town = { g: this.g, city: this.cp, roads: this.roads, lots: this.lots, rng: this.rng, districts: [], profiles: this.profiles };
    this.town.profileAt = (x, y) => this.profileAt(x, y);
    layoutTown(this.town);
    this.lm = new LandmarkSystem(this);
    this.lm.sync();
    this.roads.blockFlags = Flag.Docks;
    this.roads.corridor = {
      blocked: (ax, ay, bx, by) => this.lots.inCorridor(ax, ay, bx, by, ROAD_HALF[RC.Local] + 0.05)
        .some((l) => (l.flags & (Flag.Docks | Flag.Planned)) || l.constr > 0 || l.type === BT.Ind || isAmenity(l.type) || l.level >= 2),
      clear: (ax, ay, bx, by) => { for (const l of this.lots.inCorridor(ax, ay, bx, by, ROAD_HALF[RC.Local] + 0.05)) this.lots.remove(l); },
    };
    this.aggregate();
    this.computeLandValue();
    this.lvS.set(this.lv);
    this.field.update(this);
  }

  get liveLots(): Lot[] { return this.lots.lots.filter((l) => l.alive); }

  // ---------------------------------------------------------------- commands
  apply(cmd: Command) {
    if (cmd.type !== 'speed') this.actions.push({ month: this.month, cmd });
    switch (cmd.type) {
      case 'speed': this.speed = cmd.speed; break;
      case 'step': for (let k = 0; k < cmd.months; k++) this.tick(); break;
      default: this.applyGame(cmd);
    }
  }

  protected applyGame(cmd: Command) {
    const m = this.metro, w = this.g.water;
    switch (cmd.type) {
      case 'placeStation': {
        if (this.money < STATION_COST) { this.say('Not enough money for a station'); return; }
        const st = m.addStation(cmd.x, cmd.y, w);
        if (!st) return;
        this.money -= STATION_COST; this.buildSpend += STATION_COST;
        this.say(`${st.name} station dug`);
        break;
      }
      case 'removeStation': if (m.removeStation(cmd.id)) this.money += STATION_COST * 0.5; break;
      case 'buildLine': {
        const q = m.quote(cmd.stations, w);
        const est = q.cost + 2 * TRAIN_COST;
        if (this.money < est) { this.say(`Line needs ${(est / 1e6).toFixed(0)}M, not enough money`); return; }
        const l = m.addLine(cmd.stations, w);
        if (!l) return;
        const cost = q.cost + l.trains * TRAIN_COST;
        this.money -= cost; this.buildSpend += cost;
        this.say(`Line ${l.id} opened: ${l.stations.length} stations, ${l.lengthKm.toFixed(1)} km${q.wkm > 0.05 ? ` (${q.wkm.toFixed(1)} km under water)` : ''}`);
        this.refreshTransit();
        break;
      }
      case 'setTrains': {
        const l = m.line(cmd.line);
        if (!l) return;
        const n = Math.max(1, Math.min(40, Math.round(cmd.trains)));
        const d = n - l.trains;
        if (d > 0 && this.money < d * TRAIN_COST) return;
        this.money -= d > 0 ? d * TRAIN_COST : d * TRAIN_COST * 0.4;
        l.trains = n;
        m.updateLine(l);
        this.refreshTransit();
        break;
      }
      case 'deleteLine': m.lines = m.lines.filter((l) => l.id !== cmd.line); this.refreshTransit(); break;
      default: this.applyEvent(cmd);
    }
  }

  /** Land value reacts at once when service changes; buildings follow over the next months (lvS lags). */
  refreshTransit() {
    this.computeTransit();
    this.computeRiders();
    this.computeLandValue();
  }

  protected applyEvent(cmd: Command) {
    if (cmd.type !== 'choose' || !this.pending || this.pending.def.id !== cmd.event) return;
    const choices = this.pending.variant ? this.pending.variant.choices : this.pending.def.choices;
    const ch = choices[cmd.choice];
    if (!ch) return;
    for (const e of ch.effects) this.applyEffect(e);
    this.resolved[cmd.event] = { month: this.month, choice: cmd.choice };
    this.lastEventMonth = this.month;
    this.say(`${fill(this.pending.variant?.title ?? this.pending.def.title, this.pending.vars)}: ${fill(ch.label, this.pending.vars)}`);
    this.pending = null;
  }

  // ---------------------------------------------------------------- events
  private checkEvents() {
    if (this.pending) return;
    for (const def of EVENTS) {
      if (this.fired[def.id] !== undefined) continue;
      if (def.landmark) {
        const after = def.id.endsWith('_after');
        if (this.month < this.lastEventMonth + (after ? 3 : 10)) continue; // proposals are spread out
        if (!after && [...this.lm.states.values()].filter((q) => q.state === 'building').length >= 2) continue;
        const ld = LANDMARKS.find((x) => x.id === def.landmark)!;
        if (!this.lm.allowed(ld)) continue;
        if (def.id.endsWith('_after') && ![...this.lm.states.values()].some((st) => LANDMARKS[st.def].id === ld.id && st.state === 'open')) continue;
      }
      if (def.requires) {
        const q = def.requires;
        if (q.site && (!q.site.includes(this.cp.site) || this.g.docksCells.length < 4)) continue;
        if (q.origin && !q.origin.includes(this.cp.origin) && !(q.history && this.cp.history.some((h) => q.history!.includes(h.kind)))) continue;
      }
      const t = def.trigger;
      if (t.monthAtLeast !== undefined && this.month < t.monthAtLeast) continue;
      if (t.popAtLeast !== undefined && this.homes * PERSONS_PER_HOME < t.popAtLeast) continue;
      if (t.after) {
        const r = this.resolved[t.after.event];
        if (!r || this.month < r.month + t.after.months) continue;
      }
      const vars = this.eventVars();
      let variant: Variant | null = null;
      if (def.variants) {
        variant = def.variants.find((v) => (v.when.deal === undefined || v.when.deal === this.docks.deal?.id) &&
          (v.when.late === undefined || v.when.late === (Number(vars.locked) > Math.max(2, Number(vars.planned) * 0.15))) &&
          (v.when.served === undefined || v.when.served === this.lm.servedFor(def.landmark ?? ''))) ?? null;
        if (!variant) { this.fired[def.id] = this.month; continue; }
      }
      this.fired[def.id] = this.month;
      this.pending = { def, variant, vars };
      return;
    }
  }

  docksLots(): Lot[] { return this.liveLots.filter((l) => l.flags & Flag.Docks); }

  private eventVars(): Record<string, string | number> {
    let planned = 0, built = 0, locked = 0, homes = 0, dT = 0, dW = 0, cong = 0, cz = 0, plots = 0;
    for (const l of this.docksLots()) {
      plots++;
      if (l.planLevel) planned++;
      if (l.planLevel && !(l.flags & Flag.Planned) && l.type) built++;
      if (l.flags & Flag.CarLocked) locked++;
      const h = this.lotHomes(l);
      homes += h;
      const z = this.zoneOf(l.cell);
      dT += (h || 1) * this.zTransitShare[z]; dW += h || 1;
      cong += this.zCong[z]; cz++;
    }
    const pct = (v: number) => Math.round(v * 100);
    return {
      ...SITE_TEXT[this.cp.site], village: this.g.villages[0]?.name ?? 'harbour', cells: plots, homes, planned, built, locked,
      share: pct(dW ? dT / dW : 0), cityShare: pct(this.totalTrips ? this.transitTrips / this.totalTrips : 0), cong: pct(cz ? cong / cz : 0),
    };
  }

  private applyEffect(e: Effect) {
    switch (e.kind) {
      case 'money': this.money += e.amount; break;
      case 'log': this.say(e.text); break;
      case 'docksDeal': {
        const d = { ...e.deal, name: fill(e.deal.name, this.eventVars()) };
        this.docks = { state: 'active', deal: d, start: this.month, deadline: d.deadline ? this.month + d.deadline : 0, roadRelief: false, lateLogged: false };
        for (const l of this.docksLots()) {
          l.type = BT.None; l.level = 0; l.constr = 0; l.target = 0;
          const r = this.rng.next();
          let t: number = BT.Res, lv = 1;
          if (d.density === 'high') { if (r < 0.34) lv = 3; else if (r < 0.66) lv = 2; else if (r < 0.82) { t = BT.Com; lv = 3; } else { t = BT.Com; lv = 2; } }
          else if (d.density === 'mid') { if (r < 0.7) lv = 2; else { t = BT.Com; lv = 2; } }
          else { lv = r < 0.45 ? 2 : 1; if (r > 0.9) t = BT.Com; }
          l.planType = t; l.planLevel = lv;
          l.flags |= Flag.Planned;
          if (d.carLockAll) l.flags |= Flag.CarLocked;
        }
        this.say(`Docks deal signed with ${d.name}${d.deadline ? `: metro needed within ${d.deadline} months` : ''}`);
        break;
      }
      case 'docksExtraPlots': {
        const c = this.docksCentre();
        const cands = this.lots.near(c.x, c.y, 14).filter((l) => !l.type && !(l.flags & (Flag.Planned | Flag.Docks)))
          .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y) || a.id - b.id);
        for (const l of cands.slice(0, e.count)) { l.flags |= Flag.Docks | Flag.Planned; l.planType = BT.Res; l.planLevel = 3; }
        this.docks.state = 'active';
        this.docks.deadline = this.month + 12;
        this.docks.lateLogged = false;
        this.say(`${Math.min(e.count, cands.length)} more tower plots planned at the docks: service needed within 12 months`);
        break;
      }
      case 'docksPark': {
        const ls = this.docksLots().sort((a, b) => a.level - b.level || a.id - b.id).slice(0, 2);
        for (const l of ls) { l.type = BT.Park; l.level = 1; l.constr = 0; l.flags &= ~Flag.Planned; l.planLevel = 0; }
        this.say(SITE_TEXT[this.cp.site].parkLabel);
        break;
      }
      case 'landmark': {
        const def = LANDMARKS.find((x) => x.id === e.id)!;
        if (!this.lm.place(e.id, e.site, e.pay)) { if (e.pay === 'city') this.money += def.cost; else this.money -= def.cost * 0.2; }
        break;
      }
      case 'lmCarPark': this.lm.setCarPark(e.id); this.say('Car park extended'); break;
      case 'docksRoadRelief': this.docks.roadRelief = true; this.say('Bus lanes painted along the harbour roads'); break;
    }
  }

  docksCentre() {
    const c = this.g.docksCells;
    if (!c.length) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const i of c) { x += (i % N) + 0.5; y += ((i / N) | 0) + 0.5; }
    return { x: x / c.length, y: y / c.length };
  }

  /** Best walk time (minutes, over streets) from any station on a line to this cell. */
  walkToStation(cell: number): number {
    let b = Infinity;
    for (const f of this.walk) if (f[cell] < b) b = f[cell];
    return b;
  }

  private docksTick() {
    if (this.docks.state !== 'active') return;
    const late = this.docks.deadline > 0 && this.month > this.docks.deadline;
    let remaining = 0, starts = 0, newlyLocked = 0;
    for (const l of this.docksLots()) {
      if (!(l.flags & Flag.Planned)) continue;
      if (l.constr) { remaining++; continue; }
      if (l.type === l.planType && l.level >= l.planLevel) { l.flags &= ~Flag.Planned; continue; }
      remaining++;
      const locked = (l.flags & Flag.CarLocked) !== 0;
      const build = () => {
        // the developer captures regional demand: docks homes/jobs come out of the city's pools
        if (l.planType === BT.Res) this.resPool -= HOMES[l.planLevel] * this.capOf(l); else this.comPool -= COM_JOBS[l.planLevel] * this.capOf(l);
        this.startBuild(l, l.planType, l.planLevel);
        starts++;
      };
      if (!locked && this.walkToStation(l.cell) <= TUNE.serveWalk) { if (starts < 6) build(); }
      else if (locked) { if (starts < 6) { l.planLevel = Math.min(l.planLevel, 2); build(); } }
      else if (late) { l.flags |= Flag.CarLocked; l.planLevel = Math.min(l.planLevel, 2); newlyLocked++; }
    }
    if (newlyLocked && !this.docks.lateLogged) {
      this.docks.lateLogged = true;
      this.say(`Docks deadline missed: ${newlyLocked} blocks go car-first, residents buy cars`);
    }
    if (remaining === 0) { this.docks.state = 'done'; this.say(SITE_TEXT[this.cp.site].done); }
  }

  docksInfo(): DocksInfo {
    const d = this.docks;
    let served = 0, planned = 0, locked = 0, built = 0;
    for (const l of this.docksLots()) {
      if (!l.planLevel) continue;
      planned++;
      if (l.flags & Flag.CarLocked) locked++;
      if (!(l.flags & Flag.Planned)) built++;
      if (d.state === 'active' && this.walkToStation(l.cell) <= TUNE.serveWalk) served++;
    }
    const deal = d.deal;
    const brief = !deal ? '' : deal.carLockAll
      ? 'Car-oriented district: builds without a station, but every household owns cars.'
      : 'Every block needs a station on a line within an 8-minute walk (about 600 m) along the streets. Unserved blocks after the deadline go car-first.';
    return { state: d.state, title: SITE_TEXT[this.cp.site].project, deal: deal?.id ?? '', dealName: deal?.name ?? '', brief, deadline: d.deadline, served, planned, carLocked: locked, built, centre: this.docksCentre() };
  }

  eventInfo(): EventInfo | null {
    const p = this.pending;
    if (!p) return null;
    const choices = p.variant ? p.variant.choices : p.def.choices;
    return { id: p.def.id, title: fill(p.variant?.title ?? p.def.title, p.vars), text: fill(p.variant?.text ?? p.def.text, p.vars), choices: choices.map((c) => ({ label: fill(c.label, p.vars), detail: fill(c.detail, p.vars) })) };
  }

  paused(): boolean { return this.pending !== null; }

  quoteLine(stations: number[]) {
    const q = this.metro.quote(stations, this.g.water);
    return { cost: q.cost, km: q.km, underwaterKm: q.wkm };
  }

  say(s: string) {
    this.log.push(`${this.month}|${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  // ---------------------------------------------------------------- monthly tick
  tick() {
    this.month++;
    this.progressConstruction();
    this.lm.tick();
    this.aggregate();
    this.computeCongestion();
    this.computeDriveTimes();
    this.computeTransit();
    this.computeRiders();
    this.computeLandValue();
    for (let i = 0; i < N * N; i++) this.lvS[i] += (this.lv[i] - this.lvS[i]) * TUNE.lvLag;
    this.field.update(this);
    this.grow();
    this.resubdivide();
    this.docksTick();
    this.extendRoads();
    this.upgradeRoads();
    this.finance();
    this.checkEvents();
  }

  private progressConstruction() {
    for (const l of this.lots.lots) {
      if (!l.alive) continue;
      l.age = Math.min(65000, l.age + 1);
      if (l.demo > 0 && --l.demo === 0) { if (l.ntype) l.type = l.ntype; l.ntype = 0; l.level = 0; }
      if (l.constr > 0 && --l.constr === 0) { l.level = l.target; l.hgt = l.nhgt; l.nhgt = 0; l.target = 0; l.age = 0; l.built = this.month; }
    }
  }

  /** Capacity of a plot relative to a standard detached one: follows frontage width, denser tiers stack a bit more. */
  capOf(l: Lot) { return (l.w / LOT_W) * (1 + 0.15 * l.dens); }
  /** Homes (Res) or jobs (Com / Ind) a building of this kind, level and height holds on the plot: storeys x a per-storey figure for mid and high rise. */
  capacity(l: Lot, kind: number, level: number, h: number): number {
    if (level <= 0) return 0;
    const cap = this.capOf(l), floors = Math.max(2, Math.round(h / 3.3));
    if (kind === BT.Res) return (level === 1 || !h ? HOMES[level] : floors * (level === 3 ? 17 : 11)) * cap;
    if (kind === BT.Com) return (level === 1 || !h ? COM_JOBS[level] : floors * 17) * cap;
    if (kind === BT.Ind) return IND_JOBS[level] * cap;
    return 0;
  }
  lotHomes(l: Lot) { return l.type === BT.Res ? Math.round(this.capacity(l, BT.Res, l.level, l.hgt)) : 0; }
  lotJobs(l: Lot) { return l.type === BT.Com || l.type === BT.Ind ? Math.round(this.capacity(l, l.type, l.level, l.hgt)) : 0; }

  /** Height of a new mid / high-rise building on this plot: capped by the field's allowed height and by the plot's width (tall needs a wide plot). */
  pickHeight(l: Lot, level: number): number {
    if (level < 2) return 0;
    const hm = this.field.hmaxAt(l.x, l.y), r = hash01(l.id, this.month);
    if (level === 2) return Math.round(Math.min(24, Math.max(13, hm)) * (0.72 + 0.28 * r));
    const wcap = 24 + 70 * Math.max(0, l.w - 0.4);
    return Math.round(Math.max(FIELD.level3, Math.min(hm, wcap) * (0.62 + 0.38 * r)));
  }

  /** District profile for new street frontage: the old industrial site, the nearest quarter's core / mid / outer profile, downtown near stations or at high value. */
  profileAt(x: number, y: number): number {
    const gx = Math.floor(x), gy = Math.floor(y);
    if (gx >= 0 && gy >= 0 && gx < N && gy < N && (this.g.flags[gy * N + gx] & Flag.Docks)) return PROFILE_INDEX[this.cp.site === 'harbour' ? 'docks' : 'railside'];
    let dq = this.town.districts[0], dc = Infinity;
    for (const d of this.town.districts) { const dd = Math.hypot(d.x - x, d.y - y); if (dd < dc) { dc = dd; dq = d; } }
    const F = this.field.fAt(x, y);
    const Z = ZONING;
    const q = dq ?? { core: PROFILE_INDEX.oldTown, mid: PROFILE_INDEX.terraces, outer: PROFILE_INDEX.suburb, coreR: Z.coreRadius, midR: Z.midRadius };
    if (dc < (q.coreR ?? Z.coreRadius)) return q.core ?? PROFILE_INDEX.oldTown;
    if (F > Z.cbdF) return PROFILE_INDEX.downtown;
    if (dc < (q.midR ?? Z.midRadius) && F > Z.innerF || F > Z.midF) return q.mid ?? PROFILE_INDEX.terraces;
    return q.outer ?? PROFILE_INDEX.suburb;
  }

  homesAt(i: number) { return this.cHomes[i]; }
  jobsAt(i: number) { return this.cJobs[i]; }
  zoneOf(i: number) { return (((i / N) | 0) / ZONE | 0) * NZ + ((i % N) / ZONE | 0); }

  aggregate() {
    const g = this.g;
    this.cHomes.fill(0); this.cJobs.fill(0); this.cInd.fill(0); this.cPark.fill(0); this.cBuilt.fill(0);
    this.zHomes.fill(0); this.zJobs.fill(0); this.zRoads.fill(0); this.zCarLocked.fill(0);
    let h = 0, j = 0, jx = 0, jy = 0;
    for (const l of this.lots.lots) {
      if (!l.alive || !l.type) continue;
      const hh = this.lotHomes(l), jj = this.lotJobs(l), z = this.zoneOf(l.cell);
      this.cHomes[l.cell] += hh; this.cJobs[l.cell] += jj;
      if (!isAmenity(l.type) && l.level > 0) this.cBuilt[l.cell]++;
      if (l.type === BT.Ind) this.cInd[l.cell] += l.level;
      if (l.type === BT.Park || l.type === BT.Square) this.cPark[l.cell] += 1;
      else if (l.type === BT.Landmark) this.cPark[l.cell] += l.level > 0 ? (landmarkAt(l.lm)?.value ?? 0.5) * 3 : 0;
      this.zHomes[z] += hh; this.zJobs[z] += jj; h += hh; j += jj;
      if (l.flags & Flag.CarLocked) this.zCarLocked[z] += hh;
      jx += (jj + hh * 0.3) * l.x; jy += (jj + hh * 0.3) * l.y;
    }
    for (let i = 0; i < N * N; i++) if (g.road[i]) this.zRoads[this.zoneOf(i)]++;
    for (let z = 0; z < ZONES; z++) this.zCarLocked[z] = this.zHomes[z] > 0 ? this.zCarLocked[z] / this.zHomes[z] : 0;
    this.homes = h; this.jobs = j;
    const w = j + h * 0.3;
    if (w > 0) this.centre = { x: jx / w, y: jy / w };
    const rd = this.roadDist;
    rd.fill(9);
    const q: number[] = [];
    for (let i = 0; i < N * N; i++) if (g.road[i]) { rd[i] = 0; q.push(i); }
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      if (rd[i] >= 5) continue;
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const jn = idx(nx, ny);
        if (rd[jn] > rd[i] + 1) { rd[jn] = rd[i] + 1; q.push(jn); }
      }
    }
  }

  private computeCongestion() {
    const ends = new Float64Array(ZONES);
    for (let z = 0; z < ZONES; z++) {
      const car = 1 - this.zTransitShare[z] * 0.9;
      ends[z] = (this.zHomes[z] * WORKERS_PER_HOME * 2 + this.zJobs[z] * 1.2) * car;
    }
    const docksZ = this.docksZones();
    let vol = 0, wsum = 0, ssum = 0, wc = 0;
    for (let zy = 0; zy < NZ; zy++)
      for (let zx = 0; zx < NZ; zx++) {
        let e = 0, r = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ax = zx + dx, ay = zy + dy;
            if (ax < 0 || ay < 0 || ax >= NZ || ay >= NZ) continue;
            const wgt = dx === 0 && dy === 0 ? 1 : 0.5;
            e += ends[ay * NZ + ax] * wgt; r += this.zRoads[ay * NZ + ax] * wgt;
          }
        const z = zy * NZ + zx;
        const relief = this.docks.roadRelief && docksZ.has(z) ? 1.6 : 1;
        const vc = r > 0 ? e / (r * TUNE.roadCap * relief) : 0;
        this.zCong[z] = vc;
        this.zSpeed[z] = TUNE.freeSpeed / (1 + TUNE.bprA * Math.pow(vc, TUNE.bprB));
        vol += ends[z]; wsum += ends[z]; ssum += ends[z] * this.zSpeed[z]; wc += ends[z] * vc;
      }
    this.congestion = vol > 0 ? wc / vol : 0;
    this.driveSpeed = wsum > 0 ? ssum / wsum : TUNE.freeSpeed;
  }

  private _docksZones: Set<number> | null = null;
  docksZones() {
    if (!this._docksZones) this._docksZones = new Set(this.g.docksCells.map((i) => this.zoneOf(i)));
    return this._docksZones;
  }

  private computeDriveTimes() {
    const dt = this.driveTime;
    for (let a = 0; a < ZONES; a++) {
      const ax = (a % NZ) + 0.5, ay = ((a / NZ) | 0) + 0.5;
      for (let b = 0; b < ZONES; b++) {
        const bx = (b % NZ) + 0.5, by = ((b / NZ) | 0) + 0.5;
        const mx = Math.min(NZ - 1, Math.floor((ax + bx) / 2)), my = Math.min(NZ - 1, Math.floor((ay + by) / 2));
        const dist = a === b ? 300 : Math.hypot(ax - bx, ay - by) * ZONE * CELL * TUNE.circuity;
        const sp = (this.zSpeed[a] + this.zSpeed[b] + this.zSpeed[my * NZ + mx] + this.driveSpeed) / 4;
        dt[a * ZONES + b] = (dist / 1000) / sp * 60 + TUNE.accessMin;
      }
    }
    const J = this.jobs || 1;
    for (let a = 0; a < ZONES; a++) {
      let s = 0;
      for (let b = 0; b < ZONES; b++) if (this.zJobs[b] > 0) s += this.zJobs[b] * Math.exp(-dt[a * ZONES + b] / TUNE.tau);
      this.zCarAcc[a] = s / J;
    }
  }

  /**
   * Station catchments follow the street network: Dijkstra from each station over road nodes at walking speed,
   * then each cell takes its nearest node's time plus the walk to it. A station across a river with no bridge barely helps.
   */
  private computeWalkFields(used: { id: number; x: number; y: number }[]) {
    const key = `${this.roads.version}|${used.map((s) => `${s.id}:${s.x.toFixed(2)},${s.y.toFixed(2)}`).join(';')}`;
    if (key === this.walkKey) return;
    this.walkKey = key;
    const R = this.roads, M = R.nx.length, sp = TUNE.walkSpeed / CELL; // cells per minute
    const cap = TUNE.walkCap;
    this.walk = [];
    for (const st of used) {
      const t = new Float32Array(M).fill(Infinity);
      const heap = new MinHeap();
      // street access from the station entrance (straight-line walk to nearby nodes)
      for (let n = 0; n < M; n++) {
        if (!R.adj[n].length) continue;
        const d = Math.hypot(R.nx[n] - st.x, R.ny[n] - st.y);
        if (d < 2.5) { const v = (d * 1.2) / sp; if (v < t[n]) { t[n] = v; heap.push(n, v); } }
      }
      while (heap.size) {
        const n = heap.pop();
        const tn = t[n];
        if (tn > cap) continue;
        for (const e of R.adj[n]) {
          const o = R.other(e, n);
          const v = tn + R.edgeLen(e) / sp;
          if (v < t[o]) { t[o] = v; heap.push(o, v); }
        }
      }
      const f = new Float32Array(N * N).fill(Infinity);
      const stamp = (px: number, py: number, base: number, r: number) => {
        for (let y = Math.floor(py - r); y <= Math.floor(py + r); y++)
          for (let x = Math.floor(px - r); x <= Math.floor(px + r); x++) {
            if (x < 0 || y < 0 || x >= N || y >= N) continue;
            const i = y * N + x;
            if (this.g.water[i]) continue;
            const v = base + (Math.hypot(x + 0.5 - px, y + 0.5 - py) * 1.2) / sp;
            if (v < f[i]) f[i] = v;
          }
      };
      stamp(st.x, st.y, 0, 2);
      for (let n = 0; n < M; n++) if (t[n] <= cap) stamp(R.nx[n], R.ny[n], t[n], 2.2);
      // edges: interpolate along long segments so mid-block cells are reached too
      for (let e = 0; e < R.ea.length; e++) {
        if (!R.alive[e]) continue;
        const a = R.ea[e], b = R.eb[e];
        if (!(t[a] <= cap || t[b] <= cap)) continue;
        const L = R.edgeLen(e), steps = Math.floor(L / 1.2);
        for (let k = 1; k < steps; k++) {
          const u = k / steps;
          const base = Math.min(t[a] + (L * u) / sp, t[b] + (L * (1 - u)) / sp);
          if (base <= cap) stamp(R.nx[a] + (R.nx[b] - R.nx[a]) * u, R.ny[a] + (R.ny[b] - R.ny[a]) * u, base, 1.6);
        }
      }
      this.walk.push(f);
    }
  }

  /** Transit accessibility: travel time = walk + wait + ride + transfers + crowding, smooth exp decay (no cutoffs). */
  computeTransit() {
    const m = this.metro;
    m.rebuildGraph();
    this.transitCell.fill(0);
    this.stationPrem.fill(0);
    this.accCell.fill(0);
    const S = m.sIndex.size;
    this.stAccess = new Float64Array(S);
    this.zoneNear = [];
    for (let z = 0; z < ZONES; z++) this.zoneNear.push([]);
    this.egress = new Float64Array(S * ZONES).fill(Infinity);
    this.egressVia = new Int32Array(S * ZONES).fill(-1);
    const used = m.stations.filter((st) => m.sIndex.has(st.id)).sort((a, b) => m.sIndex.get(a.id)! - m.sIndex.get(b.id)!);
    this.computeWalkFields(used);
    if (S === 0) return;
    // walk from each zone's activity centroid (homes + jobs)
    const ax = new Float64Array(ZONES), ay = new Float64Array(ZONES), aw = new Float64Array(ZONES);
    for (let i = 0; i < N * N; i++) {
      const w = this.cHomes[i] + this.cJobs[i];
      if (!w) continue;
      const z = this.zoneOf(i);
      ax[z] += w * (i % N + 0.5); ay[z] += w * (((i / N) | 0) + 0.5); aw[z] += w;
    }
    for (let z = 0; z < ZONES; z++) {
      const cx = aw[z] ? ax[z] / aw[z] : (z % NZ + 0.5) * ZONE, cy = aw[z] ? ay[z] / aw[z] : (((z / NZ) | 0) + 0.5) * ZONE;
      const cell = Math.floor(cy) * N + Math.floor(cx);
      for (let k = 0; k < S; k++) {
        const wt = this.walk[k][cell];
        if (wt < TUNE.walkCap) this.zoneNear[z].push({ s: k, w: wt + 1 });
      }
    }
    const T = m.T, eg = this.egress;
    for (let b = 0; b < ZONES; b++)
      for (const { s: t, w } of this.zoneNear[b])
        for (let s = 0; s < S; s++) {
          if (s === t) continue;
          const v = T[s * S + t] + w;
          if (v < eg[s * ZONES + b]) { eg[s * ZONES + b] = v; this.egressVia[s * ZONES + b] = t; }
        }
    const J = Math.max(1, this.jobs);
    for (let s = 0; s < S; s++) {
      let a = 0;
      for (let b = 0; b < ZONES; b++) if (this.zJobs[b] > 0 && eg[s * ZONES + b] < Infinity) a += this.zJobs[b] * Math.exp(-eg[s * ZONES + b] / TUNE.tau);
      this.stAccess[s] = a / J;
    }
    for (let s = 0; s < S; s++) {
      const A = this.stAccess[s], f = this.walk[s];
      const premK = TUNE.stationPrem * Math.min(1, A / 0.1);
      for (let i = 0; i < N * N; i++) {
        const wt = f[i];
        if (!(wt < TUNE.walkCap)) continue;
        const fade = 1 - clamp((wt - TUNE.walkFade) / (TUNE.walkCap - TUNE.walkFade), 0, 1);
        const val = A * Math.exp(-wt / TUNE.walkDecay) * fade;
        if (val > this.transitCell[i]) this.transitCell[i] = val;
        const p = premK * Math.max(0, 1 - wt / TUNE.premWalk);
        if (p > this.stationPrem[i]) this.stationPrem[i] = p;
        const av = Math.min(1, A / FIELD.accRef) * clamp((FIELD.walkZero - wt) / (FIELD.walkZero - FIELD.walkFull), 0, 1);
        if (av > this.accCell[i]) this.accCell[i] = av;
      }
    }
  }

  zoneSampleXY(f: Float64Array, x: number, y: number): number {
    const fx = x / ZONE - 0.5, fy = y / ZONE - 0.5;
    const x0 = clamp(Math.floor(fx), 0, NZ - 1), y0 = clamp(Math.floor(fy), 0, NZ - 1);
    const x1 = Math.min(NZ - 1, x0 + 1), y1 = Math.min(NZ - 1, y0 + 1);
    const tx = clamp(fx - x0, 0, 1), ty = clamp(fy - y0, 0, 1);
    return (f[y0 * NZ + x0] * (1 - tx) + f[y0 * NZ + x1] * tx) * (1 - ty) + (f[y1 * NZ + x0] * (1 - tx) + f[y1 * NZ + x1] * tx) * ty;
  }

  /** Bilinear sample of a cell field at a point (cell units). */
  fieldAt(f: Float32Array, x: number, y: number): number {
    const fx = x - 0.5, fy = y - 0.5;
    const x0 = clamp(Math.floor(fx), 0, N - 1), y0 = clamp(Math.floor(fy), 0, N - 1);
    const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
    const tx = clamp(fx - x0, 0, 1), ty = clamp(fy - y0, 0, 1);
    return (f[y0 * N + x0] * (1 - tx) + f[y0 * N + x1] * tx) * (1 - ty) + (f[y1 * N + x0] * (1 - tx) + f[y1 * N + x1] * tx) * ty;
  }

  computeLandValue() {
    const g = this.g;
    const ind = new Float32Array(N * N), park = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const vi = this.cInd[i], vp = this.cPark[i];
      if (!vi && !vp) continue;
      const x = i % N, y = (i / N) | 0;
      for (const [v, R, out] of [[vi, 4, ind], [vp, 3, park]] as [number, number, Float32Array][]) {
        if (!v) continue;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (!inb(x + dx, y + dy)) continue;
          const f = 1 - Math.hypot(dx, dy) / (R + 1);
          if (f > 0) out[idx(x + dx, y + dy)] += f * v;
        }
      }
    }
    const cx = this.centre.x, cy = this.centre.y;
    for (let i = 0; i < N * N; i++) {
      if (g.water[i]) { this.lv[i] = 0; continue; }
      const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
      const rdf = [1, 1, 0.85, 0.65, 0.45, 0.35][Math.min(5, this.roadDist[i])] ?? 0.3;
      const car = this.zoneSampleXY(this.zCarAcc, x, y) * rdf;
      const dw = g.distWater[i];
      const water = dw <= 4 ? TUNE.wWater * (1 - (dw - 1) / 4) : 0;
      const pk = Math.min(0.15, park[i] * TUNE.wPark);
      const nz = Math.min(0.4, ind[i] * TUNE.wInd);
      const dc = Math.hypot(x - cx, y - cy) / (N * 0.5);
      let v = TUNE.base + TUNE.wCar * car + TUNE.wTransit * this.transitCell[i] + this.stationPrem[i] + water + pk - nz - TUNE.wCentre * dc;
      if (g.flags[i] & Flag.Steep) v -= 0.2;
      this.lv[i] = clamp(v, 0, 1.5);
    }
  }

  /** Ridership-weighted pull of nearby busy stations (0..1), over the street network. */
  stationPull(cell: number): number {
    let p = 0;
    const m = this.metro;
    for (const st of m.stations) {
      const k = m.sIndex.get(st.id);
      if (k === undefined || !this.walk[k]) continue;
      const wt = this.walk[k][cell];
      if (wt < 12) p += Math.min(1, st.riders / 4000) * Math.exp(-wt / 5);
    }
    return Math.min(1, p);
  }

  // ---------------------------------------------------------------- growth
  private grow() {
    const workers = this.homes * WORKERS_PER_HOME;
    const scale = Math.max(400, workers);
    this.resDemand = clamp((this.jobs - workers * 0.95) / scale * 3 + 0.35, -1, 1);
    this.comDemand = clamp((workers * 0.95 - this.jobs) / scale * 3 + 0.35, -1, 1);
    const lots = this.liveLots;
    let indJobs = 0, lvSum = 0, lvN = 0;
    for (const l of lots) {
      if (l.type === BT.Ind) indJobs += this.lotJobs(l);
      if (l.type === BT.Res) { lvSum += this.lvS[l.cell]; lvN++; }
    }
    this.indDemand = clamp(0.5 - (indJobs / Math.max(1, this.jobs)) * 3, -1, 1);
    const attract = lvN ? lvSum / lvN : 0.4;
    const congPenalty = 1 / (1 + 1.2 * Math.max(0, this.congestion - 0.6));
    const B = Math.max(TUNE.minGrowth, this.homes * TUNE.growth * (0.6 + 0.6 * attract) * congPenalty);
    this.resPool = this.resPool * 0.85 + B * Math.max(0.05, 0.5 + 0.5 * this.resDemand);
    const jobB = B * WORKERS_PER_HOME * Math.max(0.05, 0.5 + 0.5 * this.comDemand);
    this.comPool = this.comPool * 0.85 + jobB * (this.indDemand > 0 ? 0.75 : 0.92);
    this.indPool = this.indPool * 0.85 + jobB * (this.indDemand > 0 ? 0.25 : 0.08);
    const pR = clamp(this.resPool / (B * 4), 0, 1), pC = clamp(this.comPool / (jobB * 4 + 1), 0, 1);
    this.pressure = (pR + pC) / 2;
    const spawnR = TUNE.spawnLV - 0.14 * pR, spawnC = TUNE.spawnLV - 0.14 * pC;

    type Cand = { l: Lot; s: number; kind: number; to: number; h: number };
    const res: Cand[] = [], com: Cand[] = [], ind: Cand[] = [];
    const F = this.field;
    const built3 = (cell: number) => {
      const cx = cell % N, cy = (cell / N) | 0;
      let b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < N && y < N) b += this.cBuilt[y * N + x]; }
      return b;
    };
    for (const l of lots) {
      if (l.constr || (l.flags & (Flag.Planned | Flag.Docks)) && !l.type) continue;
      if (l.flags & Flag.Planned) continue;
      const v = this.fieldAt(this.lvS, l.x, l.y), t = l.type, lv = l.level;
      const jit = this.rng.next() * 0.12;
      const pf = this.profiles[l.prof], fr = (0.5 + pf.landUseMix.res) * pf.growthRate, fc = (0.5 + pf.landUseMix.com) * pf.growthRate, fi = (0.5 + pf.landUseMix.ind) * pf.growthRate;
      const maxL = F.maxLevel(l.x, l.y);
      if (t === BT.None) {
        if (v < Math.min(spawnR, spawnC)) continue;
        const pull = this.stationPull(l.cell);
        const front = l.cls === RC.Arterial ? 0.1 : l.cls === RC.Collector ? 0.05 : 0;
        // fill the built-up area first: neighbours and the field's density class pull growth inward
        const fill = 0.1 * Math.min(1, built3(l.cell) / 5) + 0.2 * F.fAt(l.x, l.y);
        if (v >= spawnR) res.push({ l, s: (v + jit + fill) * fr, kind: BT.Res, to: 1, h: 0 });
        if (v >= spawnC) com.push({ l, s: (v * 0.8 + this.zoneSampleXY(this.zCarAcc, l.x, l.y) * 0.5 + this.transitCell[l.cell] * 0.9 + pull * 0.4 + front + jit - 0.12 + fill) * fc, kind: BT.Com, to: 1, h: 0 });
        ind.push({ l, s: (0.6 - v * 0.4 + (this.g.distWater[l.cell] <= 3 ? 0.15 : 0) + this.zoneSampleXY(this.zCarAcc, l.x, l.y) * 0.3 + front + jit) * fi, kind: BT.Ind, to: 1, h: 0 });
      } else if (t === BT.Res && lv < 3) {
        const cap = l.flags & Flag.CarLocked ? 2 : 3;
        if (lv + 1 > cap || lv + 1 > maxL) continue;
        if (v > TUNE.upLV[lv] - 0.1 * pR && l.age >= (lv === 1 ? 10 : 8)) res.push({ l, s: v + 0.05 + jit, kind: BT.Res, to: lv + 1, h: this.pickHeight(l, lv + 1) });
      } else if (t === BT.Com && lv < 3) {
        if (lv + 1 > maxL) continue;
        if (v > TUNE.comUpLV[lv] - 0.1 * pC && l.age >= (lv === 1 ? 5 : 10)) com.push({ l, s: v + 0.1 + jit, kind: BT.Com, to: lv + 1, h: this.pickHeight(l, lv + 1) });
      } else if ((t === BT.Res || t === BT.Com) && lv === 3 && l.hgt > 0 && l.age >= 36 && !(l.flags & Flag.CarLocked)) {
        // a better-connected centre rebuilds its towers taller
        const hm = F.hmaxAt(l.x, l.y);
        if (hm >= 45 && hm > l.hgt * 1.4 && v > 0.7) {
          const h = this.pickHeight(l, 3);
          if (h > l.hgt * 1.25) (t === BT.Res ? res : com).push({ l, s: v + 0.02 + jit, kind: t, to: 3, h });
        }
      }
    }
    const order = (a: Cand, b: Cand) => b.s - a.s || a.l.id - b.l.id;
    res.sort(order); com.sort(order); ind.sort(order);
    const zoneOps = new Uint8Array(ZONES);
    const taken = new Set<number>();
    let towers = 0, mids = 0;
    const place = (list: Cand[], poolKey: 'resPool' | 'comPool' | 'indPool', maxOps: number) => {
      let ops = 0;
      for (const c of list) {
        if (this[poolKey] <= 0 || ops >= maxOps) break;
        if (taken.has(c.l.id)) continue;
        // growth lags: only a few towers and mid-rises start each month
        if (c.to === 3 && towers >= TUNE.maxTowerStarts) continue;
        if (c.to === 2 && mids >= TUNE.maxMidStarts) continue;
        const z = this.zoneOf(c.l.cell);
        if (zoneOps[z] >= 6) continue;
        const add = this.capacity(c.l, c.kind, c.to, c.h) - (c.l.type === c.kind ? this.capacity(c.l, c.kind, c.l.level, c.l.hgt) : 0);
        if (add > this[poolKey] * 2.5 + 10) continue;
        this[poolKey] -= add;
        taken.add(c.l.id); zoneOps[z]++; ops++;
        if (c.to === 3) towers++; else if (c.to === 2) mids++;
        if (c.to >= 2) this.tryMerge(c.l, c.to);
        this.startBuild(c.l, c.kind, c.to);
      }
    };
    if (this.comDemand > this.resDemand) { place(com, 'comPool', 120); place(res, 'resPool', 300); }
    else { place(res, 'resPool', 300); place(com, 'comPool', 120); }
    place(ind, 'indPool', 30);

    // decline: buildings whose value falls empty out
    for (const l of lots) {
      if (!l.type || isAmenity(l.type) || l.constr || (l.flags & Flag.Planned)) continue;
      const v = this.fieldAt(this.lvS, l.x, l.y);
      if (v < TUNE.downLV[l.level]) l.low = Math.min(255, l.low + 1); else l.low = 0;
      if (l.low >= 6 && this.rng.next() < 0.25) {
        l.low = 0;
        l.level--; l.hgt = 0;
        if (l.level === 0) l.type = BT.None;
      }
    }
    if (this.resDemand < -0.6) {
      for (const l of lots) if (l.type === BT.Res && !l.constr && this.lvS[l.cell] < 0.3 && this.rng.next() < 0.02) { l.type = BT.None; l.level = 0; }
    }
    this.placeParks(lots);
    this.carveHubSquares();
  }

  private edgeCursor = 0;
  resubdivided = 0;
  /**
   * Re-subdivision: when the field says a street now belongs to a denser class than the one its plots were cut for
   * (a station opened, jobs concentrated), its vacant plots and old low houses are cleared and the frontage is cut again
   * with the new class's widths, depths and back rows. Occupied plots stay, so the street fills in around them.
   */
  private resubdivide() {
    const R = this.roads, total = R.ea.length;
    if (!total) return;
    let checked = 0, done = 0, k = 0;
    for (; k < total && checked < 80 && done < 4; k++) {
      const e = (this.edgeCursor + k) % total;
      if (!R.alive[e]) continue;
      checked++;
      const old = this.lots.cachedProf(e);
      if (old === undefined) continue;
      const mx = (R.nx[R.ea[e]] + R.nx[R.eb[e]]) / 2, my = (R.ny[R.ea[e]] + R.ny[R.eb[e]]) / 2;
      const np = this.profileAt(mx, my);
      if (np === old) continue;
      const A = this.profiles[old], B = this.profiles[np];
      if (!(B.density > A.density + 0.2 || densClass(B) > densClass(A))) continue;
      if (this.reprofile(e)) done++;
    }
    this.edgeCursor = (this.edgeCursor + k) % total;
  }

  private reprofile(e: number): boolean {
    const ls = (this.lots.byEdge.get(e) ?? []).filter((l) => l.alive);
    if (ls.some((l) => (l.flags & (Flag.Core | Flag.Docks | Flag.Planned)) || l.lm || l.constr || l.demo || l.type === BT.Landmark)) return false;
    for (const l of ls) {
      const vacant = l.type === BT.None;
      const old = (l.type === BT.Res || l.type === BT.Com) && l.level <= 1 && l.age >= 24 && !(l.flags & Flag.CarLocked) && hash01(l.id, 7) < 0.7;
      if (vacant || old) this.lots.remove(l);
    }
    this.lots.forgetEdge(e);
    const fresh = this.lots.frontageAll([e]);
    for (const l of fresh) this.reserveRiverPark(l);
    this.resubdivided++;
    return true;
  }

  /** The busiest stations get a paved square next to the entrance; it raises value around it, so denser buildings edge it. */
  private carveHubSquares() {
    for (const st of this.metro.stations) {
      if (st.riders < 3000) continue;
      const near = this.lots.near(st.x, st.y, 2.8);
      if (near.some((l) => l.type === BT.Square && Math.hypot(l.x - st.x, l.y - st.y) < 3)) continue;
      const pick = near.filter((l) => !l.constr && !(l.flags & (Flag.Docks | Flag.Planned)) && (l.type === BT.None || ((l.type === BT.Res || l.type === BT.Com) && l.level <= 2)))
        .sort((a, b) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(b.x - st.x, b.y - st.y) || a.id - b.id)[0];
      if (!pick) continue;
      pick.type = BT.Square; pick.level = 1; pick.target = 0;
      this.say(`${st.name} square opens by the busy station`);
      return; // one per month
    }
  }

  /** Redevelopment: an existing building is demolished first (one month of rubble), then the new one rises floor by floor. */
  startBuild(l: Lot, type: number, level: number, h?: number) {
    l.nhgt = type === BT.Ind ? 0 : h ?? this.pickHeight(l, level);
    const had = l.level > 0 && l.type !== BT.None;
    if (had) { l.demo = 1; l.ntype = type; } else { l.type = type; l.level = 0; l.demo = 0; l.ntype = 0; }
    l.target = level;
    l.constrTotal = BUILD_MONTHS[level];
    l.constr = BUILD_MONTHS[level] + l.demo;
  }

  /** A bigger building may replace its small row neighbour: the two plots become one. */
  private tryMerge(l: Lot, to: number) {
    if (l.dens === 0 || l.w > 0.7 || (l.flags & (Flag.Core | Flag.Docks | Flag.Planned))) return;
    if (this.rng.next() > (to === 3 ? 0.4 : 0.15)) return;
    const nb = this.lots.near(l.x, l.y, 0.9).filter((o) => o !== l && o.alive && o.dens === l.dens && o.back === l.back && o.cls === l.cls && !o.constr && !o.demo
      && !(o.flags & (Flag.Core | Flag.Docks | Flag.Planned | Flag.CarLocked)) && !isAmenity(o.type) && o.level <= 1 && o.type !== BT.Ind);
    for (const o of nb) if (this.lots.merge(l, o)) break;
  }

  /** As a zone fills with homes, a share of its plots is set aside as parks (small clusters of neighbouring plots next to the housing). */
  private placeParks(lots: Lot[]) {
    const have = new Uint16Array(ZONES);
    const cands: Lot[][] = [];
    for (let z = 0; z < ZONES; z++) cands.push([]);
    for (const l of lots) {
      const z = this.zoneOf(l.cell);
      if (l.type === BT.Park) have[z]++;
      else if (!l.type && !l.flags) cands[z].push(l);
    }
    for (let z = 0; z < ZONES; z++) {
      const want = Math.min(16, Math.floor(this.zHomes[z] / 320));
      if (want < 2 || have[z] >= want || !cands[z].length) continue;
      // prefer plots that already have built neighbours: parks belong to neighbourhoods, not open fields
      const near = cands[z].filter((l) => this.lots.near(l.x, l.y, 1.9).some((o) => o.level > 0 && !isAmenity(o.type)));
      const pool = near.length ? near : cands[z];
      const l = pool[Math.floor(this.rng.next() * pool.length)];
      l.type = BT.Park; l.level = 1;
      let extra = 1 + Math.floor(this.rng.next() * 3);
      for (const o of this.lots.near(l.x, l.y, 1.1)) {
        if (extra <= 0) break;
        if (o === l || o.type || o.flags || Math.hypot(o.x - l.x, o.y - l.y) > 1.1) continue;
        o.type = BT.Park; o.level = 1; extra--;
      }
    }
  }

  // ---------------------------------------------------------------- roads
  private growthField(): GrowthField {
    return {
      lvAt: (x, y) => this.fieldAt(this.lvS, x, y),
      stationPull: (x, y) => this.stationPull(Math.floor(y) * N + Math.floor(x)),
      pressure: this.pressure,
      spawnLV: TUNE.spawnLV,
      year: 2030 + Math.floor(this.month / 12),
    };
  }

  private extendRoads() {
    // frontier: empty plots on good land; when it runs low, the edge explores outward
    let frontier = 0;
    for (const l of this.lots.lots) if (l.alive && !l.type && !l.flags && this.lvS[l.cell] > TUNE.spawnLV + 0.08) frontier += this.capOf(l) * (l.back ? 0.4 : 1);
    const want = 70 + Math.max(0, this.resPool) / 3 + this.homes / 120;
    const exploreOps = frontier > want ? 2 : Math.min(12, 3 + Math.floor((want - frontier) / 15));
    const f = this.growthField();
    const v0 = this.roads.version;
    explore(this.town, f, exploreOps);
    // densification: high value but poor access, biased toward busy stations
    let pull = 0;
    for (const st of this.metro.stations) pull += st.riders;
    const densOps = (this.pressure > 0.3 ? 1 : 0) + (pull > 3000 ? 1 : 0) + (pull > 12000 ? 1 : 0);
    if (densOps) densify(this.town, f, this.roadDist, densOps);
    if (this.roads.version !== v0) {
      this.roads.rasterize(this.g.road);
      for (const l of this.lots.frontageAll(this.roads.drainFresh())) this.reserveRiverPark(l);
    }
  }

  /** Plots on the river bank are kept as a green ribbon of parks (most of them). */
  private reserveRiverPark(l: Lot) {
    const cx = Math.floor(l.x), cy = Math.floor(l.y), g = this.g;
    let river = false;
    for (let dy = -1; dy <= 1 && !river; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < N && y < N && g.water[y * N + x] === Water.River) { river = true; break; }
    }
    if (river && !l.flags && ((l.id * 2654435761) >>> 0) % 100 < 65) { l.type = BT.Park; l.level = 1; }
  }

  /** Streets near busy stations gain importance and are upgraded (local -> collector -> arterial) over time. */
  private upgradeRoads() {
    if (!this.walk.length) return;
    const R = this.roads;
    const m = this.metro;
    let changed = false;
    for (let e = 0; e < R.ea.length; e++) {
      if (!R.alive[e] || R.ecls[e] === RC.Arterial) continue;
      const mx = (R.nx[R.ea[e]] + R.nx[R.eb[e]]) / 2, my = (R.ny[R.ea[e]] + R.ny[R.eb[e]]) / 2;
      const cell = Math.floor(my) * N + Math.floor(mx);
      let gain = 0;
      for (const st of m.stations) {
        const k = m.sIndex.get(st.id);
        if (k === undefined) continue;
        const wt = this.walk[k][cell];
        if (wt < 6) gain += (st.riders / 1000) * (1 - wt / 6);
      }
      if (!gain) continue;
      R.eimp[e] += gain;
      if (R.ecls[e] === RC.Local && R.eimp[e] > 80) { R.ecls[e] = RC.Collector; changed = true; }
      else if (R.ecls[e] === RC.Collector && R.eimp[e] > 600) { R.ecls[e] = RC.Arterial; changed = true; }
    }
    if (changed) R.version++;
  }

  // ---------------------------------------------------------------- riders
  computeRiders() {
    const m = this.metro, S = m.sIndex.size;
    const segLoad = m.lines.map((l) => l.segTime.map(() => [0, 0]));
    const boards = new Float64Array(m.lines.length);
    const stEntries = new Float64Array(S);
    const stOD = new Float64Array(S * S);
    const zTrips = new Float64Array(ZONES), zTransit = new Float64Array(ZONES);
    const attr = new Float64Array(ZONES);
    for (let b = 0; b < ZONES; b++) attr[b] = this.zJobs[b] + 0.3 * this.zHomes[b];
    const zd = (a: number, b: number) => a === b ? 0.3 : Math.hypot((a % NZ) - (b % NZ), ((a / NZ) | 0) - ((b / NZ) | 0)) * ZONE * CELL / 1000;
    const gv = new Float64Array(ZONES);
    const desire: { a: number; b: number; trips: number }[] = [];
    let total = 0, transit = 0;
    // attraction of open landmarks pulls ordinary trips toward their zone
    const lmOpen = this.lm.open();
    for (const o of lmOpen) attr[o.zone] += o.def.attr * (o.st.eventDay ? 1.5 : 1);
    /** Route T trips from zone a to zone b: logistic car / transit choice, stations and desire lines. */
    const route = (a: number, b: number, T: number, asc: number, extraDrive = 0) => {
      const near = this.zoneNear[a] ?? [];
      if (a === b || !near.length) { if (a !== b && T > 30 && zd(a, b) > 1.2) desire.push({ a, b, trips: T }); return; }
      let best = Infinity, bs = -1;
      for (const { s, w } of near) {
        const v = w + this.egress[s * ZONES + b];
        if (v < best) { best = v; bs = s; }
      }
      const drive = this.driveTime[a * ZONES + b] + TUNE.parkMin * Math.min(1, this.zJobs[b] / 2500) + extraDrive;
      // logistic mode choice on the time difference; smooth, no hard cutoff
      const share = bs >= 0 && best < Infinity ? 1 / (1 + Math.exp(TUNE.modeBeta * (best + asc - drive))) : 0;
      const F = T * share;
      if (T * (1 - share) > 30 && zd(a, b) > 1.2) desire.push({ a, b, trips: T * (1 - share) });
      if (F <= 0.01) return;
      transit += F; zTransit[a] += F;
      const t = this.egressVia[bs * ZONES + b];
      if (t >= 0) { stOD[bs * S + t] += F; stEntries[bs] += F; }
    };
    for (let a = 0; a < ZONES; a++) {
      const P = this.zHomes[a] * TRIPS_PER_HOME;
      if (P <= 0) continue;
      let sum = 0;
      for (let b = 0; b < ZONES; b++) { gv[b] = attr[b] > 0 ? attr[b] * Math.exp(-zd(a, b) / TUNE.distDecay) : 0; sum += gv[b]; }
      if (sum <= 0) continue;
      const asc = TUNE.transitASC + this.zCarLocked[a] * TUNE.carLockASC;
      for (let b = 0; b < ZONES; b++) {
        if (gv[b] <= 0) continue;
        const T = P * gv[b] / sum;
        total += T; zTrips[a] += T;
        route(a, b, T, asc);
      }
    }
    // landmark visitors: extra trips from everywhere toward each open landmark (all-day, peaks, weekends) plus event-day crowds
    for (const o of lmOpen) {
      const day = o.def.pattern === 'weekend' ? 0.85 : o.def.pattern === 'events' ? 0.6 : 1;
      const base = o.def.visitors * day, crowd = o.st.eventDay ? o.def.eventTrips : 0;
      if (base + crowd <= 0) continue;
      const w = new Float64Array(ZONES);
      let ws = 0;
      for (let a = 0; a < ZONES; a++) { if (this.zHomes[a] <= 0) continue; w[a] = this.zHomes[a] * Math.exp(-zd(a, o.zone) / (TUNE.distDecay * 2.2)); ws += w[a]; }
      if (ws <= 0) continue;
      const lockAsc = o.st.carPark ? TUNE.carLockASC : 0;
      for (let a = 0; a < ZONES; a++) {
        if (w[a] <= 0) continue;
        const f = w[a] / ws;
        if (base > 0) { total += base * f; zTrips[a] += base * f; route(a, o.zone, base * f, TUNE.transitASC + this.zCarLocked[a] * TUNE.carLockASC + lockAsc); }
        // crowds on an event day cannot all park: driving costs a long walk from far-away parking unless the landmark has its own car park
        if (crowd > 0) { total += crowd * f; zTrips[a] += crowd * f; route(a, o.zone, crowd * f, TUNE.transitASC - 1 + lockAsc, o.st.carPark ? 0 : 28); }
      }
    }
    for (let s = 0; s < S; s++)
      for (let t = 0; t < S; t++) {
        const F = stOD[s * S + t];
        if (F > 0) m.tracePath(s, t, (li, k, dir) => { segLoad[li][k][dir > 0 ? 0 : 1] += F; }, (li) => { boards[li] += F; });
      }
    let rSum = 0, rW = 0;
    m.lines.forEach((l, li) => {
      l.riders = boards[li];
      l.segLoad = segLoad[li].map(([f, r]) => Math.max(f, r) * PEAK_FACTOR);
      l.peakLoad = l.segLoad.reduce((a, b) => Math.max(a, b), 0);
      l.crowd = l.capacity > 0 ? l.peakLoad / l.capacity : 0;
      l.rating = clamp(100 - Math.max(0, l.crowd - 0.7) * 130 - Math.max(0, l.headway - 4) * 4, 0, 100);
      rSum += l.rating * Math.max(1, l.riders); rW += Math.max(1, l.riders);
    });
    for (const st of m.stations) { const k = m.sIndex.get(st.id); st.riders = k === undefined ? 0 : stEntries[k]; }
    this.rating = rW > 0 ? rSum / rW : 0;
    this.transitTrips = transit;
    this.totalTrips = total;
    for (let z = 0; z < ZONES; z++) this.zTransitShare[z] = zTrips[z] > 0 ? zTransit[z] / zTrips[z] : 0;
    const agg = new Map<number, number>();
    for (const d of desire) {
      const k = Math.min(d.a, d.b) * ZONES + Math.max(d.a, d.b);
      agg.set(k, (agg.get(k) ?? 0) + d.trips);
    }
    this.desire = [...agg.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 30).map(([k, v]) => ({ a: Math.floor(k / ZONES), b: k % ZONES, trips: v }));
  }

  // ---------------------------------------------------------------- money
  protected finance() {
    const m = this.metro;
    this.income = this.transitTrips * FARE * 30;
    let trains = 0, km = 0;
    for (const l of m.lines) { trains += l.trains; km += l.lengthKm; }
    this.expenses = trains * TRAIN_MONTH + m.stations.length * STATION_UPKEEP + km * TRACK_UPKEEP_KM;
    this.money += this.income - this.expenses;
  }

  // ---------------------------------------------------------------- output
  initMsg(): InitMsg {
    return { type: 'init', seed: this.seed, height: this.g.height, water: this.g.water, flags: this.g.flags.slice(), villages: this.g.villages, bay: this.g.bay, rail: this.g.rail, mine: this.g.mine, rondpoints: this.g.rondpoints, city: this.cp, profiles: this.profiles };
  }

  stats(): Stats {
    let b = 0;
    for (const l of this.lots.lots) if (l.alive && l.type && !isAmenity(l.type) && (l.level > 0 || l.constr)) b++;
    return {
      month: this.month, population: Math.round(this.homes * PERSONS_PER_HOME), homes: this.homes, jobs: this.jobs,
      money: this.money, income: this.income, expenses: this.expenses, build: this.buildSpend,
      resDemand: this.resDemand, comDemand: this.comDemand, indDemand: this.indDemand,
      congestion: this.congestion, driveSpeed: this.driveSpeed, transitShare: this.totalTrips > 0 ? this.transitTrips / this.totalTrips : 0,
      transitTrips: this.transitTrips, rating: this.rating, buildings: b,
    };
  }

  catchmentRaster(): Uint8Array {
    const out = new Uint8Array(N * N).fill(255);
    for (const f of this.walk) for (let i = 0; i < N * N; i++) { const v = Math.min(255, Math.round(f[i] * 10)); if (v < out[i]) out[i] = v; }
    return out;
  }

  roadsMsg(): RoadsMsg {
    const R = this.roads;
    const es = R.aliveEdges();
    const nodes = new Float32Array(R.nx.length * 2);
    for (let n = 0; n < R.nx.length; n++) { nodes[n * 2] = R.nx[n]; nodes[n * 2 + 1] = R.ny[n]; }
    return {
      version: R.version, nodes, ids: Int32Array.from(es), ea: Int32Array.from(es.map((e) => R.ea[e])), eb: Int32Array.from(es.map((e) => R.eb[e])),
      cls: Uint8Array.from(es.map((e) => R.ecls[e])), year: Uint16Array.from(es.map((e) => R.eyear[e])),
    };
  }

  lotsMsg(): LotsMsg {
    const ls = this.liveLots;
    const n = ls.length;
    const f = () => new Float32Array(n), u = () => new Uint8Array(n);
    const m: LotsMsg = { n, id: new Int32Array(n), x: f(), y: f(), ang: f(), w: f(), d: f(), type: u(), level: u(), target: u(), constr: u(), constrTotal: u(), flags: u(), planType: u(), planLevel: u(), served: u(),
      hgt: u(), nhgt: u(), poly: new Float32Array(n * 8), dens: u(), prof: u(), sides: u(), back: u(), demo: u(), seed: new Uint32Array(n), built: new Uint16Array(n), ntype: u(), lm: u() };
    ls.forEach((l, k) => {
      m.poly.set(l.poly, k * 8); m.dens[k] = l.dens; m.prof[k] = l.prof; m.sides[k] = l.sides; m.back[k] = l.back; m.demo[k] = l.demo; m.seed[k] = l.seed; m.built[k] = l.built; m.ntype[k] = l.ntype; m.lm[k] = l.lm; m.hgt[k] = Math.min(255, l.hgt); m.nhgt[k] = Math.min(255, l.nhgt);
      m.id[k] = l.id; m.x[k] = l.x; m.y[k] = l.y; m.ang[k] = l.ang; m.w[k] = l.w; m.d[k] = l.d;
      m.type[k] = l.type; m.level[k] = l.level; m.target[k] = l.target; m.constr[k] = l.constr; m.constrTotal[k] = l.constrTotal;
      m.flags[k] = l.flags; m.planType[k] = l.planType; m.planLevel[k] = l.planLevel;
      m.served[k] = (l.flags & Flag.Planned) && this.walkToStation(l.cell) <= TUNE.serveWalk ? 1 : 0;
    });
    return m;
  }

  snapshot(): StateMsg {
    return {
      type: 'state', stats: this.stats(),
      roads: this.roadsMsg(), lots: this.lotsMsg(),
      road: this.g.road.slice(), lv: this.lv.slice(), flags: this.g.flags.slice(), catchment: this.catchmentRaster(),
      stations: this.metro.stations.map((st) => ({ ...st })),
      lines: this.metro.lines.map((l) => ({ id: l.id, color: l.color, stations: l.stations.slice(), trains: l.trains, headway: l.headway, riders: l.riders,
        capacity: l.capacity, peakLoad: l.peakLoad, rating: l.rating, lengthKm: l.lengthKm, segLoad: l.segLoad.slice() })),
      event: this.eventInfo(),
      docks: this.docksInfo(),
      landmarks: this.lm.info(),
      desire: this.desire.map((d) => ({ ax: (d.a % NZ + 0.5) * ZONE, ay: (((d.a / NZ) | 0) + 0.5) * ZONE, bx: (d.b % NZ + 0.5) * ZONE, by: (((d.b / NZ) | 0) + 0.5) * ZONE, trips: d.trips })),
      log: this.log.slice(-8), speed: this.speed,
    };
  }
}
