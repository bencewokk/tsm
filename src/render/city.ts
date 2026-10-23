import * as THREE from 'three';
import { N, CELL, BT, Flag } from '../sim/constants';
import type { StateMsg } from '../sim/protocol';
import { cellCenter, groundY, vhash } from './common';
import { patchBuildingMaterial } from './look';

export interface Box { x: number; z: number; w: number; d: number; h: number; rot: number; color: number }

const COL = {
  res: 0xf6f0e2,
  res2: 0xf1e9d8,
  com: 0xfbfaf6,
  com2: 0xeef0f0,
  ind: 0xd9d1c3,
  ind2: 0xcfc6b6,
  park: 0xc5d6b0,
};

/** Box layout for a building of (type, level) on cell i. Purely visual. */
export function buildingForm(i: number, type: number, level: number): Box[] {
  const [cx, cz] = cellCenter(i % N, (i / N) | 0);
  const r = (k: number) => vhash(i, k);
  const out: Box[] = [];
  const rot = 0;
  if (type === BT.Res) {
    if (level === 1) {
      const n = 2 + Math.floor(r(1) * 3);
      const spots = [[-12, -12], [12, -12], [-12, 12], [12, 12]];
      for (let k = 0; k < n; k++) {
        const [ox, oz] = spots[(k + Math.floor(r(2) * 4)) % 4];
        out.push({ x: cx + ox + (r(10 + k) - 0.5) * 4, z: cz + oz + (r(20 + k) - 0.5) * 4, w: 10 + r(30 + k) * 4, d: 9 + r(40 + k) * 4, h: 6 + r(50 + k) * 3, rot, color: r(60 + k) < 0.5 ? COL.res : COL.res2 });
      }
    } else if (level === 2) {
      if (r(1) < 0.5) {
        out.push({ x: cx, z: cz - 10, w: 38, d: 14, h: 15 + r(2) * 9, rot, color: COL.res });
        out.push({ x: cx, z: cz + 12, w: 38, d: 14, h: 12 + r(3) * 9, rot, color: COL.res2 });
      } else {
        out.push({ x: cx - 9, z: cz, w: 16, d: 36, h: 18 + r(2) * 8, rot, color: COL.res });
        out.push({ x: cx + 12, z: cz + 6, w: 14, d: 22, h: 12 + r(3) * 6, rot, color: COL.res2 });
      }
    } else if (level === 3) {
      out.push({ x: cx, z: cz, w: 38, d: 38, h: 8, rot, color: COL.res2 });
      out.push({ x: cx + (r(4) - 0.5) * 6, z: cz + (r(5) - 0.5) * 6, w: 19 + r(6) * 4, d: 19 + r(7) * 4, h: 55 + r(2) * 45, rot, color: COL.res });
    }
  } else if (type === BT.Com) {
    if (level === 1) {
      out.push({ x: cx, z: cz, w: 26 + r(1) * 8, d: 22 + r(2) * 6, h: 7 + r(3) * 3, rot, color: COL.com });
    } else if (level === 2) {
      out.push({ x: cx, z: cz, w: 34, d: 34, h: 22 + r(2) * 16, rot, color: COL.com });
    } else if (level === 3) {
      out.push({ x: cx, z: cz, w: 40, d: 40, h: 12, rot, color: COL.com2 });
      out.push({ x: cx, z: cz, w: 24 + r(3) * 4, d: 24 + r(4) * 4, h: 100 + r(2) * 60, rot, color: COL.com });
    }
  } else if (type === BT.Ind) {
    out.push({ x: cx, z: cz, w: 40, d: 30 + r(1) * 8, h: level >= 2 ? 13 : 9, rot, color: r(2) < 0.5 ? COL.ind : COL.ind2 });
    if (level >= 2 && r(3) < 0.6) out.push({ x: cx + 14, z: cz + 12, w: 4, d: 4, h: 34, rot, color: COL.ind2 });
  } else if (type === BT.Park) {
    out.push({ x: cx, z: cz, w: 46, d: 46, h: 0.8, rot, color: COL.park });
  }
  return out;
}

function boxGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

interface Anim { start: number; count: number; cell: number }

export class CityView {
  group = new THREE.Group();
  buildings: THREE.InstancedMesh;
  ghosts: THREE.InstancedMesh;
  roads: THREE.InstancedMesh;
  trees: THREE.InstancedMesh;
  craneMast: THREE.InstancedMesh;
  craneJib: THREE.InstancedMesh;
  buildingMat: THREE.MeshStandardMaterial;
  roadMat: THREE.MeshStandardMaterial;
  /** every opaque surface material, for the x-ray fade */
  get surfaceMats(): THREE.Material[] {
    return [this.buildingMat, this.roadMat, this.trees.material as THREE.Material, this.craneMast.material as THREE.Material];
  }
  /** per instance: x, base, z, w, h, d */
  private inst = new Float32Array(0);
  private anims: Anim[] = [];
  private cranes: { x: number; y: number; z: number; h: number; cell: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  private state: StateMsg | null = null;

  constructor(private height: Float32Array, private water: Uint8Array) {
    const cap = 60000;
    this.buildingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, emissive: 0x000000 });
    patchBuildingMaterial(this.buildingMat);
    this.buildings = new THREE.InstancedMesh(boxGeo(), this.buildingMat, cap);
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    this.buildings.count = 0;
    this.buildings.frustumCulled = false;
    this.inst = new Float32Array(cap * 6);

    const ghostMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x404040, emissiveIntensity: 0.4 });
    this.ghosts = new THREE.InstancedMesh(boxGeo(), ghostMat, 4000);
    this.ghosts.count = 0;
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 5;

    const roadMat = new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 1, emissive: 0xffb860, emissiveIntensity: 0 });
    this.roadMat = roadMat;
    this.roads = new THREE.InstancedMesh(boxGeo(), roadMat, N * N * 3);
    this.roads.receiveShadow = true;
    this.roads.count = 0;
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

  private gy(i: number) { return groundY(this.height, this.water, i); }

  update(s: StateMsg) {
    this.state = s;
    this.rebuildRoads(s);
    this.rebuildBuildings(s);
    this.rebuildTrees(s);
  }

  private rebuildRoads(s: StateMsg) {
    const W = 13;
    let n = 0;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0, alongX = true) => {
      this.v.set(x, y, z);
      this.s.set(sx, sy, sz);
      if (alongX) this.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt);
      else this.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -tilt);
      this.m.compose(this.v, this.q, this.s);
      this.roads.setMatrixAt(n++, this.m);
    };
    for (let i = 0; i < N * N; i++) {
      if (!s.road[i]) continue;
      const x = i % N, y = (i / N) | 0;
      const [cx, cz] = cellCenter(x, y);
      const h = this.roadY(i);
      put(cx, h - 1.5, cz, W, 2, W);
      if (x + 1 < N && s.road[i + 1]) {
        const h2 = this.roadY(i + 1);
        put(cx + CELL / 2, (h + h2) / 2 - 1.5, cz, CELL + 1, 2, W, Math.atan2(h2 - h, CELL), true);
      }
      if (y + 1 < N && s.road[i + N]) {
        const h2 = this.roadY(i + N);
        put(cx, (h + h2) / 2 - 1.5, cz + CELL / 2, W, 2, CELL + 1, Math.atan2(h2 - h, CELL), false);
      }
    }
    this.roads.count = n;
    this.roads.instanceMatrix.needsUpdate = true;
  }

  private roadY(i: number) {
    return this.water[i] ? 5 : this.gy(i) + 0.6;
  }

  private rebuildBuildings(s: StateMsg) {
    let n = 0, ng = 0;
    // which cells are within 600 m of a station on a line (docks service brief)
    const onLine = new Set<number>();
    for (const l of s.lines) for (const id of l.stations) onLine.add(id);
    const served = new Uint8Array(N * N);
    for (const st of s.stations) {
      if (!onLine.has(st.id)) continue;
      for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
        const x = st.x + dx, y = st.y + dy;
        if (dx * dx + dy * dy <= 144 && x >= 0 && y >= 0 && x < N && y < N) served[y * N + x] = 1;
      }
    }
    const ghostCol = new THREE.Color();
    this.anims = [];
    this.cranes = [];
    const inst = this.inst;
    for (let i = 0; i < N * N; i++) {
      const t = s.btype[i];
      const building = s.constr[i] > 0;
      const lvl = building ? s.target[i] : s.level[i];
      if ((t && lvl) || building) {
        const form = buildingForm(i, t, lvl);
        const base = this.gy(i) - 2;
        const start = n;
        for (const b of form) {
          if (n >= 60000) break;
          inst.set([b.x, base, b.z, b.w, b.h + 2, b.d], n * 6);
          this.setInst(n, 1);
          this.buildings.setColorAt(n, this.col.setHex(b.color));
          n++;
        }
        if (building) {
          this.anims.push({ start, count: n - start, cell: i });
          if (lvl >= 2) {
            const [cx, cz] = cellCenter(i % N, (i / N) | 0);
            const top = Math.max(...form.map((b) => b.h));
            this.cranes.push({ x: cx + 20, y: base, z: cz - 20, h: top + 14, cell: i });
          }
        }
      }
      if ((s.flags[i] & Flag.Planned) && !(s.btype[i] && s.level[i] >= s.planLevel[i]) && !building) {
        for (const b of buildingForm(i, s.planType[i], s.planLevel[i])) {
          if (ng >= 4000) break;
          this.v.set(b.x, this.gy(i), b.z); this.s.set(b.w, b.h, b.d); this.q.identity();
          this.m.compose(this.v, this.q, this.s);
          ghostCol.setHex((s.flags[i] & Flag.CarLocked) ? 0xd9785a : served[i] ? 0x6fb0e8 : 0xf2c46a);
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
    const a = this.inst, o = n * 6;
    this.v.set(a[o], a[o + 1], a[o + 2]);
    this.s.set(a[o + 3], Math.max(0.01, a[o + 4] * p), a[o + 5]);
    this.q.identity();
    this.m.compose(this.v, this.q, this.s);
    this.buildings.setMatrixAt(n, this.m);
  }

  private rebuildTrees(s: StateMsg) {
    let n = 0;
    for (let i = 0; i < N * N && n < 29990; i++) {
      if (this.water[i] || s.road[i]) continue;
      const park = s.btype[i] === BT.Park;
      if (s.btype[i] && !park) continue;
      if (s.flags[i] & Flag.Planned) continue;
      const steep = (s.flags[i] & Flag.Steep) !== 0;
      const r0 = vhash(i, 77);
      const count = park ? 4 : r0 < (steep ? 0.6 : 0.14) ? 1 + Math.floor(vhash(i, 78) * 3) : 0;
      const [cx, cz] = cellCenter(i % N, (i / N) | 0);
      const base = this.gy(i);
      for (let k = 0; k < count; k++) {
        const sc = 5 + vhash(i, 80 + k) * 4;
        this.v.set(cx + (vhash(i, 90 + k) - 0.5) * 38, base + sc * 0.9, cz + (vhash(i, 100 + k) - 0.5) * 38);
        this.s.set(sc, sc * 1.25, sc);
        this.q.identity();
        this.m.compose(this.v, this.q, this.s);
        this.trees.setMatrixAt(n++, this.m);
      }
    }
    this.trees.count = n;
    this.trees.instanceMatrix.needsUpdate = true;
  }

  /** Animate rising buildings + cranes. frac = fraction of the current month elapsed. */
  animate(frac: number, time: number) {
    const s = this.state;
    if (!s) return;
    for (const a of this.anims) {
      const tot = Math.max(1, s.constrTotal[a.cell]);
      const done = tot - s.constr[a.cell];
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
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), time * 0.25 + c.cell);
      this.m.compose(this.v, this.q, this.s);
      this.craneJib.setMatrixAt(k, this.m);
    }
    if (this.cranes.length) { this.craneMast.instanceMatrix.needsUpdate = true; this.craneJib.instanceMatrix.needsUpdate = true; }
  }
}
