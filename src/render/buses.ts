import * as THREE from 'three';
import { CELL } from '../sim/constants';
import type { BusInfo, StationInfo } from '../sim/protocol';

/**
 * Bus routes (round 7, step 4b/c): a thin coloured ribbon along each route's streets (a busway is wider and rust-red edged, bus priority
 * dashed in white), a post at every stop, and the buses themselves: one instanced mesh for every bus in the city, moving along their
 * routes at the route's ride time. LOD: past about 3.5 km of camera distance the buses are hidden (the ribbons stay).
 */
export class BusView {
  group = new THREE.Group();
  private routes = new THREE.Group();
  private stopsMesh: THREE.InstancedMesh | null = null;
  private fleet: THREE.InstancedMesh;
  private sig = '';
  private paths: { pts: THREE.Vector3[]; len: number[]; total: number; n: number; ride: number; color: THREE.Color }[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  private v = new THREE.Vector3();

  constructor(private ground: (x: number, z: number) => number) {
    this.group.add(this.routes);
    const geo = new THREE.BoxGeometry(13, 3.6, 3.2);
    this.fleet = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), 256);
    this.fleet.count = 0;
    this.fleet.castShadow = false;
    this.group.add(this.fleet);
  }

  update(buses: BusInfo[], stops: StationInfo[]) {
    const sig = JSON.stringify([buses.map((b) => [b.id, b.lane, b.trains, b.pts.length, Math.round(b.ride)]), stops.length]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.routes.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.routes.clear();
    this.paths = [];
    for (const b of buses) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k + 1 < b.pts.length; k += 2) { const x = b.pts[k] * CELL, z = b.pts[k + 1] * CELL; pts.push(new THREE.Vector3(x, this.ground(x, z) + 1.4, z)); }
      if (pts.length < 2) continue;
      const len = [0];
      for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + pts[k].distanceTo(pts[k - 1]));
      const col = new THREE.Color(b.color);
      // the bus body is a lighter tint of the route colour so it stands out on its own ribbon
      this.paths.push({ pts, len, total: len[len.length - 1], n: b.trains, ride: Math.max(1, b.ride), color: col.clone().lerp(new THREE.Color(0xffffff), 0.45) });
      // the ribbon: flat quads along the polyline
      const w = b.lane === 2 ? 5.5 : 3.2;
      const pos: number[] = [];
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], c = pts[k];
        if (b.lane === 1 && k % 2 === 0) continue;   // bus priority: dashed
        const dx = c.x - a.x, dz = c.z - a.z, L = Math.hypot(dx, dz) || 1, nx = -dz / L * w / 2, nz = dx / L * w / 2;
        pos.push(a.x + nx, a.y, a.z + nz, c.x + nx, c.y, c.z + nz, c.x - nx, c.y, c.z - nz, a.x + nx, a.y, a.z + nz, c.x - nx, c.y, c.z - nz, a.x - nx, a.y, a.z - nz);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.MeshBasicMaterial({ color: b.lane === 2 ? col.clone().lerp(new THREE.Color(0xa0442c), 0.45) : col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = 4;
      this.routes.add(mesh);
    }
    // stops: small posts
    if (this.stopsMesh) { this.group.remove(this.stopsMesh); this.stopsMesh.geometry.dispose(); }
    const sg = new THREE.CylinderGeometry(0.9, 0.9, 7, 6);
    this.stopsMesh = new THREE.InstancedMesh(sg, new THREE.MeshStandardMaterial({ color: 0x3c4a55 }), Math.max(1, stops.length));
    stops.forEach((s, k) => { const x = s.x * CELL, z = s.y * CELL; this.m4.makeTranslation(x, this.ground(x, z) + 3.5, z); this.stopsMesh!.setMatrixAt(k, this.m4); });
    this.stopsMesh.count = stops.length;
    this.group.add(this.stopsMesh);
  }

  /** move the buses: each runs out and back along its route, evenly spaced; hidden when the camera is far */
  animate(t: number, camDist: number) {
    const far = camDist > 3500;
    this.fleet.visible = !far;
    if (far) return;
    let i = 0;
    for (const p of this.paths) {
      const cycle = p.ride * 2 * 60 / 40;   // seconds of animation for a round trip: 40x real time
      for (let k = 0; k < p.n && i < 256; k++, i++) {
        let u = ((t / cycle + k / p.n) % 1 + 1) % 1;
        const back = u > 0.5; u = back ? 1 - (u - 0.5) * 2 : u * 2;
        const d = u * p.total;
        let s = 1;
        while (s < p.len.length - 1 && p.len[s] < d) s++;
        const a = p.pts[s - 1], b = p.pts[s], f = (d - p.len[s - 1]) / Math.max(1e-6, p.len[s] - p.len[s - 1]);
        this.v.lerpVectors(a, b, f); this.v.y += 1.6;
        this.dir.subVectors(b, a); this.dir.y = 0;
        const ang = Math.atan2(-this.dir.z, this.dir.x);
        this.q.setFromAxisAngle(this.up, ang);
        // drive on the right: offset sideways by direction
        const side = back ? -1.6 : 1.6, L = Math.hypot(this.dir.x, this.dir.z) || 1;
        this.v.x += (-this.dir.z / L) * side * (back ? -1 : 1); this.v.z += (this.dir.x / L) * side * (back ? -1 : 1);
        this.m4.compose(this.v, this.q, new THREE.Vector3(1, 1, 1));
        this.fleet.setMatrixAt(i, this.m4);
        this.fleet.setColorAt(i, p.color);
      }
    }
    this.fleet.count = i;
    this.fleet.instanceMatrix.needsUpdate = true;
    if (this.fleet.instanceColor) this.fleet.instanceColor.needsUpdate = true;
  }
}
