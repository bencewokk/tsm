export const N = 128;               // grid cells per side
export const CELL = 50;             // metres per cell
export const ZONE = 8;              // cells per zone side
export const NZ = N / ZONE;         // zones per side (16)
export const ZONES = NZ * NZ;       // 256

export const BT = { None: 0, Res: 1, Com: 2, Ind: 3, Park: 4 } as const;
export const Water = { Land: 0, Sea: 1, River: 2 } as const;

export const Flag = {
  Docks: 1,       // part of the old docks district
  CarLocked: 2,   // residents bought cars: lower transit share for good
  Planned: 4,     // ghost building planned by the docks project
  Steep: 8,       // too steep to build
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
export const WORKERS_PER_HOME = 1.15;
