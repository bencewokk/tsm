import * as THREE from 'three';
import { N, CELL, BT, Flag } from '../sim/constants';
import type { StateMsg, LotsMsg, RoadsMsg } from '../sim/protocol';
import { vhash } from './common';
import { patchBuildingMaterial } from './look';

/** A box in a lot's local frame: u along the street, v across it (metres). */
export interface Box { u: number; v: number; w: number; d: number; h: number; color: number }

const COL = { res: 0xf6f0e2, res2: 0xf1e9d8, com: 0xfbfaf6, com2: 0xeef0f0, ind: 0xd9d1c3, ind2: 0xcfc6b6, park: 0xc5d6b0 };

/** Building massing for (type, level) on a lot. Purely visual; seeded by lot id. */
export function buildingForm(id: number, type: number, level: number): Box[] {
  const r = (k: number) => vhash(id, k);
  const out: Box[] = [];
  if (type === BT.Res) {
    if (level === 1) {
      if (r(1) < 0.5) {
        out.push({ u: -9 + r(2) * 2, v: (r(3) - 0.5) * 6, w: 12 + r(4) * 3, d: 10 + r(5) * 3, h: 6 + r(6) * 3, color: COL.res });
        out.push({ u: 9 - r(7) * 2, v: (r(8) - 0.5) * 6, w: 11 + r(9) * 3, d: 10 + r(10) * 3, h: 6 + r(11) * 3, color: COL.res2 });
      } else out.push({ u: (r(2) - 0.5) * 8, v: (r(3) - 0.5) * 6, w: 15 + r(4) * 5, d: 12 + r(5) * 3, h: 7 + r(6) * 3, color: r(7) < 0.5 ? COL.res : COL.res2 });
    } else if (level === 2) {
      out.push({ u: 0, v: -4, w: 32, d: 15, h: 14 + r(2) * 10, color: COL.res });
      if (r(3) < 0.6) out.push({ u: (r(4) - 0.5) * 12, v: 9, w: 14, d: 12, h: 10 + r(5) * 6, color: COL.res2 });
    } else if (level === 3) {
      out.push({ u: 0, v: 0, w: 35, d: 31, h: 8, color: COL.res2 });
      out.push({ u: (r(4) - 0.5) * 6, v: (r(5) - 0.5) * 5, w: 18 + r(6) * 4, d: 18 + r(7) * 4, h: 55 + r(2) * 45, color: COL.res });
    }
  } else if (type === BT.Com) {
    if (level === 1) out.push({ u: 0, v: -4, w: 28 + r(1) * 6, d: 20 + r(2) * 5, h: 7 + r(3) * 3, color: COL.com });
    else if (level === 2) out.push({ u: 0, v: 0, w: 33, d: 29, h: 22 + r(2) * 16, color: COL.com });
    else if (level === 3) {
      out.push({ u: 0, v: 0, w: 37, d: 33, h: 12, color: COL.com2 });
      out.push({ u: 0, v: 0, w: 23 + r(3) * 4, d: 23 + r(4) * 4, h: 100 + r(2) * 60, color: COL.com });
    }
  } else if (type === BT.Ind) {
    out.push({ u: 0, v: 0, w: 35, d: 28 + r(1) * 4, h: level >= 2 ? 13 : 9, color: r(2) < 0.5 ? COL.ind : COL.ind2 });
    if (level >= 2 && r(3) < 0.6) out.push({ u: 13, v: 10, w: 4, d: 4, h: 34, color: COL.ind2 });
  } else if (type === BT.Park) {
    out.push({ u: 0, v: 0, w: 37, d: 33, h: 0.8, color: COL.park });
  }
  return out;
}

function boxGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

const ROAD_W = [17, 12, 9]; // metres by class
const ROAD_COL = [new THREE.Color(0xe9e5dc), new THREE.Color(0xf0ede6), new THREE.Color(0xf5f3ee)];

interface Anim { start: number; count: number; lot: number }

export class CityView {
  group = new THREE.Group();
  buildings: THREE.InstancedMesh;
  ghosts: THREE.InstancedMesh;
  roads: THREE.Mesh;
  trees: THREE.InstancedMesh;
  craneMast: THREE.InstancedMesh;
  craneJib: THREE.InstancedMesh;
  buildingMat: THREE.MeshStandardMaterial;
  roadMat: THREE.MeshStandardMaterial;
  get surfaceMats(): THREE.Material[] {
    return [this.buildingMat, this.roadMat, this.trees.material as THREE.Material, this.craneMast.material as THREE.Material];
  }
  /** per instance: x, base, z, w, h, d, rot */
  private inst = new Float32Array(0);
  private anims: Anim[] = [];
  private cranes: { x: number; y: number; z: number; h: number; k: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private col = new THREE.Color();
  private lots: LotsMsg | null = null;
  private roadVersion = -1;
  private treeSig = '';
  private occ = new Uint8Array(N * 4 * N * 4); // 12.5 m occupancy grid (roads + plots) for tree placement

  constructor(private water: Uint8Array, private sample: (x: number, z: number) => number) {
    const cap = 60000;
    this.buildingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, emissive: 0x000000 });
    patchBuildingMaterial(this.buildingMat);
    this.buildings = new THREE.InstancedMesh(boxGeo(), this.buildingMat, cap);
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    this.buildings.count = 0;
    this.buildings.frustumCulled = false;
    this.inst = new Float32Array(cap * 7);

    const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x404040, emissiveIntensity: 0.4 });
    this.ghosts = new THREE.InstancedMesh(boxGeo(), ghostMat, 4000);
    this.ghosts.count = 0;
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 5;

    this.roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, emissive: 0xffb860, emissiveIntensity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.roads = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMat);
    this.roads.receiveShadow = true;
    this.roads.frustumCulled = false;

    const treeMat = new THREE.MeshStandardMaterial({ color: 0xb4c79c, roughness: 1, flatShading: true });
    this.trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), treeMat, 30000);
    this.trees.castShadow = true;
    this.trees.receiveShadow = true;
    this.trees.count = 0;
    this.trees.frustumCulled = false;

    const craneMat = new THREE.MeshStandardMaterial({ color: 0xd0643f, roughness: 0.8 });
    this.craneMast = new THREE.InstancedMesh(boxGeo(), craneMat, 2000);
    const jibGeo = new THREE.BoxGeometry(1, 1, 1);
    jibGeo.translate(0.3, 0, 0);
    this.craneJib = new THREE.InstancedMesh(jibGeo, craneMat, 2000);
    for (const c of [this.craneMast, this.craneJib]) { c.count = 0; c.castShadow = true; c.frustumCulled = false; }
    this.group.add(this.roads, this.trees, this.buildings, this.ghosts, this.craneMast, this.craneJib);
  }

  private ground(x: number, z: number) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    if (cx >= 0 && cz >= 0 && cx < N && cz < N && this.water[cz * N + cx]) return 0.4;
    return this.sample(x, z);
  }

  update(s: StateMsg) {
    this.lots = s.lots;
    if (s.roads.version !== this.roadVersion) { this.roadVersion = s.roads.version; this.rebuildRoads(s.roads); }
    this.rebuildBuildings(s);
    const sig = `${s.roads.version}|${s.lots.n}|${s.stats.buildings}`;
    if (sig !== this.treeSig) { this.treeSig = sig; this.rebuildTrees(s); }
  }

  // ---------------------------------------------------------------- roads: one merged, terrain-following mesh
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
      return wet ? 6 : this.sample(x, z) + 0.7;
    };
    const maxW = new Float32Array(r.nodes.length / 2);
    for (let k = 0; k < r.ea.length; k++) {
      const a = r.ea[k], b = r.eb[k], w = ROAD_W[r.cls[k]], c = ROAD_COL[r.cls[k]];
      maxW[a] = Math.max(maxW[a], w); maxW[b] = Math.max(maxW[b], w);
      const ax = r.nodes[a * 2] * CELL, az = r.nodes[a * 2 + 1] * CELL, bx = r.nodes[b * 2] * CELL, bz = r.nodes[b * 2 + 1] * CELL;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const nx = (-(bz - az) / L) * w / 2, nz = ((bx - ax) / L) * w / 2;
      const steps = Math.max(1, Math.ceil(L / 25));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const y = yAt(x, z);
        pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        if (j > 0) { const o = base + (j - 1) * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
        stampOcc(x, z, w / 2 + 4);
      }
      base += (steps + 1) * 2;
    }
    // junction discs so corners read cleanly at any angle
    const SEG = 10;
    for (let n = 0; n < maxW.length; n++) {
      if (!maxW[n]) continue;
      const x = r.nodes[n * 2] * CELL, z = r.nodes[n * 2 + 1] * CELL, y = yAt(x, z) + 0.05, rad = maxW[n] / 2;
      const c = ROAD_COL[2];
      pos.push(x, y, z); col.push(c.r, c.g, c.b);
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        pos.push(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad); col.push(c.r, c.g, c.b);
        idx.push(base, base + 1 + ((k + 1) % SEG), base + 1 + k);
      }
      base += SEG + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.roads.geometry.dispose();
    this.roads.geometry = g;
  }

  // ---------------------------------------------------------------- buildings on plots
  private rebuildBuildings(s: StateMsg) {
    const L = s.lots;
    let n = 0, ng = 0;
    const inst = this.inst;
    this.anims = [];
    this.cranes = [];
    const ghostCol = new THREE.Color();
    for (let k = 0; k < L.n; k++) {
      const building = L.constr[k] > 0;
      const lvl = building ? L.target[k] : L.level[k];
      const t = L.type[k];
      const x = L.x[k] * CELL, z = L.y[k] * CELL, ang = L.ang[k];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const base = this.ground(x, z) - 2;
      if (t && lvl) {
        const start = n;
        let top = 0;
        for (const b of buildingForm(L.id[k], t, lvl)) {
          if (n >= 60000) break;
          // local (u along street, v across) -> world (x, z)
          const wx = x + b.u * ca - b.v * sa, wz = z + b.u * sa + b.v * ca;
          inst.set([wx, base, wz, b.w, b.h + 2, b.d, ang], n * 7);
          this.setInst(n, 1);
          this.buildings.setColorAt(n, this.col.setHex(b.color));
          top = Math.max(top, b.h);
          n++;
        }
        if (building) {
          this.anims.push({ start, count: n - start, lot: k });
          if (lvl >= 2) this.cranes.push({ x: x + 18 * ca - 16 * sa, y: base, z: z + 18 * sa + 16 * ca, h: top + 14, k: L.id[k] });
        }
      }
      if ((L.flags[k] & Flag.Planned) && !building) {
        for (const b of buildingForm(L.id[k], L.planType[k], L.planLevel[k])) {
          if (ng >= 4000) break;
          const wx = x + b.u * ca - b.v * sa, wz = z + b.u * sa + b.v * ca;
          this.v.set(wx, base + 2, wz); this.s.set(b.w, b.h, b.d); this.q.setFromAxisAngle(this.up, -ang);
          this.m.compose(this.v, this.q, this.s);
          ghostCol.setHex((L.flags[k] & Flag.CarLocked) ? 0xd9785a : L.served[k] ? 0x6fb0e8 : 0xf2c46a);
          this.ghosts.setColorAt(ng, ghostCol);
          this.ghosts.setMatrixAt(ng++, this.m);
        }
      }
    }
    this.buildings.count = n;
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
    this.ghosts.count = ng;
    this.ghosts.instanceMatrix.needsUpdate = true;
    if (this.ghosts.instanceColor) this.ghosts.instanceColor.needsUpdate = true;
    this.craneMast.count = this.cranes.length;
    this.craneJib.count = this.cranes.length;
    this.animate(0, 0);
  }

  private setInst(n: number, p: number) {
    const a = this.inst, o = n * 7;
    this.v.set(a[o], a[o + 1], a[o + 2]);
    this.s.set(a[o + 3], Math.max(0.01, a[o + 4] * p), a[o + 5]);
    this.q.setFromAxisAngle(this.up, -a[o + 6]);
    this.m.compose(this.v, this.q, this.s);
    this.buildings.setMatrixAt(n, this.m);
  }

  // ---------------------------------------------------------------- trees: only where no street or plot is
  private rebuildTrees(s: StateMsg) {
    const occ = this.occ.slice();
    const L = s.lots, W = N * 4;
    for (let k = 0; k < L.n; k++) {
      if (L.type[k] === BT.Park) continue;
      const x = L.x[k] * CELL, z = L.y[k] * CELL, ca = Math.cos(L.ang[k]), sa = Math.sin(L.ang[k]);
      const hw = (L.w[k] * CELL) / 2, hd = (L.d[k] * CELL) / 2;
      for (let u = -hw; u <= hw; u += 8) for (let v = -hd; v <= hd; v += 8) {
        const gx = Math.floor((x + u * ca - v * sa) / 12.5), gz = Math.floor((z + u * sa + v * ca) / 12.5);
        if (gx >= 0 && gz >= 0 && gx < W && gz < W) occ[gz * W + gx] = 1;
      }
    }
    let n = 0;
    for (let i = 0; i < N * N && n < 29990; i++) {
      if (this.water[i]) continue;
      const steep = (s.flags[i] & Flag.Steep) !== 0;
      const r0 = vhash(i, 77);
      const want = r0 < (steep ? 0.6 : 0.16) ? 1 + Math.floor(vhash(i, 78) * 3) : 0;
      const cx = (i % N) * CELL, cz = ((i / N) | 0) * CELL;
      for (let k = 0; k < want; k++) {
        const x = cx + vhash(i, 90 + k) * CELL, z = cz + vhash(i, 100 + k) * CELL;
        const gx = Math.floor(x / 12.5), gz = Math.floor(z / 12.5);
        if (occ[gz * W + gx]) continue;
        const sc = 5 + vhash(i, 80 + k) * 4;
        this.v.set(x, this.sample(x, z) + sc * 0.9, z);
        this.s.set(sc, sc * 1.25, sc);
        this.q.identity();
        this.m.compose(this.v, this.q, this.s);
        this.trees.setMatrixAt(n++, this.m);
      }
    }
    // park plots get a small grove
    for (let k = 0; k < L.n && n < 29990; k++) {
      if (L.type[k] !== BT.Park) continue;
      const x = L.x[k] * CELL, z = L.y[k] * CELL;
      for (let j = 0; j < 5; j++) {
        const px = x + (vhash(L.id[k], 200 + j) - 0.5) * 28, pz = z + (vhash(L.id[k], 300 + j) - 0.5) * 28, sc = 5 + vhash(L.id[k], 400 + j) * 3;
        this.v.set(px, this.sample(px, pz) + sc * 0.9, pz); this.s.set(sc, sc * 1.25, sc); this.q.identity();
        this.m.compose(this.v, this.q, this.s);
        this.trees.setMatrixAt(n++, this.m);
      }
    }
    this.trees.count = n;
    this.trees.instanceMatrix.needsUpdate = true;
  }

  /** Rising buildings + cranes. frac = fraction of the current month elapsed. */
  animate(frac: number, time: number) {
    const L = this.lots;
    if (!L) return;
    for (const a of this.anims) {
      const tot = Math.max(1, L.constrTotal[a.lot]);
      const done = tot - L.constr[a.lot];
      let p = Math.min(1, (done + frac) / tot);
      p = 1 - Math.pow(1 - p, 2);
      for (let k = 0; k < a.count; k++) this.setInst(a.start + k, p);
    }
    if (this.anims.length) this.buildings.instanceMatrix.needsUpdate = true;
    for (let k = 0; k < this.cranes.length; k++) {
      const c = this.cranes[k];
      this.v.set(c.x, c.y, c.z); this.s.set(2.2, c.h, 2.2); this.q.identity();
      this.m.compose(this.v, this.q, this.s);
      this.craneMast.setMatrixAt(k, this.m);
      this.v.set(c.x, c.y + c.h, c.z); this.s.set(42, 1.8, 1.8);
      this.q.setFromAxisAngle(this.up, time * 0.25 + c.k);
      this.m.compose(this.v, this.q, this.s);
      this.craneJib.setMatrixAt(k, this.m);
    }
    if (this.cranes.length) { this.craneMast.instanceMatrix.needsUpdate = true; this.craneJib.instanceMatrix.needsUpdate = true; }
  }
}
