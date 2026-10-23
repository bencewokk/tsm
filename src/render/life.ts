import * as THREE from 'three';
import { CELL } from '../sim/constants';
import type { RoadsMsg, StationInfo } from '../sim/protocol';

/**
 * Small signs of life on the model: cars driving the streets (more on arterials, as many as the city's size suggests)
 * and little crowds milling round busy stations. Render only: nothing here touches the sim.
 */
export class Life {
  group = new THREE.Group();
  private cars: THREE.InstancedMesh;
  private people: THREE.InstancedMesh;
  private nx = new Float32Array(0); private ny = new Float32Array(0);
  private ea: Int32Array = new Int32Array(0); private eb: Int32Array = new Int32Array(0); private cls: Uint8Array = new Uint8Array(0);
  private adj: number[][] = [];
  /** Every car keeps its identity: `id` never changes, the colour is a pure function of it, and a car always draws in the instance slot equal to its array position (cars are only ever added or removed at the end). */
  private car: { id: number; e: number; eid: number; from: number; t: number; v: number; lane: number; rs: number }[] = [];
  private nextCar = 1;
  private slotId = new Int32Array(400);
  private palette = [0xc8c4bc, 0xb5533c, 0x3d6e9e, 0xd6a23a, 0x4f6a5b, 0xe8e4dc, 0x6a6e73, 0x9b6b8a].map((c) => new THREE.Color(c));
  private eids: Int32Array = new Int32Array(0);
  private eidIndex = new Map<number, number>();
  private crowd: { x: number; z: number; r: number; a: number; w: number; s: number }[] = [];
  private homes = 0;
  private roadVersion = -1;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private p = new THREE.Vector3(); private sc = new THREE.Vector3(); private up = new THREE.Vector3(0, 1, 0);
  private carMat: THREE.MeshStandardMaterial;

  constructor(private sample: (x: number, z: number) => number, private water: Uint8Array) {
    this.carMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0xffe9b0, emissiveIntensity: 0 });
    this.cars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.carMat, 400);
    this.cars.count = 0; this.cars.frustumCulled = false; this.cars.castShadow = true;
    this.people = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), 500);
    this.people.count = 0; this.people.frustumCulled = false;
    this.group.add(this.cars, this.people);
    for (let i = 0; i < 400; i++) this.cars.setColorAt(i, this.palette[0]);
    const ppl = [0xc0504d, 0x4a77a8, 0xe0b04a, 0x6a8f5b, 0xf0ede4, 0x8a5f7a];
    for (let i = 0; i < 500; i++) this.people.setColorAt(i, new THREE.Color(ppl[(i * 5) % ppl.length]));
  }

  setRoads(r: RoadsMsg) {
    if (r.version === this.roadVersion) return;
    this.roadVersion = r.version;
    const n = r.nodes.length / 2;
    this.nx = new Float32Array(n); this.ny = new Float32Array(n);
    for (let i = 0; i < n; i++) { this.nx[i] = r.nodes[i * 2]; this.ny[i] = r.nodes[i * 2 + 1]; }
    this.ea = r.ea; this.eb = r.eb; this.cls = r.cls;
    this.eids = r.ids;
    this.eidIndex = new Map();
    for (let e = 0; e < r.ids.length; e++) this.eidIndex.set(r.ids[e], e);
    this.adj = Array.from({ length: n }, () => []);
    for (let e = 0; e < r.ea.length; e++) { this.adj[r.ea[e]].push(e); this.adj[r.eb[e]].push(e); }
    // cars keep their identity across road changes: re-find their street by its stable id, only a car whose street is gone is put on another one
    for (const c of this.car) {
      const e = this.eidIndex.get(c.eid);
      if (e === undefined) this.place(c); else { c.e = e; if (this.ea[e] !== c.from && this.eb[e] !== c.from) c.from = this.ea[e]; }
    }
    this.fleet();
  }

  private rnd(c: { rs: number }) { c.rs = (Math.imul(c.rs, 1664525) + 1013904223) >>> 0; return c.rs / 4294967296; }

  private weightTotal() {
    let tot = 0;
    for (let e = 0; e < this.ea.length; e++) tot += this.weight(this.cls[e]);
    return tot;
  }
  private weight(c: number) { return c === 0 ? 4 : c === 1 ? 2 : 0.6; }

  /** put a car on a random street (weighted towards arterials) without changing who it is */
  private place(c: { e: number; eid: number; from: number; t: number; rs: number }) {
    const E = this.ea.length;
    if (!E) return;
    let r = this.rnd(c) * this.weightTotal(), e = 0;
    for (; e < E - 1; e++) { r -= this.weight(this.cls[e]); if (r <= 0) break; }
    c.e = e; c.eid = this.eids[e]; c.from = this.rnd(c) < 0.5 ? this.ea[e] : this.eb[e]; c.t = this.rnd(c);
  }

  /** grow or shrink the fleet at the end of the list; the cars already driving are untouched */
  private fleet() {
    if (!this.ea.length) return;
    const want = Math.max(10, Math.min(320, Math.round(this.homes / 45)));
    while (this.car.length > want) this.car.pop();
    while (this.car.length < want) {
      const id = this.nextCar++;
      const c = { id, e: 0, eid: 0, from: 0, t: 0, v: 0, lane: 1, rs: (Math.imul(id, 2654435761) ^ 0x9e3779b9) >>> 0 };
      this.place(c);
      this.car.push(c);
    }
  }

  setCity(homes: number, stations: StationInfo[]) {
    this.homes = homes;
    this.fleet();
    this.crowd = [];
    for (const st of stations) {
      const n = Math.min(18, Math.floor(st.riders / 320));
      for (let k = 0; k < n; k++) this.crowd.push({ x: st.x * CELL, z: st.y * CELL, r: 12 + Math.random() * 24, a: Math.random() * Math.PI * 2, w: 0.15 + Math.random() * 0.3, s: Math.random() < 0.5 ? 1 : -1 });
    }
  }

  animate(dt: number, time: number, night: number) {
    const E = this.ea.length;
    let n = 0;
    for (const c of this.car) {
      if (n >= 400 || !E) break;
      const e = c.e, a = c.from, b = this.ea[e] === a ? this.eb[e] : this.ea[e];
      const ax = this.nx[a] * CELL, az = this.ny[a] * CELL, bx = this.nx[b] * CELL, bz = this.ny[b] * CELL;
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const sp = this.cls[e] === 0 ? 46 : this.cls[e] === 1 ? 32 : 22;
      c.t += (dt * sp) / L;
      if (c.t >= 1) {
        // at the end node: take another street, preferring to carry on (not to turn back). The car is still drawn this frame (at the start of the next street) so slots never shift.
        const opts = this.adj[b].filter((x) => x !== e);
        c.from = b; c.e = opts.length ? opts[Math.floor(this.rnd(c) * opts.length)] : e; c.eid = this.eids[c.e]; c.t = 0;
        this.carPose(c, n++);
        continue;
      }
      this.carPose(c, n++);
    }
    this.cars.count = n;
    this.cars.instanceMatrix.needsUpdate = true;
    if (this.colourDirty) { this.cars.instanceColor!.needsUpdate = true; this.colourDirty = false; }
    this.carMat.emissiveIntensity = night * 0.9;
    this.drawCrowd(time);
  }

  private colourDirty = false;
  /** write car `c` into instance slot `n`; the slot's colour is set from the car's id whenever the slot's owner differs */
  private carPose(c: { id: number; e: number; from: number; t: number }, n: number) {
    {
      const e = c.e, a = c.from, b = this.ea[e] === a ? this.eb[e] : this.ea[e];
      const ax = this.nx[a] * CELL, az = this.ny[a] * CELL, bx = this.nx[b] * CELL, bz = this.ny[b] * CELL;
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const t = c.t, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const ux = (bx - ax) / L, uz = (bz - az) / L, off = (this.cls[e] === 0 ? 5 : 3.2);
      const px = x - uz * off, pz = z + ux * off;
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      const wet = cx >= 0 && cz >= 0 && cx < 128 && cz < 128 && this.water[cz * 128 + cx];
      const y = wet ? 6.6 : this.sample(px, pz) + 1.9;
      this.q.setFromAxisAngle(this.up, Math.atan2(ux, uz));
      this.p.set(px, y, pz);
      this.sc.set(4.6, 3.2, 10.5);
      this.m.compose(this.p, this.q, this.sc);
      this.cars.setMatrixAt(n, this.m);
      if (this.slotId[n] !== c.id) { this.slotId[n] = c.id; this.cars.setColorAt(n, this.palette[this.colourOf(c.id)]); this.colourDirty = true; }
    }
  }

  /** a car's colour: a hash of its id (never of the slot, the frame or the time of day) */
  colourOf(id: number) { return (Math.imul(id ^ (id >>> 5), 2246822519) >>> 11) % this.palette.length; }

  private drawCrowd(time: number) {
    let k = 0;
    for (const c of this.crowd) {
      if (k >= 500) break;
      const a = c.a + time * c.w * c.s, r = c.r + Math.sin(time * 0.7 + c.a * 3) * 3;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r * 0.8;
      this.p.set(x, this.sample(x, z) + 3.4, z);
      this.q.identity();
      this.sc.set(2.6, 6.2, 2.6);
      this.m.compose(this.p, this.q, this.sc);
      this.people.setMatrixAt(k++, this.m);
    }
    this.people.count = k;
    this.people.instanceMatrix.needsUpdate = true;
  }
}
