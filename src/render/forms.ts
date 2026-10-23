import { BT, Flag } from '../sim/constants';
import { vhash } from './common';

/**
 * District looks. Every plot gets a land-use kind that decides its building shapes, palette and ground.
 * Local plot frame (metres): u along the street, v across it; the street is on the -v side (v = -D/2).
 */

export type Kind = 'none' | 'house' | 'core' | 'apart' | 'tower' | 'shop' | 'office' | 'cbd' | 'ind' | 'port' | 'dockNew' | 'park' | 'square' | 'church' | 'yard';

export function kindOf(type: number, level: number, flags: number): Kind {
  if (!type || !level) return 'none';
  if (type === BT.Park) return 'park';
  if (type === BT.Square) return 'square';
  if (type === BT.Landmark) return 'church';
  if (flags & Flag.Docks) {
    if (type === BT.Ind) return 'port';
    return level >= 3 ? 'tower' : 'dockNew';
  }
  if (type === BT.Ind) return 'ind';
  if (flags & Flag.Core) return 'core';
  if (type === BT.Res) return level === 1 ? 'house' : level === 2 ? 'apart' : 'tower';
  return level === 1 ? 'shop' : level === 2 ? 'office' : 'cbd';
}

// ---- muted, differentiated palette
export const PAL = {
  coreWall: [0xe2c497, 0xd8b07f, 0xe9d5b0, 0xcfa477, 0xe5cba0, 0xd9b8a0, 0xead9bb],
  coreRoof: [0xb45f3e, 0xa65439, 0xc26f47, 0x9b4e35, 0xb86a4a],
  houseWall: [0xf2ede3, 0xe9e2d2, 0xe2e6e2, 0xf0e2cc, 0xdfe5ea, 0xeee6dc],
  houseRoof: [0x666d74, 0x7a675b, 0x8b5a47, 0x5d646c, 0x735d52],
  apart: [0xccb59a, 0xbfa489, 0xd9d1c4, 0xc8beb1, 0xb99b84, 0xd4c3ad],
  flatRoof: 0x9a9893,
  tower: [0xaabdcb, 0x9db2c2, 0xb9c8d2, 0x91a9ba, 0xc4cfd7],
  cbd: [0x7f98ab, 0x8ba3b6, 0x71889a, 0x9db1c0, 0x86a0a8],
  office: [0xd8d5ce, 0xc5ccd1, 0xb8c3ca, 0xcfcac0],
  shop: [0xece5d7, 0xe3ddd0, 0xe8dfcf],
  awning: [0xb05a4b, 0x55806b, 0x46709a, 0xc69a43, 0x8b5f7a],
  ind: [0xa3aba0, 0x97a298, 0xb0b2aa, 0x8f9b90],
  indRoof: [0x7c8881, 0x6e7975, 0x878d88],
  brick: [0xa55e44, 0x93563e, 0xae694b, 0x8a5240],
  slate: [0x5f6469, 0x6a6c6e],
  container: [0xb5533c, 0x3d6e9e, 0x4f8a5b, 0xd6a23a, 0x8a8f96, 0xc9c3b6, 0x7b4a6a],
  stone: 0xdcd0b6,
  leaf: [0x8fae73, 0x9bb87e, 0x80a26b, 0xa6bf87, 0x88a874],
  pine: [0x6f8f62, 0x7a9969, 0x678758],
  trunk: 0x86735f,
};

export const GROUND: Record<Kind, number> = {
  none: 0, yard: 0xc4d3aa, house: 0xbcd19f, core: 0xcdbea4, apart: 0xd3cdc1, tower: 0xd5d1c9, shop: 0xc4c2bb, office: 0xd2cfc8, cbd: 0xcfccc6,
  ind: 0xb9b8b1, port: 0xbdbbb4, dockNew: 0xd2ccc0, park: 0x9fc07f, square: 0xddd2bf, church: 0xd8ccb6,
};
export const SITE = 0xd8c8a6; // construction site / planned ground

export const pick = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
