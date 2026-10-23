import { N, CELL } from '../sim/constants';

/** Vertical exaggeration for terrain relief. */
export const VS = 2.3;
export const MAP = N * CELL;

export function cellCenter(x: number, y: number): [number, number] {
  return [(x + 0.5) * CELL, (y + 0.5) * CELL];
}

/** Ground elevation (world units) at a cell centre. */
export function groundY(height: Float32Array, water: Uint8Array, i: number): number {
  if (water[i]) return 0.4;
  return height[i] * VS;
}

/** Deterministic per-cell hash for visual variation (never used by the sim). */
export function vhash(i: number, k = 0): number {
  let h = (i * 2654435761 + k * 40503) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
