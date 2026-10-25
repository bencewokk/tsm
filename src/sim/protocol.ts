import type { Village } from './terrain';

export interface InitMsg {
  type: 'init';
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  /** static raster flags at start (docks, steep) */
  flags: Uint8Array;
  villages: Village[];
  bay: { x: number; y: number; r: number };
  rail: [number, number][][];
  mine: { x: number; y: number } | null;
  rondpoints: [number, number][];
  city: import('./cityprofile').CityProfile;
  profiles: import('./profiles').DistrictProfile[];
}

export interface StationInfo { id: number; x: number; y: number; name: string; riders: number; underwater: boolean; depth: number; opened: number; reach?: number; walkHomes?: number; ownHomes?: number; bus?: boolean }
/** round 7 step 4b: a bus line for the HUD and the renderer (pts: the street polyline, cell units) */
export interface BusInfo { id: number; color: string; stations: number[]; trains: number; headway: number; riders: number; capacity: number; peakLoad: number; rating: number; lengthKm: number; lane: number; inherited: boolean; ride: number; pts: number[];
  /** round 7 step 6, on a busway: whether a tram fits (route km on wide streets, or why not) */
  tram?: { ok: boolean; km: number; why: string } }
export interface LineInfo {
  id: number;
  color: string;
  stations: number[];
  trains: number;
  headway: number;     // minutes
  riders: number;      // boardings per day
  capacity: number;    // passengers per hour per direction
  peakLoad: number;    // passengers per hour on busiest segment
  rating: number;      // 0..100
  lengthKm: number;
  segLoad: number[];
  by: number[];        // km by construction type: cut-and-cover, bored tunnel, viaduct, under water, rack
  elev: number[];      // track elevation at each station (m)   // peak-hour load per segment (both directions summed / 2)
  /** round 7 step 8: 'rail' for a regional line, with its track as cell points (x, y pairs) */
  mode?: 'metro' | 'rail';
  pts?: number[];
}

export interface Stats {
  month: number;
  population: number;
  homes: number;
  jobs: number;
  money: number;
  income: number;
  expenses: number;
  build: number;
  resDemand: number;
  comDemand: number;
  indDemand: number;
  congestion: number;   // 0..~2 (volume / capacity)
  driveSpeed: number;   // km/h effective
  transitShare: number; // 0..1, the metro's share of motorised trips (metro vs car)
  transitTrips: number; // metro trips per day (journeys, both directions; a change of line is one trip)
  totalTrips: number;   // trips per day by all modes
  modeTrips: { car: number; transit: number; walk: number; bike: number; bus: number; tram: number };
  /** round 7 step 5: the average transit journey in minutes (walk both ends, wait, in-vehicle, transfer penalties incl. the walk
   *  between stops, crowding), changes per trip, the share of transit trips that combine bus and metro, and transit trips a day */
  journey?: { walk: number; wait: number; ride: number; xfer: number; crowd: number; changes: number; feeder: number; trips: number };
  rating: number;
  buildings: number;
}

/** cost: what the choice takes from the city account ($, 0 = nothing or it pays the city); ok: the city can afford it (round 7: no debt) */
export interface EventChoiceInfo { label: string; detail: string; cost?: number; ok?: boolean }
export interface EventInfo { id: string; title: string; text: string; choices: EventChoiceInfo[] }

export interface DocksInfo {
  state: 'none' | 'active' | 'done';
  deal: string;
  dealName: string;
  title: string;          // project name for the panel (Docks / Rail-yard / Pithead project)
  brief: string;
  deadline: number;       // month index
  served: number;         // planned cells already in service range
  planned: number;
  carLocked: number;
  built: number;
  centre: { x: number; y: number };
}

export interface DesireLine { ax: number; ay: number; bx: number; by: number; trips: number }

/** Planar road graph: node coordinates (cell units) and live edges with stable ids, class and build year. */
export interface RoadsMsg {
  version: number;
  nodes: Float32Array;   // x,y pairs
  ids: Int32Array;       // stable edge ids (never reused)
  ea: Int32Array;
  eb: Int32Array;
  cls: Uint8Array;       // 0 arterial, 1 collector, 2 local
  year: Uint16Array;
}

/** Building plots: oriented rectangles along street frontage. */
export interface LotsMsg {
  n: number;
  id: Int32Array;
  x: Float32Array; y: Float32Array; ang: Float32Array; w: Float32Array; d: Float32Array;
  type: Uint8Array; level: Uint8Array; target: Uint8Array; constr: Uint8Array; constrTotal: Uint8Array;
  flags: Uint8Array; planType: Uint8Array; planLevel: Uint8Array;
  served: Uint8Array;    // planned plot already within walking range of a station
  asm: Uint16Array;      // large-plot assembly id (0 = none)
  astate: Uint8Array;    // 0 pending, 1 acquired (hoarding), 2 holdout, 3 cleared
  deco: Uint8Array;      // deliberate open land / yard kind (see reserves.ts)
  hgt: Uint8Array;       // height in metres of the current building (0 = default for its level)
  nhgt: Uint8Array;      // height of the building under construction
  poly: Float32Array;    // 8 numbers per plot: F0, F1, B1, B0 (cell units); F0-F1 is the street front
  dens: Uint8Array;      // density class 0..2
  prof: Uint8Array;      // district profile index
  sides: Uint8Array;     // bit0 / bit1: start / end side faces a cross street
  back: Uint8Array;      // back-row plot
  demo: Uint8Array;      // months of demolition left
  seed: Uint32Array;     // visual seed
  built: Uint16Array;    // month the building was completed
  ntype: Uint8Array;     // type after demolition (while demo > 0)
  lm: Uint8Array;        // landmark id + 1 (0 = none)
}

export interface StateMsg {
  type: 'state';
  stats: Stats;
  roads: RoadsMsg;
  lots: LotsMsg;
  /** hidden 50 m raster, only for overlays / tree placement */
  road: Uint8Array;
  lv: Float32Array;
  flags: Uint8Array;
  /** land-use territory per cell (see territory.ts) */
  terr: Uint8Array;
  /** walk minutes x10 to the nearest station on a line, over streets (255 = out of reach) */
  catchment: Uint8Array;
  stations: StationInfo[];
  lines: LineInfo[];
  /** round 7 step 4b: bus stops and bus lines */
  stops: StationInfo[];
  buses: BusInfo[];
  event: EventInfo | null;
  /** dev builds only: road graph validation (graphcheck.ts) after the latest tick, and the log of changes in the defect count */
  graph?: { defects: number; report: import('./graphcheck').GraphReport; log: string[] };
  docks: DocksInfo;
  landmarks: import('./landmarkSys').LandmarkInfo[];
  assemblies: import('./assembly').AssemblyInfo[];
  /** development projects (projects.ts): live instances and the last few finished ones */
  projects: import('./projects').ProjectInfo[];
  /** latest project notifications (newest last) */
  notices: { month: number; text: string; x: number; y: number; color: string }[];
  /** round 7: development envelope per cell (envelopes.ts ENV), the station area plans, the requested plan preview, value capture this month */
  env: Uint8Array;
  plans: ReturnType<import('./envelopes').EnvelopeSystem['infos']>;
  planPreview: ReturnType<import('./envelopes').EnvelopeSystem['preview']>;
  capture: number;
  /** round 7 step 3: demand pressure by mode (walk, car, transit opportunity: 3 bytes a cell, log scale) and missing-link candidates */
  pressure: { field: Uint8Array; cands: import('./pressure').LinkCandidate[] };
  /** round 7 step 7: the highways department's proposals (polyline in cells) and the transit streets (buses, trams, bikes, walkers) */
  /** round 7 step 9: the open gateways (intercity station, motorway junction, ferry terminal, airport) and this month's travellers */
  gateways?: { id: string; type: string; name: string; x: number; y: number; ang: number; opened: number; serve: string; trips: number; transit: number; car: number; cargo: number }[];
  /** round 7 step 8: the portals to the region and this month's out-of-town commuters */
  region?: { portals: { kind: string; x: number; y: number; name: string }[]; commuters: number; car: number; rail: number; byPortal: { name: string; kind: string; trips: number; rail: number }[] };
  roadPlan?: { proposals: { id: number; kind: string; state: string; name: string; pts: number[]; pressure: number; km: number }[]; transitStreets: number[][] };
  desire: DesireLine[];
  /** the active goal of each track, newest headline moments (each has a unique seq), unlocked upgrades */
  goals: import('./goals').GoalInfo[];
  goalsDone: number;
  goalsTotal: number;
  moments: import('./goals').Moment[];
  unlocks: string[];
  log: string[];
  speed: number;
  /** worker timings of the tick and snapshot that produced this message (ms, dev perf overlay) */
  perf?: { tick: number; snap: number };
}

export type Command =
  | { type: 'speed'; speed: number }
  | { type: 'placeStation'; x: number; y: number; kind?: 'bus' | 'rail' }
  | { type: 'removeStation'; id: number; full?: boolean }
  | { type: 'buildLine'; stations: number[]; mode?: 'bus' | 'rail' }
  /** round 7 step 4b: upgrade a bus line's streets (1 bus priority, 2 busway) */
  | { type: 'setLane'; line: number; lane: number }
  | { type: 'setTrains'; line: number; trains: number }
  | { type: 'deleteLine'; line: number }
  | { type: 'choose'; event: string; choice: number }
  | { type: 'step'; months: number }
  /** round 7: a station area plan (upzoning, CBD edge) or protecting the old town, decided by the council */
  | { type: 'proposePlan'; station: number; kind: 'station' | 'cbd' | 'protect' }
  /** ask for the plan preview of a station in the next state messages (null = none) */
  | { type: 'planPreview'; station: number | null };

export type WorkerOut = InitMsg | StateMsg | { type: 'error'; message: string } | { type: 'quote'; id: number; cost: number; km: number; underwaterKm: number };
