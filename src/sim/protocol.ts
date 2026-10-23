import type { Village } from './terrain';

export interface InitMsg {
  type: 'init';
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  villages: Village[];
  bay: { x: number; y: number; r: number };
}

export interface StationInfo { id: number; x: number; y: number; name: string; riders: number; underwater: boolean }
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
  segLoad: number[];   // peak-hour load per segment (both directions summed / 2)
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
  brief: string;
  deadline: number;       // month index
  served: number;         // planned cells already in service range
  planned: number;
  carLocked: number;
  built: number;
  centre: { x: number; y: number };
}

export interface DesireLine { ax: number; ay: number; bx: number; by: number; trips: number }

export interface StateMsg {
  type: 'state';
  stats: Stats;
  road: Uint8Array;
  btype: Uint8Array;
  level: Uint8Array;
  target: Uint8Array;
  constr: Uint8Array;
  constrTotal: Uint8Array;
  lv: Float32Array;
  flags: Uint8Array;
  planType: Uint8Array;
  planLevel: Uint8Array;
  stations: StationInfo[];
  lines: LineInfo[];
  event: EventInfo | null;
  docks: DocksInfo;
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
