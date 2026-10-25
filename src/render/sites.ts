/**
 * Large-plot assembly sites: hoardings round the plots as they are bought, demolition (existing grow meshes), a cleared yard with
 * site cabins and laydown, foundations, a concrete frame rising under cranes, then the facade going on. One small group of meshes
 * per assembly, rebuilt only when its stage changes.
 */
import * as THREE from 'three';
import { CELL, BT } from '../sim/constants';
import type { StateMsg, LotsMsg } from '../sim/protocol';
import type { AssemblyInfo } from '../sim/assembly';
import { MB, Quad, scalePoly, type Pt, type Mat } from './poly';
import { designLot, massing, FOOT, type Ctx, type Tree } from './buildings';
import { kindOf, PAL, type Kind } from './forms';
import { LM_HEIGHT } from './landmarks';
import { landmarkAt } from '../sim/landmarks';
import { vhash } from './common';

export interface SiteHost {
  ground(x: number, z: number): number;
  quadOf(L: LotsMsg, k: number): Quad;
  ctxFor(L: LotsMsg, k: number, Q: Quad, mb: MB, kind: Kind, level: number, trees: Tree[], hgt?: number): Ctx;
  polyMats: Record<Mat, THREE.Material>;
  scafMat: THREE.LineBasicMaterial;
}
export interface SiteCrane { x: number; y: number; z: number; h: number; k: number }
export interface Site { sig: number; group: THREE.Group; cranes: SiteCrane[]; skin: THREE.Object3D[]; trees: Tree[] }

const MATS: Mat[] = ['wall', 'glass', 'plain', 'lamp'];
const HOARD = [0x3f6f8f, 0x4c7f6a, 0x8a5f4c];
const CONCRETE = 0xb4b0a6, CORE = 0xa29e94, GROUND = 0xcdc0a4, RUBBLE = 0xb4ab9b;

export function siteSig(a: AssemblyInfo, L: LotsMsg, idx: Map<number, number>): number {
  let h = a.id * 7919 + a.phase * 104729;
  const m = (v: number) => { h = Math.imul(h ^ v, 16777619); };
  if (a.phase === 0) for (const id of [...a.lots, ...a.plaza]) { const k = idx.get(id); m(k === undefined ? -1 : L.astate[k] + 1); }
  else if (a.phase === 2) for (const id of [...a.lots, ...a.plaza]) { const k = idx.get(id); m(k === undefined ? -1 : L.astate[k] * 3 + (L.demo[k] > 0 ? 1 : 0)); }
  else if (a.phase === 5) m(Math.floor(a.pct * 14));
  m(a.merged + 3); m(a.closed.length);
  return h;
}

export function buildSite(host: SiteHost, a: AssemblyInfo, s: StateMsg, idx: Map<number, number>): Site {
  const L = s.lots;
  const mb = new MB();
  const group = new THREE.Group();
  const cranes: SiteCrane[] = [];
  const skin: THREE.Object3D[] = [];
  const trees: Tree[] = [];
  const r = (k: number) => vhash(a.id * 131 + 7, k);
  const hoardCol = HOARD[a.id % HOARD.length];
  const members = [...a.lots, ...a.plaza].map((id) => idx.get(id)).filter((k): k is number => k !== undefined);
  const polyOf = (k: number): Pt[] => [0, 1, 2, 3].map((i) => [L.poly[k * 8 + i * 2] * CELL, L.poly[k * 8 + i * 2 + 1] * CELL] as Pt);
  const P = (i: number): Pt => [a.quad[i * 2] * CELL, a.quad[i * 2 + 1] * CELL];
  const U = new Quad(P(0), P(1), P(2), P(3));
  const cx = U.centre()[0], cz = U.centre()[1], gU = host.ground(cx, cz);

  // ---- one continuous hoarding round the site outline once every plot is bought (round 7: was a fence round each plot with a post every
  // 10 m, which from above read as scattered pins); it stays up until the building is finished
  if (a.phase >= 1 && a.phase <= 6 && a.kind !== 'docks') {
    const ring = U.poly(-0.6);
    const g = gU;
    for (let i = 0; i < ring.length; i++) {
      const A = ring[i], B = ring[(i + 1) % ring.length];
      const dx = B[0] - A[0], dz = B[1] - A[1], len = Math.hypot(dx, dz) || 1, nx = -dz / len * 0.2, nz = dx / len * 0.2;
      // run each panel a little past the corner so the ring closes without a gap
      const ex = dx / len * 0.2, ez = dz / len * 0.2;
      const seg: Pt[] = [[A[0] - ex + nx, A[1] - ez + nz], [B[0] + ex + nx, B[1] + ez + nz], [B[0] + ex - nx, B[1] + ez - nz], [A[0] - ex - nx, A[1] - ez - nz]];
      mb.prism('plain', seg, g - 1.2, g + 2.4, hoardCol, hoardCol);
      mb.prism('plain', seg, g + 2.4, g + 2.6, 0xe9e5da, 0xe9e5da);
    }
  }

  // ---- cleared plots: packed earth (demolished plots show it once their rubble is gone)
  if (a.phase >= 2 && a.phase <= 4) {
    for (const k of members) {
      if (L.astate[k] < 3 || L.demo[k] > 0) continue;
      const g = host.ground(L.x[k] * CELL, L.y[k] * CELL);
      mb.prism('plain', polyOf(k), g - FOOT, g + 0.3, GROUND, GROUND);
      // a few rubble heaps left on the plot until the yard is cleared
      if (a.phase === 2) for (let i = 0; i < 3; i++) {
        const q = new Quad(...(polyOf(k) as [Pt, Pt, Pt, Pt]));
        const s0 = 0.15 + vhash(L.id[k], 20 + i) * 0.6, t0 = 0.15 + vhash(L.id[k], 30 + i) * 0.6;
        mb.prism('plain', q.strip(s0, s0 + 0.12, t0, t0 + 0.12), g + 0.25, g + 0.9 + vhash(L.id[k], 40 + i) * 1.4, RUBBLE, RUBBLE);
      }
    }
  }
  const area = Math.abs(U.W * U.D);

  // ---- the cleared yard: cabins, laydown, gate board
  if (a.phase >= 3 && a.kind !== 'docks') {
    mb.prism('plain', U.poly(0.8), gU - FOOT, gU + 0.32, GROUND, GROUND);
    const nCab = a.phase === 3 ? 3 : 2;
    for (let i = 0; i < nCab; i++) {
      const s0 = 0.06 + i * 0.13 + r(1 + i) * 0.04, t0 = 0.05;
      const cw = 7.5 / U.W, cd = 3.2 / U.D;
      const body = U.strip(s0, s0 + cw, t0, t0 + cd);
      mb.prism('wall', body, gU + 0.3, gU + 2.9, 0xe3e6e2, 0xcfd4cf);
      mb.prism('plain', scalePoly(body, 1.04), gU + 2.9, gU + 3.15, 0x7b8995, 0x7b8995);
      if (i === 0) mb.prism('plain', scalePoly(U.strip(s0 + 0.01, s0 + cw - 0.01, t0, t0 + cd), 0.9), gU + 3.15, gU + 5.6, 0xdfe3df, 0x7b8995);
    }
    // laydown: stacked containers, pipe bundles, pallets of blocks
    const nStack = 5 + Math.min(6, Math.round(area / 1500));
    for (let i = 0; i < nStack; i++) {
      const s0 = 0.08 + r(20 + i) * 0.8, t0 = 0.62 + r(40 + i) * 0.28;
      const kind = r(60 + i);
      if (kind < 0.4) {
        const col = PAL.container[Math.floor(r(80 + i) * PAL.container.length)];
        const b = U.strip(s0, s0 + 6.2 / U.W, t0, t0 + 2.5 / U.D);
        mb.prism('plain', b, gU + 0.3, gU + 2.9, col, col);
        if (r(90 + i) < 0.5) mb.prism('plain', b, gU + 2.9, gU + 5.4, PAL.container[Math.floor(r(100 + i) * PAL.container.length)], 0xcccccc);
      } else if (kind < 0.7) {
        mb.prism('plain', U.strip(s0, s0 + 9 / U.W, t0, t0 + 1.8 / U.D), gU + 0.3, gU + 1.5, 0xc9b690, 0xc9b690);
      } else {
        mb.prism('plain', U.strip(s0, s0 + 3.4 / U.W, t0, t0 + 3.4 / U.D), gU + 0.3, gU + 1.6, 0xa8a49a, 0xb9b5ab);
      }
    }
    // developer board on the street side
    const bq = U.strip(0.46, 0.46 + 11 / U.W, 0.02, 0.02 + 0.6 / U.D);
    mb.prism('plain', bq, gU + 1.6, gU + 5.6, hoardCol, 0xe9e5da);
  }

  // ---- foundations: slab, pile caps and rebar stubs
  if (a.phase === 4) {
    mb.prism('plain', U.poly(1.5), gU - FOOT, gU + 0.55, 0x8d8982, 0x9a968e);
    const nx = Math.max(2, Math.round(U.W / 12)), nz = Math.max(2, Math.round(U.D / 12));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const s0 = (i + 0.5) / nx, t0 = (j + 0.5) / nz;
      const q = U.strip(s0 - 0.8 / U.W, s0 + 0.8 / U.W, t0 - 0.8 / U.D, t0 + 0.8 / U.D);
      mb.prism('plain', q, gU + 0.5, gU + 2.4 + r(130 + i * 7 + j) * 1.6, 0x7f7b75, 0x8f8b84);
    }
  }

  // ---- structure and facade: the merged plot's building
  const k0 = a.merged >= 0 ? idx.get(a.merged) : undefined;
  if (a.phase >= 5 && k0 !== undefined) {
    const Q = host.quadOf(L, k0);
    const lm = landmarkAt(L.lm[k0]);
    const kind: Kind = a.type === BT.Landmark ? 'landmark' : kindOf(a.type, a.level, 0);
    const level = a.type === BT.Landmark ? 1 : a.level;
    const probe = new MB();
    const pc = host.ctxFor(L, k0, Q, probe, kind, level, [], L.nhgt[k0]);
    const ms = massing(pc);
    const H = a.type === BT.Landmark ? (LM_HEIGHT[lm?.form ?? ''] ?? 30) : Math.max(12, L.nhgt[k0] || ms.h);
    const g = host.ground(L.x[k0] * CELL, L.y[k0] * CELL);
    const poly = ms.poly;
    const frac = a.phase === 5 ? Math.max(0.04, a.pct) : 1;
    const Hc = H * frac;
    mb.prism('plain', Q.poly(0.8), g - FOOT, g + 0.4, 0x8d8982, 0x9a968e);
    // columns on the corners and edge midpoints, a core, and floor slabs
    const ring: Pt[] = [];
    for (let i = 0; i < poly.length; i++) { ring.push(poly[i]); ring.push([(poly[i][0] + poly[(i + 1) % poly.length][0]) / 2, (poly[i][1] + poly[(i + 1) % poly.length][1]) / 2]); }
    for (const p of ring) mb.prism('plain', [[p[0] - 0.7, p[1] - 0.7], [p[0] + 0.7, p[1] - 0.7], [p[0] + 0.7, p[1] + 0.7], [p[0] - 0.7, p[1] + 0.7]], g - 0.5, g + Hc, CONCRETE, CONCRETE);
    mb.prism('plain', scalePoly(poly, 0.38), g - 0.5, g + Hc + 3, CORE, CORE);
    const step = H > 60 ? 3.3 * 2 : 3.3;
    for (let y = step; y <= Hc; y += step) mb.prism('plain', scalePoly(poly, 1.0), g + y - 0.3, g + y + 0.12, CONCRETE, 0xc9c5bb);
    // scaffold cage
    const pos: number[] = [];
    const Hs = Math.min(110, Hc + 4);
    const line = (A: Pt, ay: number, B: Pt, by: number) => pos.push(A[0], g + ay, A[1], B[0], g + by, B[1]);
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length], mid: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      line(A, 0, A, Hs); line(mid, 0, mid, Hs);
      for (let y = 3.4; y <= Hs; y += 3.4) line(A, y, B, y);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(sg, host.scafMat);
    lines.frustumCulled = false;
    group.add(lines);
    // facade: the building's skin rises over the frame (scaled in y by the stage)
    if (a.phase === 6) {
      const sk = new MB();
      sk.ox = Q.centre()[0]; sk.oy = g; sk.oz = Q.centre()[1];
      const trees2: Tree[] = [];
      const c2 = host.ctxFor(L, k0, Q, sk, kind, level, trees2, L.nhgt[k0]);
      designLot(c2);
      const sgp = new THREE.Group();
      sgp.position.set(Q.centre()[0], g, Q.centre()[1]);
      for (const m of MATS) {
        const geo = sk.acc[m].build();
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, host.polyMats[m]);
        mesh.castShadow = m !== 'lamp'; mesh.receiveShadow = true;
        sgp.add(mesh); skin.push(mesh);
      }
      group.add(sgp);
      for (const t of trees2) trees.push(t);
    }
    // cranes scale with the site
    const n = a.cranes;
    for (let i = 0; i < n; i++) {
      const q = Q.at((i + 1) / (n + 1), 0.5 + (i % 2 ? 0.28 : -0.28));
      cranes.push({ x: q[0], y: g - 1, z: q[1], h: Math.min(110, H * Math.max(0.35, frac) + 16), k: a.id * 7 + i });
    }
  } else if (a.phase === 4) {
    const q = U.at(0.8, 0.5);
    cranes.push({ x: q[0], y: gU - 1, z: q[1], h: 34, k: a.id * 7 });
  }

  // ---- barriers at the ends of streets closed for the site
  for (const [ax, ay, bx, by] of a.closed) {
    for (const [x, y, ox, oy] of [[ax, ay, bx, by], [bx, by, ax, ay]]) {
      const px = x * CELL, pz = y * CELL, g = host.ground(px, pz);
      const dx = (ox - x) * CELL, dz = (oy - y) * CELL, L2 = Math.hypot(dx, dz) || 1;
      const ux = dx / L2 * 4, uz = dz / L2 * 4, nx = -uz / 4 * 5, nz = ux / 4 * 5;
      const bar: Pt[] = [[px + ux - nx, pz + uz - nz], [px + ux + nx, pz + uz + nz], [px + ux + nx + 0.5, pz + uz + nz + 0.5], [px + ux - nx + 0.5, pz + uz - nz + 0.5]];
      mb.prism('plain', bar, g + 0.9, g + 1.5, 0xd9d4c6, 0xd9d4c6);
      mb.prism('plain', scalePoly(bar, 0.5), g + 0.9, g + 1.52, 0xc0443a, 0xc0443a);
    }
  }

  for (const m of MATS) {
    const geo = mb.acc[m].build();
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, host.polyMats[m]);
    mesh.castShadow = m !== 'lamp'; mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { sig: 0, group, cranes, skin, trees };
}
