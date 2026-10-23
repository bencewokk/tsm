import * as THREE from 'three';
import { N, CELL, Flag, BT } from '../sim/constants';
import type { StateMsg, LotsMsg, RoadsMsg } from '../sim/protocol';
import type { Village } from '../sim/terrain';
import { vhash } from './common';
import { patchBuildingMaterial } from './look';
import { Layer, unitGeos } from './layers';
import { kindOf, SITE, PAL, type Kind } from './forms';
import { Harbour } from './harbour';
import { MB, Quad, type Pt, type Mat } from './poly';
import { PROFILES, PALETTES } from '../sim/profiles';
import { designLot, massing, pad, tree as ctxTree, FOOT, type Ctx, type Tree } from './buildings';

// road widths (m) by class, and the narrow cobbled lanes of the old cores
const ROAD_W = [16, 11, 8];
const CORE_W = 6.5;
const ASPHALT = [new THREE.Color(0x7d8186), new THREE.Color(0x8c8f93), new THREE.Color(0x9a9c9f)];
const COBBLE = new THREE.Color(0xbfae94);
const KERB = new THREE.Color(0xd9d5cb);

const CHUNK = 16; // cells per chunk side (800 m)
const MATS: Mat[] = ['wall', 'glass', 'plain', 'ghost', 'lamp'];

interface Chunk { sig: number; meshes: THREE.Mesh[]; trees: Tree[] }

/** A plot being demolished or built: its own small meshes, scaled in y as the work progresses. */
interface Grow {
  sig: number;
  lot: number;            // lot id
  mode: 'build' | 'demo';
  group: THREE.Group;
  bodies: THREE.Object3D[]; // scaled in y
  crane: { x: number; y: number; z: number; h: number; k: number } | null;
}

const imul = Math.imul;

export class CityView {
  group = new THREE.Group();
  wallMat: THREE.MeshStandardMaterial;
  glassMat: THREE.MeshStandardMaterial;
  plainMat: THREE.MeshStandardMaterial;
  ghostMat: THREE.MeshStandardMaterial;
  lampMat: THREE.MeshBasicMaterial;
  treeMat: THREE.MeshStandardMaterial;
  roadMat: THREE.MeshStandardMaterial;
  craneMat: THREE.MeshStandardMaterial;
  scafMat: THREE.LineBasicMaterial;
  roads: THREE.Mesh;
  private L: Record<string, Layer>;
  private craneMast: Layer;
  private craneJib: Layer;
  private polyMats: Record<Mat, THREE.Material>;
  harbour: Harbour;
  get surfaceMats(): THREE.Material[] {
    return [this.wallMat, this.glassMat, this.plainMat, this.treeMat, this.roadMat, this.craneMat];
  }
  private chunks = new Map<number, Chunk>();
  private chunkGroup = new THREE.Group();
  private grows = new Map<number, Grow>();
  private growGroup = new THREE.Group();
  private cranes: { x: number; y: number; z: number; h: number; k: number }[] = [];
  private lots: LotsMsg | null = null;
  private roadVersion = -1;
  private occ = new Uint8Array(N * 4 * N * 4); // 12.5 m occupancy grid (roads) for wild tree placement
  private coreEdge = new Set<number>();
  private streetTrees: { x: number; z: number; s: number; seed: number }[] = [];
  stats = { chunksBuilt: 0, lots: 0, grows: 0 };

  constructor(private water: Uint8Array, private flags: Uint8Array, private villages: Village[], private sample: (x: number, z: number) => number) {
    const g = unitGeos();
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
    patchBuildingMaterial(this.wallMat, false, true);
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.25, envMapIntensity: 1, vertexColors: true });
    patchBuildingMaterial(this.glassMat, true, true);
    this.plainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, vertexColors: true });
    this.ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.5, depthWrite: false, emissive: 0x404040, emissiveIntensity: 0.4, vertexColors: true });
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    this.polyMats = { wall: this.wallMat, glass: this.glassMat, plain: this.plainMat, ghost: this.ghostMat, lamp: this.lampMat };
    this.treeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
    this.craneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    this.scafMat = new THREE.LineBasicMaterial({ color: 0xb59b5f, transparent: true, opacity: 0.9 });
    const plainInst = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    this.L = {
      leaf: new Layer(g.sphere, this.treeMat, 60000),
      pine: new Layer(g.cone, this.treeMat, 20000),
      trunk: new Layer(g.cyl, plainInst, 40000, false),
    };
    this.craneMast = new Layer(g.box, this.craneMat, 2000);
    const jib = new THREE.BoxGeometry(1, 1, 1);
    jib.translate(0.3, 0, 0);
    this.craneJib = new Layer(jib, this.craneMat, 2000);

    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, emissive: 0xffb860, emissiveIntensity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.roads = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMat);
    this.roads.receiveShadow = true;
    this.roads.frustumCulled = false;

    this.harbour = new Harbour(water, flags, sample, plainInst);
    this.group.add(this.roads, this.chunkGroup, this.growGroup, ...Object.values(this.L).map((l) => l.mesh), this.craneMast.mesh, this.craneJib.mesh, this.harbour.group);
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

  // ---------------------------------------------------------------- plots: merged chunks of buildings, growing plots, trees
  private quadOf(L: LotsMsg, k: number): Quad {
    const p = L.poly, o = k * 8;
    const P = (i: number): Pt => [p[o + i * 2] * CELL, p[o + i * 2 + 1] * CELL];
    return new Quad(P(0), P(1), P(2), P(3));
  }

  private sigOf(L: LotsMsg, k: number): number {
    let h = imul(L.id[k] + 1, 2654435761) ^ imul(L.prof[k] + 5, 7919);
    h ^= imul(L.type[k] * 31 + L.level[k] * 7 + L.dens[k] * 977 + L.sides[k] * 53 + L.back[k] * 13, 40503);
    h ^= imul((L.flags[k] & 23) * 131 + L.planType[k] * 17 + L.planLevel[k] * 19 + L.served[k] * 23 + L.built[k] * 3, 69069);
    for (let i = 0; i < 8; i++) h = imul(h ^ Math.round(L.poly[k * 8 + i] * 200), 16777619);
    return h;
  }

  private ctxFor(L: LotsMsg, k: number, Q: Quad, mb: MB, kind: Kind, level: number, trees: Tree[]): Ctx {
    const cx = L.x[k] * CELL, cz = L.y[k] * CELL;
    const g = this.ground(cx, cz);
    const seed = L.seed[k];
    mb.baseY = g; mb.seed = L.id[k] % 4096;
    const dens = L.dens[k];
    return {
      mb, Q, id: L.id[k], seed, g, kind, level, dens, sides: L.sides[k], back: L.back[k], isCom: L.type[k] === BT.Com, flags: L.flags[k],
      prof: PROFILES[L.prof[k]], pal: PALETTES[PROFILES[L.prof[k]].palette], wave: Math.floor(L.built[k] / 24),
      era: Math.min(1, PROFILES[L.prof[k]].era * 0.3 + (L.built[k] / 96) * 0.8), lv: dens === 2 ? 0.8 : dens === 1 ? 0.5 : 0.3, trees,
      r: (j: number) => vhash(seed >>> 3, j),
    };
  }

  private rebuild(s: StateMsg) {
    const L = s.lots;
    this.stats.lots = L.n;
    const W4 = N * 4;
    const lotOcc = this.occ.slice();
    // per-chunk signatures over static plots
    const sigs = new Map<number, number>();
    const members = new Map<number, number[]>();
    const grows = new Set<number>();
    for (let k = 0; k < L.n; k++) {
      // keep wild trees off every plot
      const Q = this.quadOf(L, k);
      for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
        const p = Q.at(a / 4, b / 4);
        const gx = Math.floor(p[0] / 12.5), gz = Math.floor(p[1] / 12.5);
        if (gx >= 0 && gz >= 0 && gx < W4 && gz < W4) lotOcc[gz * W4 + gx] = 1;
      }
      if (L.constr[k] > 0 || L.demo[k] > 0) { grows.add(k); continue; }
      const key = Math.floor(L.y[k] / CHUNK) * 100 + Math.floor(L.x[k] / CHUNK);
      sigs.set(key, (sigs.get(key) ?? 0) + this.sigOf(L, k));
      let m = members.get(key); if (!m) members.set(key, (m = []));
      m.push(k);
    }
    // rebuild only chunks whose lots changed
    for (const [key, sig] of sigs) {
      const ch = this.chunks.get(key);
      if (ch && ch.sig === sig) continue;
      this.buildChunk(key, sig, members.get(key)!, s);
    }
    for (const [key, ch] of this.chunks) if (!sigs.has(key)) { this.disposeChunk(ch); this.chunks.delete(key); }
    this.rebuildGrows(s, grows);
    // trees: lot trees (cached per chunk), street trees, wild trees
    for (const l of Object.values(this.L)) l.reset();
    for (const ch of this.chunks.values()) for (const t of ch.trees) this.treeAt(t.x, this.ground(t.x, t.z), t.z, t.size, t.h, t.pine, t.seed);
    for (const t of this.streetTrees) this.treeAt(t.x, this.sample(t.x, t.z), t.z, t.s, t.s * 1.15, vhash(t.seed, 7) < 0.12, t.seed);
    this.wildTrees(s, lotOcc);
    for (const l of Object.values(this.L)) l.finish();
    // cranes over plots under construction
    this.craneMast.reset(); this.craneJib.reset();
    this.cranes = [];
    for (const gr of this.grows.values()) if (gr.crane) this.cranes.push(gr.crane);
    for (const c of this.cranes) { this.craneMast.add(c.x, c.y, c.z, 1.6, c.h, 1.6, 0, 0xc9a24a); this.craneJib.add(c.x, c.y + c.h, c.z, 30, 1.4, 1.4, 0, 0xc9a24a); }
    this.craneMast.finish(); this.craneJib.finish();
    this.animate(0, 0);
  }

  private disposeChunk(ch: Chunk) {
    for (const m of ch.meshes) { this.chunkGroup.remove(m); m.geometry.dispose(); }
  }

  private buildChunk(key: number, sig: number, ks: number[], s: StateMsg) {
    const old = this.chunks.get(key);
    if (old) this.disposeChunk(old);
    const L = s.lots;
    const mb = new MB();
    const trees: Tree[] = [];
    for (const k of ks) {
      const Q = this.quadOf(L, k);
      const flags = L.flags[k], planned = (flags & Flag.Planned) !== 0;
      const dens = L.dens[k];
      let kind: Kind = kindOf(L.type[k], L.level[k], flags);
      if (planned) {
        const c = this.ctxFor(L, k, Q, mb, 'none', 0, trees);
        pad(c, SITE, 0.4, 0.3);
        const pk = kindOf(L.planType[k], L.planLevel[k], flags);
        const m = massing({ ...c, kind: pk, level: L.planLevel[k] });
        const gc = (flags & Flag.CarLocked) ? 0xd9785a : L.served[k] ? 0x6fb0e8 : 0xf2c46a;
        mb.prism('ghost', m.poly, c.g, c.g + m.h, gc, gc);
        continue;
      }
      if (kind === 'none') { if (dens >= 1 && L.type[k] === BT.None) kind = 'yard'; else continue; }
      const c = this.ctxFor(L, k, Q, mb, kind, L.level[k], trees);
      designLot(c);
    }
    const meshes: THREE.Mesh[] = [];
    for (const m of MATS) {
      const geo = mb.acc[m].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.polyMats[m]);
      mesh.castShadow = m !== 'ghost' && m !== 'lamp';
      mesh.receiveShadow = m !== 'lamp';
      if (m === 'ghost') mesh.renderOrder = 5;
      this.chunkGroup.add(mesh);
      meshes.push(mesh);
    }
    this.chunks.set(key, { sig, meshes, trees });
    this.stats.chunksBuilt++;
  }

  /** Dev: a row of every tower style (and a few landmark-sized samples) on an empty spot, for screenshots. */
  gallery(cx: number, cz: number, styles: string[], heights = 120) {
    const mb = new MB();
    const trees: Tree[] = [];
    styles.forEach((st, i) => {
      const x = cx + i * 46, g = this.ground(x, cz);
      const Q = new Quad([x - 21, cz], [x + 21, cz], [x + 21, cz + 40], [x - 21, cz + 40]);
      mb.baseY = g; mb.seed = i;
      const seed = 1000 + i * 77;
      const prof = PROFILES[3];
      const c: Ctx = { mb, Q, id: i, seed, g, kind: 'cbd', level: 3, dens: 2, sides: 0, back: 0, isCom: true, flags: 0, era: 0.5, lv: 0.9, trees, r: (j: number) => vhash(seed, j), style: st, prof, pal: PALETTES[prof.palette], wave: 2 };
      designLot(c);
      void heights;
    });
    const out = new THREE.Group();
    for (const m of MATS) {
      const geo = mb.acc[m].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.polyMats[m]);
      mesh.castShadow = m !== 'lamp'; mesh.receiveShadow = true;
      out.add(mesh);
    }
    this.group.add(out);
    return out;
  }

  // ---------------------------------------------------------------- plots under demolition / construction
  private rebuildGrows(s: StateMsg, ids: Set<number>) {
    const L = s.lots;
    const keep = new Set<number>();
    for (const k of ids) {
      const id = L.id[k];
      keep.add(id);
      const mode = L.demo[k] > 0 ? 'demo' : 'build';
      const sig = imul(this.sigOf(L, k) ^ (mode === 'demo' ? 77 : 0), 31) + L.target[k] + L.ntype[k] * 7;
      const old = this.grows.get(id);
      if (old && old.sig === sig) continue;
      if (old) this.disposeGrow(old);
      const gr = this.makeGrow(s, k, mode, sig);
      if (gr) this.grows.set(id, gr); else this.grows.delete(id);
    }
    for (const [id, gr] of this.grows) if (!keep.has(id)) { this.disposeGrow(gr); this.grows.delete(id); }
    this.stats.grows = this.grows.size;
  }

  private disposeGrow(gr: Grow) {
    this.growGroup.remove(gr.group);
    gr.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }

  private makeGrow(s: StateMsg, k: number, mode: 'build' | 'demo', sig: number): Grow | null {
    const L = s.lots;
    const Q = this.quadOf(L, k);
    const flags = L.flags[k];
    const kind = mode === 'demo' ? kindOf(L.type[k], L.level[k], flags) : kindOf(L.type[k], L.target[k], flags);
    const level = mode === 'demo' ? L.level[k] : L.target[k];
    const cx = L.x[k] * CELL, cz = L.y[k] * CELL, g = this.ground(cx, cz);
    const group = new THREE.Group();
    group.position.set(cx, g, cz);
    const bodies: THREE.Object3D[] = [];
    const mbBody = new MB();
    mbBody.ox = cx; mbBody.oy = g; mbBody.oz = cz;
    const trees: Tree[] = [];
    const c = this.ctxFor(L, k, Q, mbBody, kind === 'none' ? 'yard' : kind, level, trees);
    // site / rubble ground, not scaled
    const mbSite = new MB();
    mbSite.ox = cx; mbSite.oy = g; mbSite.oz = cz; mbSite.baseY = g;
    const siteCol = mode === 'demo' ? 0xb4ab9b : SITE;
    mbSite.prism('plain', Q.poly(0.4), g - FOOT, g + 0.28, siteCol, siteCol);
    let crane: Grow['crane'] = null;
    if (mode === 'demo') {
      // rubble heaps
      const r = c.r;
      for (let i = 0; i < 7; i++) {
        const s0 = 0.08 + r(300 + i) * 0.7, t0 = 0.08 + r(320 + i) * 0.7, ds = (4 + r(340 + i) * 6) / Q.W, dt = (3 + r(360 + i) * 5) / Q.D;
        const col = [0x9b9488, 0x8a8278, 0xb0a79a, 0x7d766b][i % 4];
        mbSite.prism('plain', Q.strip(s0, Math.min(0.96, s0 + ds), t0, Math.min(0.96, t0 + dt)), g + 0.2, g + 0.7 + r(380 + i) * 2.2, col, col);
      }
    }
    if (kind !== 'none') designLot(c);
    for (const m of ['wall', 'glass', 'plain', 'lamp'] as Mat[]) {
      const geo = mbBody.acc[m].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.polyMats[m]);
      mesh.castShadow = m !== 'lamp'; mesh.receiveShadow = true;
      group.add(mesh); bodies.push(mesh);
    }
    const sg = mbSite.acc.plain.build();
    if (sg) { const mesh = new THREE.Mesh(sg, this.polyMats.plain); mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh); }
    if (mode === 'build') {
      // scaffold: a wire cage of the finished massing, scaled with the building
      const ms = massing(c);
      const pos: number[] = [];
      const H = Math.min(95, ms.h + 6);
      const P = ms.poly.map((p) => [p[0] - cx, p[1] - cz] as Pt);
      const line = (a: Pt, ay: number, b: Pt, by: number) => pos.push(a[0], ay, a[1], b[0], by, b[1]);
      for (let i = 0; i < 4; i++) {
        const a = P[i], b = P[(i + 1) % 4];
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        line(a, 0, a, H); line(mid, 0, mid, H);
        for (let y = 3.4; y <= H; y += 3.4) line(a, y, b, y);
        for (let y = 0; y + 6.8 <= H; y += 13.6) line(a, y, mid, y + 6.8);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, this.scafMat);
      lines.frustumCulled = false;
      group.add(lines); bodies.push(lines);
      const q = Q.at(0.88, 0.3);
      crane = { x: q[0], y: g - 1, z: q[1], h: Math.min(85, ms.h + 12), k: L.id[k] };
    }
    this.growGroup.add(group);
    return { sig, lot: L.id[k], mode, group, bodies, crane };
  }

  private treeAt(x: number, g: number, z: number, size: number, h: number, pine: boolean, seed: number) {
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

  /** Demolition + rising buildings + cranes. frac = fraction of the current month elapsed. */
  animate(frac: number, time: number) {
    const L = this.lots;
    if (!L) return;
    if (this.grows.size) {
      const idx = new Map<number, number>();
      for (let k = 0; k < L.n; k++) if (L.constr[k] > 0 || L.demo[k] > 0) idx.set(L.id[k], k);
      for (const gr of this.grows.values()) {
        const k = idx.get(gr.lot);
        if (k === undefined) continue;
        let p: number;
        if (gr.mode === 'demo') { const f = Math.min(1, frac * 1.2); p = 1 - 0.9 * f * f * (3 - 2 * f); }
        else {
          const tot = Math.max(1, L.constrTotal[k]);
          const done = Math.max(0, tot - L.constr[k]);
          p = Math.min(1, (done + frac) / tot);
          p = Math.max(0.03, 1 - Math.pow(1 - p, 2));
        }
        for (const b of gr.bodies) b.scale.y = p;
      }
    }
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
