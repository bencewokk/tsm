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
// trips per resident and the mode choice live in TRIP (sim.ts, round 7 calibration)
export const PEAK_FACTOR = 0.12;       // share of daily trips in the peak hour, per direction
export const WORKERS_PER_HOME = 1.15;

// ---- metro economics ----
export const STATION_COST = 5e6;
export const TUNNEL_KM = 11e6;
export const WATER_KM = 34e6;          // tunnelling under water costs ~3x
export const TRAIN_COST = 2e6;         // buying a train
// running costs (round 7: were 0.05M / 0.02M / 0.015M, so a line paid for itself many times over and money never bound; now a starter
// line roughly breaks even on fares in its first years and a well-used one makes a modest surplus)
export const TRAIN_MONTH = 0.12e6;     // running cost per train per month (crew, energy, maintenance)
export const STATION_UPKEEP = 0.06e6;  // per station per month (staff, escalators, cleaning)
export const TRACK_UPKEEP_KM = 0.04e6; // per km per month
/** round 7 step 4b: buses. A stop costs little, a bus is cheap to buy and to run; lane upgrades per street km */
export const BUS_STOP_COST = 0.3e6;
export const BUS_COST = 0.45e6;
export const BUS_MONTH = 0.03e6;
export const STOP_UPKEEP = 0.003e6;
export const LANE_COST_KM = [0, 0.8e6, 5e6, 16e6];   // ordinary, bus priority (paint, signals), busway (kerbed, own lane), tram (street track over the busway)
/** round 7 step 6: a tram (replaces the buses of an upgraded busway; about three in four buses' worth), its running cost and seats */
export const TRAM_COST = 3.5e6;
export const TRAM_MONTH = 0.07e6;
export const TRAM_CAP = 200;
export const FARE = 4;                 // flat fare per trip
export const TRAIN_CAP = 300;          // passengers per (short, automated) train
export const METRO_SPEED = 36;         // km/h including dwell
export const START_MONEY = 100e6;     // round 7: was 150M (line two and three were affordable from day one)
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
