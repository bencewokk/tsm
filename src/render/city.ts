import * as THREE from 'three';
import { N, CELL, Flag, BT } from '../sim/constants';
import type { StateMsg, LotsMsg, RoadsMsg } from '../sim/protocol';
import type { Village } from '../sim/terrain';
import { vhash, VS } from './common';
import { patchBuildingMaterial } from './look';
import { Layer, REC, unitGeos } from './layers';
import { kindOf, SITE, PAL, type Kind } from './forms';
import { Harbour } from './harbour';
import { MB, Quad, type Pt, type Mat } from './poly';
import { PALETTES, type DistrictProfile } from '../sim/profiles';
import type { CityProfile } from '../sim/cityprofile';
import type { InitMsg } from '../sim/protocol';
import { landmarkAt, LANDMARKS } from '../sim/landmarks';
import { designLot, massing, pad, tree as ctxTree, FOOT, type Ctx, type Tree } from './buildings';
import { buildSite, siteSig, type Site } from './sites';

// road widths (m) by class, and the narrow cobbled lanes of the old cores
const ROAD_W = [20, 11.5, 7];
const CORE_W = 6;          // old-town lanes
const CORE_MAIN_W = 9.5;   // the historic main streets of an old core (collectors there)
const ASPHALT = [new THREE.Color(0x676b70), new THREE.Color(0x868a8e), new THREE.Color(0xa4a5a6)];
const COBBLE = new THREE.Color(0xbfae94);
const COBBLE_MAIN = new THREE.Color(0xcdbea5);
const MEDIAN = new THREE.Color(0x93b076);
const KERB = new THREE.Color(0xd9d5cb);

const CHUNK = 16; // cells per chunk side (800 m)
const MATS: Mat[] = ['wall', 'glass', 'plain', 'ghost', 'lamp'];

/** One plot's slice of its chunk's merged geometry (vertex start / count per material), reused while the plot's signature holds. */
interface LotPart { sig: number; start: Int32Array; count: Int32Array; trees: Tree[]; recs: TreeRecs; box: Float64Array }
/** Precomputed tree instances per layer (Layer.rec records), re-added by copying when the tree layers are rebuilt. */
interface TreeRecs { leaf: number[]; pine: number[]; trunk: number[] }
const noRecs = (): TreeRecs => ({ leaf: [], pine: [], trunk: [] });
interface Chunk { sig: number; meshes: THREE.Mesh[]; trees: Tree[]; recs: TreeRecs; parts: Map<number, LotPart>; geos: (THREE.BufferGeometry | null)[] }
/** Static wild-tree candidates (terrain only), in the original generation order: occupancy-grid index, layer (0 leaf, 1 pine), record. */
interface Wild { occ: Int32Array; pine: Uint8Array; rec: Float32Array }
const ATTRS: [string, number][] = [['position', 3], ['normal', 3], ['color', 3], ['aH', 1], ['aSeed', 1]];

/** A plot being demolished or built: its own small meshes, scaled in y as the work progresses. */
interface Grow {
  sig: number;
  lot: number;            // lot id
  mode: 'build' | 'demo';
  group: THREE.Group;
  bodies: THREE.Object3D[]; // scaled in y
  k: number;              // index of the plot in the current lots message
  crane: { x: number; y: number; z: number; h: number; k: number } | null;
}

const imul = Math.imul;

/**
 * BufferGeometry.computeVertexNormals for an indexed mesh, on the typed arrays directly (same arithmetic, same float32 rounding,
 * same results), without a Vector3 round trip per vertex: the road mesh is rebuilt whenever the street graph changes.
 */
export function vertexNormals(g: THREE.BufferGeometry) {
  const P = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array, I = g.index!.array;
  const Nm = new Float32Array(P.length);
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const cbx = P[c] - P[b], cby = P[c + 1] - P[b + 1], cbz = P[c + 2] - P[b + 2];
    const abx = P[a] - P[b], aby = P[a + 1] - P[b + 1], abz = P[a + 2] - P[b + 2];
    const x = cby * abz - cbz * aby, y = cbz * abx - cbx * abz, z = cbx * aby - cby * abx;
    // read all three first, then write (as three does: a repeated vertex gets the face once)
    const ax = Nm[a] + x, ay = Nm[a + 1] + y, az = Nm[a + 2] + z, bx = Nm[b] + x, by = Nm[b + 1] + y, bz = Nm[b + 2] + z, cx = Nm[c] + x, cy = Nm[c + 1] + y, cz = Nm[c + 2] + z;
    Nm[a] = ax; Nm[a + 1] = ay; Nm[a + 2] = az; Nm[b] = bx; Nm[b + 1] = by; Nm[b + 2] = bz; Nm[c] = cx; Nm[c + 1] = cy; Nm[c + 2] = cz;
  }
  for (let i = 0; i < Nm.length; i += 3) {
    const x = Nm[i], y = Nm[i + 1], z = Nm[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    Nm[i] = x * k; Nm[i + 1] = y * k; Nm[i + 2] = z * k;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(Nm, 3));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

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
  railMesh: THREE.Mesh;
  private L: Record<string, Layer>;
  private craneMast: Layer;
  private craneJib: Layer;
  polyMats: Record<Mat, THREE.Material>;
  harbour: Harbour;
  get surfaceMats(): THREE.Material[] {
    return [this.wallMat, this.glassMat, this.plainMat, this.treeMat, this.roadMat, this.craneMat];
  }
  private chunks = new Map<number, Chunk>();
  private chunkGroup = new THREE.Group();
  private grows = new Map<number, Grow>();
  private sites = new Map<number, Site & { pct: number }>();
  private siteGroup = new THREE.Group();
  private growGroup = new THREE.Group();
  private cranes: { x: number; y: number; z: number; h: number; k: number }[] = [];
  private lots: LotsMsg | null = null;
  private roadVersion = -1;
  private occ = new Uint8Array(N * 4 * N * 4); // 12.5 m occupancy grid (roads) for wild tree placement
  private coreEdge = new Set<number>();
  private streetTrees: { x: number; z: number; s: number; seed: number }[] = [];
  private streetRecs: TreeRecs = noRecs();
  stats = { chunksBuilt: 0, lotsDesigned: 0, lotsReused: 0, treeRebuilds: 0, lots: 0, grows: 0 };
  /** plot occupancy (12.5 m grid, roads + plots) that keeps wild trees off built land; rebuilt only when roads or plot shapes change */
  private lotOcc: Uint8Array | null = null;
  private polyHash = 0;
  private roadsDirty = true;
  private lotSig = new Int32Array(0);
  private bb = new THREE.Box3(); private bv = new THREE.Vector3();
  private wild: Wild | null = null;
  private wildFlags: Uint8Array | null = null;
  private jm = new THREE.Matrix4(); private jq = new THREE.Quaternion(); private jv = new THREE.Vector3(); private js = new THREE.Vector3(30, 1.4, 1.4); private up = new THREE.Vector3(0, 1, 0);

  profiles: DistrictProfile[];
  city: CityProfile;
  private rail: [number, number][][];
  private rond: [number, number][];
  private mine: { x: number; y: number } | null;

  constructor(private water: Uint8Array, private flags: Uint8Array, private villages: Village[], private sample: (x: number, z: number) => number, init: InitMsg) {
    this.profiles = init.profiles; this.city = init.city; this.rail = init.rail; this.rond = init.rondpoints; this.mine = init.mine;
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

    this.railMesh = this.buildRail();
    this.harbour = new Harbour(water, flags, sample, plainInst, init.city.terrain === 'coast', init.city.site === 'harbour');
    this.group.add(this.roads, this.railMesh, this.chunkGroup, this.growGroup, this.siteGroup, ...Object.values(this.L).map((l) => l.mesh), this.craneMast.mesh, this.craneJib.mesh, this.harbour.group);
  }

  ground(x: number, z: number) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && this.water[cz * N + cx]) return 0.4;
    return this.sample(x, z);
  }

  /** Railway lines: ballast bed, two rails and sleepers, following the terrain (bridged over water). */
  private buildRail(): THREE.Mesh {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    let base = 0;
    const quad = (a: Pt, b: Pt, c: Pt, d: Pt, ya: number, yb: number, color: number) => {
      const cc = new THREE.Color(color);
      for (const [p, y] of [[a, ya], [b, yb], [c, yb], [d, ya]] as [Pt, number][]) { pos.push(p[0], y, p[1]); col.push(cc.r, cc.g, cc.b); }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    };
    const yAt = (x: number, z: number) => {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      const wet = cx >= 0 && cz >= 0 && cx < N && cz < N && this.water[cz * N + cx];
      return wet ? 6.3 : this.sample(x, z) + 0.5;
    };
    for (const line of this.rail) {
      const pts = line.map(([x, y]) => [x * CELL, y * CELL] as Pt);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
        const steps = Math.max(1, Math.ceil(L / 20));
        for (let j = 0; j < steps; j++) {
          const t0 = j / steps, t1 = (j + 1) / steps;
          const p0: Pt = [ax + (bx - ax) * t0, az + (bz - az) * t0], p1: Pt = [ax + (bx - ax) * t1, az + (bz - az) * t1];
          const y0 = yAt(p0[0], p0[1]), y1 = yAt(p1[0], p1[1]);
          const off = (p: Pt, o: number): Pt => [p[0] + nx * o, p[1] + nz * o];
          quad(off(p0, -4), off(p0, 4), off(p1, 4), off(p1, -4), y0, y1, 0xa9a396);          // ballast
          // a kept corridor: grass verges, a fence line each side (the rail corridor is deliberate open land)
          for (const sgn of [-1, 1]) {
            quad(off(p0, sgn * 4), off(p0, sgn * 11), off(p1, sgn * 11), off(p1, sgn * 4), y0 - 0.1, y1 - 0.1, 0xb4c796);
            quad(off(p0, sgn * 10.4), off(p0, sgn * 11), off(p1, sgn * 11), off(p1, sgn * 10.4), y0 + 0.9, y1 + 0.9, 0x575b5f);
          }
          for (const o of [-1.7, 1.7]) quad(off(p0, o - 0.45), off(p0, o + 0.45), off(p1, o + 0.45), off(p1, o - 0.45), y0 + 0.25, y1 + 0.25, 0x4d5055); // rails
          // sleepers every 3 m
          const n = Math.max(1, Math.round((L / steps) / 3));
          for (let q = 0; q < n; q++) {
            const t = t0 + ((q + 0.5) / n) * (t1 - t0);
            const c: Pt = [ax + (bx - ax) * t, az + (bz - az) * t], y = y0 + (y1 - y0) * ((q + 0.5) / n);
            const a: Pt = [c[0] - ux * 0.4, c[1] - uz * 0.4], b: Pt = [c[0] + ux * 0.4, c[1] + uz * 0.4];
            quad(off(a, -3.1), off(a, 3.1), off(b, 3.1), off(b, -3.1), y + 0.15, y + 0.15, 0x6e6a60);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.receiveShadow = true; m.frustumCulled = false;
    return m;
  }

  /**
   * Apply a state message. The cheap diff runs now; the rebuilds it calls for (roads, plot occupancy, each changed chunk, each new
   * construction site, assembly sites) are queued and `pump` works through them within a time budget per frame. Every step only
   * prepares its meshes; the last step swaps them all into the scene at once and rebuilds trees and cranes, so the month still changes
   * in a single frame, it just no longer stalls one. If a message arrives while the previous one's queue is unfinished (overload),
   * that queue is finished first. `flush` runs everything now (captures, headless tools). Default budget: everything at once.
   */
  update(s: StateMsg, budgetMs = Infinity) {
    if (this.pending) this.flush();
    this.queue = []; this.names = []; this.qi = 0; this.staged = [];
    if (s.roads.version !== this.roadVersion) { const r = s.roads; this.step('roads', () => { this.roadVersion = r.version; this.rebuildRoads(r); }); }
    this.rebuild(s);
    this.pump(budgetMs);
  }

  private queue: (() => void)[] = [];
  private names: string[] = [];
  private qi = 0;
  private step(name: string, f: () => void) { this.queue.push(f); this.names.push(name); }
  /** name of the longest step (perf tools) */
  maxStepName = '';
  /** scene changes prepared by queued steps, applied together by the last step */
  private staged: (() => void)[] = [];
  private treesDirty = false;
  /** longest single step since the last read (ms), for the perf tools */
  maxStep = 0;

  /** Run queued rebuild steps for up to `ms` milliseconds (at least one step). Returns true while work remains. */
  pump(ms = 6): boolean {
    const t0 = performance.now();
    while (this.qi < this.queue.length) {
      const t = performance.now(), i = this.qi++;
      this.queue[i]();
      const now = performance.now();
      if (now - t > this.maxStep) { this.maxStep = now - t; this.maxStepName = this.names[i]; }
      if (now - t0 >= ms) break;
    }
    return this.qi < this.queue.length;
  }

  flush() { this.pump(Infinity); }
  get pending() { return this.queue.length - this.qi; }

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
      const main = isCore && r.cls[k] === 1;
      const w = isCore ? (main ? CORE_MAIN_W : CORE_W) : ROAD_W[r.cls[k]], c = isCore ? (main ? COBBLE_MAIN : COBBLE) : ASPHALT[r.cls[k]];
      widths.push(w); colors.push(c);
      for (const n of [a, b]) if (w > maxW[n]) { maxW[n] = w; nodeCol[n] = c; }
    }
    // roundabouts of planned boulevards: a wide asphalt ring with a green island
    const rondNodes: number[] = [];
    for (const [rx, ry] of this.rond) {
      let bn = -1, bd = 0.2;
      for (let n = 0; n < nNodes; n++) { const d = Math.hypot(r.nodes[n * 2] - rx, r.nodes[n * 2 + 1] - ry); if (d < bd) { bd = d; bn = n; } }
      if (bn >= 0) { rondNodes.push(bn); maxW[bn] = Math.max(maxW[bn], 34); if (!nodeCol[bn]) nodeCol[bn] = ASPHALT[0]; }
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
    // street trees: one row on each side of every ordinary street (plus a median row on arterials), none in the cobbled cores or on the docks
    this.streetTrees = [];
    const degs = new Uint8Array(nNodes);
    for (let k = 0; k < r.ea.length; k++) { degs[r.ea[k]]++; degs[r.eb[k]]++; }
    const deg0 = (n: number) => degs[n];
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
        if (r.cls[k] === 0 && deg0(a) <= 2 && deg0(b) <= 2 && vhash(r.ids[k] * 31 + j, 8) > 0.2) {
          const x = ax + ux * t, z = az + uz * t, cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
          if (cx >= 0 && cz >= 0 && cx < N && cz < N && !this.water[cz * N + cx] && !(this.flags[cz * N + cx] & Flag.Docks)) this.streetTrees.push({ x, z, s: 5.5 + vhash(r.ids[k] * 31 + j, 9) * 2, seed: r.ids[k] * 31 + j });
        }
      }
    }
    this.streetRecs = noRecs();
    for (const t of this.streetTrees) this.treeRec(this.streetRecs, t.x, this.sample(t.x, t.z), t.z, t.s, t.s * 1.15, vhash(t.seed, 7) < 0.12, t.seed);
    // kerb / pavement strip first, then the carriageway on top
    for (let k = 0; k < r.ea.length; k++) strip(k, widths[k] + 5, KERB, 0);
    for (let n = 0; n < nNodes; n++) if (maxW[n]) disc(n, maxW[n] / 2 + 2.5, KERB, 0.02);
    for (let k = 0; k < r.ea.length; k++) strip(k, widths[k], colors[k], 0.25);
    // arterials: a planted median on the open stretches (both ends plain bends or straights, not junctions)
    const deg = new Uint8Array(nNodes);
    for (let k = 0; k < r.ea.length; k++) { deg[r.ea[k]]++; deg[r.eb[k]]++; }
    for (let k = 0; k < r.ea.length; k++) if (r.cls[k] === 0 && !this.coreEdge.has(r.ids[k]) && deg[r.ea[k]] <= 2 && deg[r.eb[k]] <= 2) strip(k, 2.6, MEDIAN, 0.33);
    for (let n = 0; n < nNodes; n++) if (maxW[n]) disc(n, maxW[n] / 2, nodeCol[n], 0.27);
    for (const n of rondNodes) { disc(n, 8.5, KERB, 0.3); disc(n, 6.8, new THREE.Color(0x9fbf86), 0.34); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    vertexNormals(g);
    this.staged.push(() => { this.roads.geometry.dispose(); this.roads.geometry = g; });
    this.roadsDirty = true;
  }

  // ---------------------------------------------------------------- plots: merged chunks of buildings, growing plots, trees
  quadOf(L: LotsMsg, k: number): Quad {
    const p = L.poly, o = k * 8;
    const P = (i: number): Pt => [p[o + i * 2] * CELL, p[o + i * 2 + 1] * CELL];
    return new Quad(P(0), P(1), P(2), P(3));
  }

  private sigOf(L: LotsMsg, k: number): number {
    let h = imul(L.id[k] + 1, 2654435761) ^ imul(L.prof[k] + 5, 7919) ^ imul(L.lm[k] + 3, 104729);
    h ^= imul(L.asm[k] * 6151 + L.astate[k] * 389 + L.hgt[k] * 3571 + L.type[k] * 31 + L.level[k] * 7 + L.dens[k] * 977 + L.sides[k] * 53 + L.back[k] * 13, 40503);
    h ^= imul(L.deco[k] * 7727 + (L.flags[k] & 23) * 131 + L.planType[k] * 17 + L.planLevel[k] * 19 + L.served[k] * 23 + L.built[k] * 3, 69069);
    for (let i = 0; i < 8; i++) h = imul(h ^ Math.round(L.poly[k * 8 + i] * 200), 16777619);
    return h;
  }

  ctxFor(L: LotsMsg, k: number, Q: Quad, mb: MB, kind: Kind, level: number, trees: Tree[], hgt = L.hgt[k]): Ctx {
    const cx = L.x[k] * CELL, cz = L.y[k] * CELL;
    const g = this.ground(cx, cz);
    const seed = L.seed[k];
    mb.baseY = g; mb.seed = L.id[k] % 4096;
    const dens = L.dens[k];
    return {
      mb, Q, id: L.id[k], seed, g, kind, level, dens, hgt, sides: L.sides[k], back: L.back[k], isCom: L.type[k] === BT.Com, flags: L.flags[k], deco: L.deco[k],
      prof: this.profiles[L.prof[k]], pal: PALETTES[this.profiles[L.prof[k]].palette], wave: Math.floor(L.built[k] / 24), site: this.city.site, mine: this.mine ? [this.mine.x * CELL, this.mine.y * CELL] : null, lmForm: landmarkAt(L.lm[k])?.form,
      era: Math.min(1, this.profiles[L.prof[k]].era * 0.3 + (L.built[k] / 96) * 0.8), lv: dens === 2 ? 0.8 : dens === 1 ? 0.5 : 0.3, trees,
      r: (j: number) => vhash(seed >>> 3, j),
    };
  }

  private rebuild(s: StateMsg) {
    const L = s.lots;
    this.stats.lots = L.n;
    // plot shapes: when none changed (and the roads did not), the occupancy grid for wild trees is still valid
    let ph = L.n;
    for (let i = 0; i < L.n * 8; i++) ph = imul(ph ^ Math.round(L.poly[i] * 64), 16777619);
    // the road step (queued first, if any) sets roadsDirty; the occupancy step runs after it
    if (this.queue.length || this.roadsDirty || ph !== this.polyHash || !this.lotOcc)
      this.step('occupancy', () => { this.lotOcc = this.stampLots(L); this.polyHash = ph; this.roadsDirty = false; this.treesDirty = true; });
    // per-chunk signatures over static plots
    const sigs = new Map<number, number>();
    const members = new Map<number, number[]>();
    const grows = new Set<number>();
    if (this.lotSig.length < L.n) this.lotSig = new Int32Array(L.n * 2);
    for (let k = 0; k < L.n; k++) {
      if (L.asm[k] > 0 && L.constr[k] > 0) continue;        // assembly sites draw their own structure
      if (L.constr[k] > 0 || L.demo[k] > 0) { grows.add(k); continue; }
      const key = Math.floor(L.y[k] / CHUNK) * 100 + Math.floor(L.x[k] / CHUNK);
      const sg = this.sigOf(L, k);
      this.lotSig[k] = sg;
      sigs.set(key, (sigs.get(key) ?? 0) + sg);
      let m = members.get(key); if (!m) members.set(key, (m = []));
      m.push(k);
    }
    // rebuild only chunks whose lots changed (and inside them only the plots that changed): one step per chunk
    for (const [key, sig] of sigs) {
      const ch = this.chunks.get(key);
      if (ch && ch.sig === sig) continue;
      const ks = members.get(key)!;
      this.step('chunk', () => { this.buildChunk(key, sig, ks, s); this.treesDirty = true; });
    }
    for (const [key, ch] of this.chunks) if (!sigs.has(key)) this.staged.push(() => { this.disposeChunk(ch); this.chunks.delete(key); this.treesDirty = true; });
    this.rebuildGrows(s, grows);
    this.planSites(s);
    this.step('commit', () => {
      // swap everything prepared above into the scene in this one step
      this.lots = L;
      for (const f of this.staged) f();
      this.staged = [];
      if (this.treesDirty) { this.treesDirty = false; this.rebuildTrees(s); }
      // cranes over plots under construction
      this.craneMast.reset(); this.craneJib.reset();
      this.cranes = [];
      for (const gr of this.grows.values()) if (gr.crane) this.cranes.push(gr.crane);
      for (const st of this.sites.values()) for (const c of st.cranes) this.cranes.push(c);
      for (const c of this.cranes) { this.craneMast.add(c.x, c.y, c.z, 1.6, c.h, 1.6, 0, 0xc9a24a); this.craneJib.add(c.x, c.y + c.h, c.z, 30, 1.4, 1.4, 0, 0xc9a24a); }
      this.craneMast.finish(); this.craneJib.finish();
      this.animate(0, 0);
    });
  }

  /** Road occupancy plus every plot (5 x 5 sample points per plot) on the 12.5 m grid. */
  private stampLots(L: LotsMsg): Uint8Array {
    const W4 = N * 4;
    const lotOcc = this.occ.slice();
    for (let k = 0; k < L.n; k++) {
      const Q = this.quadOf(L, k);
      for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
        const p = Q.at(a / 4, b / 4);
        const gx = Math.floor(p[0] / 12.5), gz = Math.floor(p[1] / 12.5);
        if (gx >= 0 && gz >= 0 && gx < W4 && gz < W4) lotOcc[gz * W4 + gx] = 1;
      }
    }
    return lotOcc;
  }

  /** Trees: lot trees (cached per chunk), site trees, street trees, wild trees; only when one of them changed. */
  private rebuildTrees(s: StateMsg) {
    this.stats.treeRebuilds++;
    for (const l of Object.values(this.L)) l.reset();
    const addRecs = (r: TreeRecs) => { this.L.leaf.addRecs(r.leaf); this.L.pine.addRecs(r.pine); this.L.trunk.addRecs(r.trunk); };
    for (const ch of this.chunks.values()) addRecs(ch.recs);
    for (const st of this.sites.values()) for (const t of st.trees) this.treeAt(t.x, this.ground(t.x, t.z), t.z, t.size, t.h, t.pine, t.seed);
    addRecs(this.streetRecs);
    this.wildTrees(s, this.lotOcc!);
    for (const l of Object.values(this.L)) l.finish();
  }

  private disposeChunk(ch: Chunk) {
    for (const m of ch.meshes) { this.chunkGroup.remove(m); m.geometry.dispose(); }
  }

  /**
   * A chunk is one merged mesh per material. Plots whose signature did not change copy their vertices out of the old merged
   * arrays; only changed plots run the (slow) building designer. The result is the same arrays, in the same plot order.
   */
  private buildChunk(key: number, sig: number, ks: number[], s: StateMsg) {
    const old = this.chunks.get(key);
    const L = s.lots;
    type Entry = { id: number; sig: number; from: LotPart | null; mb: MB | null; trees: Tree[]; recs: TreeRecs; box: Float64Array };
    const entries: Entry[] = [];
    for (const k of ks) {
      const id = L.id[k], sg = this.lotSig[k];
      const op = old?.parts.get(id);
      if (op && op.sig === sg) { entries.push({ id, sig: sg, from: op, mb: null, trees: op.trees, recs: op.recs, box: op.box }); this.stats.lotsReused++; continue; }
      const mb = new MB(), trees: Tree[] = [], recs = noRecs();
      this.designInto(L, k, mb, trees);
      for (const t of trees) this.treeRec(recs, t.x, this.ground(t.x, t.z), t.z, t.size, t.h, t.pine, t.seed);
      // the plot's bounds per material (min xyz, max xyz): chunk bounding spheres come from these, not from a pass over every vertex
      const box = new Float64Array(MATS.length * 6);
      MATS.forEach((m, mi) => {
        const P = mb.acc[m].pos, o = mi * 6;
        box[o] = box[o + 1] = box[o + 2] = Infinity; box[o + 3] = box[o + 4] = box[o + 5] = -Infinity;
        for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < box[o + a]) box[o + a] = v; if (v > box[o + 3 + a]) box[o + 3 + a] = v; }
      });
      entries.push({ id, sig: sg, from: null, mb, trees, recs, box });
      this.stats.lotsDesigned++;
    }
    const parts = new Map<number, LotPart>();
    for (const e of entries) parts.set(e.id, { sig: e.sig, start: new Int32Array(MATS.length), count: new Int32Array(MATS.length), trees: e.trees, recs: e.recs, box: e.box });
    const geos: (THREE.BufferGeometry | null)[] = [];
    const meshes: THREE.Mesh[] = [];
    MATS.forEach((m, mi) => {
      let total = 0;
      for (const e of entries) total += e.from ? e.from.count[mi] : e.mb!.acc[m].pos.length / 3;
      if (!total) { geos.push(null); return; }
      const arrs = ATTRS.map(([, n]) => new Float32Array(total * n));
      const oldGeo = old?.geos[mi] ?? null;
      const src = oldGeo ? ATTRS.map(([name]) => (oldGeo.getAttribute(name) as THREE.BufferAttribute).array as Float32Array) : null;
      let off = 0;
      // reused plots are mostly consecutive in the old arrays too: copy them in runs
      let runSrc = -1, runDst = 0, runN = 0;
      const flush = () => { if (runN) for (let a = 0; a < ATTRS.length; a++) { const w = ATTRS[a][1]; arrs[a].set(src![a].subarray(runSrc * w, (runSrc + runN) * w), runDst * w); } runN = 0; };
      for (const e of entries) {
        const part = parts.get(e.id)!;
        if (e.from) {
          const st = e.from.start[mi], n = e.from.count[mi];
          if (n) { if (runN && runSrc + runN === st) runN += n; else { flush(); runSrc = st; runDst = off; runN = n; } }
          part.start[mi] = off; part.count[mi] = n; off += n;
        } else {
          flush();
          const A = e.mb!.acc[m], n = A.pos.length / 3;
          if (n) { arrs[0].set(A.pos, off * 3); arrs[1].set(A.nrm, off * 3); arrs[2].set(A.col, off * 3); arrs[3].set(A.aH, off); arrs[4].set(A.seed, off); }
          part.start[mi] = off; part.count[mi] = n; off += n;
        }
      }
      flush();
      const geo = new THREE.BufferGeometry();
      ATTRS.forEach(([name, w], a) => geo.setAttribute(name, new THREE.BufferAttribute(arrs[a], w)));
      // bounding sphere from the union of the plots' boxes (encloses the same vertices; used only for frustum culling)
      const o = mi * 6, bb = this.bb.makeEmpty();
      for (const e of entries) if (e.box[o] <= e.box[o + 3]) { this.bv.set(e.box[o], e.box[o + 1], e.box[o + 2]); bb.expandByPoint(this.bv); this.bv.set(e.box[o + 3], e.box[o + 4], e.box[o + 5]); bb.expandByPoint(this.bv); }
      geo.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
      geos.push(geo);
      const mesh = new THREE.Mesh(geo, this.polyMats[m]);
      mesh.castShadow = m !== 'ghost' && m !== 'lamp';
      mesh.receiveShadow = m !== 'lamp';
      if (m === 'ghost') mesh.renderOrder = 5;
      meshes.push(mesh);
    });
    const swap = () => { if (old) this.disposeChunk(old); for (const mesh of meshes) this.chunkGroup.add(mesh); };
    const trees: Tree[] = [], recs = noRecs();
    for (const e of entries) {
      for (const t of e.trees) trees.push(t);
      for (const x of e.recs.leaf) recs.leaf.push(x);
      for (const x of e.recs.pine) recs.pine.push(x);
      for (const x of e.recs.trunk) recs.trunk.push(x);
    }
    this.staged.push(() => { swap(); this.chunks.set(key, { sig, meshes, trees, recs, parts, geos }); });
    this.stats.chunksBuilt++;
  }

  /** Run the building designer for one plot into `mb` (its own trees into `trees`). */
  private designInto(L: LotsMsg, k: number, mb: MB, trees: Tree[]) {
    {
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
        return;
      }
      if (kind === 'none') { if (dens >= 1 && L.type[k] === BT.None && !L.asm[k]) kind = 'yard'; else return; }
      const c = this.ctxFor(L, k, Q, mb, kind, L.level[k], trees);
      designLot(c);
    }
  }

  /** Dev: a row of every tower style (and a few landmark-sized samples) on an empty spot, for screenshots. */
  gallery(cx: number, cz: number, styles: string[], heights = 0) {
    const mb = new MB();
    const trees: Tree[] = [];
    styles.forEach((st, i) => {
      const x = cx + i * 46, g = this.ground(x, cz);
      const Q = new Quad([x - 21, cz], [x + 21, cz], [x + 21, cz + 40], [x - 21, cz + 40]);
      mb.baseY = g; mb.seed = i;
      const seed = 1000 + i * 77;
      const prof = this.profiles[3];
      const c: Ctx = { mb, Q, id: i, seed, g, kind: 'cbd', level: 3, dens: 2, sides: 0, back: 0, isCom: true, flags: 0, era: 0.5, lv: 0.9, trees, r: (j: number) => vhash(seed, j), style: st, prof, pal: PALETTES[prof.palette], wave: 2, site: this.city.site, mine: null, hgt: heights };
      designLot(c);
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

  /** Dev: every landmark form in a row (plots sized as in the catalogue), for screenshots. */
  galleryLandmarks(cx: number, cz: number, ids: string[]) {
    const mb = new MB();
    const trees: Tree[] = [];
    let x = cx;
    ids.forEach((id, i) => {
      const def = LANDMARKS.find((l) => l.id === id)!;
      const w = def.size[0] * CELL, d = def.size[1] * CELL;
      const px = x + w / 2, g = this.ground(px, cz);
      const Q = new Quad([px - w / 2, cz], [px + w / 2, cz], [px + w / 2, cz + d], [px - w / 2, cz + d]);
      mb.baseY = g; mb.seed = i;
      const seed = 5000 + i * 91;
      const prof = this.profiles[2];
      const c: Ctx = { mb, Q, id: i, seed, g, kind: 'landmark', level: 1, dens: 2, sides: 0, back: 0, isCom: false, flags: 0, era: 0.5, lv: 0.9, trees, r: (j: number) => vhash(seed, j), prof, pal: PALETTES[prof.palette], wave: 1, site: this.city.site, mine: null, lmForm: def.form, hgt: 0 };
      designLot(c);
      x += w + 30;
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
    for (const t of trees) this.treeAt(t.x, this.ground(t.x, t.z), t.z, t.size, t.h, t.pine, t.seed);
    for (const l of Object.values(this.L)) l.finish();
    return { group: out, width: x - cx };
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
      if (old && old.sig === sig) { this.staged.push(() => { old.k = k; }); continue; }
      this.step('grow', () => {
        const gr = this.makeGrow(s, k, mode, sig);
        this.staged.push(() => {
          if (old) this.disposeGrow(old);
          if (gr) { this.growGroup.add(gr.group); this.grows.set(id, gr); } else this.grows.delete(id);
        });
      });
    }
    for (const [id, gr] of this.grows) if (!keep.has(id)) this.staged.push(() => { this.disposeGrow(gr); this.grows.delete(id); });
    this.staged.push(() => { this.stats.grows = this.grows.size; });
  }

  /** Assembly sites: one queued step per site that changed (built off-scene, swapped in by the commit step). */
  private planSites(s: StateMsg) {
    const L = s.lots;
    const idx = new Map<number, number>();
    for (let k = 0; k < L.n; k++) if (L.asm[k] > 0 || s.assemblies.length) idx.set(L.id[k], k);
    const keep = new Set<number>();
    for (const a of s.assemblies) {
      keep.add(a.id);
      const sig = siteSig(a, L, idx);
      const old = this.sites.get(a.id);
      if (old && old.sig === sig) { old.pct = a.pct; continue; }
      this.step('site', () => {
        const st = buildSite(this, a, s, idx) as Site & { pct: number };
        st.sig = sig; st.pct = a.pct;
        this.staged.push(() => { if (old) this.disposeSite(old); this.siteGroup.add(st.group); this.sites.set(a.id, st); this.treesDirty = true; });
      });
    }
    for (const [id, st] of this.sites) if (!keep.has(id)) this.staged.push(() => { this.disposeSite(st); this.sites.delete(id); this.treesDirty = true; });
  }

  private disposeSite(st: Site) {
    this.siteGroup.remove(st.group);
    st.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
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
    const c = this.ctxFor(L, k, Q, mbBody, kind === 'none' ? 'yard' : kind, level, trees, mode === 'build' ? L.nhgt[k] : L.hgt[k]);
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
    return { sig, lot: L.id[k], mode, group, bodies, crane, k };
  }

  /** The instances `treeAt` would add, as records (same layers, same order). */
  private treeRec(out: TreeRecs, x: number, g: number, z: number, size: number, h: number, pine: boolean, seed: number) {
    const c = pine ? PAL.pine[Math.floor(vhash(seed, 1) * PAL.pine.length)] : PAL.leaf[Math.floor(vhash(seed, 1) * PAL.leaf.length)];
    if (pine) { Layer.rec(out.pine, x, g + 1, z, size, h, size, 0, c); Layer.rec(out.trunk, x, g - 0.5, z, 1, 2, 1, 0, PAL.trunk); }
    else { Layer.rec(out.trunk, x, g - 0.5, z, 1.1, 3.5, 1.1, 0, PAL.trunk); Layer.rec(out.leaf, x, g + 2.4, z, size, h, size, vhash(seed, 2) * 6, c); }
  }

  private treeAt(x: number, g: number, z: number, size: number, h: number, pine: boolean, seed: number) {
    const c = pine ? PAL.pine[Math.floor(vhash(seed, 1) * PAL.pine.length)] : PAL.leaf[Math.floor(vhash(seed, 1) * PAL.leaf.length)];
    if (pine) { this.L.pine.add(x, g + 1, z, size, h, size, 0, c); this.L.trunk.add(x, g - 0.5, z, 1, 2, 1, 0, PAL.trunk); }
    else { this.L.trunk.add(x, g - 0.5, z, 1.1, 3.5, 1.1, 0, PAL.trunk); this.L.leaf.add(x, g + 2.4, z, size, h, size, vhash(seed, 2) * 6, c); }
  }

  /** Trees on open land, denser woodland on slopes too steep to build (candidates depend on the terrain only: computed once). */
  private wildTrees(s: StateMsg, occ: Uint8Array) {
    if (!this.wild || !this.wildFlags || !sameBytes(this.wildFlags, s.flags)) { this.wild = this.wildCandidates(s.flags); this.wildFlags = s.flags.slice(); }
    const leaf = this.L.leaf, pine = this.L.pine, w = this.wild;
    for (let k = 0; k < w.occ.length; k++) if (!occ[w.occ[k]]) (w.pine[k] ? pine : leaf).addRecs(w.rec, k * REC, 1);
  }

  private wildCandidates(flags: Uint8Array): Wild {
    const W = N * 4, occs: number[] = [], pines: number[] = [], rec: number[] = [];
    for (let i = 0; i < N * N; i++) {
      if (this.water[i]) continue;
      if (this.flags[i] & Flag.Docks) continue;
      const flood = (flags[i] & Flag.Flood) !== 0;
      const cx = (i % N) * CELL, cz = ((i / N) | 0) * CELL;
      // slope (m per m) from the terrain surface: woods on the flanks, thin willows on wetland, bare above the tree line
      const mx = cx + CELL / 2, mz = cz + CELL / 2;
      const gl = (this.sample(mx + CELL, mz) - this.sample(mx - CELL, mz)) / (2 * CELL * VS), gm = (this.sample(mx, mz + CELL) - this.sample(mx, mz - CELL)) / (2 * CELL * VS);
      const slope = Math.hypot(gl, gm), hm = this.sample(mx, mz) / VS;
      const tree = hm > 125 ? 0 : hm > 95 ? 0.3 : 1;
      const steep = ((flags[i] & Flag.Steep) !== 0 || slope > 0.1) && hm > 4;
      const r0 = vhash(i, 77);
      const want = flood ? (r0 < 0.12 ? 1 : 0) : tree * (steep ? 1 : 0.4 + (slope > 0.06 ? 0.4 : 0)) > 0 && r0 < (steep ? 0.85 : slope > 0.06 ? 0.45 : 0.16) * tree ? (steep ? 3 : 1) + Math.floor(vhash(i, 78) * 3) : 0;
      for (let k = 0; k < want; k++) {
        const x = cx + vhash(i, 90 + k) * CELL, z = cz + vhash(i, 100 + k) * CELL;
        const gx = Math.floor(x / 12.5), gz = Math.floor(z / 12.5);
        const sc = 6 + vhash(i, 80 + k) * 5;
        const pine = vhash(i, 110 + k) < (steep ? 0.55 : 0.2);
        const c = pine ? PAL.pine[Math.floor(vhash(i, 120 + k) * 3)] : PAL.leaf[Math.floor(vhash(i, 120 + k) * 5)];
        const y = this.sample(x, z);
        occs.push(gz * W + gx); pines.push(pine ? 1 : 0);
        if (pine) Layer.rec(rec, x, y - 0.5, z, sc * 0.8, sc * 2, sc * 0.8, 0, c);
        else Layer.rec(rec, x, y - 0.5, z, sc, sc * 1.1, sc, vhash(i, 130 + k) * 6, c);
      }
    }
    return { occ: Int32Array.from(occs), pine: Uint8Array.from(pines), rec: Float32Array.from(rec) };
  }

  /** Demolition + rising buildings + cranes. frac = fraction of the current month elapsed. */
  animate(frac: number, time: number) {
    const L = this.lots;
    if (!L) return;
    if (this.grows.size) {
      for (const gr of this.grows.values()) {
        const k = gr.k;
        if (k >= L.n || L.id[k] !== gr.lot) continue;
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
    for (const st of this.sites.values()) for (const o of st.skin) o.scale.y = Math.max(0.03, st.pct);
    if (!this.cranes.length) return;
    const m = this.jm, q = this.jq, v = this.jv;
    for (let k = 0; k < this.cranes.length; k++) {
      const c = this.cranes[k];
      v.set(c.x, c.y + c.h, c.z);
      q.setFromAxisAngle(this.up, time * 0.25 + c.k);
      m.compose(v, q, this.js);
      this.craneJib.mesh.setMatrixAt(k, m);
    }
    this.craneJib.touch();
  }
}
