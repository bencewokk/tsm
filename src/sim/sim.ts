import { N, CELL, ZONE, NZ, ZONES, BT, Flag, Water, isAmenity, HOMES, COM_JOBS, IND_JOBS, BUILD_MONTHS, PERSONS_PER_HOME, WORKERS_PER_HOME } from './constants';
import { STATION_COST, TRAIN_COST, START_MONEY, PEAK_FACTOR, FARE, TRAIN_MONTH, STATION_UPKEEP, TRACK_UPKEEP_KM } from './constants';
import { Rng } from './rng';
import { generateTerrain, idx, inb, DIR4, SAT, type Grid } from './terrain';
import type { Command, InitMsg, StateMsg, Stats, DocksInfo, EventInfo, RoadsMsg, LotsMsg } from './protocol';
import { Metro } from './metro';
import { EVENTS, SITE_TEXT, fill, type EventDef, type Variant, type Effect, type DocksDeal } from './events';
import { RoadGraph, RC, ROAD_HALF } from './roads';
import { pointSeg } from './geom';
import { LotStore, LOT_W, type Lot } from './lots';
import { PROFILE_INDEX, ZONING, deriveProfiles, densClass, hash01, type DistrictProfile } from './profiles';
import { DensityField, FIELD } from './field';
import { AssemblySystem, type AsmPlan } from './assembly';
import { LandmarkSystem } from './landmarkSys';
import { LANDMARKS, landmarkAt } from './landmarks';
import { makeCityProfile, type CityProfile } from './cityprofile';
import { layoutTown, explore, densify, type TownCtx, type GrowthField } from './town';
import { MinHeap } from './heap';
import { pruneRoads, promoteJunctions, inCoreXY } from './hierarchy';
import { ProjectSystem, PACE } from './projects';
import { HazardSystem } from './hazards';
import { GRAPHCHECK, validateGraph, graphDefects, formatReport, type GraphReport } from './graphcheck';
import { T, T_CAP, TERR, updateTerritories } from './territory';
import { planReserves, applyReserve } from './reserves';
import { evaluateSquares, SQ } from './squares';
import { GoalSystem, type Moment } from './goals';
import { RELIEF, hAt, toblerFactor, slopeField, viewField, zoneEffort } from './relief';

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
  wView: 0.1,
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
  saveShare: 0.8,        // share of the demand pool held back while a tower waits for funds
  intensify: 0.35,       // sort bonus for upgrades where the field allows well above mid-rise (0 at 20 m, full at 60 m)
  towerPriority: 0.2,    // sort bonus for 36 m+ towers: they take the demand pool before mid-rise upgrades do
  maxTowerStarts: 4,     // per month: towers rise over months, not all at once
  towerCredit: 3.2,      // months of growth an anchor tower may borrow from the regional demand pool (was 2: after a line opened the pool sat below that for 15-20 months, so no tower could start)
  maxMidStarts: 30,
  distDecay: 2.6,
  parkMin: 9,
  modeBeta: 0.13,
  transitASC: 1.5,
  carLockASC: 14,
  growth: 0.032,
  minGrowth: 180,
};

/**
 * The station boom: a station's first months are a gold rush. Plots in its walk catchment rank first for the next buildings, may start on
 * slightly lower land value and may upgrade after three months instead of eight to ten, and the catchment can spend its own small pools
 * (refilled every month by each young station, scaled by how busy it is) when the city-wide demand pool is dry. Towers do not use the boom
 * (the density field's height cap is untouched). `BOOM.on = false` gives the old behaviour for before / after numbers.
 */
/**
 * Trip model (round 7 calibration). Real ranges it was tuned against: 2.5-3.5 trips per resident a day by all modes; a European city of
 * 100-250k without rail has roughly 45-60% car, 25-35% walking, 5-15% cycling; a busy metro station carries 10-40k entries a day in a city
 * of several hundred thousand, a short six-station line in a city of ~100k low thousands to ~20k.
 */
export const TRIP = {
  perResident: 2.8,     // trips per resident per day, all modes, both directions
  distDecay: 2.6,       // km: gravity decay of destinations
  beta: 0.1,            // logit scale per perceived minute
  walkWeight: 2,        // a minute walking to / from the station feels like two on the train
  transitASC: 3,        // minutes: the metro's fixed penalty against the car (stairs, ticket, reliability)
  circuity: 1.3,
  walkKmh: 4.8, walkASC: 0,
  bikeKmh: 14, bikeASC: 16,  // few people cycle: a high fixed penalty
  carShare0: 0.6,       // car share before any trips are computed (congestion at month 0)
};

/** Line rating 0..100 from crowding (peak load / capacity) and headway: degrades smoothly, never a cliff (a packed line keeps ~45 at 140%). */
export function lineRating(crowd: number, headway: number) {
  const c = 60 * (1 - Math.exp(-Math.max(0, crowd - 0.6) * 1.6));
  const h = 25 * (1 - Math.exp(-Math.max(0, headway - 4) / 6));
  return clamp(100 - c - h, 10, 100);
}

/** months after the first line opens before the first City hall decision */
const PACE_FIRST = 6;

export const BOOM = { on: true, months: 30, full: 14, res: 40, com: 46, thresh: 0.12, rank: 0.4, lvBonus: 0.15, upBonus: 0.1, fastAge: 3, zoneOps: 10 };

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** land value factor by distance to the nearest road (cells) */
const ROAD_DIST_F = [1, 1, 0.85, 0.65, 0.45, 0.35];

/** dev switch: seed the walk field from the side of a street passing the station entrance (off = only from nodes within 2.5 cells) */
export const WALK = { edgeAccess: true };

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
  /** static relief rasters: gradient (m per m), view value 0..1, car effort ratio between zones */
  /** deliberate open land (reserves.ts) and the squares' hysteresis streaks (squares.ts) */
  reserve: Uint8Array = new Uint8Array(N * N);
  sqStreak = new Map<number, number>();
  cSquare: Float32Array = new Float32Array(N * N);
  slope: Float32Array = new Float32Array(N * N);
  view: Float32Array = new Float32Array(N * N);
  effort: Float32Array = new Float32Array(ZONES * ZONES).fill(1);
  // zones (8x8 cells)
  zHomes = new Float64Array(ZONES);
  zJobs = new Float64Array(ZONES);
  zRoads = new Float64Array(ZONES);
  zCong = new Float64Array(ZONES);
  zSpeed = new Float64Array(ZONES);
  zCarAcc = new Float64Array(ZONES);
  zTransitShare = new Float64Array(ZONES);
  /** car share of each home zone's trips (all modes): feeds congestion */
  zCarShare = new Float64Array(ZONES).fill(TRIP.carShare0);
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
  /**
   * Station access groups per zone, at cell level: each cell walks to its nearest station (walk field), so a zone is split into the share of
   * its homes (zAccO) and of its trip attraction (zAccD) that walks to each station, with the mean walk. Trips choose the metro per group,
   * so every station gets the riders of the streets it is nearest to (one centroid per 400 m zone used to hand all of a zone's trips to a
   * single station and left stations next to a better one at zero).
   */
  zAccO: { s: number; w: number; f: number }[][] = [];
  zAccD: { s: number; w: number; f: number }[][] = [];
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
  asm = new AssemblySystem(this);
  projects = new ProjectSystem(this);
  hazards = new HazardSystem(this);
  lastEventMonth = -99;
  // goals, headlines and the station boom
  goals = new GoalSystem(this);
  unlocks: string[] = [];
  moments: Moment[] = [];
  private momentSeq = 0;
  private lines0 = 0;
  /** month the first line opened (-1: none yet); City hall decisions wait for it */
  firstLineMonth = -1;
  /** 0..1 per cell: how strongly a young station's walk catchment is being developed this month (see computeBoom) */
  boom = new Float32Array(N * N);
  /** pools only plots in a young station's catchment may spend; refilled each month while a station is in its boom */
  boomRes = 0; boomCom = 0;
  /** stations that already got their "cranes arrive" headline / first tower headline */
  private stationFlags = new Map<number, number>();

  constructor(public seed: number, force?: { terrain?: CityProfile['terrain']; origin?: CityProfile['origin'] }) {
    this.rng = new Rng(seed);
    this.cp = makeCityProfile(seed, force);
    this.profiles = deriveProfiles(this.cp);
    this.g = generateTerrain(seed, this.rng, this.cp);
    this.roads = new RoadGraph(this.g);
    this.metro.terr = { height: this.g.height, water: this.g.water };
    this.slope = slopeField(this.g.height);
    this.view = viewField(this.g.height, this.g.water);
    this.effort = zoneEffort(this.metro.terr);
    this.lots = new LotStore(this.g.water, this.g.flags, this.roads, this.profiles);
    this.lots.profileAt = (x, y) => this.profileAt(x, y);
    this.town = { g: this.g, city: this.cp, roads: this.roads, lots: this.lots, rng: this.rng, districts: [], profiles: this.profiles, terr: new Uint8Array(N * N) };
    this.town.profileAt = (x, y) => this.profileAt(x, y);
    layoutTown(this.town);
    this.lm = new LandmarkSystem(this);
    this.lm.sync();
    this.roads.blockFlags = Flag.Docks;
    this.roads.corridor = {
      blocked: (ax, ay, bx, by) => this.lots.inCorridor(ax, ay, bx, by, ROAD_HALF[RC.Local] + 0.05)
        .some((l) => (l.flags & (Flag.Docks | Flag.Planned)) || l.asm > 0 || l.constr > 0 || l.type === BT.Ind || isAmenity(l.type) || l.level >= 2),
      clear: (ax, ay, bx, by) => { for (const l of this.lots.inCorridor(ax, ay, bx, by, ROAD_HALF[RC.Local] + 0.05)) this.lots.remove(l); },
    };
    if (pruneRoads(this, 60) > 0) this.roads.rasterize(this.g.road);
    this.repairRoads();
    this.checkGraph('generation');
    this.aggregate();
    this.computeLandValue();
    this.lvS.set(this.lv);
    this.field.update(this);
    updateTerritories(this);
    this.reserve = planReserves(this);
    for (const l of this.lots.lots) if (l.alive) applyReserve(this, l);
    this.safeguardStationSites();
    this.aggregate();
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
        // the safeguarded site of a garden suburb: the land is already held, so the station costs half
        const site = this.stationSites.find((q) => Math.hypot(q.x - cmd.x - 0.5, q.y - cmd.y - 0.5) < 1.6);
        const cost = site ? STATION_COST * 0.5 : STATION_COST;
        if (this.money < cost) { this.say('Not enough money for a station'); return; }
        const st = m.addStation(cmd.x, cmd.y, w);
        if (!st) return;
        this.money -= cost; this.buildSpend += cost;
        this.say(site ? `${st.name} station dug on the ${site.name} station site (half price: the land was safeguarded)` : `${st.name} station dug`);
        break;
      }
      case 'removeStation': if (m.removeStation(cmd.id)) this.money += STATION_COST * (cmd.full ? 1 : 0.5); break;
      case 'buildLine': {
        const q = m.quote(cmd.stations);
        if (!q.ok) { this.say(`Line not built: segment ${q.badSeg + 1} climbs ${(Math.abs(q.segs[q.badSeg].grade) * 100).toFixed(0)}%, more than even a rack railway manages (${(RELIEF.maxRack * 100).toFixed(0)}%). Add stations on easier ground.`); return; }
        const est = q.cost + 2 * TRAIN_COST;
        if (this.money < est) { this.say(`Line needs ${(est / 1e6).toFixed(0)}M, not enough money`); return; }
        const l = m.addLine(cmd.stations, this.month);
        if (!l) return;
        const cost = q.cost + l.trains * TRAIN_COST;
        this.money -= cost; this.buildSpend += cost;
        const bits = [q.by[1] > 0.05 ? `${q.by[1].toFixed(1)} km bored tunnel` : '', q.by[2] > 0.05 ? `${q.by[2].toFixed(1)} km viaduct` : '', q.by[4] > 0.05 ? `${q.by[4].toFixed(1)} km rack railway` : '', q.wkm > 0.05 ? `${q.wkm.toFixed(1)} km under water` : ''].filter(Boolean);
        this.say(`Line ${l.id} opened: ${l.stations.length} stations, ${l.lengthKm.toFixed(1)} km${bits.length ? ` (${bits.join(', ')})` : ''}`);
        this.refreshTransit();
        {
          const sts = l.stations.map((id) => m.station(id)!);
          let hx = 0, hy = 0;
          for (const st of sts) { hx += st.x / sts.length; hy += st.y / sts.length; }
          let homes = 0, jobs = 0;
          for (let i = 0; i < N * N; i++) if (this.walkToStation(i) <= 8) { homes += this.cHomes[i]; jobs += this.cJobs[i]; }
          const first = this.lines0 === 0;
          this.lines0++;
          if (first) this.firstLineMonth = this.month;
          this.moment('open', `Line ${l.id} opens: ${sts[0].name} to ${sts[sts.length - 1].name}`,
            `${l.stations.length} stations over ${l.lengthKm.toFixed(1)} km. ${Math.round(homes).toLocaleString('en-US')} homes and ${Math.round(jobs).toLocaleString('en-US')} jobs now lie within an 8-minute walk of a station. Land values are already moving${first ? ': watch for cranes round the stations' : ''}.`,
            l.color, hx, hy, true, String(l.id));
        }
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
    // no City hall decision (most of the early ones are a bill) before the first line has run for a while: the player's first money goes on the metro
    if (this.firstLineMonth < 0 || this.month < this.firstLineMonth + PACE_FIRST) return;
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
      if (def.landmark && !def.id.endsWith('_after')) {
        const ld = LANDMARKS.find((x) => x.id === def.landmark)!;
        vars.pre_a = this.lm.preview(ld.id, ld.sites[0]); vars.pre_b = this.lm.preview(ld.id, ld.sites[1]);
      }
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
    // hazard defences (hazards.ts): asked after repeated floods / landslides
    const hz = this.hazards.nextDecision();
    if (hz) {
      const hid = hz.id.slice(4);
      const def: EventDef = { id: hz.id, trigger: {}, title: hz.title, text: hz.text, choices: hz.choices.map((c, k) => ({ ...c, effects: [{ kind: 'hazard', id: hid, choice: k }] })) };
      this.pending = { def, variant: null, vars: {} };
      return;
    }
    // development projects: queued decisions, one at a time and spaced out
    if (this.month < this.projects.lastDecision + PACE.decisionGap) return;
    const d = this.projects.nextDecision();
    if (d) {
      const inst = Number(d.id.slice(5)), p = this.projects.list.find((q) => q.id === inst)!;
      const def: EventDef = { id: d.id, trigger: {}, title: d.title, text: d.text, choices: d.choices.map((c, k) => ({ ...c, effects: [{ kind: 'project', inst, choice: k }] })) };
      this.pending = { def, variant: null, vars: p.vars };
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
      share: pct(dW ? dT / dW : 0), cityShare: pct(this.motorShare()), cong: pct(cz ? cong / cz : 0),
    };
  }

  private applyEffect(e: Effect) {
    switch (e.kind) {
      case 'money': this.money += e.amount; break;
      case 'log': this.say(e.text); break;
      case 'docksDeal': {
        const d = { ...e.deal, name: fill(e.deal.name, this.eventVars()) };
        // the old port is bought up, fenced and demolished block by block first (about 8 months), then the planned blocks are staked out
        this.docks = { state: 'active', deal: d, start: this.month, deadline: d.deadline ? this.month + d.deadline + 8 : 0, roadRelief: false, lateLogged: false };
        for (const l of this.docksLots()) {
          const r = this.rng.next();
          let t: number = BT.Res, lv = 1;
          if (d.density === 'high') { if (r < 0.34) lv = 3; else if (r < 0.66) lv = 2; else if (r < 0.82) { t = BT.Com; lv = 3; } else { t = BT.Com; lv = 2; } }
          else if (d.density === 'mid') { if (r < 0.7) lv = 2; else { t = BT.Com; lv = 2; } }
          else { lv = r < 0.45 ? 2 : 1; if (r > 0.9) t = BT.Com; }
          l.planType = t; l.planLevel = lv;
          if (d.carLockAll) l.flags |= Flag.CarLocked;
        }
        this.asm.startDocks(this.docksLots(), SITE_TEXT[this.cp.site].project);
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
      case 'project': this.projects.choose(e.inst, e.choice); this.projects.lastDecision = this.month; break;
      case 'hazard': this.hazards.choose(e.id, e.choice); break;
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
    if (this.docks.state !== 'active' || this.asm.docksPending) return;
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
      if (!(l.flags & Flag.Planned) && !l.asm) built++;  // staked-out blocks are Planned until built; while the old port is still being cleared (assembly) nothing is built
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
    const q = this.metro.quote(stations);
    return { cost: q.cost, km: q.km, underwaterKm: q.wkm };
  }

  say(s: string) {
    this.log.push(`${this.month}|${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  /** A headline-worthy event for the UI (toast / newspaper card / sound). Content is plain data, never random. */
  moment(kind: Moment['kind'], title: string, text: string, color: string, x: number, y: number, big = false, ref = '') {
    this.moments.push({ seq: ++this.momentSeq, month: this.month, kind, title, text, color, x, y, big, ref });
    if (this.moments.length > 24) this.moments.shift();
  }

  // ---------------------------------------------------------------- monthly tick
  tick() {
    this.month++;
    this.progressConstruction();
    this.lm.tick();
    this.asm.tick();
    this.aggregate();
    this.computeCongestion();
    this.computeDriveTimes();
    this.computeTransit();
    this.computeRiders();
    this.computeLandValue();
    for (let i = 0; i < N * N; i++) this.lvS[i] += (this.lv[i] - this.lvS[i]) * TUNE.lvLag;
    this.field.update(this);
    this.computeBoom();
    if (this.month % 12 === 0) updateTerritories(this);
    if (this.month % SQ.everyMonths === 6) evaluateSquares(this);
    this.grow();
    this.resubdivide();
    this.docksTick();
    this.extendRoads();
    this.upgradeRoads();
    if (this.month % 6 === 0) { const pr = pruneRoads(this, 10), pj = promoteJunctions(this.town); if (pr + pj > 0) this.roads.rasterize(this.g.road); }
    this.repairRoads();
    this.checkGraph(`month ${this.month}`);
    this.projects.tick();
    this.hazards.tick();
    this.finance();
    this.goals.tick();
    this.networkMoments();
    this.checkEvents();
  }

  private progressConstruction() {
    for (const l of this.lots.lots) {
      if (!l.alive) continue;
      l.age = Math.min(65000, l.age + 1);
      if (l.demo > 0 && --l.demo === 0) { if (l.ntype) l.type = l.ntype; else l.type = BT.None; l.ntype = 0; l.level = 0; l.hgt = 0; }
      if (l.constr > 0 && --l.constr === 0) { l.level = l.target; l.hgt = l.nhgt; l.nhgt = 0; l.target = 0; l.age = 0; l.built = this.month; }
    }
  }

  /** Capacity of a plot relative to a standard detached one: follows frontage width, denser tiers stack a bit more. */
  capOf(l: Lot) { return (l.w / LOT_W) * (1 + 0.15 * l.dens); }
  /** Homes (Res) or jobs (Com / Ind) a building of this kind, level and height holds on the plot: storeys x a per-storey figure for mid and high rise. */
  capacity(l: Lot, kind: number, level: number, h: number, w = l.w): number {
    if (level <= 0) return 0;
    const cap = (w / LOT_W) * (1 + 0.15 * l.dens), floors = Math.max(2, Math.round(h / 3.3));
    if (kind === BT.Res) return (level === 1 || !h ? HOMES[level] : floors * (level === 3 ? 17 : 11)) * cap;
    if (kind === BT.Com) return (level === 1 || !h ? COM_JOBS[level] : floors * 17) * cap;
    if (kind === BT.Ind) return IND_JOBS[level] * cap;
    return 0;
  }
  lotHomes(l: Lot) { return l.type === BT.Res ? Math.round(this.capacity(l, BT.Res, l.level, l.hgt)) : 0; }
  lotJobs(l: Lot) { return l.type === BT.Com || l.type === BT.Ind ? Math.round(this.capacity(l, l.type, l.level, l.hgt)) : 0; }

  /** Height of a new mid / high-rise building on this plot: capped by the field's allowed height and by the plot's width (tall needs a wide plot). */
  pickHeight(l: Lot, level: number, ambition = false): number {
    if (level < 2) return 0;
    const hm = this.field.hmaxAt(l.x, l.y), r = hash01(l.id, this.month);
    if (level === 2) return Math.round(Math.min(24, Math.max(13, hm)) * (0.72 + 0.28 * r));
    const wcap = ambition ? 1e9 : 24 + 70 * Math.max(0, l.w - 0.4);
    return Math.round(Math.max(FIELD.level3, Math.min(hm, wcap) * (0.62 + 0.38 * r)));
  }

  /** District profile for new street frontage: the old industrial site, the nearest quarter's core / mid / outer profile, downtown near stations or at high value. */
  profileAt(x: number, y: number): number {
    const gx = Math.floor(x), gy = Math.floor(y);
    if (gx >= 0 && gy >= 0 && gx < N && gy < N && (this.g.flags[gy * N + gx] & Flag.Docks)) return PROFILE_INDEX[this.cp.site === 'harbour' ? 'docks' : 'railside'];
    if (TERR.on && gx >= 0 && gy >= 0 && gx < N && gy < N) {
      const tt = this.town.terr[gy * N + gx];
      if (tt === T.Port || tt === T.Industry) return PROFILE_INDEX[this.cp.site === 'harbour' ? 'docks' : 'railside'];
      if (tt === T.Workers) return PROFILE_INDEX.terraces;
    }
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
    this.cSquare.fill(0);
    this.cHomes.fill(0); this.cJobs.fill(0); this.cInd.fill(0); this.cPark.fill(0); this.cBuilt.fill(0);
    this.zHomes.fill(0); this.zJobs.fill(0); this.zRoads.fill(0); this.zCarLocked.fill(0);
    let h = 0, j = 0, jx = 0, jy = 0;
    for (const l of this.lots.lots) {
      if (!l.alive || !l.type) continue;
      const hh = this.lotHomes(l), jj = this.lotJobs(l), z = this.zoneOf(l.cell);
      this.cHomes[l.cell] += hh; this.cJobs[l.cell] += jj;
      if (!isAmenity(l.type) && l.level > 0) this.cBuilt[l.cell]++;
      if (l.type === BT.Ind) this.cInd[l.cell] += l.level;
      if (l.type === BT.Square) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = (l.cell % N) + dx, yy = ((l.cell / N) | 0) + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) this.cSquare[yy * N + xx] += 1 / (1 + Math.abs(dx) + Math.abs(dy)); }
      if (l.type === BT.Park || l.type === BT.Square) this.cPark[l.cell] += 1;
      else if (l.type === BT.Landmark) this.cPark[l.cell] += l.level > 0 ? (landmarkAt(l.lm)?.value ?? 0.5) * 3 : 0;
      this.zHomes[z] += hh; this.zJobs[z] += jj; h += hh; j += jj;
      if (l.flags & Flag.CarLocked) this.zCarLocked[z] += hh;
      jx += (jj + hh * 0.3) * l.x; jy += (jj + hh * 0.3) * l.y;
    }
    // road capacity by class: an arterial cell carries about 2.4x a local street (g.road holds 3 / 2 / 1)
    const CAPW = [0, 1, 1.5, 2.4];
    for (let i = 0; i < N * N; i++) if (g.road[i]) this.zRoads[this.zoneOf(i)] += CAPW[g.road[i]];
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
      // congestion was tuned with the car carrying all motorised trips but the metro's: scale by the car share against the no-metro share
      const car = clamp(this.zCarShare[z] / TRIP.carShare0, 0.1, 1.3);
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

  /** zone-pair road distance (m) and midpoint zone: static (terrain effort, circuity), computed once */
  private pairDist: Float64Array | null = null;
  private pairMid: Uint16Array | null = null;
  private pairCirc = 0;
  private computeDriveTimes() {
    const dt = this.driveTime;
    if (!this.pairDist || this.pairCirc !== TUNE.circuity) {
      this.pairDist = new Float64Array(ZONES * ZONES); this.pairMid = new Uint16Array(ZONES * ZONES); this.pairCirc = TUNE.circuity;
      for (let a = 0; a < ZONES; a++) {
        const ax = (a % NZ) + 0.5, ay = ((a / NZ) | 0) + 0.5;
        for (let b = 0; b < ZONES; b++) {
          const bx = (b % NZ) + 0.5, by = ((b / NZ) | 0) + 0.5;
          const mx = Math.min(NZ - 1, Math.floor((ax + bx) / 2)), my = Math.min(NZ - 1, Math.floor((ay + by) / 2));
          this.pairDist[a * ZONES + b] = a === b ? 300 : Math.hypot(ax - bx, ay - by) * ZONE * CELL * TUNE.circuity * this.effort[a * ZONES + b];
          this.pairMid[a * ZONES + b] = my * NZ + mx;
        }
      }
    }
    const PD = this.pairDist, PM = this.pairMid!, zs = this.zSpeed, ds = this.driveSpeed;
    for (let a = 0; a < ZONES; a++) {
      for (let b = 0; b < ZONES; b++) {
        const sp = (zs[a] + zs[b] + zs[PM[a * ZONES + b]] + ds) / 4;
        dt[a * ZONES + b] = (PD[a * ZONES + b] / 1000) / sp * 60 + TUNE.accessMin;
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
  private computeWalkFields(used: { id: number; x: number; y: number; depth?: number }[]) {
    const key = `${this.roads.version}|${used.map((s) => `${s.id}:${s.x.toFixed(2)},${s.y.toFixed(2)}`).join(';')}`;
    if (key === this.walkKey) return;
    this.walkKey = key;
    const R = this.roads, M = R.nx.length, sp = TUNE.walkSpeed / CELL; // cells per minute
    const cap = TUNE.walkCap;
    const hn = new Float32Array(M);
    for (let n = 0; n < M; n++) hn[n] = hAt(this.g.height, R.nx[n], R.ny[n]);
    this.walk = [];
    for (const st of used) {
      const t = new Float32Array(M).fill(Infinity);
      const heap = new MinHeap();
      // street access from the station entrance (straight-line walk to nearby nodes)
      for (let n = 0; n < M; n++) {
        if (!R.adj[n].length) continue;
        const d = Math.hypot(R.nx[n] - st.x, R.ny[n] - st.y);
        if (d < 2.5) { const v = (d * 1.2) / sp + (st.depth ?? 0) * RELIEF.escalatorMin; if (v < t[n]) { t[n] = v; heap.push(n, v); } }
      }
      // ...and onto the side of a street that passes the entrance: a station in the middle of a long block is reached from both ends of that street
      // (a station out on open land with no street within 2.5 cells walks to the nearest street up to 6 cells away)
      const reach = heap.size ? 2.5 : 6;
      for (const e of WALK.edgeAccess ? R.edgesNear(st.x, st.y, reach) : []) {
        if (!R.alive[e]) continue;
        const a = R.ea[e], b = R.eb[e];
        const p = pointSeg(st.x, st.y, R.nx[a], R.ny[a], R.nx[b], R.ny[b]);
        if (p.d >= reach) continue;
        const L = R.edgeLen(e), base = (p.d * 1.2) / sp + (st.depth ?? 0) * RELIEF.escalatorMin;
        for (const [n, along] of [[a, p.t * L], [b, (1 - p.t) * L]] as [number, number][]) {
          const v = base + along / sp;
          if (v < t[n]) { t[n] = v; heap.push(n, v); }
        }
      }
      while (heap.size) {
        const n = heap.pop();
        const tn = t[n];
        if (tn > cap) continue;
        for (const e of R.adj[n]) {
          const o = R.other(e, n);
          // people walk from o towards the station at n: uphill is slow (Tobler)
          const L = R.edgeLen(e);
          const slope = L > 0 ? (hn[n] - hn[o]) / (L * CELL) : 0;
          const v = tn + L / sp / toblerFactor(slope);
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
    this.zAccO = []; this.zAccD = [];
    for (let z = 0; z < ZONES; z++) { this.zAccO.push([]); this.zAccD.push([]); }
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
        if (wt < TUNE.walkCap) this.zoneNear[z].push({ s: k, w: wt + 1 });  // the escalator time is already inside the walk field
      }
    }
    {
      // cell level: nearest station by walk, summed per zone into access groups (homes for trip origins, jobs + 0.3 homes for destinations)
      const oW = new Float64Array(ZONES * S), oT = new Float64Array(ZONES * S), dW = new Float64Array(ZONES * S), dT = new Float64Array(ZONES * S);
      const zO = new Float64Array(ZONES), zD = new Float64Array(ZONES), own = new Float64Array(S);
      for (let i = 0; i < N * N; i++) {
        const h = this.cHomes[i], d = this.cJobs[i] + 0.3 * h;
        if (!h && !d) continue;
        const z = this.zoneOf(i);
        zO[z] += h; zD[z] += d;
        let bk = -1, bt = TUNE.walkCap;
        for (let k = 0; k < S; k++) { const t = this.walk[k][i]; if (t < bt) { bt = t; bk = k; } }
        if (bk < 0) continue;
        oW[z * S + bk] += h; oT[z * S + bk] += h * bt; dW[z * S + bk] += d; dT[z * S + bk] += d * bt;
        own[bk] += h;
      }
      // what each station reaches (shown on a quiet station's tag: no street nearby, a nearer station takes its streets, or empty land)
      for (let k = 0; k < S; k++) {
        let reach = 0, wh = 0;
        const f = this.walk[k];
        for (let i = 0; i < N * N; i++) if (f[i] <= 8) { reach++; wh += this.cHomes[i]; }
        const st = used[k];
        st.reach = reach; st.walkHomes = Math.round(wh); st.ownHomes = Math.round(own[k]);
      }
      for (let z = 0; z < ZONES; z++) for (let k = 0; k < S; k++) {
        if (oW[z * S + k] > 0) this.zAccO[z].push({ s: k, w: oT[z * S + k] / oW[z * S + k] + 1, f: oW[z * S + k] / zO[z] });
        if (dW[z * S + k] > 0) this.zAccD[z].push({ s: k, w: dT[z * S + k] / dW[z * S + k] + 1, f: dW[z * S + k] / zD[z] });
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

  private lvInd = new Float32Array(N * N);
  private lvPark = new Float32Array(N * N);
  computeLandValue() {
    const g = this.g;
    const ind = this.lvInd, park = this.lvPark;
    ind.fill(0); park.fill(0);
    const spread = (x: number, y: number, v: number, R: number, out: Float32Array) => {
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (!inb(x + dx, y + dy)) continue;
        const f = 1 - Math.hypot(dx, dy) / (R + 1);
        if (f > 0) out[idx(x + dx, y + dy)] += f * v;
      }
    };
    for (let i = 0; i < N * N; i++) {
      const vi = this.cInd[i], vp = this.cPark[i];
      if (!vi && !vp) continue;
      const x = i % N, y = (i / N) | 0;
      if (vi) spread(x, y, vi, 4, ind);
      if (vp) spread(x, y, vp, 3, park);
    }
    const cx = this.centre.x, cy = this.centre.y;
    for (let i = 0; i < N * N; i++) {
      if (g.water[i]) { this.lv[i] = 0; continue; }
      const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
      const rdf = ROAD_DIST_F[Math.min(5, this.roadDist[i])] ?? 0.3;
      const car = this.zoneSampleXY(this.zCarAcc, x, y) * rdf;
      const dw = g.distWater[i];
      const water = dw <= 4 ? TUNE.wWater * (1 - (dw - 1) / 4) : 0;
      const pk = Math.min(0.15, park[i] * TUNE.wPark);
      const nz = Math.min(0.4, ind[i] * TUNE.wInd);
      const dc = Math.hypot(x - cx, y - cy) / (N * 0.5);
      let v = TUNE.base + TUNE.wCar * car + TUNE.wTransit * this.transitCell[i] + this.stationPrem[i] + water + pk - nz - TUNE.wCentre * dc;
      if (g.flags[i] & Flag.Steep) v -= 0.2;
      if (g.flags[i] & Flag.Flood) v -= 0.25;
      v += TUNE.wView * this.view[i];   // views raise value (not density: the field ignores them)
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

  /** Per-cell boom strength from young stations' walk fields, and this month's refill of the boom pools. */
  private computeBoom() {
    this.boom.fill(0);
    if (!BOOM.on) { this.boomRes = 0; this.boomCom = 0; return; }
    const m = this.metro;
    let rate = 0;
    for (const st of m.stations) {
      if (st.opened < 0) continue;
      const age = this.month - st.opened;
      if (age >= BOOM.months) continue;
      const k = m.sIndex.get(st.id);
      if (k === undefined || !this.walk[k]) continue;
      const w = age <= BOOM.full ? 1 : 1 - (age - BOOM.full) / (BOOM.months - BOOM.full);
      rate += w * clamp(0.5 + st.riders / 1500, 0.5, 1.6);
      const wk = this.walk[k];
      for (let i = 0; i < N * N; i++) { const t = wk[i]; if (t < 10) { const f = w * (1 - t / 10); if (f > this.boom[i]) this.boom[i] = f; } }
    }
    this.boomRes = Math.min(this.boomRes + rate * BOOM.res, rate * BOOM.res * 6 + 1);
    this.boomCom = Math.min(this.boomCom + rate * BOOM.com, rate * BOOM.com * 6 + 1);
    if (rate === 0) { this.boomRes = 0; this.boomCom = 0; }
  }

  /** The young station that owns a plot's boom (shortest walk), for headlines. */
  private boomStation(cell: number) {
    const m = this.metro;
    let best: { id: number; name: string; x: number; y: number } | null = null, bt = 10;
    for (const st of m.stations) {
      if (st.opened < 0 || this.month - st.opened >= BOOM.months) continue;
      const k = m.sIndex.get(st.id);
      if (k === undefined || !this.walk[k]) continue;
      const t = this.walk[k][cell];
      if (t < bt) { bt = t; best = st; }
    }
    return best;
  }

  /** Once-per-station / once-per-line headlines: first cranes, first tower, first riders, overcrowding. */
  private networkMoments() {
    const m = this.metro;
    for (const l of m.lines) {
      const f = this.lineFlags.get(l.id) ?? 0;
      const first = m.station(l.stations[0]);
      if (!(f & 1) && l.riders > 0) {
        this.lineFlags.set(l.id, f | 1);
        this.moment('riders', `Line ${l.id}: first riders`, `${Math.round(l.riders).toLocaleString('en-US')} trips a day at $${FARE} a fare is $${Math.round(l.riders * FARE * 30 / 1000)}k a month. Stations in busy streets earn more: watch where the riders come from.`, l.color, first?.x ?? 0, first?.y ?? 0, false, String(l.id));
      }
      if (!(f & 2) && l.crowd > 1.05) {
        this.lineFlags.set(l.id, (this.lineFlags.get(l.id) ?? 0) | 2);
        this.moment('crowd', `Line ${l.id} is overcrowded`, `Peak load is ${Math.round(l.crowd * 100)}% of capacity: platforms are packed and the rating is falling. Add trains with the + button, or open a parallel line.`, '#d9534f', first?.x ?? 0, first?.y ?? 0, false, String(l.id));
      }
    }
    // first tower beside a station
    let any = false;
    for (const st of m.stations) if (st.opened >= 0 && !((this.stationFlags.get(st.id) ?? 0) & 2)) { any = true; break; }
    if (!any) return;
    for (const l of this.lots.lots) {
      if (!l.alive || l.level < 3 || l.constr || l.hgt < 36 || (l.type !== BT.Res && l.type !== BT.Com)) continue;
      for (const st of m.stations) {
        const f = this.stationFlags.get(st.id) ?? 0;
        if (st.opened < 0 || (f & 2)) continue;
        const k = m.sIndex.get(st.id);
        if (k === undefined || !this.walk[k] || this.walk[k][l.cell] > 8) continue;
        this.stationFlags.set(st.id, f | 2);
        this.moment('tower', `A ${l.hgt} m tower tops out by ${st.name}`, `${this.month - st.opened} months after the station opened, ${l.type === BT.Res ? 'homes' : 'offices'} rise ${l.hgt} m above the street. Land beside a busy station is the most valuable in the city.`, '#8e5bb5', l.x, l.y, false, String(st.id));
      }
    }
  }
  private lineFlags = new Map<number, number>();

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
    // developers (the docks deal, landmarks) can borrow against future demand, but only about three months' worth
    this.resPool = Math.max(this.resPool, -B * 3); this.comPool = Math.max(this.comPool, -jobB * 3);
    const pR = clamp(this.resPool / (B * 4), 0, 1), pC = clamp(this.comPool / (jobB * 4 + 1), 0, 1);
    this.pressure = (pR + pC) / 2;
    const spawnR = TUNE.spawnLV - 0.14 * pR, spawnC = TUNE.spawnLV - 0.14 * pC;

    type Cand = { l: Lot; s: number; kind: number; to: number; h: number };
    const res: Cand[] = [], com: Cand[] = [], ind: Cand[] = [];
    const sat = this.satelliteBonus();
    const F = this.field;
    const built3 = (cell: number) => {
      const cx = cell % N, cy = (cell / N) | 0;
      let b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < N && y < N) b += this.cBuilt[y * N + x]; }
      return b;
    };
    for (const l of lots) {
      if (l.constr || l.asm || (l.flags & (Flag.Planned | Flag.Docks)) && !l.type) continue;
      if (l.flags & Flag.Planned) continue;
      const v = this.fieldAt(this.lvS, l.x, l.y), t = l.type, lv = l.level;
      const jit = this.rng.next() * 0.12;
      const pf = this.profiles[l.prof], fr = (0.5 + pf.landUseMix.res) * pf.growthRate, fc = (0.5 + pf.landUseMix.com) * pf.growthRate, fi = (0.5 + pf.landUseMix.ind) * pf.growthRate;
      const maxL = F.maxLevel(l.x, l.y);
      const bm = this.boom[l.cell];
      if (t === BT.None) {
        const tt0 = TERR.on ? this.town.terr[l.cell] : 0;
        // heavy industry does not care about land value: it builds wherever its territory is
        if (v < Math.min(spawnR, spawnC) && !(tt0 === T.Port || tt0 === T.Industry)) continue;
        const pull = this.stationPull(l.cell);
        const front = l.cls === RC.Arterial ? 0.1 : l.cls === RC.Collector ? 0.05 : 0;
        // fill the built-up area first: neighbours and the field's density class pull growth inward
        const fill = 0.1 * Math.min(1, built3(l.cell) / 5) + 0.2 * F.fAt(l.x, l.y);
        // territories: the port, yards and heavy industry take industry only; homes and shops stay out of them
        const tt = TERR.on ? this.town.terr[l.cell] : 0;
        const heavy = tt === T.Port || tt === T.Industry;
        // satellites grow by their own rule (homes by the works, round the station of a rail town or a served garden suburb): a local pull on top of land value
        const sb = sat[l.cell];
        if (v + sb + BOOM.lvBonus * bm >= spawnR && !heavy) res.push({ l, s: (v + sb + jit + fill + BOOM.rank * bm) * fr, kind: BT.Res, to: 1, h: 0 });
        if (v + BOOM.lvBonus * bm >= spawnC && !heavy) com.push({ l, s: (BOOM.rank * bm + v * 0.8 + this.zoneSampleXY(this.zCarAcc, l.x, l.y) * 0.5 + this.transitCell[l.cell] * 0.9 + pull * 0.4 + front + jit - 0.12 + fill + 0.3 * Math.min(1, this.cSquare[l.cell])) * fc, kind: BT.Com, to: 1, h: 0 });
        if (!TERR.on || heavy) ind.push({ l, s: (0.6 - v * 0.4 + (this.g.distWater[l.cell] <= 3 ? 0.15 : 0) + this.zoneSampleXY(this.zCarAcc, l.x, l.y) * 0.3 + front + jit) * fi, kind: BT.Ind, to: 1, h: 0 });
      } else if (t === BT.Res && lv < 3) {
        const cap = l.flags & Flag.CarLocked ? 2 : 3;
        if (lv + 1 > cap || lv + 1 > maxL) continue;
        if (v + sat[l.cell] * 0.5 + BOOM.upBonus * bm > TUNE.upLV[lv] - 0.1 * pR && l.age >= (bm > 0.3 ? BOOM.fastAge : lv === 1 ? 10 : 8)) res.push({ l, s: v + 0.05 + jit + BOOM.rank * bm, kind: BT.Res, to: lv + 1, h: this.pickHeight(l, lv + 1, true) });
        // where the field allows a tower and the value is high, a low building is replaced by a tower directly (no stop at mid-rise)
        if (lv === 1 && cap === 3 && maxL === 3 && F.hmaxAt(l.x, l.y) >= 40 && v > TUNE.upLV[2] && l.age >= 12) res.push({ l, s: v + 0.05 + jit, kind: BT.Res, to: 3, h: this.pickHeight(l, 3, true) });
      } else if (t === BT.Com && lv < 3) {
        if (lv + 1 > maxL) continue;
        if (v + BOOM.upBonus * bm > TUNE.comUpLV[lv] - 0.1 * pC && l.age >= (bm > 0.3 ? BOOM.fastAge : lv === 1 ? 5 : 10)) com.push({ l, s: v + 0.1 + jit + BOOM.rank * bm, kind: BT.Com, to: lv + 1, h: this.pickHeight(l, lv + 1, true) });
        if (lv === 1 && maxL === 3 && F.hmaxAt(l.x, l.y) >= 40 && v > TUNE.comUpLV[2] && l.age >= 10) com.push({ l, s: v + 0.1 + jit, kind: BT.Com, to: 3, h: this.pickHeight(l, 3, true) });
      } else if ((t === BT.Res || t === BT.Com) && lv === 3 && l.hgt > 0 && l.age >= 24 && !(l.flags & Flag.CarLocked)) {
        // a better-connected centre rebuilds its towers taller
        const hm = F.hmaxAt(l.x, l.y);
        if (hm >= 40 && hm > l.hgt * 1.3 && v > 0.7) {
          const h = this.pickHeight(l, 3, true);
          if (h > l.hgt * 1.25) (t === BT.Res ? res : com).push({ l, s: v + 0.02 + jit, kind: t, to: 3, h });
        }
      }
    }
    // where the field allows more than mid-rise, the pool goes to intensifying those plots first (towers before mid-rise upgrades before
    // fringe spawns); the field's cap itself is untouched, so without transit nothing above ~30 m is ever allowed
    const prio = new Map<Cand, number>();
    for (const list of [res, com]) for (const c of list) {
      let b = 0;
      if (c.to >= 2) b = TUNE.intensify * clamp((F.hmaxAt(c.l.x, c.l.y) - 20) / 40, 0, 1) + (c.to === 3 && c.h >= 36 ? TUNE.towerPriority : 0);
      prio.set(c, c.s + b);
    }
    const order = (a: Cand, b: Cand) => (prio.get(b) ?? b.s) - (prio.get(a) ?? a.s) || a.l.id - b.l.id;
    res.sort(order); com.sort(order); ind.sort(order);
    const zoneOps = new Uint8Array(ZONES);
    const taken = new Set<number>();
    let towers = 0, mids = 0;
    const place = (list: Cand[], poolKey: 'resPool' | 'comPool' | 'indPool', maxOps: number) => {
      let ops = 0;
      const start = this[poolKey];
      let keep = 0;   // a tower that does not fit the pool yet makes the city save: other starts may spend only a fifth of it this month
      for (const c of list) {
        if (ops >= maxOps) break;
        // an anchor tower may be financed on credit (regional demand) while the pool is in debt, as long as the debt stays under ~2 months of growth
        const credit = c.to === 3 && c.h >= 36 && poolKey !== 'indPool' && this[poolKey] > -TUNE.towerCredit * B;
        // a plot in a young station's catchment may spend the station's own boom pool (never for an anchor tower: the height cap is untouched)
        const bp = poolKey === 'resPool' ? 'boomRes' : poolKey === 'comPool' ? 'boomCom' : null;
        const useBoom = !!bp && BOOM.on && !(c.to === 3 && c.h >= 36) && this.boom[c.l.cell] > BOOM.thresh && this[bp] > 0;
        // an exhausted pool stops ordinary starts, but the scan goes on: an anchor tower further down the list may still start on credit
        // (the old `break` here ended the scan at the first ordinary candidate, so with the pool in debt no tower was ever looked at)
        if (this[poolKey] <= keep && !credit && !useBoom) continue;
        if (taken.has(c.l.id)) continue;
        // growth lags: only a few towers and mid-rises start each month
        if (c.to === 3 && towers >= TUNE.maxTowerStarts) continue;
        if (c.to === 2 && mids >= TUNE.maxMidStarts) continue;
        const z = this.zoneOf(c.l.cell);
        if (zoneOps[z] >= (useBoom ? BOOM.zoneOps : 6)) continue;
        let h = c.h, plan: AsmPlan | null = null;
        if (c.to === 3 && c.kind !== BT.Ind && h >= 36) {
          // a tall building consumes several plots: assemble a site, or settle for what one plot allows
          if (!this.asm.canStart(this.homes * PERSONS_PER_HOME)) continue;
          plan = this.asm.planRow(c.l, h);
          if (!plan) continue;   // no site to assemble here: the plot waits (its mid-rise upgrade is a separate candidate), later candidates are tried
        }
        const wEff = plan ? Math.hypot(plan.quad[2] - plan.quad[0], plan.quad[3] - plan.quad[1]) : c.l.w;
        const add = this.capacity(c.l, c.kind, c.to, h, wEff) - (c.l.type === c.kind ? this.capacity(c.l, c.kind, c.l.level, c.l.hgt) : 0);
        const avail = useBoom ? this[bp!] : this[poolKey];
        if (add > Math.max(0, avail) * 2.5 + 10 && !(credit && add <= B * 3)) { if (c.to === 3 && h >= 36 && keep === 0) keep = start * TUNE.saveShare; continue; }
        if (useBoom) {
          this[bp!] -= add;
          const bs = this.boomStation(c.l.cell);
          if (bs && !((this.stationFlags.get(bs.id) ?? 0) & 1)) {
            this.stationFlags.set(bs.id, (this.stationFlags.get(bs.id) ?? 0) | 1);
            this.moment('growth', `Cranes at ${bs.name}`, `The first new ${c.kind === BT.Res ? 'homes' : 'shops and offices'} are going up beside the station, ${this.month - this.metro.station(bs.id)!.opened} months after it opened.`, '#e0a526', c.l.x, c.l.y, false, String(bs.id));
          }
        } else this[poolKey] -= add;
        taken.add(c.l.id); zoneOps[z]++; ops++;
        if (c.to === 3) towers++; else if (c.to === 2) mids++;
        if (plan) {
          // beside a young station the crews work shifts: a quarter fewer months of structure (the height itself is still the field's)
          const months0 = Math.max(3, Math.min(11, Math.round(h / 11)));
          const months = BOOM.on && this.boom[c.l.cell] > 0.3 ? Math.max(3, Math.round(months0 * 0.75)) : months0;
          this.asm.start(plan, { type: c.kind, level: 3, hgt: h, months, label: `${c.kind === BT.Res ? 'Residential' : 'Office'} tower (${h} m)` });
          continue;
        }
        if (c.to >= 2) this.tryMerge(c.l, c.to);
        this.startBuild(c.l, c.kind, c.to, c.to === 3 ? h : undefined);
      }
    };
    if (this.comDemand > this.resDemand) { place(com, 'comPool', 120); place(res, 'resPool', 300); }
    else { place(res, 'resPool', 300); place(com, 'comPool', 120); }
    place(ind, 'indPool', 30);
    this.satelliteStarts(sat, taken);

    // decline: buildings whose value falls empty out
    for (const l of lots) {
      if (!l.type || isAmenity(l.type) || l.constr || l.asm || (l.flags & Flag.Planned)) continue;
      if (l.type === BT.Ind && TERR.on && (this.town.terr[l.cell] === T.Port || this.town.terr[l.cell] === T.Industry)) continue;   // industry stays in its own territory whatever the land value
      const v = this.fieldAt(this.lvS, l.x, l.y);
      if (v < TUNE.downLV[l.level]) l.low = Math.min(255, l.low + 1); else l.low = 0;
      if (l.low >= 6 && this.rng.next() < 0.25) {
        l.low = 0;
        l.level--; l.hgt = 0;
        if (l.level === 0) l.type = BT.None;
      }
    }
    if (this.resDemand < -0.6) {
      for (const l of lots) if (l.type === BT.Res && !l.constr && !l.asm && this.lvS[l.cell] < 0.3 && this.rng.next() < 0.02) { l.type = BT.None; l.level = 0; }
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
    if (ls.some((l) => (l.flags & (Flag.Core | Flag.Docks | Flag.Planned)) || l.asm || l.lm || l.constr || l.demo || l.type === BT.Landmark)) return false;
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
    // some industrial plots in the industrial territory are fenced, paved yards (container stacks, pipe racks)
    if (type === BT.Ind && TERR.on) { const tt = this.town.terr[l.cell]; l.deco = (tt === T.Industry || tt === T.Port) && hash01(l.id, 33) < 0.18 ? 4 : 0; }
    l.target = level;
    l.constrTotal = BUILD_MONTHS[level];
    l.constr = BUILD_MONTHS[level] + l.demo;
  }

  /** A bigger building may replace its small row neighbour: the two plots become one. */
  private tryMerge(l: Lot, to: number) {
    if (l.asm || l.dens === 0 || l.w > 0.7 || (l.flags & (Flag.Core | Flag.Docks | Flag.Planned))) return;
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
      else if (!l.type && !l.flags && !l.asm) cands[z].push(l);
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

  /**
   * Satellite growth rules (per cell, 0..~0.3, falling to 0 at 9 cells from the settlement's centre), recomputed monthly:
   *   factory town   0.14 + 0.2 x (industrial jobs within 9 cells / 400): workers live by the works, whatever the land value
   *   rail town      0.06, + 0.16 with a metro station within 6 cells (its station square), + 0.06 for the rail spur itself
   *   garden suburb  0.03, + 0.25 once a metro station is within 7 cells of its centre (the commuter suburb waits for its line)
   *   historic village 0.04 (a small market of its own)
   */
  satelliteBonus(): Float32Array {
    const out = new Float32Array(N * N);
    if (!SAT.on) return out;
    const used = new Set(this.metro.lines.flatMap((l) => l.stations));
    for (const v of this.g.villages) {
      if (!v.cause) continue;
      const stNear = (r: number) => this.metro.stations.some((st) => used.has(st.id) && Math.hypot(st.x - v.x, st.y - v.y) < r);
      let b = 0;
      if (v.cause === 'factory') {
        let jobs = 0;
        for (const l of this.lots.near(v.x, v.y, 9)) if (l.alive && l.type === BT.Ind && l.level) jobs += this.lotJobs(l);
        b = 0.14 + 0.2 * Math.min(1, jobs / 400);
      } else if (v.cause === 'rail') b = 0.12 + (stNear(6) ? 0.16 : 0);
      else if (v.cause === 'commuter') b = 0.03 + (stNear(7) ? 0.25 : 0);
      else b = 0.04;
      for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
        const x = v.x + dx, y = v.y + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const f = 1 - Math.hypot(dx, dy) / 9;
        if (f > 0) out[y * N + x] = Math.max(out[y * N + x], b * f);
      }
    }
    return out;
  }

  /**
   * Satellites' own demand: the city-wide pool always goes to the high-value centre first, so a factory town by its works or a
   * served rail town / garden suburb starved. Each month such a settlement may start up to 3 houses on its best vacant plots
   * (land value plus the satellite bonus above the spawn line) while it is below its own target: factory town 0.45 homes per works job
   * within 9 cells; rail town or served garden suburb +30% over the homes it has (capped at 1500). They still count against the pool.
   */
  private satelliteStarts(sat: Float32Array, taken: Set<number>) {
    if (!SAT.on) return;
    const used = new Set(this.metro.lines.flatMap((l) => l.stations));
    for (const v of this.g.villages) {
      if (!v.cause || v.cause === 'hist') continue;
      const near = this.lots.near(v.x, v.y, 9).filter((l) => l.alive);
      let homes = 0, jobs = 0;
      for (const l of near) { homes += this.lotHomes(l); if (l.type === BT.Ind && l.level) jobs += this.lotJobs(l); }
      const served = this.metro.stations.some((st) => used.has(st.id) && Math.hypot(st.x - v.x, st.y - v.y) < 7);
      const target = v.cause === 'factory' ? jobs * 0.45 : (v.cause === 'rail' || served) ? Math.min(1500, homes * 1.3 + 30) : 0;
      if (homes >= target) continue;
      const cand = near.filter((l) => l.type === BT.None && !l.deco && !l.asm && !l.constr && !l.demo && !(l.flags & (Flag.Planned | Flag.Docks)) && !taken.has(l.id)
        && (!TERR.on || (this.town.terr[l.cell] !== T.Port && this.town.terr[l.cell] !== T.Industry)) && this.fieldAt(this.lvS, l.x, l.y) + sat[l.cell] >= TUNE.spawnLV)
        .sort((a, b) => (this.fieldAt(this.lvS, b.x, b.y) + sat[b.cell]) - (this.fieldAt(this.lvS, a.x, a.y) + sat[a.cell]) || a.id - b.id);
      for (const l of cand.slice(0, 3)) {
        taken.add(l.id);
        this.resPool -= this.capacity(l, BT.Res, 1, 0);
        this.startBuild(l, BT.Res, 1);
      }
    }
  }

  /** Garden (commuter) suburbs keep a metro station site at their heart (deco 6): a paved forecourt held free for a future station. */
  stationSites: { x: number; y: number; lot: number; name: string }[] = [];
  private safeguardStationSites() {
    if (!SAT.on) return;
    for (const v of this.g.villages) {
      if (v.cause !== 'commuter') continue;
      const c = this.lots.near(v.x + 0.5, v.y + 0.5, 3).filter((l) => l.alive && !l.type && !l.flags && !l.asm && !l.back)
        .sort((a, b) => Math.hypot(a.x - v.x - 0.5, a.y - v.y - 0.5) - Math.hypot(b.x - v.x - 0.5, b.y - v.y - 0.5) || a.id - b.id)[0];
      if (!c) continue;
      c.type = BT.Park; c.level = 1; c.deco = 6;
      this.stationSites.push({ x: c.x, y: c.y, lot: c.id, name: v.name });
    }
  }

  /** Keep the road graph a clean planar network after growth (merge, split, join, de-duplicate); the validator in graphcheck.ts counts what is left. */
  repairRoads() {
    const R = this.roads, v0 = R.version;
    const free = (e: number) => (this.lots.byEdge.get(e) ?? []).every((l) => !l.alive || !(l.type || l.constr || l.demo || l.asm || l.lm || (l.flags & (Flag.Docks | Flag.Planned | Flag.Core))));
    this.repairStats = R.repair(2030 + Math.floor(this.month / 12), {
      canKill: free,
      onKill: (e) => { for (const l of this.lots.byEdge.get(e) ?? []) if (l.alive) this.lots.remove(l); this.lots.forgetEdge(e); },
    });
    promoteJunctions(this.town);   // a local street that new growth joined to an arterial becomes a collector straight away (not only at the 6-monthly prune)
    if (R.version !== v0) {
      R.rasterize(this.g.road);
      for (const l of this.lots.frontageAll(R.drainFresh())) this.reserveRiverPark(l);
    }
  }
  repairStats: import('./roads').RepairStats | null = null;

  /** Dev builds: validate the road graph (after generation and after each growth tick) and keep the counts; a change in the defect count is logged. */
  checkGraph(stage: string) {
    if (!GRAPHCHECK.on) return;
    const r = validateGraph(this.roads, (x, y) => inCoreXY(this.town, x, y));
    const d = graphDefects(r);
    if (!this.graphReport || d !== graphDefects(this.graphReport)) this.graphLog.push(`[graph] ${stage}: defects ${d} | ${formatReport(r)}`);
    if (this.graphLog.length > 40) this.graphLog.shift();
    this.graphReport = r;
  }
  graphReport: GraphReport | null = null;
  graphLog: string[] = [];

  /** Plots on the river bank are kept as a green ribbon of parks (most of them). */
  private reserveRiverPark(l: Lot) {
    const cx = Math.floor(l.x), cy = Math.floor(l.y), g = this.g;
    let river = false;
    for (let dy = -1; dy <= 1 && !river; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < N && y < N && g.water[y * N + x] === Water.River) { river = true; break; }
    }
    if (river && !l.flags && ((l.id * 2654435761) >>> 0) % 100 < 65) { l.type = BT.Park; l.level = 1; }
    else applyReserve(this, l);
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
  /** daily trips by mode (both directions), from the last computeRiders */
  modeTrips = { car: 0, transit: 0, walk: 0, bike: 0 };
  /**
   * Trips and mode choice (calibrated in round 7 against real ranges; numbers in PROGRESS "Round 7, step 1").
   * Every resident makes TRIP.perResident trips a day by all modes (both directions); half of them are home-based trips out, distributed by
   * gravity over jobs and homes, and each comes back the same way, so a station counts an entry at both ends and a line a boarding each way.
   * Mode choice is a multinomial logit over car, metro, walking and cycling on perceived minutes: walking to and from the station counts
   * double (people dislike it more than sitting on a train), and walking and cycling compete for the short trips the metro used to win.
   */
  computeRiders() {
    const m = this.metro, S = m.sIndex.size;
    const segLoad = m.lines.map((l) => l.segTime.map(() => [0, 0]));
    const boards = new Float64Array(m.lines.length);
    const stEntries = new Float64Array(S);
    const stOD = new Float64Array(S * S);
    const zTrips = new Float64Array(ZONES), zTransit = new Float64Array(ZONES), zCar = new Float64Array(ZONES);
    const attr = new Float64Array(ZONES);
    for (let b = 0; b < ZONES; b++) attr[b] = this.zJobs[b] + 0.3 * this.zHomes[b];
    const zd = (a: number, b: number) => a === b ? 0.3 : Math.hypot((a % NZ) - (b % NZ), ((a / NZ) | 0) - ((b / NZ) | 0)) * ZONE * CELL / 1000;
    const gv = new Float64Array(ZONES);
    const desire: { a: number; b: number; trips: number }[] = [];
    let total = 0, transit = 0, car = 0, walk = 0, bike = 0;
    const beta = TRIP.beta, ww = TRIP.walkWeight, T_ = m.T;
    // attraction of open landmarks pulls ordinary trips toward their zone
    const lmOpen = this.lm.open();
    for (const o of lmOpen) attr[o.zone] += o.def.attr * (o.st.eventDay ? 1.5 : 1);
    /** Route T round trips from zone a to zone b and back: logit over car / metro / walk / bike, stations and desire lines. */
    const route = (a: number, b: number, T: number, asc: number, extraDrive = 0) => {
      const dk = zd(a, b);
      const drive = this.driveTime[a * ZONES + b] + TUNE.parkMin * Math.min(1, this.zJobs[b] / 2500) + extraDrive;
      const walkT = dk * TRIP.circuity / TRIP.walkKmh * 60 + TRIP.walkASC, bikeT = dk * TRIP.circuity / TRIP.bikeKmh * 60 + TRIP.bikeASC;
      // utilities relative to the car (exp(0) = 1); long walks underflow to 0 smoothly
      const uw = Math.exp(-beta * (walkT - drive)), ub = Math.exp(-beta * (bikeT - drive));
      const go = a !== b ? this.zAccO[a] : null, gd = this.zAccD[b];
      let fT = 0, cS = 0, wS = 0, bS = 0, cov = 0;
      if (go && go.length && gd.length) for (const o of go) for (const d of gd) {
        if (o.s === d.s) continue;
        const ride = T_[o.s * S + d.s];
        if (!(ride < Infinity)) continue;
        const f = o.f * d.f;
        const ut = Math.exp(-beta * ((o.w + d.w) * ww + ride + asc - drive));
        const sum = 1 + ut + uw + ub, F = T * f * ut / sum;
        cov += f; fT += F; cS += T * f / sum; wS += T * f * uw / sum; bS += T * f * ub / sum;
        if (F > 0.002) { stOD[o.s * S + d.s] += F; stOD[d.s * S + o.s] += F; stEntries[o.s] += F; stEntries[d.s] += F; }
      }
      // the part of the trips with no station within walking distance at one end chooses between car, walking and cycling
      const rest = T * Math.max(0, 1 - cov), sum3 = 1 + uw + ub;
      const C = cS + rest / sum3;
      total += 2 * T; zTrips[a] += 2 * T; zCar[a] += 2 * C;
      car += 2 * C; walk += 2 * (wS + rest * uw / sum3); bike += 2 * (bS + rest * ub / sum3);
      if (C > 15 && dk > 1.2) desire.push({ a, b, trips: 2 * C });
      transit += 2 * fT; zTransit[a] += 2 * fT;
    };
    for (let a = 0; a < ZONES; a++) {
      const P = this.zHomes[a] * PERSONS_PER_HOME * TRIP.perResident / 2;
      if (P <= 0) continue;
      let sum = 0;
      for (let b = 0; b < ZONES; b++) { gv[b] = attr[b] > 0 ? attr[b] * Math.exp(-zd(a, b) / TRIP.distDecay) : 0; sum += gv[b]; }
      if (sum <= 0) continue;
      const asc = TRIP.transitASC + this.zCarLocked[a] * TUNE.carLockASC;
      for (let b = 0; b < ZONES; b++) {
        if (gv[b] <= 0) continue;
        route(a, b, P * gv[b] / sum, asc);
      }
    }
    // landmark visitors (a visitor comes and goes: one round trip) from everywhere toward each open landmark, plus event-day crowds
    for (const o of lmOpen) {
      const day = o.def.pattern === 'weekend' ? 0.85 : o.def.pattern === 'events' ? 0.6 : 1;
      const base = o.def.visitors * day, crowd = o.st.eventDay ? o.def.eventTrips : 0;
      if (base + crowd <= 0) continue;
      const w = new Float64Array(ZONES);
      let ws = 0;
      for (let a = 0; a < ZONES; a++) { if (this.zHomes[a] <= 0) continue; w[a] = this.zHomes[a] * Math.exp(-zd(a, o.zone) / (TRIP.distDecay * 2.2)); ws += w[a]; }
      if (ws <= 0) continue;
      const lockAsc = o.st.carPark ? TUNE.carLockASC : 0;
      for (let a = 0; a < ZONES; a++) {
        if (w[a] <= 0) continue;
        const f = w[a] / ws;
        if (base > 0) route(a, o.zone, base * f, TRIP.transitASC + this.zCarLocked[a] * TUNE.carLockASC + lockAsc);
        // crowds on an event day cannot all park: driving costs a long walk from far-away parking unless the landmark has its own car park
        if (crowd > 0) route(a, o.zone, crowd * f, TRIP.transitASC - 1 + lockAsc, o.st.carPark ? 0 : 28);
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
      l.rating = lineRating(l.crowd, l.headway);
      rSum += l.rating * Math.max(1, l.riders); rW += Math.max(1, l.riders);
    });
    for (const st of m.stations) { const k = m.sIndex.get(st.id); st.riders = k === undefined ? 0 : stEntries[k]; }
    this.rating = rW > 0 ? rSum / rW : 0;
    this.transitTrips = transit;
    this.totalTrips = total;
    this.modeTrips = { car, transit, walk, bike };
    for (let z = 0; z < ZONES; z++) {
      this.zTransitShare[z] = zTransit[z] + zCar[z] > 0 ? zTransit[z] / (zTransit[z] + zCar[z]) : 0;
      this.zCarShare[z] = zTrips[z] > 0 ? zCar[z] / zTrips[z] : TRIP.carShare0;
    }
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

  /** the metro's share of motorised trips (metro vs car): what "won from the car" means */
  motorShare() { const d = this.modeTrips.transit + this.modeTrips.car; return d > 0 ? this.modeTrips.transit / d : 0; }

  stats(): Stats {
    let b = 0;
    for (const l of this.lots.lots) if (l.alive && l.type && !isAmenity(l.type) && (l.level > 0 || l.constr)) b++;
    return {
      month: this.month, population: Math.round(this.homes * PERSONS_PER_HOME), homes: this.homes, jobs: this.jobs,
      money: this.money, income: this.income, expenses: this.expenses, build: this.buildSpend,
      resDemand: this.resDemand, comDemand: this.comDemand, indDemand: this.indDemand,
      congestion: this.congestion, driveSpeed: this.driveSpeed, transitShare: this.motorShare(),
      transitTrips: this.transitTrips, rating: this.rating, buildings: b, totalTrips: this.totalTrips, modeTrips: { ...this.modeTrips },
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
      asm: new Uint16Array(n), astate: u(), deco: u(), hgt: u(), nhgt: u(), poly: new Float32Array(n * 8), dens: u(), prof: u(), sides: u(), back: u(), demo: u(), seed: new Uint32Array(n), built: new Uint16Array(n), ntype: u(), lm: u() };
    ls.forEach((l, k) => {
      m.poly.set(l.poly, k * 8); m.dens[k] = l.dens; m.prof[k] = l.prof; m.sides[k] = l.sides; m.back[k] = l.back; m.demo[k] = l.demo; m.seed[k] = l.seed; m.built[k] = l.built; m.ntype[k] = l.ntype; m.lm[k] = l.lm; m.asm[k] = l.asm; m.astate[k] = l.astate; m.deco[k] = l.deco; m.hgt[k] = Math.min(255, l.hgt); m.nhgt[k] = Math.min(255, l.nhgt);
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
      road: this.g.road.slice(), lv: this.lv.slice(), flags: this.g.flags.slice(), terr: this.town.terr.slice(), catchment: this.catchmentRaster(),
      stations: this.metro.stations.map((st) => ({ ...st })),
      lines: this.metro.lines.map((l) => ({ id: l.id, color: l.color, stations: l.stations.slice(), trains: l.trains, headway: l.headway, riders: l.riders,
        capacity: l.capacity, peakLoad: l.peakLoad, rating: l.rating, lengthKm: l.lengthKm, segLoad: l.segLoad.slice(), by: l.by.slice(), elev: l.elev.slice() })),
      event: this.eventInfo(),
      graph: this.graphReport ? { defects: graphDefects(this.graphReport), report: this.graphReport, log: this.graphLog.splice(0) } : undefined,
      docks: this.docksInfo(),
      landmarks: this.lm.info(),
      assemblies: this.asm.infos(),
      projects: this.projects.infos(), notices: this.projects.notices.slice(-5),
      desire: this.desire.map((d) => ({ ax: (d.a % NZ + 0.5) * ZONE, ay: (((d.a / NZ) | 0) + 0.5) * ZONE, bx: (d.b % NZ + 0.5) * ZONE, by: (((d.b / NZ) | 0) + 0.5) * ZONE, trips: d.trips })),
      goals: this.goals.infos(), goalsDone: this.goals.count(), goalsTotal: this.goals.total(), moments: this.moments.slice(-10), unlocks: this.unlocks.slice(),
      log: this.log.slice(-8), speed: this.speed,
    };
  }
}
