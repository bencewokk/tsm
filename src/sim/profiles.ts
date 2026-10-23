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
  flat?: number;       // chance that houses get flat roofs instead of pitched ones
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
  plasterSlate: {
    wall: [0xf2ede3, 0xe9e2d2, 0xe2e6e2, 0xdfe5ea, 0xeee6dc, 0xd9d6cf],
    roof: [0x4f5560, 0x5a6068, 0x484d56, 0x636a73],
    mid: [0xb7b2a6, 0xa9a396, 0xc4bdae, 0xb0a58f],
    shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xbcd19f,
    accent: [0x8b5f4b, 0x55706b, 0x46607a, 0xa68a43, 0x6b5f7a],
  },
  sand: {
    wall: [0xe8d4a8, 0xdfc79a, 0xefdcb6, 0xd8bd8c, 0xe9cfa0, 0xf0e2c2],
    roof: [0xc9a27a, 0xb98f68, 0xd1b08a, 0xa9805a],
    mid: [0xe3cfa3, 0xd7bd8e, 0xefdcb6, 0xcfb582],
    shop: [0xf0e2c2, 0xe8d4a8, 0xefdcb6],
    office: [0xe3ded2, 0xd4d8d6, 0xc8cfd1, 0xe0dbcc],
    glass: [0x8da6b5, 0x9ab0b8, 0xa6b9c0, 0x7d9a8c, 0xb4bcc2, 0x9a9c9c],
    ground: 0xd8c8a0,
    accent: [0x9a5a4b, 0x4f7a6b, 0x46709a, 0xc69a43, 0x8b5f7a],
    flat: 0.8,
  },
  slateStone: {
    wall: [0xb7b2a6, 0xa9a396, 0xc4bdae, 0x9d978a, 0xb0a58f, 0xbab09b],
    roof: [0x4f5560, 0x5a6068, 0x484d56, 0x636a73],
    mid: [0xb7b2a6, 0xa9a396, 0xc4bdae, 0xb0a58f],
    shop: [0xcfc9bb, 0xc4bdae, 0xd5cdbb],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xb5b0a2,
    accent: [0x8b5f4b, 0x55706b, 0x46607a, 0xa68a43, 0x6b5f7a],
  },
  neoclassic: {
    wall: [0xf0ead8, 0xe8e0cb, 0xf4efe2, 0xe3dcc8, 0xddd5bf, 0xeadfc6],
    roof: [0x8d9a95, 0x7f8d89, 0x9aa7a3, 0x6f7d7a],
    mid: [0xe8e0cb, 0xddd5bf, 0xf0ead8, 0xd9cfb8],
    shop: [0xf0ead8, 0xe8e0cb, 0xf4efe2],
    office: [0xe3ded2, 0xd4d8d6, 0xc8cfd1, 0xe0dbcc],
    glass: [0x8da6b5, 0x9ab0b8, 0xa6b9c0, 0x7d9a8c, 0xb4bcc2, 0x9a9c9c],
    ground: 0xdcd6c6,
    accent: [0x6f4b4b, 0x4b6f5e, 0x4b5f7a, 0xa68a43, 0x6b4b6b],
  },
  market: {
    wall: [0xf1ebdc, 0xe9dcc0, 0xdcc7a0, 0xe6d2c0, 0xefe4d0, 0xd9c9a8],
    roof: [0x6b4f40, 0x5a4a44, 0x7a5a46, 0x4f4640],
    mid: [0xe9dcc0, 0xdcc7a0, 0xd9c9a8, 0xe6d2c0],
    shop: [0xf1ebdc, 0xe9dcc0, 0xefe4d0],
    office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
    glass: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
    ground: 0xcfc3a8,
    accent: [0xa05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
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

/** Base profiles (the port city's set plus the profiles of other eras); `deriveProfiles` adapts them to a city. */
export const BASE_PROFILES: DistrictProfile[] = [
  { id: 'suburb', density: 0.2, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.74, 0.82], lotDepthRange: [0.66, 0.74], setbackRange: [0.09, 0.11],
    buildingHeightRange: [0.82, 0.82], frontageContinuity: 0, roadRegularity: 0.35, palette: 'plaster', era: 0.3, yardChance: 0.6, courtyardChance: 0, growthRate: 1, backRows: 0 },
  { id: 'terraces', density: 0.55, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.52, 0.6], lotDepthRange: [0.58, 0.66], setbackRange: [0.05, 0.07],
    buildingHeightRange: [1, 1], frontageContinuity: 1, roadRegularity: 0.5, palette: 'brick', era: 0.4, yardChance: 0.35, courtyardChance: 0.5, growthRate: 1, backRows: 1 },
  { id: 'oldTown', density: 0.9, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.42, 0.5], lotDepthRange: [0.52, 0.6], setbackRange: [0.035, 0.045],
    buildingHeightRange: [1.08, 1.08], frontageContinuity: 1, roadRegularity: 0.25, palette: 'terracotta', era: 0, yardChance: 0.35, courtyardChance: 0.6, growthRate: 1, backRows: 2 },
  { id: 'downtown', density: 1, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.42, 0.5], lotDepthRange: [0.52, 0.6], setbackRange: [0.035, 0.045],
    buildingHeightRange: [1.0, 1.16], frontageContinuity: 1, roadRegularity: 0.5, palette: 'modern', era: 0.5, yardChance: 0.3, courtyardChance: 0.7, growthRate: 1, backRows: 2 },
  { id: 'miners', density: 0.85, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.38, 0.44], lotDepthRange: [0.46, 0.52], setbackRange: [0.03, 0.04],
    buildingHeightRange: [0.9, 1], frontageContinuity: 1, roadRegularity: 0.1, palette: 'slateStone', era: 0, yardChance: 0.15, courtyardChance: 0.1, growthRate: 1, backRows: 1 },
  { id: 'grand', density: 0.85, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.62, 0.74], lotDepthRange: [0.6, 0.68], setbackRange: [0.08, 0.1],
    buildingHeightRange: [1.15, 1.4], frontageContinuity: 1, roadRegularity: 1, palette: 'neoclassic', era: 0.25, yardChance: 0.2, courtyardChance: 0.8, growthRate: 1, backRows: 1 },
  { id: 'grandOuter', density: 0.5, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.66, 0.76], lotDepthRange: [0.62, 0.7], setbackRange: [0.09, 0.11],
    buildingHeightRange: [0.9, 1.0], frontageContinuity: 0.75, roadRegularity: 0.9, palette: 'neoclassic', era: 0.35, yardChance: 0.5, courtyardChance: 0.5, growthRate: 1, backRows: 0 },
  { id: 'railside', density: 0.6, landUseMix: { res: 0.4, com: 0.4, ind: 0.8 }, lotWidthRange: [0.6, 0.7], lotDepthRange: [0.6, 0.7], setbackRange: [0.05, 0.06],
    buildingHeightRange: [1, 1], frontageContinuity: 1, roadRegularity: 0.8, palette: 'dockBrick', era: 0.3, yardChance: 0.1, courtyardChance: 0.2, growthRate: 1, backRows: 0 },
  { id: 'marketTown', density: 0.9, landUseMix: { res: 0.5, com: 0.55, ind: 0.45 }, lotWidthRange: [0.44, 0.52], lotDepthRange: [0.54, 0.62], setbackRange: [0.035, 0.045],
    buildingHeightRange: [1.0, 1.05], frontageContinuity: 1, roadRegularity: 0.3, palette: 'market', era: 0.05, yardChance: 0.35, courtyardChance: 0.5, growthRate: 1, backRows: 2 },
  { id: 'garden', density: 0.3, landUseMix: { res: 0.6, com: 0.4, ind: 0.3 }, lotWidthRange: [0.7, 0.8], lotDepthRange: [0.66, 0.74], setbackRange: [0.1, 0.12],
    buildingHeightRange: [0.8, 0.9], frontageContinuity: 0.2, roadRegularity: 0.8, palette: 'plaster', era: 0.45, yardChance: 0.8, courtyardChance: 0, growthRate: 1, backRows: 0 },
  { id: 'docks', density: 0.6, landUseMix: { res: 0.5, com: 0.5, ind: 0.5 }, lotWidthRange: [0.52, 0.6], lotDepthRange: [0.58, 0.66], setbackRange: [0.05, 0.07],
    buildingHeightRange: [1, 1], frontageContinuity: 1, roadRegularity: 0.6, palette: 'dockBrick', era: 0.2, yardChance: 0.1, courtyardChance: 0.2, growthRate: 1, backRows: 0 },
];

export const PROFILE_INDEX: Record<string, number> = Object.fromEntries(BASE_PROFILES.map((p, i) => [p.id, i]));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Regional building tradition: which palette the old-fabric profiles use. 'south' is the port city's own. */
export const TRADITIONS: Record<string, Record<string, string>> = {
  south: {},
  north: { oldTown: 'slateStone', terraces: 'slateStone', marketTown: 'slateStone', suburb: 'plasterSlate', garden: 'plasterSlate', miners: 'slateStone' },
  brick: { oldTown: 'brick', marketTown: 'brick', suburb: 'brick', garden: 'brick', miners: 'brick' },
  whitewash: { oldTown: 'market', terraces: 'market', marketTown: 'market', suburb: 'market', garden: 'market', miners: 'market' },
  sand: { oldTown: 'sand', terraces: 'sand', marketTown: 'sand', suburb: 'sand', garden: 'sand', miners: 'sand' },
};

/** Adapt the base profiles to a city: planning strength moves road regularity, wealth heights and greenery, dominant types the land-use mix. Identity at 0.5 / 0.5. */
export function deriveProfiles(cp: { planningStrength: number; wealth: number; dominant: { res: number; com: number; ind: number }; tradition?: string }): DistrictProfile[] {
  const trad = TRADITIONS[cp.tradition ?? 'south'] ?? {};
  return BASE_PROFILES.map((b) => ({
    ...b,
    palette: trad[b.id] ?? b.palette,
    roadRegularity: clamp01(b.roadRegularity + (cp.planningStrength - 0.5) * 0.9),
    buildingHeightRange: [b.buildingHeightRange[0] * (0.8 + 0.4 * cp.wealth), b.buildingHeightRange[1] * (0.8 + 0.4 * cp.wealth)] as [number, number],
    yardChance: clamp01(b.yardChance + (cp.wealth - 0.5) * 0.4),
    landUseMix: {
      res: clamp01(b.landUseMix.res + cp.dominant.res - 0.5), com: clamp01(b.landUseMix.com + cp.dominant.com - 0.5), ind: clamp01(b.landUseMix.ind + cp.dominant.ind - 0.5),
    },
  }));
}

/** The default (port city) set. */
export const PROFILES: DistrictProfile[] = deriveProfiles({ planningStrength: 0.5, wealth: 0.5, dominant: { res: 0.5, com: 0.5, ind: 0.5 } });
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
