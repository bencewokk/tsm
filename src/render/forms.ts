import { BT, Flag } from '../sim/constants';
import { vhash } from './common';

/**
 * District looks. Every plot gets a land-use kind that decides its building shapes, palette and ground.
 * Local plot frame (metres): u along the street, v across it; the street is on the -v side (v = -D/2).
 */
export type Shape = 'wall' | 'glass' | 'plain' | 'gable' | 'saw' | 'pyr' | 'cyl' | 'tree' | 'pine';
export interface Part { s: Shape; u: number; v: number; w: number; d: number; h: number; y: number; c: number; r?: number }

export const W = 39, D = 35; // plot size in metres (LOT_W, LOT_D)
const FRONT = -D / 2;

export type Kind = 'none' | 'house' | 'core' | 'apart' | 'tower' | 'shop' | 'office' | 'cbd' | 'ind' | 'port' | 'dockNew' | 'park' | 'square' | 'church';

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
  none: 0, house: 0xbcd19f, core: 0xcdbea4, apart: 0xd3cdc1, tower: 0xd5d1c9, shop: 0xc4c2bb, office: 0xd2cfc8, cbd: 0xcfccc6,
  ind: 0xb9b8b1, port: 0xbdbbb4, dockNew: 0xd2ccc0, park: 0x9fc07f, square: 0xddd2bf, church: 0xd8ccb6,
};
export const SITE = 0xd8c8a6; // construction site / planned ground

const pick = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];

/** Building parts for a plot. Deterministic per plot id; purely visual. */
export function partsFor(id: number, kind: Kind, level: number): Part[] {
  const r = (k: number) => vhash(id, k);
  const out: Part[] = [];
  const P = (s: Shape, u: number, v: number, w: number, d: number, h: number, y: number, c: number, rr = 0) => out.push({ s, u, v, w, d, h, y, c, r: rr });
  const tree = (u: number, v: number, size: number, k: number) => out.push({ s: r(k) < 0.25 ? 'pine' : 'tree', u, v, w: size, d: size, h: size * (r(k) < 0.25 ? 1.9 : 1.15), y: 0, c: 0 });
  switch (kind) {
    case 'house': {
      const wallC = pick(PAL.houseWall, r(1)), roofC = pick(PAL.houseRoof, r(2));
      const across = r(3) < 0.35;
      const house = (u: number, w: number, d: number, h: number, wc: number) => {
        const v = FRONT + 8 + d / 2 + r(4) * 2;
        P('wall', u, v, w, d, h, 0, wc);
        if (across) P('gable', u, v, d + 1.2, w + 1.2, 3.6 + r(5), h, roofC, Math.PI / 2);
        else P('gable', u, v, w + 1.2, d + 1.2, 3.6 + r(5), h, roofC);
      };
      if (r(6) < 0.55) {
        house(-9.5 + r(7) * 2, 11 + r(8) * 2, 9 + r(9) * 2, 5.5 + r(10), wallC);
        house(9.5 - r(11) * 2, 11 + r(12) * 2, 9 + r(13) * 2, 5.5 + r(14), pick(PAL.houseWall, r(15)));
        tree(-9 + r(16) * 4, 11, 6 + r(17) * 2, 18);
        tree(10 - r(19) * 4, 12, 5.5 + r(20) * 2, 21);
      } else {
        house(-2 + r(7) * 4, 15 + r(8) * 2, 11 + r(9) * 1.5, 6 + r(10), wallC);
        P('wall', 11.5, FRONT + 10, 6.5, 7, 3, 0, 0xd9d6cf); // garage
        tree(-12 + r(16) * 4, 11, 6.5 + r(17) * 2, 18);
        tree(8 + r(19) * 4, 12, 6 + r(20) * 2, 21);
      }
      if (r(22) < 0.6) tree(-15 + r(23) * 30, FRONT + 2.5, 5 + r(24) * 1.5, 25); // street tree
      break;
    }
    case 'core': {
      // a row of narrow townhouses on the street line, pitched terracotta roofs, varied heights
      const n = level >= 2 ? 3 : 3 + (r(1) < 0.4 ? 1 : 0);
      const segW = W / n;
      for (let k = 0; k < n; k++) {
        if (level === 1 && r(30 + k) < 0.14) continue; // a gap: little yard
        const h = (level === 1 ? 7.5 : level === 2 ? 13 : 20) + r(40 + k) * (level === 1 ? 4 : 5);
        const d = (level === 1 ? 12 : 16) + r(50 + k) * 4;
        const u = -W / 2 + segW * (k + 0.5);
        const v = FRONT + 0.6 + d / 2;
        const w = segW - 0.4;
        P('wall', u, v, w, d, h, 0, pick(PAL.coreWall, r(60 + k)));
        P('gable', u, v, w + 0.6, d + 1, 4 + r(70 + k) * 2.5, h, pick(PAL.coreRoof, r(80 + k)));
      }
      // rear wing on deeper levels
      if (level >= 2 && r(2) < 0.7) {
        const h = 9 + r(3) * 4;
        P('wall', (r(4) - 0.5) * 16, 9, 14, 12, h, 0, pick(PAL.coreWall, r(5)));
        P('gable', (r(4) - 0.5) * 16, 9, 12.6, 14.6, 3.5, h, pick(PAL.coreRoof, r(6)), Math.PI / 2);
      }
      break;
    }
    case 'apart': {
      // perimeter block: front bar on the street, wings around a courtyard, flat roofs
      const c = pick(PAL.apart, r(1)), H = 13 + r(2) * 10;
      P('wall', 0, FRONT + 1.5 + 6, W - 1.5, 12, H, 0, c);
      P('plain', 0, FRONT + 7.5, W - 2.5, 11, 0.9, H, PAL.flatRoof);
      const wings = r(3) < 0.4 ? [r(4) < 0.5 ? -1 : 1] : [-1, 1];
      for (const s of wings) {
        const wh = H * (0.75 + r(5 + s) * 0.25);
        P('wall', s * 13.5, 5, 11, 21, wh, 0, c);
        P('plain', s * 13.5, 5, 10, 20, 0.9, wh, PAL.flatRoof);
      }
      if (r(9) < 0.6) tree((r(10) - 0.5) * 6, 9, 6, 11);
      break;
    }
    case 'tower': {
      const pc = pick(PAL.apart, r(1));
      P('wall', 0, -1, 37, 31, 7 + r(2) * 2, 0, pc);
      const tw = 16 + r(3) * 5, th = 52 + r(4) * 45, u = (r(5) - 0.5) * 6, v = (r(6) - 0.5) * 4;
      const tc = pick(PAL.tower, r(7));
      P('glass', u, v, tw, tw * (0.85 + r(8) * 0.3), th, 0, tc);
      P('plain', u, v, tw - 4, tw - 4, 3, th, 0xe3e6e8);
      break;
    }
    case 'shop': {
      const d = 15 + r(1) * 3, h = 5 + r(2) * 2.5, w = 27 + r(3) * 6, v = FRONT + 2 + d / 2;
      P('wall', 0, v, w, d, h, 0, pick(PAL.shop, r(4)));
      P('plain', 0, v, w - 1, d - 1, 0.7, h, PAL.flatRoof);
      P('plain', 0, FRONT + 1.2, w, 2.4, 0.45, 3.2, pick(PAL.awning, r(5))); // awning over the pavement
      if (r(6) < 0.5) P('plain', (r(7) - 0.5) * 12, v + 2, 4, 3, 1.6, h + 0.7, 0xc8c8c4); // rooftop plant
      break;
    }
    case 'office': {
      const c = pick(PAL.office, r(1)), h = 22 + r(2) * 16;
      P('glass', 0, -2, 33, 25, h, 0, c);
      if (r(3) < 0.6) P('glass', (r(4) - 0.5) * 6, -2, 22, 17, 7 + r(5) * 8, h, c);
      else P('plain', 0, -2, 31, 23, 1, h, PAL.flatRoof);
      break;
    }
    case 'cbd': {
      const c = pick(PAL.cbd, r(1));
      P('glass', 0, 0, 37, 32, 11, 0, pick(PAL.office, r(2)));
      const tw = 22 + r(3) * 5, th = 100 + r(4) * 65;
      P('glass', 0, 0, tw, tw * (0.8 + r(5) * 0.3), th, 0, c);
      P('glass', 0, 0, tw * 0.68, tw * 0.6, 9 + r(6) * 8, th, c);
      if (r(7) < 0.6) P('cyl', 0, 0, 1.6, 1.6, 18, th + 9, 0xd7d9db);
      break;
    }
    case 'ind': {
      // big grey shed with a sawtooth or low roof, a chimney, tanks and a stock yard with pallets and containers
      const c = pick(PAL.ind, r(1)), h = level >= 2 ? 11 + r(2) * 3 : 8 + r(2) * 2;
      const w = 34 + r(3) * 3, d = 18 + r(4) * 3, v = FRONT + 3 + d / 2;
      P('plain', 0, v, w, d, h, 0, c);
      if (level >= 2 || r(5) < 0.55) P('saw', 0, v, w, d, 3.6, h, pick(PAL.indRoof, r(6)));
      else P('plain', 0, v, w - 1, d - 1, 0.9, h, pick(PAL.indRoof, r(6)));
      P('plain', 0, FRONT + 3 - 0.2, w * 0.7, 0.6, 5, 0, 0x54595c); // loading dock doors
      const yardV = FRONT + 3 + d + 5.5;
      // chimney by the shed
      if (level >= 2 || r(7) < 0.55) { P('cyl', w / 2 - 3.5, v + d / 2 - 4, 3.6, 3.6, 26 + r(8) * 14, 0, pick(PAL.brick, r(9))); P('cyl', w / 2 - 3.5, v + d / 2 - 4, 4.2, 4.2, 1.6, 24 + r(8) * 14, 0xe8e4dc); }
      // yard: fenced strip with tanks or stock
      if (r(10) < 0.5) {
        for (let k = 0; k < 3; k++) P('cyl', -12 + k * 9.5, yardV, 7.5, 7.5, 7 + r(11 + k) * 3, 0, 0xd8d9d4);
      } else {
        for (let k = 0; k < 3; k++) for (let s = 0; s < 1 + Math.floor(r(14 + k) * 2.4); s++) P('plain', -12 + k * 12, yardV, 10.5, 4.2, 2.55, s * 2.6, pick(PAL.container, r(20 + k * 3 + s)));
      }
      P('plain', 0, yardV + 4.6, W - 3, 0.35, 1.7, 0, 0x6b7076); // yard fence
      break;
    }
    case 'port': {
      if (r(1) < 0.42) {
        // container yard: stacks of coloured boxes
        for (let row = 0; row < 5; row++)
          for (let col = 0; col < 3; col++) {
            if (r(100 + row * 3 + col) < 0.18) continue;
            const stack = 1 + Math.floor(r(120 + row * 3 + col) * 3);
            for (let s = 0; s < stack; s++)
              P('plain', -12.6 + col * 12.6, -12 + row * 5.6, 12, 2.4, 2.55, s * 2.6, pick(PAL.container, r(140 + row * 9 + col * 3 + s)));
          }
      } else {
        // long low warehouse with gabled or sawtooth roof
        const h = 9 + r(2) * 3, c = pick(PAL.brick, r(3));
        P('plain', 0, 0, 37, 23, h, 0, c);
        if (level >= 2 || r(4) < 0.6) P('saw', 0, 0, 37, 23, 3.5, h, pick(PAL.slate, r(5)));
        else P('gable', 0, 0, 37.6, 24, 5, h, pick(PAL.slate, r(5)));
        for (let k = -1; k <= 1; k++) P('plain', k * 11, FRONT + 5.4, 5, 0.6, 5, 0, 0x5d5f60); // loading doors
      }
      break;
    }
    case 'dockNew': {
      if (r(1) < 0.5) {
        // converted warehouse: brick, big pitched roof, now with windows
        const h = 12 + r(2) * 5;
        P('wall', 0, -1, 36, 21, h, 0, pick(PAL.brick, r(3)));
        P('gable', 0, -1, 36.6, 22, 5.5, h, pick(PAL.slate, r(4)));
      } else {
        // new mid-rise on the waterfront
        const h = (level >= 2 ? 18 : 11) + r(2) * 8;
        P('wall', -4, -3, 28, 20, h, 0, r(3) < 0.5 ? 0xe9e7e2 : 0xd6dade);
        P('wall', 11, 8, 14, 14, h * 0.7, 0, r(3) < 0.5 ? 0xdcdad4 : 0xc9ced3);
        P('plain', -4, -3, 27, 19, 0.8, h, PAL.flatRoof);
      }
      break;
    }
    case 'park': {
      // a curving path, a pond in some, trees everywhere else
      const bend = (r(1) - 0.5) * 0.9, base = r(2) * Math.PI;
      for (let k = -1; k <= 1; k++) {
        const a = base + bend * k;
        P('plain', Math.cos(base) * k * 13, Math.sin(base) * k * 13, 15, 3, 0.25, 0.45, 0xe9e1cd, a);
      }
      const pond = r(3) < 0.4;
      if (pond) P('cyl', (r(4) - 0.5) * 8 + 9, (r(5) - 0.5) * 8 - 8, 15, 10, 0.35, 0.5, 0x8db4cb);
      let n = 0;
      for (let k = 0; k < 16 && n < 9; k++) {
        const u = (r(200 + k) - 0.5) * 34, v = (r(220 + k) - 0.5) * 30;
        // keep off the path line and the pond
        const along = u * Math.cos(base) + v * Math.sin(base), off = -u * Math.sin(base) + v * Math.cos(base);
        if (Math.abs(off - along * bend * 0.08) < 4.5) continue;
        if (pond && Math.hypot(u - 9, v + 8) < 11) continue;
        tree(u, v, 6 + r(240 + k) * 4, 260 + k);
        n++;
      }
      break;
    }
    case 'square': {
      // paved plaza: fountain in the middle, trees at the corners
      P('cyl', 0, 0, 11, 11, 0.9, 0.4, 0xcfc5b2);
      P('cyl', 0, 0, 9, 9, 0.6, 1.0, 0x9dc1d5);
      P('cyl', 0, 0, 1.6, 1.6, 3.6, 0.4, 0xd8d0c0);
      for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) tree(su * 14, sv * 12, 6 + r(10 + su + sv * 2) * 2, 20 + su + sv * 3);
      P('plain', 12, 5, 0.6, 0.6, 4.5, 0.4, 0x55595d); // lamp
      P('plain', -12, -5, 0.6, 0.6, 4.5, 0.4, 0x55595d);
      break;
    }
    case 'church': {
      const roofC = r(1) < 0.6 ? pick(PAL.coreRoof, r(2)) : 0x6c6a68;
      P('wall', 2, 3, 25, 12, 11, 0, PAL.stone);
      P('gable', 2, 3, 25.4, 13, 7, 11, roofC);
      P('wall', -14, 3, 7.5, 7.5, 25, 0, 0xd5c8ac);
      P('pyr', -14, 3, 8.2, 8.2, 14, 25, roofC);
      P('cyl', 14.5, 3, 9, 9, 9, 0, PAL.stone); // apse
      tree(10, -12, 6, 30);
      break;
    }
  }
  return out;
}
