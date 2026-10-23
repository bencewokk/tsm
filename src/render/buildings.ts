import { MB, Quad, chamfer, circle, lerpP, scalePoly, centroid, type Pt } from './poly';
import { PAL, GROUND, pick, type Kind } from './forms';
import { vhash } from './common';
import { designTower } from './towers';

export interface Tree { x: number; z: number; size: number; h: number; pine: boolean; seed: number }

export interface Ctx {
  mb: MB; Q: Quad; id: number; seed: number;
  g: number;                     // ground level
  kind: Kind; level: number; dens: number; sides: number; back: number; isCom: boolean; flags: number;
  era: number;                   // 0..1 game progress when the building was started
  lv: number;                    // land value 0..1
  trees: Tree[];
  r: (k: number) => number;
}

export const FOOT = 2.2; // walls start this far below ground so slopes never show a gap

// ------------------------------------------------------------------ helpers
export function tree(c: Ctx, p: Pt, size: number, k: number) {
  const pine = c.r(k) < 0.22;
  c.trees.push({ x: p[0], z: p[1], size, h: size * (pine ? 1.9 : 1.15), pine, seed: c.id * 31 + k });
}

/** Walls of a polygon with a flat or pitched roof. Returns the roof base y (top of the walls). */
export function block(c: Ctx, poly: Pt[], h: number, wall: number, o: { roof?: 'flat' | 'gableS' | 'gableT' | 'hip' | 'pyr' | 'mansard' | 'none'; rh?: number; roofColor?: number; mat?: 'wall' | 'glass'; inset?: number; hipIn?: number } = {}): number {
  const { g, mb } = c;
  const y1 = g + h;
  mb.prism(o.mat ?? 'wall', poly, g - FOOT, y1, wall, o.roofColor ?? PAL.flatRoof);
  const roof = o.roof ?? 'flat';
  const rc = o.roofColor ?? PAL.flatRoof;
  if (poly.length === 4) {
    if (roof === 'gableS') mb.roofGable('plain', poly, y1, o.rh ?? 4, true, rc);
    else if (roof === 'gableT') mb.roofGable('plain', poly, y1, o.rh ?? 4, false, rc);
    else if (roof === 'hip') mb.roofHip('plain', poly, y1, o.rh ?? 3.5, o.hipIn ?? 0.3, rc, true);
    else if (roof === 'pyr') mb.roofHip('plain', poly, y1, o.rh ?? 6, 0.5, rc, true);
    else if (roof === 'mansard') mb.mansard('plain', poly, y1, o.rh ?? 3.5, 0.12, rc);
  }
  if (roof === 'flat') {
    // parapet ring read as a thin slab
    mb.prism('plain', scalePoly(poly, 0.97), y1, y1 + 0.7, rc, rc);
  }
  return y1;
}

/** A small rooftop plant box. */
function plant(c: Ctx, poly: Pt[], y: number, k: number) {
  const p = lerpP(poly[0], poly[2], 0.3 + c.r(k) * 0.4);
  const w = 3 + c.r(k + 1) * 3;
  const s = c.Q.dirS();
  const a: Pt = [p[0] - s[0] * w / 2, p[1] - s[1] * w / 2], b: Pt = [p[0] + s[0] * w / 2, p[1] + s[1] * w / 2];
  const nx = -s[1] * w / 2, nz = s[0] * w / 2;
  c.mb.prism('plain', [[a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz], [a[0] + nx, a[1] + nz]], y + 0.7, y + 2.8, 0xc9cac6);
}

/** Ground slab for a plot. */
export function pad(c: Ctx, color: number, inset = 0.3, h = 0.35) {
  c.mb.prism('plain', c.Q.poly(inset), c.g - FOOT, c.g + h, color, color);
}

/** Splits [0,1] into n parts with jittered cuts. */
function cuts(c: Ctx, n: number, jit = 0.35): number[] {
  const out = [0];
  for (let i = 1; i < n; i++) out.push(i / n + (c.r(900 + i) - 0.5) * jit / n);
  out.push(1);
  return out;
}

const cornerStart = (c: Ctx) => (c.sides & 1) !== 0;
const cornerEnd = (c: Ctx) => (c.sides & 2) !== 0;

/** Awning / balcony slab sticking out of a front strip. */
function awning(c: Ctx, s0: number, s1: number, y: number, depth: number, color: number) {
  const Q = c.Q;
  const a = Q.at(s0 + 0.01, 0), b = Q.at(s1 - 0.01, 0);
  const n = Q.dirS();
  const nx = n[1], nz = -n[0]; // towards the street (front is on the -v side)
  // front edge lies on the street side; push outwards (the sign is fixed by the plot's winding)
  const cen = Q.centre();
  const sgn = (cen[0] - a[0]) * nx + (cen[1] - a[1]) * nz > 0 ? -1 : 1;
  const ox = nx * depth * sgn, oz = nz * depth * sgn;
  c.mb.prism('plain', [a, b, [b[0] + ox, b[1] + oz], [a[0] + ox, a[1] + oz]], c.g + y, c.g + y + 0.4, color, color);
}

/** Balcony bands on a front strip: thin slabs every second floor. */
function balconies(c: Ctx, s0: number, s1: number, h: number, floors: number, color: number) {
  const step = 3.3;
  for (let k = 1; k < floors; k += 2) awning(c, s0 + 0.04, s1 - 0.04, k * step + 0.2, 1.4, color);
}

// ------------------------------------------------------------------ kinds
function designHouse(c: Ctx) {
  const { Q, r } = c;
  if (c.dens === 0) {
    // detached house(s) with a front garden, lawn and trees
    pad(c, GROUND.house, 0.6, 0.3);
    const wall = pick(PAL.houseWall, r(1)), roof = pick(PAL.houseRoof, r(2));
    const two = r(6) < 0.5;
    const place = (s: number, wm: number, dm: number, h: number, wc: number) => {
      const ws = wm / Q.W / 2, tt0 = (7 + r(4) * 2) / Q.D;
      const poly = Q.strip(s - ws, s + ws, tt0, tt0 + dm / Q.D);
      block(c, poly, h, wc, { roof: r(3) < 0.35 ? 'gableT' : 'gableS', rh: 3.6 + r(5), roofColor: roof });
      return poly;
    };
    if (two) {
      place(0.27 + r(7) * 0.05, 11 + r(8) * 2, 9 + r(9) * 2, 5.5 + r(10), wall);
      place(0.74 - r(11) * 0.05, 11 + r(12) * 2, 9 + r(13) * 2, 5.5 + r(14), pick(PAL.houseWall, r(15)));
      tree(c, Q.at(0.25, 0.8), 6 + r(17) * 2, 18);
      tree(c, Q.at(0.76, 0.85), 5.5 + r(20) * 2, 21);
    } else {
      place(0.45 + r(7) * 0.1, 15 + r(8) * 2, 11 + r(9) * 1.5, 6 + r(10), wall);
      const gp = Q.strip(0.78, 0.78 + 6.5 / Q.W, 8 / Q.D, 15 / Q.D);
      block(c, gp, 3, 0xd9d6cf, { roof: 'flat' });
      tree(c, Q.at(0.12, 0.8), 6.5 + r(17) * 2, 18);
      tree(c, Q.at(0.7, 0.85), 6 + r(19) * 2, 21);
    }
    if (r(22) < 0.6) tree(c, Q.at(0.15 + r(23) * 0.7, 0.04), 5 + r(24) * 1.5, 25);
    return;
  }
  // terraced / semi-detached row: continuous street wall, separate houses
  pad(c, GROUND.core, 0.2, 0.3);
  const n = Math.max(2, Math.round(Q.W / 7));
  const cs = cuts(c, n, 0.4);
  const bd = 10 + r(2) * 3;
  for (let i = 0; i < n; i++) {
    const poly = Q.strip(cs[i], cs[i + 1], 0, bd / Q.D);
    const h = 7.5 + r(10 + i) * 3.5;
    const wall = r(40 + i) < 0.55 ? pick(PAL.brick, r(30 + i)) : pick(PAL.houseWall, r(20 + i));
    block(c, poly, h, wall, { roof: r(50 + i) < 0.7 ? 'gableT' : 'gableS', rh: 3 + r(60 + i) * 2, roofColor: r(70 + i) < 0.5 ? pick(PAL.houseRoof, r(71 + i)) : pick(PAL.coreRoof, r(72 + i)) });
  }
  // back gardens
  if (r(80) < 0.8) tree(c, Q.at(0.3, 0.8), 5 + r(81) * 2, 82);
  if (r(83) < 0.7) tree(c, Q.at(0.72, 0.85), 5 + r(84) * 2, 85);
}

function designCore(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.core, 0.1, 0.3);
  const n = Math.max(1, Math.round(Q.W / 8.6));
  const cs = cuts(c, n, 0.5);
  const lvl = c.level;
  const baseH = lvl === 1 ? 8 : lvl === 2 ? 13.5 : 19;
  let last: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let poly = Q.strip(cs[i], cs[i + 1], 0, (13 + r(50 + i) * 4) / Q.D);
    const h = baseH + (r(40 + i) - 0.3) * (lvl === 1 ? 3 : 5);
    const wall = pick(PAL.coreWall, r(60 + i));
    const roofC = pick(PAL.coreRoof, r(80 + i));
    const rr = r(90 + i);
    const roof = rr < 0.5 ? 'gableT' : rr < 0.78 ? 'gableS' : lvl >= 3 && rr < 0.9 ? 'mansard' : 'hip';
    const corner = (i === 0 && cornerStart(c)) || (i === n - 1 && cornerEnd(c));
    if (corner) {
      // wrap the corner: chamfered front corner, a wing along the side street
      const atStart = i === 0 && cornerStart(c);
      const wingW = Math.min(0.5, 12 / Q.W);
      const wing = atStart ? Q.strip(0, wingW, 0, 0.9) : Q.strip(1 - wingW, 1, 0, 0.9);
      block(c, wing, h - 0.5, wall, { roof: 'hip', rh: 4.2, roofColor: roofC, hipIn: 0.28 });
      poly = chamfer(poly, atStart ? 0 : 1, 3.2);
      if (r(95 + i) < 0.35) {
        // corner turret with a pointed roof
        const p = atStart ? Q.at(0.02, 0.03) : Q.at(0.98, 0.03);
        const ts = 3.4, s = Q.dirS();
        const tq: Pt[] = [[p[0] - ts, p[1] - ts], [p[0] + ts, p[1] - ts], [p[0] + ts, p[1] + ts], [p[0] - ts, p[1] + ts]];
        void s;
        block(c, tq, h + 3.5, wall, { roof: 'pyr', rh: 7, roofColor: 0x6c7a74 });
      }
    }
    block(c, poly, h, wall, { roof, rh: roof === 'mansard' ? 4 : 3.6 + r(100 + i) * 2.2, roofColor: roofC, hipIn: 0.25 });
    if (c.isCom) {
      // ground-floor shopfront and awning
      const shop = Q.strip(cs[i] + 0.004, cs[i + 1] - 0.004, 0, 0.5 / Q.D * 1.0);
      void shop;
      awning(c, cs[i], cs[i + 1], 3.3, 1.6, pick(PAL.awning, r(110 + i)));
    }
    last = poly;
  }
  // rear range around a courtyard
  if (lvl >= 2 && Q.D > 24 && r(3) < 0.75) {
    const poly = Q.strip(0.08, 0.92, 1 - 9 / Q.D, 0.97);
    block(c, poly, 8 + r(4) * 4, pick(PAL.coreWall, r(5)), { roof: 'gableS', rh: 3.4, roofColor: pick(PAL.coreRoof, r(6)) });
  }
  if (lvl === 1 && r(7) < 0.6) tree(c, Q.at(0.5, 0.82), 5 + r(8) * 2, 9);
  void last;
}

function designApart(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.apart, 0.3, 0.3);
  const col = pick(PAL.apart, r(1));
  const floors = 4 + Math.floor(r(2) * 4) + (c.dens === 2 ? 1 : 0);
  const H = floors * 3.3;
  if (c.dens === 0) {
    // detached mid-rise slab with a green setback
    const poly = Q.strip(0.1, 0.9, 0.2, 0.2 + 13 / Q.D);
    block(c, poly, H, col, { roof: 'flat' });
    plant(c, poly, c.g + H, 4);
    balconies(c, 0.1, 0.9, H, floors, 0xe6e1d6);
    tree(c, Q.at(0.2, 0.08), 6, 5); tree(c, Q.at(0.8, 0.08), 6, 6);
    return;
  }
  // perimeter block: continuous street wall, courtyard behind, corner turned
  const bd = 12.5 + r(3) * 1.5;
  const front = Q.strip(0, 1, 0, bd / Q.D);
  const atS = cornerStart(c), atE = cornerEnd(c);
  const poly = atS ? chamfer(front, 0, 3.5) : atE ? chamfer(front, 1, 3.5) : front;
  const roofType = r(6) < 0.25 ? 'mansard' : 'flat';
  block(c, poly, H, col, { roof: roofType, rh: 3.3, roofColor: roofType === 'mansard' ? pick(PAL.slate, r(7)) : PAL.flatRoof });
  if (roofType === 'flat') plant(c, poly, c.g + H, 8);
  balconies(c, 0, 1, H, floors, 0xe2ddd2);
  // wings enclose a courtyard where the plot is deep enough
  if (Q.D >= 26 && (c.dens === 2 || r(9) < 0.5)) {
    const wd = Math.min(Q.W * 0.28, 10) / Q.W;
    const wh = H * (0.75 + r(10) * 0.2);
    const both = r(11) < 0.6;
    block(c, Q.strip(0, wd, bd / Q.D - 0.02, 0.9), wh, col, { roof: 'flat' });
    if (both) block(c, Q.strip(1 - wd, 1, bd / Q.D - 0.02, 0.9), wh, col, { roof: 'flat' });
    tree(c, Q.at(0.5, 0.6), 6, 12);
  } else if (atS || atE) {
    const wd = Math.min(0.5, 12 / Q.W);
    block(c, atS ? Q.strip(0, wd, bd / Q.D - 0.02, 0.9) : Q.strip(1 - wd, 1, bd / Q.D - 0.02, 0.9), H * 0.9, col, { roof: 'flat' });
  }
}

function designShop(c: Ctx) {
  const { Q, r } = c;
  if (c.dens === 0) {
    pad(c, GROUND.shop, 0.4, 0.3);
    const d = 15 + r(1) * 3, h = 5 + r(2) * 2.5;
    const poly = Q.strip(0.08, 0.92, 2 / Q.D, 2 / Q.D + d / Q.D);
    block(c, poly, h, pick(PAL.shop, r(4)), { roof: 'flat' });
    awning(c, 0.08, 0.92, 3.2, 1.2, pick(PAL.awning, r(5)));
    if (r(6) < 0.5) plant(c, poly, c.g + h, 7);
    return;
  }
  pad(c, GROUND.shop, 0.1, 0.3);
  const n = Q.W > 20 && r(2) < 0.6 ? 2 : 1;
  const cs = cuts(c, n, 0.3);
  for (let i = 0; i < n; i++) {
    let poly = Q.strip(cs[i], cs[i + 1], 0, (14 + r(10 + i) * 3) / Q.D);
    const floors = 3 + Math.floor(r(20 + i) * 2.4);
    const h = floors * 3.4 + 0.6;
    const wall = r(30 + i) < 0.4 ? pick(PAL.brick, r(31 + i)) : pick(PAL.shop, r(32 + i));
    if (i === 0 && cornerStart(c)) poly = chamfer(poly, 0, 3);
    if (i === n - 1 && cornerEnd(c)) poly = chamfer(poly, 1, 3);
    const rr = r(40 + i);
    block(c, poly, h, wall, { roof: rr < 0.3 ? 'hip' : 'flat', rh: 2.6, roofColor: rr < 0.3 ? pick(PAL.slate, r(41)) : PAL.flatRoof, hipIn: 0.2 });
    // glazed shopfront band + awning
    const sf = Q.strip(cs[i] + 0.006, cs[i + 1] - 0.006, 0, 0.9 / Q.D);
    c.mb.prism('glass', sf, c.g, c.g + 3.6, 0x8aa0ae, 0x8aa0ae);
    awning(c, cs[i], cs[i + 1], 3.7, 1.8, pick(PAL.awning, r(50 + i)));
    if (r(60 + i) < 0.5) plant(c, poly, c.g + h, 61 + i);
  }
}

function designOffice(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.office, 0.1, 0.3);
  const col = pick(PAL.office, r(1));
  const h = 22 + r(2) * 16 + (c.dens === 2 ? 4 : 0);
  const full = c.dens > 0;
  const poly = full ? Q.strip(0, 1, 0, 0.78) : Q.strip(0.08, 0.92, 0.1, 0.75);
  const p2 = (cornerStart(c) && full) ? chamfer(poly, 0, 4) : (cornerEnd(c) && full) ? chamfer(poly, 1, 4) : poly;
  block(c, p2, h, col, { mat: 'glass', roof: 'flat' });
  // stepped crown
  if (r(3) < 0.6) block(c, scalePoly(Q.strip(0.15, 0.85, 0.12, 0.62), 1), 7 + r(5) * 8, col, { mat: 'glass', roof: 'flat' }).valueOf();
}

function designTowerKind(c: Ctx, cbd: boolean) {
  pad(c, c.dens === 0 ? GROUND.tower : GROUND.cbd, 0.1, 0.3);
  designTower(c, cbd);
}

function designInd(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.ind, 0.4, 0.3);
  const col = pick(PAL.ind, r(1));
  const h = (c.level >= 2 ? 11 : 8) + r(2) * 3;
  const sd = 0.08, sw = 0.96;
  const shed = Q.strip(sd, sw, 0.07, 0.07 + Math.min(0.62, 21 / Q.D));
  const t1 = 0.07 + Math.min(0.62, 21 / Q.D);
  block(c, shed, h, col, { roof: 'none' });
  if (c.level >= 2 || r(5) < 0.55) {
    c.mb.roofSaw('plain', Q, sd, sw, 0.07, t1, c.g + h, 3.6, Math.max(2, Math.round(Q.W / 9)), pick(PAL.indRoof, r(6)), 0xbfd1d6);
  } else block(c, shed, 0.01, col, { roof: 'flat', roofColor: pick(PAL.indRoof, r(6)) });
  // loading doors
  c.mb.prism('plain', Q.strip(0.16, 0.84, 0.065, 0.075), c.g, c.g + 4.6, 0x54595c, 0x54595c);
  // chimney
  if (c.level >= 2 || r(7) < 0.55) {
    const p = Q.at(0.9, 0.55);
    c.mb.prism('plain', circle(p[0], p[1], 1.9, 10), c.g - 1, c.g + 26 + r(8) * 14, pick(PAL.brick, r(9)), 0xe8e4dc);
  }
  // yard: tanks or stock behind the shed
  const yv = t1 + 0.18;
  if (r(10) < 0.5) {
    for (let k = 0; k < 3; k++) { const p = Q.at(0.25 + k * 0.25, Math.min(0.88, yv)); c.mb.prism('plain', circle(p[0], p[1], 3.6, 12), c.g - 1, c.g + 7 + r(11 + k) * 3, 0xd8d9d4, 0xc7c9c4); }
  } else {
    for (let k = 0; k < 3; k++) for (let s = 0; s < 1 + Math.floor(r(14 + k) * 2.4); s++) {
      const cc = pick(PAL.container, r(20 + k * 3 + s));
      c.mb.prism('plain', Q.strip(0.12 + k * 0.28, 0.12 + k * 0.28 + 11 / Q.W, Math.min(0.8, yv), Math.min(0.8, yv) + 4.2 / Q.D), c.g + s * 2.6, c.g + s * 2.6 + 2.55, cc, cc);
    }
  }
  c.mb.prism('plain', Q.strip(0.02, 0.98, 0.955, 0.97), c.g, c.g + 1.7, 0x6b7076, 0x6b7076); // yard fence
}

function designPort(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.port, 0.3, 0.3);
  if (r(1) < 0.42) {
    // container yard: stacks of coloured boxes in rows
    const rows = 5, cols = Math.max(2, Math.round(Q.W / 13));
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      if (r(100 + row * 3 + col) < 0.16) continue;
      const stack = 1 + Math.floor(r(120 + row * 3 + col) * 3);
      const s0 = 0.03 + col * (0.94 / cols), s1 = s0 + 0.94 / cols - 0.012;
      const t0 = 0.08 + row * 0.17, t1 = t0 + 0.11;
      for (let s = 0; s < stack; s++) { const cc = pick(PAL.container, r(140 + row * 9 + col * 3 + s)); c.mb.prism('plain', Q.strip(s0, s1, t0, t1), c.g + s * 2.6, c.g + s * 2.6 + 2.55, cc, cc); }
    }
  } else {
    const h = 9 + r(2) * 3, col = pick(PAL.brick, r(3));
    const body = Q.strip(0.02, 0.98, 0.1, 0.78);
    block(c, body, h, col, { roof: 'none' });
    if (c.level >= 2 || r(4) < 0.6) c.mb.roofSaw('plain', Q, 0.02, 0.98, 0.1, 0.78, c.g + h, 3.5, Math.max(3, Math.round(Q.W / 8)), pick(PAL.slate, r(5)), 0xbfd1d6);
    else block(c, body, 0.01, col, { roof: 'gableS', rh: 5, roofColor: pick(PAL.slate, r(5)) });
    for (let k = 0; k < 3; k++) c.mb.prism('plain', Q.strip(0.2 + k * 0.28, 0.2 + k * 0.28 + 5 / Q.W, 0.095, 0.105), c.g, c.g + 5, 0x5d5f60, 0x5d5f60);
  }
}

function designDockNew(c: Ctx) {
  const { Q, r } = c;
  pad(c, GROUND.dockNew, 0.2, 0.3);
  if (r(1) < 0.5) {
    // converted warehouse: brick walls, pitched slate roof, now glazed
    const h = 12 + r(2) * 5;
    block(c, Q.strip(0, 1, 0.02, 0.78), h, pick(PAL.brick, r(3)), { roof: 'gableS', rh: 5.5, roofColor: pick(PAL.slate, r(4)) });
  } else {
    const h = (c.level >= 2 ? 18 : 11) + r(2) * 8, wc = r(3) < 0.5 ? 0xe9e7e2 : 0xd6dade;
    const bar = Q.strip(0, 1, 0, 0.55);
    block(c, bar, h, wc, { roof: 'flat' });
    block(c, Q.strip(0.55, 1, 0.5, 0.95), h * 0.7, r(3) < 0.5 ? 0xdcdad4 : 0xc9ced3, { roof: 'flat' });
  }
}

function designPark(c: Ctx) {
  const { Q, r, mb, g } = c;
  pad(c, GROUND.park, 0.3, 0.3);
  // a curving path across the plot
  const bend = (r(1) - 0.5) * 0.5, tilt = (r(2) - 0.5) * 0.4;
  const pts: Pt[] = [];
  for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push(Q.at(0.5 + Math.sin(t * Math.PI) * bend + (t - 0.5) * tilt, t)); }
  for (let k = 0; k < 8; k++) {
    const a = pts[k], b = pts[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l * 1.3, nz = dx / l * 1.3;
    mb.prism('plain', [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]], g + 0.1, g + 0.5, 0xe9e1cd, 0xe9e1cd);
  }
  if (r(3) < 0.45) { const p = Q.at(0.25 + r(4) * 0.5, 0.25 + r(5) * 0.5); mb.prism('plain', circle(p[0], p[1], 5 + r(6) * 2, 14), g + 0.1, g + 0.55, 0x8db4cb, 0x8db4cb); }
  let n = 0;
  for (let k = 0; k < 18 && n < 9; k++) {
    const s = 0.1 + r(200 + k) * 0.8, t = 0.1 + r(220 + k) * 0.8;
    // stay off the path
    let ok = true;
    for (const p of pts) if (Math.hypot(p[0] - Q.at(s, t)[0], p[1] - Q.at(s, t)[1]) < 3.2) { ok = false; break; }
    if (!ok) continue;
    tree(c, Q.at(s, t), 6 + r(240 + k) * 4, 260 + k);
    n++;
  }
}

function designSquare(c: Ctx) {
  const { Q, r, mb, g } = c;
  pad(c, GROUND.square, 0.1, 0.4);
  // paved plaza with a fountain and trees at the corners
  const ce = Q.centre();
  mb.prism('plain', circle(ce[0], ce[1], 5.8, 14), g + 0.3, g + 1.3, 0xcfc5b2, 0xcfc5b2);
  mb.prism('plain', circle(ce[0], ce[1], 4.6, 14), g + 1.2, g + 1.6, 0x9dc1d5, 0x9dc1d5);
  mb.prism('plain', circle(ce[0], ce[1], 0.8, 8), g + 1.2, g + 4.8, 0xd8d0c0, 0xd8d0c0);
  for (const [s, t] of [[0.14, 0.14], [0.86, 0.14], [0.14, 0.86], [0.86, 0.86]]) tree(c, Q.at(s, t), 5.5 + r(10 + s * 10 + t * 3) * 2, 20 + Math.round(s * 5 + t * 7));
  for (const [s, t] of [[0.25, 0.5], [0.75, 0.5]]) { const p = Q.at(s, t); mb.prism('plain', circle(p[0], p[1], 0.3, 6), g, g + 4.6, 0x55595d, 0x55595d); }
  // paving pattern: pale stripes
  for (let k = 1; k < 4; k++) mb.prism('plain', Q.strip(0.03, 0.97, k / 4 - 0.006, k / 4 + 0.006), g + 0.3, g + 0.42, 0xcbbfa9, 0xcbbfa9);
}

function designChurch(c: Ctx) {
  const { Q, r, mb, g } = c;
  pad(c, GROUND.church, 0.2, 0.35);
  const roofC = r(1) < 0.6 ? pick(PAL.coreRoof, r(2)) : 0x6c6a68;
  // nave along the front, tower at one end, apse at the other
  const nave = Q.strip(0.2, 0.92, 0.18, 0.55);
  block(c, nave, 11, PAL.stone, { roof: 'gableS', rh: 6.5, roofColor: roofC });
  const tower = Q.strip(0.04, 0.04 + 8 / Q.W, 0.16, 0.16 + 8 / Q.D);
  block(c, tower, 25, 0xd5c8ac, { roof: 'pyr', rh: 15, roofColor: roofC });
  const ap = Q.at(0.94, 0.37);
  mb.prism('wall', circle(ap[0], ap[1], 4.2, 10), g - FOOT, g + 8, PAL.stone, roofC);
  tree(c, Q.at(0.55, 0.85), 6, 30);
  tree(c, Q.at(0.2, 0.85), 5.5, 31);
}

function designYard(c: Ctx) {
  const { Q, r } = c;
  pad(c, c.back ? 0xcfc6b0 : GROUND.yard, 0.5, 0.25);
  const n = 1 + Math.floor(r(1) * 3);
  for (let i = 0; i < n; i++) tree(c, Q.at(0.2 + r(10 + i) * 0.6, 0.2 + r(20 + i) * 0.6), 5 + r(30 + i) * 3, 40 + i);
}

export function designLot(c: Ctx) {
  switch (c.kind) {
    case 'house': designHouse(c); break;
    case 'core': designCore(c); break;
    case 'apart': designApart(c); break;
    case 'tower': designTowerKind(c, false); break;
    case 'cbd': designTowerKind(c, true); break;
    case 'shop': designShop(c); break;
    case 'office': designOffice(c); break;
    case 'ind': designInd(c); break;
    case 'port': designPort(c); break;
    case 'dockNew': designDockNew(c); break;
    case 'park': designPark(c); break;
    case 'square': designSquare(c); break;
    case 'church': designChurch(c); break;
    case 'yard': designYard(c); break;
  }
}

/** Massing used for planned (ghost) plots and construction scaffolds: footprint + height of the finished building. */
export function massing(c: Ctx): { poly: Pt[]; h: number } {
  const { Q } = c;
  const poly = c.dens > 0 ? Q.strip(0.02, 0.98, 0, 0.7) : Q.strip(0.15, 0.85, 0.15, 0.7);
  const h = c.kind === 'tower' || c.kind === 'cbd' ? 40 + c.r(7) * 40 : c.kind === 'apart' ? 20 : c.kind === 'office' ? 30 : c.kind === 'core' ? 14 : c.kind === 'house' ? 8 : 12;
  return { poly, h };
}

export { vhash, centroid };
