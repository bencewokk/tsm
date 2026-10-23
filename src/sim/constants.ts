export const N = 128;               // grid cells per side
export const CELL = 50;             // metres per cell
export const ZONE = 8;              // cells per zone side
export const NZ = N / ZONE;         // zones per side (16)
export const ZONES = NZ * NZ;       // 256

export const BT = { None: 0, Res: 1, Com: 2, Ind: 3, Park: 4, Square: 5, Landmark: 6 } as const;
/** Amenity plots that hold no homes or jobs and never grow or decline. */
export const isAmenity = (t: number) => t === BT.Park || t === BT.Square || t === BT.Landmark;
export const Water = { Land: 0, Sea: 1, River: 2 } as const;

export const Flag = {
  Docks: 1,       // part of the old docks district
  CarLocked: 2,   // residents bought cars: lower transit share for good
  Planned: 4,     // ghost building planned by the docks project
  Steep: 8,       // too steep to build
  Core: 16,       // lot flag: part of an original village core (old town)
  Rail: 32,       // raster flag: railway corridor (no plots). Lot flags: 32 = civic landmark (hall)
  Civic: 32,      // lot flag (Landmark plots): a civic hall instead of a church
  Mine: 64,       // lot flag: pithead / mine yard building
  Flood: 128,     // raster flag: river floodplain (wetland, no plots; roads may cross it on causeways)
} as const;

/** Households per residential level (index = level). */
export const HOMES = [0, 6, 60, 280];
/** Jobs per commercial level. */
export const COM_JOBS = [0, 14, 150, 650];
/** Jobs per industrial level. */
export const IND_JOBS = [0, 30, 90, 90];
/** Months of construction to reach a level. */
export const BUILD_MONTHS = [0, 1, 2, 4];

export const PERSONS_PER_HOME = 2.3;
export const TRIPS_PER_HOME = 3.0;     // motorised trips per household per day
export const PEAK_FACTOR = 0.12;       // share of daily trips in the peak hour, per direction
export const WORKERS_PER_HOME = 1.15;

// ---- metro economics ----
export const STATION_COST = 5e6;
export const TUNNEL_KM = 11e6;
export const WATER_KM = 34e6;          // tunnelling under water costs ~3x
export const TRAIN_COST = 2e6;         // buying a train
export const TRAIN_MONTH = 0.05e6;     // running cost per train per month
export const STATION_UPKEEP = 0.02e6;  // per station per month
export const TRACK_UPKEEP_KM = 0.015e6; // per km per month
export const FARE = 4;                 // flat fare per trip
export const TRAIN_CAP = 300;          // passengers per (short, automated) train
export const METRO_SPEED = 36;         // km/h including dwell
export const START_MONEY = 150e6;
export const LINE_COLORS = ['#d9534f', '#2f7fc1', '#3a9d5d', '#e0a526', '#8e5bb5', '#e06fa0', '#1fa3a3', '#7a6a58'];

/** Cost to tunnel between two cell positions; fraction under water sampled along the segment. */
export function segmentCost(ax: number, ay: number, bx: number, by: number, water: Uint8Array) {
  const d = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(d * 2));
  let wet = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t);
    if (x >= 0 && y >= 0 && x < N && y < N && water[y * N + x]) wet++;
  }
  const km = (d * CELL) / 1000;
  const wkm = km * (wet / (steps + 1));
  return { km, wkm, cost: (km - wkm) * TUNNEL_KM + wkm * WATER_KM };
}
