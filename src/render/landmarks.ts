import { Quad, chamfer, circle, ellipse, lerpP, scalePoly, centroid, type Pt } from './poly';
import { pick } from './forms';
import { block, pad, tree, FOOT, type Ctx } from './buildings';
import { designTower } from './towers';

/**
 * Hand-shaped landmarks: each form has its own silhouette that reads from far away, a forecourt, and its own night lighting
 * (floodlights, lit crowns, glowing glass). Forms are laid out in the plot's own (s, t) frame so they fit any street-aligned plot.
 */
const STONE = 0xdad0b8, CREAM = 0xe9e1cc, SLATE = 0x6b7078, COPPER = 0x78a590, BRICK = 0xa55e44, WARM = 0xffe3a6, WHITE = 0xf1efe9;

function ang(c: Ctx) { const d = c.Q.dirS(); return Math.atan2(d[1], d[0]); }
function rad(c: Ctx, k: number) { return Math.min(c.Q.W, c.Q.D) * k; }
function lampRing(c: Ctx, poly: Pt[], y: number, hh: number, color = WARM) { c.mb.frustum('lamp', scalePoly(poly, 1.012), scalePoly(poly, 1.012), y, y + hh, color, false); }
function floodlights(c: Ctx, pts: Pt[], h: number) {
  for (const p of pts) {
    c.mb.prism('plain', circle(p[0], p[1], 0.7, 6), c.g - 1, c.g + h, 0x6d7378, 0x6d7378);
    c.mb.prism('lamp', [[p[0] - 3.6, p[1] - 1.2], [p[0] + 3.6, p[1] - 1.2], [p[0] + 3.6, p[1] + 1.2], [p[0] - 3.6, p[1] + 1.2]], c.g + h, c.g + h + 2.4, 0xfff4d0, 0xfff4d0);
  }
}
/** Rows of ground lights washing a facade. */
function facadeLights(c: Ctx, s0: number, s1: number, t: number, n: number) {
  for (let k = 0; k < n; k++) { const p = c.Q.at(s0 + (s1 - s0) * (k + 0.5) / n, t); c.mb.prism('lamp', [[p[0] - 1.4, p[1] - 1.4], [p[0] + 1.4, p[1] - 1.4], [p[0] + 1.4, p[1] + 1.4], [p[0] - 1.4, p[1] + 1.4]], c.g, c.g + 2.2, WARM, WARM); }
}
function plaza(c: Ctx, color = 0xe3dccb) { pad(c, color, 0.2, 0.38); }

// ---------------------------------------------------------------- forms
function cathedral(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c);
  const roof = c.r(1) < 0.5 ? SLATE : COPPER;
  block(c, Q.strip(0.3, 0.7, 0.2, 0.9), 19, STONE, { roof: 'gableT', rh: 8, roofColor: roof });
  block(c, Q.strip(0.08, 0.92, 0.5, 0.66), 17, STONE, { roof: 'gableS', rh: 7, roofColor: roof });
  for (const s0 of [0.3, 0.58]) { block(c, Q.strip(s0, s0 + 0.12, 0.06, 0.2), 37, 0xd5c8ac, { roof: 'pyr', rh: 17, roofColor: roof }); lampRing(c, Q.strip(s0, s0 + 0.12, 0.06, 0.2), g + 28, 3.2); }
  block(c, Q.strip(0.42, 0.58, 0.1, 0.22), 24, STONE, { roof: 'gableT', rh: 8, roofColor: roof });
  block(c, Q.strip(0.44, 0.56, 0.52, 0.64), 25, 0xd5c8ac, { roof: 'pyr', rh: 24, roofColor: roof });
  const ap = Q.at(0.5, 0.92);
  mb.frustum('wall', circle(ap[0], ap[1], rad(c, 0.16), 10), circle(ap[0], ap[1], rad(c, 0.16), 10), g - FOOT, g + 14, STONE, true, roof);
  const top = Q.at(0.5, 0.58);
  mb.prism('lamp', circle(top[0], top[1], 0.5, 5), g + 49, g + 55, WARM, WARM);
  facadeLights(c, 0.3, 0.7, 0.03, 6);
  tree(c, Q.at(0.12, 0.2), 6, 11); tree(c, Q.at(0.88, 0.2), 6, 12);
}

function cityhall(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c, 0xdcd6c6);
  const wall = pick(c.pal.wall, c.r(1));
  block(c, Q.strip(0.04, 0.96, 0.24, 0.72), 17, wall, { roof: 'mansard', rh: 5, roofColor: pick(c.pal.roof, c.r(2)) });
  block(c, Q.strip(0.04, 0.2, 0.18, 0.78), 19, wall, { roof: 'hip', rh: 5, roofColor: pick(c.pal.roof, c.r(3)), hipIn: 0.3 });
  block(c, Q.strip(0.8, 0.96, 0.18, 0.78), 19, wall, { roof: 'hip', rh: 5, roofColor: pick(c.pal.roof, c.r(3)), hipIn: 0.3 });
  const tw = Q.strip(0.44, 0.56, 0.3, 0.5);
  block(c, tw, 42, STONE, { roof: 'pyr', rh: 16, roofColor: COPPER });
  // clock faces: lamp discs on the four sides of the tower
  const ce = centroid(tw), half = Math.hypot(tw[1][0] - tw[0][0], tw[1][1] - tw[0][1]) / 2;
  const d = Q.dirS();
  for (const [dx, dz] of [[d[0], d[1]], [-d[0], -d[1]], [-d[1], d[0]], [d[1], -d[0]]]) {
    const p: Pt = [ce[0] + dx * (half + 0.2), ce[1] + dz * (half + 0.2)];
    mb.prism('lamp', circle(p[0], p[1], 2.2, 8), g + 33, g + 37, 0xfff0c8, 0xfff0c8);
  }
  for (let k = 0; k < 6; k++) mb.prism('plain', Q.strip(0.38 + k * 0.05, 0.395 + k * 0.05, 0.2, 0.225), g, g + 9, WHITE, WHITE); // portico columns
  facadeLights(c, 0.1, 0.9, 0.06, 7);
  tree(c, Q.at(0.1, 0.9), 6, 11); tree(c, Q.at(0.9, 0.9), 6, 12);
}

function markethall(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xcfc3a8, 0.2, 0.35);
  const body = Q.strip(0.03, 0.97, 0.12, 0.9);
  block(c, body, 8, pick(c.pal.wall, c.r(1)), { roof: 'none' });
  // iron-and-glass pitched roof with a clerestory ridge
  mb.roofGable('glass', body, g + 8, 9, true, 0xa9c8d2);
  const rid = Q.strip(0.05, 0.95, 0.46, 0.56);
  mb.prism('glass', rid, g + 14, g + 17, 0xa9c8d2, 0x8fa9b3);
  for (let k = 0; k < 5; k++) mb.prism('lamp', Q.strip(0.14 + k * 0.17, 0.2 + k * 0.17, 0.1, 0.12), g + 1, g + 7, 0xffe9b8, 0xffe9b8); // lit arched entrances
  const t = Q.strip(0.9, 0.97, 0.12, 0.2);
  block(c, t, 22, 0xd5c8ac, { roof: 'pyr', rh: 8, roofColor: COPPER });
  facadeLights(c, 0.1, 0.9, 0.05, 6);
}

function opera(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c, 0xe0dac8);
  const ce = Q.at(0.5, 0.26), a = ang(c);
  const foyer = ellipse(ce[0], ce[1], Q.W * 0.38, Q.D * 0.2, a, 20);
  mb.frustum('glass', foyer, foyer, g - FOOT, g + 12, 0xa9c8d8, true, 0xd4d9dc);
  lampRing(c, foyer, g + 10, 1.4);
  block(c, Q.strip(0.18, 0.82, 0.42, 0.86), 20, CREAM, { roof: 'none' });
  const dc = Q.at(0.5, 0.64);
  const d0 = ellipse(dc[0], dc[1], Q.W * 0.3, Q.D * 0.22, a, 18), d1 = ellipse(dc[0], dc[1], Q.W * 0.12, Q.D * 0.09, a, 18), d2 = ellipse(dc[0], dc[1], Q.W * 0.04, Q.D * 0.03, a, 18);
  mb.frustum('plain', d0, d1, g + 20, g + 28, COPPER, true, COPPER);
  mb.frustum('plain', d1, d2, g + 28, g + 33, COPPER, true, COPPER);
  block(c, Q.strip(0.36, 0.64, 0.7, 0.94), 33, CREAM, { roof: 'flat' });
  facadeLights(c, 0.2, 0.8, 0.02, 7);
}

function museum(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c);
  block(c, Q.strip(0.1, 0.9, 0.3, 0.76), 14, CREAM, { roof: 'flat', roofColor: 0xcfc9b8 });
  block(c, Q.strip(0.3, 0.7, 0.16, 0.34), 12.5, CREAM, { roof: 'gableS', rh: 4.5, roofColor: 0xc9c2ae });
  for (let k = 0; k < 8; k++) mb.prism('plain', Q.strip(0.3 + k * 0.05, 0.315 + k * 0.05, 0.14, 0.17), g, g + 11, WHITE, WHITE);
  const dm = Q.at(0.5, 0.55);
  mb.frustum('plain', circle(dm[0], dm[1], rad(c, 0.2), 14), circle(dm[0], dm[1], rad(c, 0.07), 14), g + 14, g + 24, COPPER, true, COPPER);
  mb.prism('lamp', circle(dm[0], dm[1], 0.7, 6), g + 24, g + 29, WARM, WARM);
  block(c, Q.strip(0.02, 0.1, 0.36, 0.7), 9, CREAM, { roof: 'flat' }); block(c, Q.strip(0.9, 0.98, 0.36, 0.7), 9, CREAM, { roof: 'flat' });
  facadeLights(c, 0.15, 0.85, 0.05, 8);
}

function university(c: Ctx) {
  const { Q, g } = c;
  pad(c, 0xb9d3a0, 0.3, 0.3);
  const brick = pick(c.pal.wall, c.r(1)), roof = pick(c.pal.roof, c.r(2));
  block(c, Q.strip(0.04, 0.22, 0.12, 0.92), 15, brick, { roof: 'gableT', rh: 5, roofColor: roof });
  block(c, Q.strip(0.78, 0.96, 0.12, 0.92), 15, brick, { roof: 'gableT', rh: 5, roofColor: roof });
  block(c, Q.strip(0.22, 0.78, 0.76, 0.92), 17, brick, { roof: 'gableS', rh: 5, roofColor: roof });
  const clock = Q.strip(0.44, 0.56, 0.76, 0.9);
  block(c, clock, 36, 0xd5c8ac, { roof: 'pyr', rh: 14, roofColor: COPPER });
  // modern lab: a glass cube on the lawn
  block(c, Q.strip(0.3, 0.46, 0.3, 0.5), 11, 0x9fb7c4, { mat: 'glass', roof: 'flat' });
  block(c, Q.strip(0.56, 0.72, 0.38, 0.54), 8, brick, { roof: 'flat' });
  for (let k = 0; k < 7; k++) tree(c, Q.at(0.26 + c.r(40 + k) * 0.48, 0.12 + c.r(50 + k) * 0.5), 6 + c.r(60 + k) * 2, 70 + k);
  c.mb.prism('lamp', Q.strip(0.46, 0.54, 0.9, 0.905), g + 28, g + 31, WARM, WARM);
}

function hospital(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xd9d6cf, 0.3, 0.3);
  block(c, Q.strip(0.3, 0.7, 0.22, 0.78), 26, WHITE, { roof: 'flat', roofColor: 0xcfcfcf });
  block(c, Q.strip(0.04, 0.96, 0.4, 0.6), 15, WHITE, { roof: 'flat', roofColor: 0xcfcfcf });
  block(c, Q.strip(0.4, 0.6, 0.08, 0.92), 15, WHITE, { roof: 'flat', roofColor: 0xcfcfcf });
  const roofC = Q.at(0.5, 0.5);
  mb.prism('plain', circle(roofC[0], roofC[1], 6, 14), g + 26.8, g + 27.4, 0x77828a, 0x77828a);
  mb.prism('lamp', circle(roofC[0], roofC[1], 4.4, 14), g + 27.4, g + 27.8, 0xfff0c0, 0xfff0c0); // helipad ring
  // red cross on the tower
  const f = Q.at(0.5, 0.215), d = Q.dirS();
  for (const [w, h] of [[5, 1.5], [1.5, 5]]) mb.prism('lamp', [[f[0] - d[0] * w / 2 - 0.4, f[1] - d[1] * w / 2 - 0.4], [f[0] + d[0] * w / 2 - 0.4, f[1] + d[1] * w / 2 - 0.4], [f[0] + d[0] * w / 2 + 0.4, f[1] + d[1] * w / 2 + 0.4], [f[0] - d[0] * w / 2 + 0.4, f[1] - d[1] * w / 2 + 0.4]], g + 15 - h / 2, g + 15 + h / 2, 0xff6a5a, 0xff6a5a);
  for (let k = 0; k < 5; k++) tree(c, Q.at(0.1 + k * 0.2, 0.05), 6, 20 + k);
}

function stadium(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xcfd2c6, 0.3, 0.3);
  const ce = Q.centre(), a = ang(c);
  const rx = Q.W * 0.43, rz = Q.D * 0.43;
  const outer = ellipse(ce[0], ce[1], rx, rz, a, 24), inner = ellipse(ce[0], ce[1], rx * 0.72, rz * 0.7, a, 24), pitch = ellipse(ce[0], ce[1], rx * 0.64, rz * 0.62, a, 24);
  mb.frustum('wall', outer, outer, g - FOOT, g + 22, 0xc7c3ba, false);
  mb.frustum('plain', outer, inner, g + 22, g + 5, 0xb85a4a, false, 0xb85a4a, true);        // raked stands, club colours
  mb.frustum('plain', scalePoly(outer, 0.93), scalePoly(inner, 1.02), g + 21.8, g + 5.2, 0xe6e1d6, false, 0xe6e1d6, true);
  mb.prism('lamp', pitch, g, g + 0.5, 0x6fae62, 0x6fae62);
  mb.prism('lamp', scalePoly(pitch, 0.5), g + 0.5, g + 0.62, 0x80ba72, 0x80ba72);
  lampRing(c, outer, g + 19.5, 2.6, 0xfff0c8);
  const m: Pt[] = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const co = Math.cos(a), si = Math.sin(a); const lu = u * rx * 0.98, lv = v * rz * 0.98; m.push([ce[0] + lu * co - lv * si, ce[1] + lu * si + lv * co]); }
  floodlights(c, m, 46);
  for (let k = 0; k < 4; k++) tree(c, Q.at(0.04 + k * 0.3, 0.02), 6, 30 + k);
}

function arena(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c, 0xd8d6cf);
  const ce = Q.at(0.5, 0.52), R = rad(c, 0.38);
  const base = circle(ce[0], ce[1], R, 22);
  mb.frustum('wall', base, base, g - FOOT, g + 14, 0xcfcfd2, false);
  mb.frustum('glass', scalePoly(base, 1.01), scalePoly(base, 1.01), g + 14, g + 24, 0x8fb4c8, false);
  lampRing(c, base, g + 22, 2.4, 0xbfe6ff);
  mb.frustum('plain', base, scalePoly(base, 0.55), g + 24, g + 36, 0xb8bec4, true, 0xb8bec4);
  mb.frustum('plain', scalePoly(base, 0.55), scalePoly(base, 0.12), g + 36, g + 41, 0xc9ced3, true, 0xc9ced3);
  mb.prism('lamp', circle(ce[0], ce[1], 1.3, 6), g + 41, g + 46, 0xbfe6ff, 0xbfe6ff);
  block(c, Q.strip(0.2, 0.8, 0.02, 0.12), 8, 0xd8d6cf, { roof: 'flat' });
}

function library(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c);
  block(c, Q.strip(0.08, 0.92, 0.18, 0.78), 9, CREAM, { roof: 'flat' });
  block(c, Q.strip(0.16, 0.84, 0.28, 0.72), 18, 0x9fc0cf, { mat: 'glass', roof: 'flat', roofColor: 0xd0d6da });
  block(c, Q.strip(0.3, 0.7, 0.36, 0.64), 29, 0x9fc0cf, { mat: 'glass', roof: 'flat', roofColor: 0xd0d6da });
  for (let k = 0; k < 12; k++) mb.prism('plain', Q.strip(0.17 + k * 0.058, 0.176 + k * 0.058, 0.265, 0.28), g, g + 14, WHITE, WHITE);
  lampRing(c, Q.strip(0.3, 0.7, 0.36, 0.64), g + 27, 1.6);
  tree(c, Q.at(0.1, 0.1), 6, 11); tree(c, Q.at(0.9, 0.1), 6, 12);
}

function tvtower(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xdcd8cc, 0.3, 0.35);
  const ce = Q.centre();
  block(c, Q.strip(0.2, 0.8, 0.18, 0.5), 8, 0xcfd2d4, { roof: 'flat' });
  mb.frustum('wall', circle(ce[0], ce[1], 5, 9), circle(ce[0], ce[1], 2.6, 9), g - FOOT, g + 96, 0xcfcfcb, true, 0xb8b8b4);
  mb.frustum('wall', circle(ce[0], ce[1], 11.5, 14), circle(ce[0], ce[1], 11.5, 14), g + 94, g + 104, 0xd8d8d4, true, 0xbfc4c8);
  mb.frustum('glass', circle(ce[0], ce[1], 11.7, 14), circle(ce[0], ce[1], 11.7, 14), g + 98, g + 101, 0x8fb4c8, false);
  mb.frustum('plain', circle(ce[0], ce[1], 8.5, 12), circle(ce[0], ce[1], 5, 12), g + 104, g + 110, 0xcfcfcb, true, 0xcfcfcb);
  mb.frustum('plain', circle(ce[0], ce[1], 2, 8), circle(ce[0], ce[1], 0.35, 8), g + 110, g + 160, 0xb9bcbf, false);
  lampRing(c, circle(ce[0], ce[1], 11.5, 14), g + 99, 1.6, 0xbfe6ff);
  mb.prism('lamp', circle(ce[0], ce[1], 1.2, 6), g + 160, g + 166, 0xff7a6a, 0xff7a6a);
  for (const y of [30, 60]) mb.prism('lamp', circle(ce[0], ce[1], 4.2 - y * 0.02, 9), g + y, g + y + 1.2, 0xff9a8a, 0xff9a8a);
}

function skyscraper(c: Ctx) {
  const { Q, mb, g } = c;
  plaza(c, 0xd6d4cd);
  designTower({ ...c, style: 'super', dens: 2, Q: new Quad(Q.at(0.1, 0.1), Q.at(0.9, 0.1), Q.at(0.9, 0.9), Q.at(0.1, 0.9)) }, true);
  const ce = Q.at(0.5, 0.5);
  mb.frustum('lamp', circle(ce[0], ce[1], 9, 8), circle(ce[0], ce[1], 9, 8), g + 150, g + 152.5, 0xfff0c8, false);
}

function expo(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xd8d6cf, 0.3, 0.3);
  const n = Math.max(3, Math.round(Q.W / 38));
  for (let k = 0; k < n; k++) {
    const s0 = 0.03 + (0.94 / n) * k, s1 = 0.03 + (0.94 / n) * (k + 1) - 0.006;
    const body = Q.strip(s0, s1, 0.26, 0.96);
    block(c, body, 9, 0xd5d8da, { roof: 'none' });
    mb.roofGable('glass', body, g + 9, 11, false, 0xa9c8d2);
  }
  block(c, Q.strip(0.2, 0.8, 0.04, 0.24), 8, 0xe2e0da, { roof: 'flat', roofColor: 0xb8bec4 });
  mb.prism('lamp', Q.strip(0.2, 0.8, 0.05, 0.065), g + 6, g + 8, 0xfff0c8, 0xfff0c8);
  for (let k = 0; k < 6; k++) { const p = Q.at(0.1 + k * 0.16, 0.02); mb.prism('plain', circle(p[0], p[1], 0.4, 5), g, g + 16, 0x8a9096, 0x8a9096); mb.prism('plain', [[p[0], p[1] - 1.5], [p[0] + 3.2, p[1] - 1.5], [p[0] + 3.2, p[1] + 0.2], [p[0], p[1] + 0.2]], g + 12, g + 15, pick([0xc9503f, 0x3d6e9e, 0xd6a23a], c.r(5 + k)), 0xc9503f); }
}

function ferris(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xd8d2bd, 0.3, 0.3);
  const ce = Q.centre(), d = Q.dirS();
  const R = Math.min(Q.W * 0.45, 38), hub = R + 8;
  const box = (x: number, y: number, z: number, s: number, m: 'plain' | 'lamp', col: number) => mb.prism(m, [[x - s, z - s], [x + s, z - s], [x + s, z + s], [x - s, z + s]], g + y - s, g + y + s, col, col);
  const N = 30;
  for (let k = 0; k < N; k++) {
    const th = (k / N) * Math.PI * 2;
    const x = ce[0] + d[0] * Math.cos(th) * R, z = ce[1] + d[1] * Math.cos(th) * R, y = hub + Math.sin(th) * R;
    box(x, y, z, 1.25, 'plain', 0xe9e5dc);
    if (k % 3 === 0) box(x, y - 3, z, 2.6, 'lamp', pick([0xffd7a0, 0xa9d8ff, 0xffb0b0, 0xc8f0b8], c.r(10 + k)));
    if (k % 3 === 0) for (let j = 1; j < 8; j++) box(ce[0] + (x - ce[0]) * j / 8, hub + (y - hub) * j / 8, ce[1] + (z - ce[1]) * j / 8, 0.8, 'plain', 0xd8d4cb);
  }
  const leg = (sg: number) => {
    const bx = ce[0] + d[0] * sg * R * 0.5 - d[1] * 0, bz = ce[1] + d[1] * sg * R * 0.5;
    mb.frustum('plain', [[bx - 3, bz - 3], [bx + 3, bz - 3], [bx + 3, bz + 3], [bx - 3, bz + 3]], [[ce[0] - 1.8, ce[1] - 1.8], [ce[0] + 1.8, ce[1] - 1.8], [ce[0] + 1.8, ce[1] + 1.8], [ce[0] - 1.8, ce[1] + 1.8]], g - 1, g + hub, 0xcfd2d6, true, 0xcfd2d6);
  };
  leg(1); leg(-1);
  mb.prism('plain', circle(ce[0], ce[1], 2.4, 8), g + hub - 2, g + hub + 2, 0xb0b4b8, 0xb0b4b8);
}

function lighthouse(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xe6dcc2, 0.3, 0.4);
  const ce = Q.centre();
  const band = (r0: number, r1: number, y0: number, y1: number, col: number) => mb.frustum('wall', circle(ce[0], ce[1], r0, 12), circle(ce[0], ce[1], r1, 12), g + y0, g + y1, col, true, col);
  band(5.2, 4.6, -2, 8, WHITE); band(4.6, 4.1, 8, 16, 0xc9503f); band(4.1, 3.7, 16, 24, WHITE); band(3.7, 3.3, 24, 32, 0xc9503f); band(3.3, 3.1, 32, 38, WHITE);
  mb.prism('plain', circle(ce[0], ce[1], 4.4, 12), g + 38, g + 39.2, 0x4d5257, 0x4d5257);
  mb.frustum('glass', circle(ce[0], ce[1], 2.6, 10), circle(ce[0], ce[1], 2.6, 10), g + 39.2, g + 44, 0xcfe6f0, true, 0xcfe6f0);
  mb.prism('lamp', circle(ce[0], ce[1], 1.8, 8), g + 40, g + 43.5, 0xfff4c0, 0xfff4c0);
  mb.frustum('plain', circle(ce[0], ce[1], 3.1, 10), circle(ce[0], ce[1], 0.4, 10), g + 44, g + 49, 0xc9503f, true, 0xc9503f);
  block(c, Q.strip(0.6, 0.86, 0.6, 0.86), 6, WHITE, { roof: 'gableS', rh: 3, roofColor: 0x9a4b3c });
}

function fort(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xb9c4a0, 0.2, 0.3);
  const st = 0xb8b09c;
  const T = 0.075;
  block(c, Q.strip(0.04, 0.96, 0.04, 0.04 + T), 10, st, { roof: 'flat', roofColor: 0xa59d8a });
  block(c, Q.strip(0.04, 0.96, 0.96 - T, 0.96), 10, st, { roof: 'flat', roofColor: 0xa59d8a });
  block(c, Q.strip(0.04, 0.04 + T, 0.04, 0.96), 10, st, { roof: 'flat', roofColor: 0xa59d8a });
  block(c, Q.strip(0.96 - T, 0.96, 0.04, 0.96), 10, st, { roof: 'flat', roofColor: 0xa59d8a });
  for (const [s, t] of [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]]) {
    const p = Q.at(s, t);
    mb.frustum('wall', circle(p[0], p[1], 7, 10), circle(p[0], p[1], 7, 10), g - FOOT, g + 17, st, true, 0xa59d8a);
    mb.frustum('plain', circle(p[0], p[1], 8, 10), circle(p[0], p[1], 0.5, 10), g + 17, g + 26, 0x7a5a4a, true, 0x7a5a4a);
  }
  block(c, Q.strip(0.34, 0.66, 0.34, 0.66), 24, st, { roof: 'flat', roofColor: 0xa59d8a });
  block(c, Q.strip(0.4, 0.6, 0.0, 0.14), 15, st, { roof: 'flat', roofColor: 0xa59d8a });
  mb.prism('lamp', Q.strip(0.46, 0.54, 0.0, 0.015), g + 1, g + 8, 0xffe3a6, 0xffe3a6); // lit gate
  for (let k = 0; k < 6; k++) { const p = Q.at(0.38 + k * 0.05, 0.5); mb.prism('plain', [[p[0] - 0.7, p[1] - 0.7], [p[0] + 0.7, p[1] - 0.7], [p[0] + 0.7, p[1] + 0.7], [p[0] - 0.7, p[1] + 0.7]], g + 24, g + 26.2, st, st); }
}

function brewery(c: Ctx) {
  const { Q, mb, g } = c;
  pad(c, 0xcdc2ae, 0.3, 0.3);
  block(c, Q.strip(0.05, 0.7, 0.2, 0.85), 12, pick([0xa55e44, 0x93563e, 0xae694b], c.r(1)), { roof: 'gableS', rh: 5, roofColor: 0x5f6469 });
  mb.roofGable('glass', Q.strip(0.15, 0.6, 0.38, 0.68), g + 12, 4, true, 0xa9c8d2);
  const ch = Q.at(0.84, 0.3);
  mb.frustum('wall', circle(ch[0], ch[1], 3.4, 10), circle(ch[0], ch[1], 2.2, 10), g - FOOT, g + 56, 0x93563e, true, 0x6a3a2a);
  lampRing(c, circle(ch[0], ch[1], 2.5, 10), g + 52, 3, 0xffd899);
  mb.prism('lamp', circle(ch[0], ch[1], 1, 6), g + 56, g + 60, 0xff8a6a, 0xff8a6a);
  for (let k = 0; k < 3; k++) { const p = Q.at(0.78 + 0.0, 0.55 + k * 0.14); mb.frustum('plain', circle(p[0], p[1], 4, 10), circle(p[0], p[1], 4, 10), g - 1, g + 10, 0xb97f56, true, 0x8a5e3e); }
  mb.prism('lamp', Q.strip(0.08, 0.66, 0.195, 0.2), g + 1, g + 7, 0xffe0a0, 0xffe0a0);
  tree(c, Q.at(0.3, 0.1), 6, 11);
}

/** Finished height (m) per form: used for the construction scaffold and crane. */
export const LM_HEIGHT: Record<string, number> = { cathedral: 50, cityhall: 42, markethall: 22, opera: 34, museum: 26, university: 36, hospital: 28, stadium: 46, arena: 46, library: 30, tvtower: 160, skyscraper: 230, expo: 20, ferris: 80, lighthouse: 50, fort: 26, brewery: 60 };

const FORMS: Record<string, (c: Ctx) => void> = { cathedral, cityhall, markethall, opera, museum, university, hospital, stadium, arena, library, tvtower, skyscraper, expo, ferris, lighthouse, fort, brewery };
export const hasForm = (id: string) => id in FORMS;
export function designLandmark(c: Ctx, form: string) {
  const f = FORMS[form] ?? cathedral;
  f(c);
}
export { chamfer, lerpP };
