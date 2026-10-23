/**
 * District profiles: every district parameter of the city fabric lives here as data.
 * A district picks one profile; plots then vary it slightly per street (edge) and per construction wave.
 * Pure data + tiny helpers, shared by the sim (plot generation, growth) and the renderer (forms, palettes).
 */

export interface Palette {
  wall: number[];      // main walls of the district's houses / rows
  roof: number[];      // pitched roofs
  mid: number[];       // apartment blocks
  shop: number[];      // shopfront rows
  office: number[];    // office / commercial slabs
  glass: number[];     // tower glazing
  ground: number;      // plot ground tint
  accent: number[];    // awnings, trims
}

export interface DistrictProfile {
  id: string;
  /** 0..1: built-up intensity. Drives capacity per plot and which tier the form picks. */
  density: number;
  /** relative land-use preference (0..1 each, 0.5 = neutral) used to weight what gets built where */
  landUseMix: { res: number; com: number; ind: number };
  /** frontage width of a plot, cells (50 m); each street picks a value inside the range */
  lotWidthRange: [number, number];
  lotDepthRange: [number, number];
  /** distance of the building line from the kerb, cells */
  setbackRange: [number, number];
  /** multiplier on a kind's base height (towers, slabs) per construction wave */
  buildingHeightRange: [number, number];
  /** 1 = rows share party walls, 0 = detached with a gap between plots */
  frontageContinuity: number;
  /** 0 organic .. 1 planned: how closely new streets follow the district grid direction */
  roadRegularity: number;
  palette: string;
  /** 0 old .. 1 modern: base of the style era (tower style mix, roofs) */
  era: number;
  /** chance that a vacant plot is kept as a garden / yard with trees */
  yardChance: number;
  /** chance that a block face closes into a courtyard (wings, rear ranges) */
  courtyardChance: number;
  /** multiplier on the chance that plots here get built */
  growthRate: number;
  /** rows of plots behind the street front (courtyards fill the block interior) */
  backRows: number;
}

export const PALETTES: Record<string, Palette> = {
  terracotta: {
    wall: [0xe2c497, 0xd8b07f, 0xe9d5b0, 0xcfa477, 0xe5cba0, 0xd9b8a0, 0xead9bb],
    roof: [0xb45f3e, 0xa65439, 0xc26f47, 0x9b4e35, 0xb86a4a],
    mid: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xcdbea4,
    accent: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  },
  brick: {
    wall: [0xa55e44, 0x93563e, 0xae694b, 0x8a5240, 0xf2ede3, 0xe9e2d2, 0xe2e6e2, 0xf0e2cc],
    roof: [0x666d74, 0x7a675b, 0x8b5a47, 0x5d646c, 0x735d52, 0xb45f3e, 0xa65439],
    mid: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xcdbea4,
    accent: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  },
  plaster: {
    wall: [0xf2ede3, 0xe9e2d2, 0xe2e6e2, 0xf0e2cc, 0xdfe5ea, 0xeee6dc],
    roof: [0x666d74, 0x7a675b, 0x8b5a47, 0x5d646c, 0x735d52],
    mid: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xbcd19f,
    accent: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  },
  modern: {
    wall: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0, 0xe6e1d6],
    roof: [0x5f6469, 0x6a6c6e],
    mid: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xcfccc6,
    accent: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  },
  dockBrick: {
    wall: [0xa55e44, 0x93563e, 0xae694b, 0x8a5240],
    roof: [0x5f6469, 0x6a6c6e],
    mid: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xbdbbb4,
    accent: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  },
};

/** The port city: one set of profiles. */
export const PROFILES: DistrictProfile[] = [
  { id: 'suburb', density: 0.2, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.74, 0.82], lotDepthRange: [0.66, 0.74], setbackRange: [0.09, 0.11],
    buildingHeightRange: [0.82, 0.82], frontageContinuity: 0, roadRegularity: 0.35, palette: 'plaster', era: 0.3, yardChance: 0.6, courtyardChance: 0, growthRate: 1, backRows: 0 },
  { id: 'terraces', density: 0.55, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.52, 0.6], lotDepthRange: [0.58, 0.66], setbackRange: [0.05, 0.07],
    buildingHeightRange: [1, 1], frontageContinuity: 1, roadRegularity: 0.5, palette: 'brick', era: 0.4, yardChance: 0.35, courtyardChance: 0.5, growthRate: 1, backRows: 1 },
  { id: 'oldTown', density: 0.9, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.42, 0.5], lotDepthRange: [0.52, 0.6], setbackRange: [0.035, 0.045],
    buildingHeightRange: [1.08, 1.08], frontageContinuity: 1, roadRegularity: 0.25, palette: 'terracotta', era: 0, yardChance: 0.35, courtyardChance: 0.6, growthRate: 1, backRows: 2 },
  { id: 'downtown', density: 1, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.42, 0.5], lotDepthRange: [0.52, 0.6], setbackRange: [0.035, 0.045],
    buildingHeightRange: [1.0, 1.16], frontageContinuity: 1, roadRegularity: 0.5, palette: 'modern', era: 0.5, yardChance: 0.3, courtyardChance: 0.7, growthRate: 1, backRows: 2 },
  { id: 'docks', density: 0.6, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.52, 0.6], lotDepthRange: [0.58, 0.66], setbackRange: [0.05, 0.07],
    buildingHeightRange: [1, 1], frontageContinuity: 1, roadRegularity: 0.6, palette: 'dockBrick', era: 0.2, yardChance: 0.1, courtyardChance: 0.2, growthRate: 1, backRows: 0 },
];

export const PROFILE_INDEX: Record<string, number> = Object.fromEntries(PROFILES.map((p, i) => [p.id, i]));
export const profileById = (id: string) => PROFILES[PROFILE_INDEX[id]];

/** Zoning rules: which profile a new street gets (distances in cells). Stage B replaces these with per-city generated layers. */
export const ZONING = {
  coreRadius: 7.5,    // around an original village centre: old town
  stationCore: 3.2,   // next to a station: downtown
  valueCore: 0.66,    // land value above this: downtown
  midRadius: 13,
  stationMid: 6.5,
  valueMid: 0.46,
};

/** Cheap deterministic per-key variation in 0..1 (street / construction wave). */
export function hash01(a: number, k: number): number {
  let h = (Math.imul(a | 0, 2654435761) ^ Math.imul(k | 0, 40503)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const lerpRange = (r: [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/** 0 detached, 1 terraced / mid, 2 dense core: the coarse class the forms switch on. */
export function densClass(p: DistrictProfile): number {
  return p.frontageContinuity < 0.5 ? 0 : p.density >= 0.8 ? 2 : 1;
}
