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

export interface StationInfo { id: number; x: number; y: number; name: string; riders: number; underwater: boolean; depth: number }
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
  transitShare: number; // 0..1
  transitTrips: number; // per day
  rating: number;
  buildings: number;
}

export interface EventChoiceInfo { label: string; detail: string }
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
  event: EventInfo | null;
  docks: DocksInfo;
  landmarks: import('./landmarkSys').LandmarkInfo[];
  assemblies: import('./assembly').AssemblyInfo[];
  desire: DesireLine[];
  log: string[];
  speed: number;
}

export type Command =
  | { type: 'speed'; speed: number }
  | { type: 'placeStation'; x: number; y: number }
  | { type: 'removeStation'; id: number }
  | { type: 'buildLine'; stations: number[] }
  | { type: 'setTrains'; line: number; trains: number }
  | { type: 'deleteLine'; line: number }
  | { type: 'choose'; event: string; choice: number }
  | { type: 'step'; months: number };

export type WorkerOut = InitMsg | StateMsg | { type: 'error'; message: string } | { type: 'quote'; id: number; cost: number; km: number; underwaterKm: number };
