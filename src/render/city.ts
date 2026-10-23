import * as THREE from 'three';
import { N, CELL, Flag } from '../sim/constants';
import type { StateMsg, LotsMsg, RoadsMsg } from '../sim/protocol';
import type { Village } from '../sim/terrain';
import { vhash } from './common';
import { patchBuildingMaterial } from './look';
import { Layer, unitGeos } from './layers';
import { kindOf, partsFor, GROUND, SITE, PAL, type Part, type Kind } from './forms';
import { Harbour } from './harbour';

// road widths (m) by class, and the narrow cobbled lanes of the old cores
const ROAD_W = [16, 11, 8];
const CORE_W = 6.5;
const ASPHALT = [new THREE.Color(0x7d8186), new THREE.Color(0x8c8f93), new THREE.Color(0x9a9c9f)];
const COBBLE = new THREE.Color(0xbfae94);
const KERB = new THREE.Color(0xd9d5cb);

interface Anim { lot: number; parts: { layer: Layer; i: number }[] }

export class CityView {
  group = new THREE.Group();
  wallMat: THREE.MeshStandardMaterial;
  glassMat: THREE.MeshStandardMaterial;
  plainMat: THREE.MeshStandardMaterial;
  treeMat: THREE.MeshStandardMaterial;
  roadMat: THREE.MeshStandardMaterial;
  ghostMat: THREE.MeshStandardMaterial;
  craneMat: THREE.MeshStandardMaterial;
  roads: THREE.Mesh;
  private L: Record<string, Layer>;
  private ghosts: Layer;
  private pads: Layer;
  private craneMast: Layer;
  private craneJib: Layer;
  harbour: Harbour;
  get surfaceMats(): THREE.Material[] {
    return [this.wallMat, this.glassMat, this.plainMat, this.treeMat, this.roadMat, this.craneMat];
  }
  private anims: Anim[] = [];
  private cranes: { x: number; y: number; z: number; h: number; k: number }[] = [];
  private lots: LotsMsg | null = null;
  private roadVersion = -1;
  private occ = new Uint8Array(N * 4 * N * 4); // 12.5 m occupancy grid (roads) for wild tree placement
  private coreEdge = new Set<number>();
  private streetTrees: { x: number; z: number; s: number; seed: number }[] = [];

  constructor(private water: Uint8Array, private flags: Uint8Array, private villages: Village[], private sample: (x: number, z: number) => number) {
    const g = unitGeos();
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    patchBuildingMaterial(this.wallMat, false);
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.25, envMapIntensity: 1 });
    patchBuildingMaterial(this.glassMat, true);
    this.plainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    this.treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
    this.craneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    this.ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.5, depthWrite: false, emissive: 0x404040, emissiveIntensity: 0.4 });
    this.L = {
      wall: new Layer(g.box, this.wallMat, 40000),
      glass: new Layer(g.box, this.glassMat, 8000),
      plain: new Layer(g.box, this.plainMat, 40000),
      gable: new Layer(g.gable, this.plainMat, 30000),
      saw: new Layer(g.saw, this.plainMat, 4000),
      pyr: new Layer(g.pyr, this.plainMat, 2000),
      cyl: new Layer(g.cyl, this.plainMat, 6000),
      leaf: new Layer(g.sphere, this.treeMat, 40000),
      pine: new Layer(g.cone, this.treeMat, 12000),
      trunk: new Layer(g.cyl, this.plainMat, 20000, false),
    };
    this.pads = new Layer(g.box, this.plainMat, 12000, false);
    this.ghosts = new Layer(g.box, this.ghostMat, 6000, false);
    this.ghosts.mesh.renderOrder = 5;
    this.craneMast = new Layer(g.box, this.craneMat, 2000);
    const jib = new THREE.BoxGeometry(1, 1, 1);
    jib.translate(0.3, 0, 0);
    this.craneJib = new Layer(jib, this.craneMat, 2000);

    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, emissive: 0xffb860, emissiveIntensity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.roads = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMat);
    this.roads.receiveShadow = true;
    this.roads.frustumCulled = false;

    this.harbour = new Harbour(water, flags, sample, this.plainMat);
    this.group.add(this.roads, this.pads.mesh, ...Object.values(this.L).map((l) => l.mesh), this.ghosts.mesh, this.craneMast.mesh, this.craneJib.mesh, this.harbour.group);
  }

  private ground(x: number, z: number) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && this.water[cz * N + cx]) return 0.4;
    return this.sample(x, z);
  }

  update(s: StateMsg) {
    this.lots = s.lots;
    if (s.roads.version !== this.roadVersion) { this.roadVersion = s.roads.version; this.rebuildRoads(s.roads); }
    this.rebuild(s);
  }

  // ---------------------------------------------------------------- roads: asphalt on a pale kerb strip, cobbles in the old cores
  private rebuildRoads(r: RoadsMsg) {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    let base = 0;
    const occ = this.occ, W = N * 4;
    occ.fill(0);
    const stampOcc = (x: number, z: number, rad: number) => {
      const R = Math.ceil(rad / 12.5);
      const gx = Math.floor(x / 12.5), gz = Math.floor(z / 12.5);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const X = gx + dx, Z = gz + dz;
        if (X >= 0 && Z >= 0 && X < W && Z < W) occ[Z * W + X] = 1;
      }
    };
    const yAt = (x: number, z: number) => {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      const wet = cx >= 0 && cz >= 0 && cx < N && cz < N && this.water[cz * N + cx];
      return wet ? 6 : this.sample(x, z) + 0.6;
    };
    const nNodes = r.nodes.length / 2;
    const core = (x: number, y: number) => this.villages.some((v) => Math.hypot(v.x + 0.5 - x, v.y + 0.5 - y) < 6.5);
    const maxW = new Float32Array(nNodes), nodeCol: THREE.Color[] = new Array(nNodes).fill(null);
    const widths: number[] = [], colors: THREE.Color[] = [];
    this.coreEdge.clear();
    for (let k = 0; k < r.ea.length; k++) {
      const a = r.ea[k], b = r.eb[k];
      const mx = (r.nodes[a * 2] + r.nodes[b * 2]) / 2, my = (r.nodes[a * 2 + 1] + r.nodes[b * 2 + 1]) / 2;
      const isCore = r.cls[k] !== 0 && r.year[k] === 0 && core(mx, my);
      if (isCore) this.coreEdge.add(r.ids[k]);
      const w = isCore ? CORE_W : ROAD_W[r.cls[k]], c = isCore ? COBBLE : ASPHALT[r.cls[k]];
      widths.push(w); colors.push(c);
      for (const n of [a, b]) if (w > maxW[n]) { maxW[n] = w; nodeCol[n] = c; }
    }
    const strip = (k: number, w: number, c: THREE.Color, lift: number) => {
      const a = r.ea[k], b = r.eb[k];
      const ax = r.nodes[a * 2] * CELL, az = r.nodes[a * 2 + 1] * CELL, bx = r.nodes[b * 2] * CELL, bz = r.nodes[b * 2 + 1] * CELL;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) return;
      const nx = (-(bz - az) / L) * w / 2, nz = ((bx - ax) / L) * w / 2;
      const steps = Math.max(1, Math.ceil(L / 25));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const y = yAt(x, z) + lift;
        pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        if (j > 0) { const o = base + (j - 1) * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
        if (lift === 0) stampOcc(x, z, w / 2 + 2);
      }
      base += (steps + 1) * 2;
    };
    const disc = (n: number, rad: number, c: THREE.Color, lift: number) => {
      const SEG = 12;
      const x = r.nodes[n * 2] * CELL, z = r.nodes[n * 2 + 1] * CELL, y = yAt(x, z) + lift;
      pos.push(x, y, z); col.push(c.r, c.g, c.b);
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        pos.push(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad); col.push(c.r, c.g, c.b);
        idx.push(base, base + 1 + ((k + 1) % SEG), base + 1 + k);
      }
      base += SEG + 1;
    };
    // street trees: one row on each side of every ordinary street, none in the cobbled cores or on the docks
    this.streetTrees = [];
    for (let k = 0; k < r.ea.length; k++) {
      if (this.coreEdge.has(r.ids[k])) continue;
      const a = r.ea[k], b = r.eb[k];
      const ax = r.nodes[a * 2] * CELL, az = r.nodes[a * 2 + 1] * CELL, bx = r.nodes[b * 2] * CELL, bz = r.nodes[b * 2 + 1] * CELL;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 70) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, off = widths[k] / 2 + 3.6;
      const n = Math.floor((L - 40) / 30);
      for (let j = 0; j <= n; j++) {
        const t = 20 + j * ((L - 40) / Math.max(1, n));
        for (const side of [1, -1]) {
          const seed = r.ids[k] * 97 + j * 2 + (side > 0 ? 1 : 0);
          if (vhash(seed, 5) < 0.28) continue;
          const x = ax + ux * t - uz * off * side, z = az + uz * t + ux * off * side;
          const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
          if (cx < 0 || cz < 0 || cx >= N || cz >= N || this.water[cz * N + cx] || (this.flags[cz * N + cx] & Flag.Docks)) continue;
          this.streetTrees.push({ x, z, s: 5 + vhash(seed, 6) * 2.5, seed });
        }
      }
    }
    // kerb / pavement strip first, then the carriageway on top
    for (let k = 0; k < r.ea.length; k++) strip(k, widths[k] + 5, KERB, 0);
    for (let n = 0; n < nNodes; n++) if (maxW[n]) disc(n, maxW[n] / 2 + 2.5, KERB, 0.02);
    for (let k = 0; k < r.ea.length; k++) strip(k, widths[k], colors[k], 0.25);
    for (let n = 0; n < nNodes; n++) if (maxW[n]) disc(n, maxW[n] / 2, nodeCol[n], 0.27);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.roads.geometry.dispose();
    this.roads.geometry = g;
  }

  // ---------------------------------------------------------------- plots: ground, buildings, trees
  private rebuild(s: StateMsg) {
    const L = s.lots;
    for (const l of Object.values(this.L)) l.reset();
    this.pads.reset(); this.ghosts.reset(); this.craneMast.reset(); this.craneJib.reset();
    this.anims = [];
    this.cranes = [];
    const lotOcc = this.occ.slice(), W4 = N * 4;
    for (let k = 0; k < L.n; k++) {
      const building = L.constr[k] > 0;
      const lvl = building ? L.target[k] : L.level[k];
      const t = L.type[k];
      const x = L.x[k] * CELL, z = L.y[k] * CELL, ang = L.ang[k];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const g = this.ground(x, z);
      const planned = (L.flags[k] & Flag.Planned) !== 0 && !building;
      const kind: Kind = kindOf(t, lvl, L.flags[k]);
      const w = L.w[k] * CELL, d = L.d[k] * CELL;
      // keep wild trees off every plot
      for (let u = -w / 2; u <= w / 2; u += 8) for (let v = -d / 2; v <= d / 2; v += 8) {
        const gx = Math.floor((x + u * ca - v * sa) / 12.5), gz = Math.floor((z + u * sa + v * ca) / 12.5);
        if (gx >= 0 && gz >= 0 && gx < W4 && gz < W4) lotOcc[gz * W4 + gx] = 1;
      }
      // ground treatment by land use
      const padC = building ? SITE : planned ? SITE : kind !== 'none' ? GROUND[kind] : 0;
      if (padC) this.pads.add(x, g - 5, z, w - 1, 5.35, d - 1, -ang, padC);
      if (kind !== 'none') {
        const anim: Anim = { lot: k, parts: [] };
        let top = 0;
        for (const p of partsFor(L.id[k], kind, lvl)) {
          const wx = x + p.u * ca - p.v * sa, wz = z + p.u * sa + p.v * ca;
          const rot = -(ang + (p.r ?? 0));
          if (p.s === 'tree' || p.s === 'pine') { this.tree(wx, g, wz, p.w, p.h, p.s === 'pine', L.id[k] * 31 + Math.round(p.u * 7 + p.v)); continue; }
          const layer = this.L[p.s];
          const yb = g - 2;
          const yoff = p.y === 0 ? 0 : p.y + 2;
          const h = p.y === 0 ? p.h + 2 : p.h;
          const i = layer.add(wx, yb, wz, p.w, h, p.d, rot, p.c, yoff);
          if (i >= 0 && building) anim.parts.push({ layer, i });
          top = Math.max(top, p.y + p.h);
        }
        if (building) {
          this.anims.push(anim);
          if (lvl >= 2 && kind !== 'park' && kind !== 'square') this.cranes.push({ x: x + 16 * ca - 15 * sa, y: g - 2, z: z + 16 * sa + 15 * ca, h: Math.min(top + 10, 80), k: L.id[k] });
        }
      }
      if (planned) {
        const pk = kindOf(L.planType[k], L.planLevel[k], L.flags[k]);
        const gc = (L.flags[k] & Flag.CarLocked) ? 0xd9785a : L.served[k] ? 0x6fb0e8 : 0xf2c46a;
        for (const p of partsFor(L.id[k], pk, L.planLevel[k]) as Part[]) {
          if (p.s !== 'wall' && p.s !== 'glass') continue;
          const wx = x + p.u * ca - p.v * sa, wz = z + p.u * sa + p.v * ca;
          this.ghosts.add(wx, g + p.y, wz, p.w, p.h, p.d, -ang, gc);
        }
      }
    }
    for (const t of this.streetTrees) this.tree(t.x, this.sample(t.x, t.z), t.z, t.s, t.s * 1.15, vhash(t.seed, 7) < 0.12, t.seed);
    this.wildTrees(s, lotOcc);
    for (const l of Object.values(this.L)) l.finish();
    this.pads.finish(); this.ghosts.finish();
    for (const c of this.cranes) { this.craneMast.add(c.x, c.y, c.z, 1.6, c.h, 1.6, 0, 0xc9a24a); this.craneJib.add(c.x, c.y + c.h, c.z, 30, 1.4, 1.4, 0, 0xc9a24a); }
    this.craneMast.finish(); this.craneJib.finish();
    this.animate(0, 0);
  }

  private tree(x: number, g: number, z: number, size: number, h: number, pine: boolean, seed: number) {
    const c = pine ? PAL.pine[Math.floor(vhash(seed, 1) * PAL.pine.length)] : PAL.leaf[Math.floor(vhash(seed, 1) * PAL.leaf.length)];
    if (pine) { this.L.pine.add(x, g + 1, z, size, h, size, 0, c); this.L.trunk.add(x, g - 0.5, z, 1, 2, 1, 0, PAL.trunk); }
    else { this.L.trunk.add(x, g - 0.5, z, 1.1, 3.5, 1.1, 0, PAL.trunk); this.L.leaf.add(x, g + 2.4, z, size, h, size, vhash(seed, 2) * 6, c); }
  }

  /** Trees on open land, denser woodland on slopes too steep to build. */
  private wildTrees(s: StateMsg, occ: Uint8Array) {
    const W = N * 4;
    for (let i = 0; i < N * N; i++) {
      if (this.water[i]) continue;
      if (this.flags[i] & Flag.Docks) continue;
      const steep = (s.flags[i] & Flag.Steep) !== 0;
      const r0 = vhash(i, 77);
      const want = r0 < (steep ? 0.85 : 0.16) ? (steep ? 3 : 1) + Math.floor(vhash(i, 78) * 3) : 0;
      const cx = (i % N) * CELL, cz = ((i / N) | 0) * CELL;
      for (let k = 0; k < want; k++) {
        const x = cx + vhash(i, 90 + k) * CELL, z = cz + vhash(i, 100 + k) * CELL;
        const gx = Math.floor(x / 12.5), gz = Math.floor(z / 12.5);
        if (occ[gz * W + gx]) continue;
        const sc = 6 + vhash(i, 80 + k) * 5;
        const pine = vhash(i, 110 + k) < (steep ? 0.55 : 0.2);
        const c = pine ? PAL.pine[Math.floor(vhash(i, 120 + k) * 3)] : PAL.leaf[Math.floor(vhash(i, 120 + k) * 5)];
        const y = this.sample(x, z);
        if (pine) this.L.pine.add(x, y - 0.5, z, sc * 0.8, sc * 2, sc * 0.8, 0, c);
        else this.L.leaf.add(x, y - 0.5, z, sc, sc * 1.1, sc, vhash(i, 130 + k) * 6, c);
      }
    }
  }

  /** Rising buildings + cranes. frac = fraction of the current month elapsed. */
  animate(frac: number, time: number) {
    const L = this.lots;
    if (!L) return;
    const touched = new Set<Layer>();
    for (const a of this.anims) {
      const tot = Math.max(1, L.constrTotal[a.lot]);
      const done = tot - L.constr[a.lot];
      let p = Math.min(1, (done + frac) / tot);
      p = 1 - Math.pow(1 - p, 2);
      for (const q of a.parts) { q.layer.set(q.i, p); touched.add(q.layer); }
    }
    for (const l of touched) l.touch();
    if (!this.cranes.length) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < this.cranes.length; k++) {
      const c = this.cranes[k];
      v.set(c.x, c.y + c.h, c.z); sc.set(30, 1.4, 1.4);
      q.setFromAxisAngle(up, time * 0.25 + c.k);
      m.compose(v, q, sc);
      this.craneJib.mesh.setMatrixAt(k, m);
    }
    this.craneJib.touch();
  }
}

