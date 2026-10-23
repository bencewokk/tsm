import { Quad, chamfer, lerpP, rotatePoly, scalePoly, shiftPoly, circle, type Pt } from './poly';
import { PAL, pick } from './forms';
import { hash01, lerpRange } from '../sim/profiles';
import type { Ctx } from './buildings';
import { block, FOOT, tree } from './buildings';

/**
 * Tower styles. Every tower is built from parts (podium / base, shaft, crown) and the style is picked from a per-plot seed,
 * weighted by the era the tower was built in and the land value, so the skyline carries the city's history:
 * early towers lean art deco and international, later ones contemporary glass and supertalls.
 */
export type TowerStyle = 'deco' | 'intl' | 'brut' | 'post' | 'contemp' | 'super' | 'resi';

export function chooseStyle(c: Ctx, cbd: boolean): TowerStyle {
  if (c.style) return c.style as TowerStyle;
  const e = c.era, lv = c.lv;
  const w: [TowerStyle, number][] = cbd
    ? [
        ['deco', 1.6 * Math.max(0, 1 - e * 1.6) + 0.05],
        ['intl', 1.0],
        ['brut', 0.65 * Math.max(0, 1 - Math.abs(e - 0.35) * 2.2)],
        ['post', 0.8 * Math.max(0, 1 - Math.abs(e - 0.5) * 2)],
        ['contemp', 0.15 + 1.5 * e],
        ['super', lv > 0.6 && e > 0.3 ? 0.35 + 0.6 * e : 0],
      ]
    : [
        ['resi', 1.2],
        ['intl', 0.6],
        ['deco', 0.9 * Math.max(0, 1 - e * 1.8)],
        ['brut', 0.9 * Math.max(0, 1 - Math.abs(e - 0.3) * 2)],
        ['post', 0.5 * Math.max(0, 1 - Math.abs(e - 0.55) * 2)],
        ['contemp', 0.1 + 0.9 * e],
      ];
  const tot = w.reduce((a, b) => a + b[1], 0);
  let t = c.r(1234) * tot;
  for (const [s, v] of w) { t -= v; if (t <= 0) return s; }
  return w[0][0];
}

const GLASS = {
  intl: [0x7f98ab, 0x8da6b5, 0x6f8695, 0x9ab0b8, 0x58707f, 0x9a9c9c, 0xa89c86, 0x7d9a8c, 0x6a7380, 0xb4bcc2],
  contemp: [0x6fa0b8, 0x7fb0bd, 0x5f8fae, 0x8bb7c4],
  super: [0x6b8aa3, 0x7794ab, 0x5d7b93],
};

/** The tower's own footprint inside the plot (set back above a street-wall podium). */
function shaftFootprint(c: Ctx, wMax: number, dMax: number, podium: boolean): Pt[] {
  const { Q, r } = c;
  const sw = Math.min(wMax, Q.W * 0.82) / Q.W;
  const s0 = Math.max(0.04, Math.min(0.96 - sw, 0.5 - sw / 2 + (r(5) - 0.5) * 0.12 + ((c.sides & 1) ? -0.08 : (c.sides & 2) ? 0.08 : 0)));
  const dd = Math.min(dMax, Q.D * 0.7) / Q.D;
  const t0 = podium ? Math.min(0.3, 0.12 + 0.02 * r(6)) : 0.12;
  return Q.strip(s0, s0 + sw, t0, Math.min(0.92, t0 + dd));
}

/** Street wall at the base: keeps the continuous frontage in dense blocks. */
function podium(c: Ctx, h: number, wall: number, glassband = true) {
  const { Q, r } = c;
  let poly = Q.strip(0, 1, 0, Math.min(0.62, 19 / Q.D));
  if (c.sides & 1) poly = chamfer(poly, 0, 4); else if (c.sides & 2) poly = chamfer(poly, 1, 4);
  block(c, poly, h, wall, { roof: 'flat', roofColor: 0xb9b6ae });
  if (glassband) c.mb.prism('glass', Q.strip(0.006, 0.994, 0, 1.0 / Q.D), c.g - 0.5, c.g + 4.2, 0x7e95a2, 0x7e95a2);
  void r;
}

function lampBand(c: Ctx, poly: Pt[], y: number, hh: number, color = 0xffe3a6) {
  c.mb.prism('lamp', scalePoly(poly, 1.012), y, y + hh, color, color);
}

function plantBox(c: Ctx, poly: Pt[], y: number, k: number) {
  const p = lerpP(poly[0], poly[2], 0.35 + c.r(k) * 0.3);
  c.mb.prism('plain', circle(p[0], p[1], 2.2, 6), y, y + 3, 0xc7c9c5, 0xc7c9c5);
}

// ---------------------------------------------------------------- styles
function deco(c: Ctx, H: number) {
  const { mb, g, r } = c;
  const stone = pick([0xdccdae, 0xd4c3a0, 0xe0d2b6, 0xcdb99a], r(7));
  const accent = pick([0x7fa89a, 0xa88f6a, 0x8d9aa6], r(8));
  const base = shaftFootprint(c, 26, 26, c.dens > 0);
  // stepped "wedding cake": each tier is narrower and the roofs are not flat
  const tiers = [[0, 0.58, 1], [0.58, 0.8, 0.78], [0.8, 0.93, 0.58]];
  let topPoly = base;
  for (const [a, b, k] of tiers) {
    const poly = scalePoly(base, k as number);
    mb.prism('wall', poly, g - FOOT + (a as number) * H, g + (b as number) * H, stone, 0xb9a98b);
    topPoly = poly;
    // setback parapet lip
    mb.prism('plain', scalePoly(poly, 1.03), g + (b as number) * H - 0.6, g + (b as number) * H, 0xcdbd9c, 0xcdbd9c);
  }
  // vertical piers: slim stone ribs up the corners and the middle of the front face
  for (const k of [0, 1, 2, 3]) {
    const p = base[k];
    const cen = lerpP(base[0], base[2], 0.5);
    const dx = p[0] - cen[0], dz = p[1] - cen[1], l = Math.hypot(dx, dz) || 1;
    const q: Pt = [p[0] + dx / l * 0.2, p[1] + dz / l * 0.2];
    mb.prism('plain', [[q[0] - 0.9, q[1] - 0.9], [q[0] + 0.9, q[1] - 0.9], [q[0] + 0.9, q[1] + 0.9], [q[0] - 0.9, q[1] + 0.9]], g - 1, g + 0.58 * H, stone, stone);
  }
  // crown: pointed spire, lit
  block(c, scalePoly(topPoly, 0.8), H * 0.04, stone, { roof: 'none' });
  mb.roofHip('plain', scalePoly(topPoly, 0.8), g + 0.93 * H + H * 0.04, H * 0.15, 0.5, accent);
  mb.prism('lamp', circle((topPoly[0][0] + topPoly[2][0]) / 2, (topPoly[0][1] + topPoly[2][1]) / 2, 0.9, 5), g + 0.93 * H + H * 0.19, g + H * 1.16, 0xffe3a6, 0xffe3a6);
  lampBand(c, scalePoly(base, 0.58), g + 0.9 * H, 2.4, 0xffd899);
  lampBand(c, scalePoly(base, 0.78), g + 0.78 * H, 1.4, 0xffd899);
}

function intl(c: Ctx, H: number, tall = false) {
  const { mb, g, r } = c;
  const col = pick(c.pal.glass, r(7));
  const fp = shaftFootprint(c, 24, 20, c.dens > 0);
  block(c, fp, H, col, { mat: 'glass', roof: 'flat', roofColor: 0xcfd3d6 });
  plantBox(c, fp, g + H + 0.7, 9);
  if (r(10) < 0.6) lampBand(c, scalePoly(fp, 0.97), g + H - 3.4, 1.8);
  if (tall && r(11) < 0.5) block(c, scalePoly(fp, 0.7), 8, col, { mat: 'glass', roof: 'flat' });
  void mb;
}

function brut(c: Ctx, H: number) {
  const { mb, g, r } = c;
  const conc = pick([0xa9a7a1, 0x9d9b95, 0xb4b1aa, 0x98958f], r(7));
  H = Math.min(H, 70 + r(2) * 15);
  const fp = shaftFootprint(c, 30, 22, c.dens > 0);
  // chunky shaft with a cantilevered top: the upper floors project past the base
  const top = H * 0.8;
  block(c, fp, top, conc, { roof: 'none' });
  const over = scalePoly(fp, 1.14);
  mb.prism('wall', over, g + top - 0.2, g + H, conc, 0x8f8d88);
  // horizontal slab fins every few floors
  for (let k = 1; k * 3.4 * 3 < top; k++) mb.prism('plain', scalePoly(fp, 1.025), g + k * 3.4 * 3, g + k * 3.4 * 3 + 0.7, 0x8e8c86, 0x8e8c86);
  mb.prism('plain', scalePoly(over, 0.9), g + H, g + H + 3, 0x7f7d79, 0x7f7d79);
}

function post(c: Ctx, H: number) {
  const { mb, g, r } = c;
  H = Math.min(H, 95);
  const baseC = pick([0xc59a86, 0xb98a74, 0xcfa58d], r(7));
  const shaftC = pick([0xdcc1b0, 0xe6d3c0, 0xd2b8ae, 0xc9d1c8], r(8));
  const copper = 0x78a08c;
  const fp = shaftFootprint(c, 24, 22, c.dens > 0);
  // coloured stone base (three floors), taller shaft, then a pitched / pedimented top
  mb.prism('wall', scalePoly(fp, 1.08), g - FOOT, g + 11, baseC, 0xa8806d);
  block(c, fp, H, shaftC, { roof: 'none' });
  mb.prism('plain', scalePoly(fp, 1.04), g + H - 2.4, g + H, baseC, baseC);
  if (r(9) < 0.5) mb.roofGable('plain', scalePoly(fp, 1.04), g + H, H * 0.14, r(10) < 0.5, copper);
  else mb.roofHip('plain', scalePoly(fp, 1.04), g + H, H * 0.16, 0.18, copper, true);
  // small lit lantern at the apex
  const m = lerpP(fp[0], fp[2], 0.5);
  mb.prism('lamp', circle(m[0], m[1], 1.2, 6), g + H + H * 0.1, g + H + H * 0.18, 0xffe3a6, 0xffe3a6);
}

function contemp(c: Ctx, H: number) {
  const { mb, g, r } = c;
  const col = pick(GLASS.contemp, r(7));
  const fp = shaftFootprint(c, 26, 24, c.dens > 0);
  // tapered, twisted shaft: the top outline is smaller, rotated and sheared
  const rot = (r(8) - 0.5) * 0.9, k = 0.62 + r(9) * 0.25;
  let top = rotatePoly(scalePoly(fp, k), rot);
  top = shiftPoly(top, (r(12) - 0.5) * 6, (r(13) - 0.5) * 6);
  mb.frustum('glass', fp, top, g - FOOT, g + H, col, true, 0xcfd6da);
  // sheared, sloped crown + a lit edge
  mb.roofShed('plain', top, g + H, H * 0.1, 0xcfd6da, Math.floor(r(14) * 4));
  mb.prism('lamp', scalePoly(top, 1.01), g + H - 3.2, g + H, 0xbfe6ff, 0xbfe6ff);
}

function supertall(c: Ctx, H: number) {
  const { mb, g, r } = c;
  H = 150 + r(2) * 90;
  const col = pick(GLASS.super, r(7));
  const fp = shaftFootprint(c, 17, 17, c.dens > 0);
  // three stepped, tapering stages with two solid mechanical bands, then a needle
  const stages = [[0, 0.4, 1, 0.82], [0.4, 0.72, 0.82, 0.62], [0.72, 0.9, 0.62, 0.42]];
  for (const [a, b, k0, k1] of stages) {
    mb.frustum('glass', scalePoly(fp, k0), scalePoly(fp, k1), g - FOOT + a * H, g + b * H, col, true, 0xcfd3d6);
  }
  for (const f of [0.4, 0.72]) mb.prism('plain', scalePoly(fp, f === 0.4 ? 0.84 : 0.64), g + f * H - 2, g + f * H + 2.6, 0xb7bdc2, 0xb7bdc2);
  const m = lerpP(fp[0], fp[2], 0.5);
  mb.frustum('plain', circle(m[0], m[1], 3.2, 8), circle(m[0], m[1], 0.5, 8), g + 0.9 * H, g + 1.06 * H, 0xcfd3d6, false);
  mb.prism('lamp', circle(m[0], m[1], 0.9, 6), g + 1.05 * H, g + 1.22 * H, 0xff9a8a, 0xff9a8a);
  lampBand(c, scalePoly(fp, 0.46), g + 0.84 * H, 3, 0xfff0c8);
}

function resi(c: Ctx, H: number) {
  const { mb, g, r } = c;
  H = Math.min(H, 62 + r(2) * 18);
  const col = pick(c.pal.mid, r(7)), stripe = pick([0xe6e1d6, 0xb88c78, 0x9bb0a3, 0xd9b27a], r(8));
  const fp = shaftFootprint(c, 21, 17, c.dens > 0);
  // staggered: a lower mass and a shifted upper mass
  const split = 0.55 + r(9) * 0.15;
  const dir = r(10) < 0.5 ? 1 : -1;
  block(c, fp, H * split, col, { roof: 'flat' });
  const up = shiftPoly(scalePoly(fp, 0.9), dir * 3.2, 0);
  mb.prism('wall', up, g + H * split - 0.1, g + H, col, 0xb4aca0);
  // stacked balcony slabs on the long face, in a contrasting stripe
  const nb = Math.floor(H / 3.3);
  for (let k = 2; k < nb; k += 2) {
    const a = k * 3.3 < H * split ? fp : up;
    const s0: Pt = lerpP(a[0], a[3], 0.0), s1: Pt = lerpP(a[1], a[2], 0.0);
    void s0; void s1;
    mb.prism('plain', scalePoly(a, 1.035), g + k * 3.3, g + k * 3.3 + 0.35, stripe, stripe);
  }
  plantBox(c, up, g + H + 0.7, 11);
}

export function designTower(c: Ctx, cbd: boolean) {
  const { Q, r } = c;
  let H = cbd ? 80 + r(4) * 85 : 34 + r(4) * 40;
  H *= lerpRange(c.prof.buildingHeightRange, hash01(c.id, c.wave)); // each construction wave varies a little
  const style = chooseStyle(c, cbd);
  // street-wall podium for dense plots (the tower sits back above it)
  const pw = style === 'deco' || style === 'brut' || style === 'post' || style === 'super';
  if (c.dens > 0) podium(c, style === 'resi' ? 9 : 11 + r(3) * 6, style === 'brut' ? 0x9a9892 : pick([0xd8c9ad, 0xc9ccd0, 0xcdb9a2, 0xdcd2c0], r(3)), !pw);
  else block(c, Q.strip(0.08, 0.92, 0.04, 0.3), 8, 0xd6d1c8, { roof: 'flat' });
  // big merged plots hold a pair of towers joined by a skybridge
  if (Q.W > 52 && style !== 'super') {
    const hh = [H, H * (0.72 + r(5) * 0.18)];
    for (let i = 0; i < 2; i++) {
      const sub = { ...c, Q: sliceQuad(c, i), r: (k: number) => c.r(k + i * 77) } as Ctx;
      if (style === 'deco') deco(sub, hh[i]); else if (style === 'contemp') contemp(sub, hh[i]); else if (style === 'resi') resi(sub, hh[i]); else if (style === 'brut') brut(sub, hh[i]); else if (style === 'post') post(sub, hh[i]); else intl(sub, hh[i]);
    }
    const y = c.g + Math.min(hh[0], hh[1]) * 0.7;
    const a = Q.at(0.4, 0.38), b = Q.at(0.6, 0.38);
    c.mb.prism('glass', [[a[0], a[1] - 2.2], [b[0], b[1] - 2.2], [b[0], b[1] + 2.2], [a[0], a[1] + 2.2]], y, y + 4.5, 0x9db4c2, 0xcfd6da);
    return;
  }
  switch (style) {
    case 'deco': deco(c, H); break;
    case 'brut': brut(c, H); break;
    case 'post': post(c, H); break;
    case 'contemp': contemp(c, H); break;
    case 'super': supertall(c, H); break;
    case 'resi': resi(c, H); break;
    default: intl(c, H, cbd);
  }
  if (c.dens === 0) { tree(c, Q.at(0.12, 0.05), 6, 5); tree(c, Q.at(0.88, 0.05), 6, 6); }
}

/** Left / right half of a wide plot as its own quad. */

function sliceQuad(c: Ctx, i: number): Quad {
  const Q = c.Q;
  const a = i === 0 ? 0 : 0.5, b = i === 0 ? 0.5 : 1;
  const p = (s: number, t: number) => Q.at(s, t);
  return new Quad(p(a, 0), p(b, 0), p(b, 1), p(a, 1));
}
