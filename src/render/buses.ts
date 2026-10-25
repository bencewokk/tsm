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
  /** round 7 step 7: transit streets (no cars) and the road proposal waiting for a decision */
  private roads = new THREE.Group();
  private roadSig = '';
  /** round 7 step 8: regional rail lines (a coloured band beside the track, platforms, long trains) */
  private rail = new THREE.Group();
  private railSig = '';
  private railPaths: { pts: THREE.Vector3[]; len: number[]; total: number; n: number; ride: number; color: THREE.Color; tram: boolean }[] = [];
  private railFleet: THREE.InstancedMesh;
  private stopsMesh: THREE.InstancedMesh | null = null;
  private fleet: THREE.InstancedMesh;
  private sig = '';
  private paths: { pts: THREE.Vector3[]; len: number[]; total: number; n: number; ride: number; color: THREE.Color; tram: boolean }[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private tramScale = new THREE.Vector3(2.3, 1.05, 1.05);

  constructor(private ground: (x: number, z: number) => number) {
    this.group.add(this.routes);
    this.group.add(this.roads);
    this.group.add(this.rail);
    this.railFleet = new THREE.InstancedMesh(new THREE.BoxGeometry(60, 4, 3.2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }), 64);
    this.railFleet.count = 0;
    this.group.add(this.railFleet);
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
      this.paths.push({ pts, len, total: len[len.length - 1], n: b.trains, ride: Math.max(1, b.ride), color: col.clone().lerp(new THREE.Color(0xffffff), 0.45), tram: b.lane === 3 });
      // round 7 step 6: a tram line is a dark track bed with two light rails, edged in the line colour
      if (b.lane === 3) {
        this.routes.add(this.strip(pts, 5.6, 0, 0x4f4a45, 1));                                          // track bed (setts)
        for (const off of [-0.75, 0.75]) this.routes.add(this.strip(pts, 0.55, off, 0xd8dbe0, 1));     // the rails
        for (const off of [-2.7, 2.7]) this.routes.add(this.strip(pts, 0.6, off, col.getHex(), 1));    // kerb lines in the line colour
        continue;
      }
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

  updateRail(lines: { id: number; color: string; stations: number[]; trains: number; segLoad: number[]; pts?: number[] }[], stations: { id: number; x: number; y: number }[]) {
    const sig = JSON.stringify(lines.map((l) => [l.id, l.trains, l.pts?.length, l.stations]));
    if (sig === this.railSig) return;
    this.railSig = sig;
    this.rail.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.rail.clear();
    this.railPaths = [];
    for (const l of lines) {
      const flat = l.pts ?? [];
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k + 1 < flat.length; k += 2) { const x = flat[k] * CELL, z = flat[k + 1] * CELL; pts.push(new THREE.Vector3(x, this.ground(x, z) + 1.0, z)); }
      if (pts.length < 2) continue;
      const len = [0];
      for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + pts[k].distanceTo(pts[k - 1]));
      const col = new THREE.Color(l.color);
      // a band in the line colour each side of the track, so the served railway reads as a line on the map
      for (const off of [-4.6, 4.6]) this.rail.add(this.strip(pts, 3, off, col.getHex(), 0.95));
      const ride = len[len.length - 1] / 1000 / 65 * 60 + l.stations.length;
      this.railPaths.push({ pts, len, total: len[len.length - 1], n: l.trains, ride, color: col.clone().lerp(new THREE.Color(0xffffff), 0.35), tram: false });
      for (const id of l.stations) {
        const st = stations.find((q) => q.id === id);
        if (!st) continue;
        const x = st.x * CELL, z = st.y * CELL;
        const plat = new THREE.Mesh(new THREE.BoxGeometry(70, 1.2, 9), new THREE.MeshStandardMaterial({ color: 0xd9d4c7 }));
        // along the track at the station
        let bk = 1, bd = Infinity;
        for (let k = 1; k < pts.length; k++) { const d = Math.hypot((pts[k].x + pts[k - 1].x) / 2 - x, (pts[k].z + pts[k - 1].z) / 2 - z); if (d < bd) { bd = d; bk = k; } }
        plat.rotation.y = -Math.atan2(pts[bk].z - pts[bk - 1].z, pts[bk].x - pts[bk - 1].x);
        plat.position.set(x, this.ground(x, z) + 0.8, z);
        this.rail.add(plat);
      }
    }
  }

  /** transit streets as a terracotta street surface; a proposal waiting at City hall as a dashed orange line with posts at its ends */
  setRoads(info: { proposals: { id: number; state: string; pts: number[] }[]; transitStreets: number[][] }) {
    const asked = info.proposals.filter((p) => p.state === 'asked');
    const sig = JSON.stringify([info.transitStreets, asked.map((p) => p.id)]);
    if (sig === this.roadSig) return;
    this.roadSig = sig;
    this.roads.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.roads.clear();
    const toPts = (flat: number[], lift: number, step: number) => {
      const out: THREE.Vector3[] = [];
      for (let k = 2; k < flat.length; k += 2) {
        const ax = flat[k - 2] * CELL, az = flat[k - 1] * CELL, bx = flat[k] * CELL, bz = flat[k + 1] * CELL;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
        for (let q = k === 2 ? 0 : 1; q <= n; q++) { const x = ax + (bx - ax) * q / n, z = az + (bz - az) * q / n; out.push(new THREE.Vector3(x, this.ground(x, z) + lift, z)); }
      }
      return out;
    };
    for (const pl of info.transitStreets) this.roads.add(this.strip(toPts(pl, 1.2, 10), 7.5, 0, 0xb4613f, 0.75));
    for (const p of asked) {
      const pts = toPts(p.pts, 3, 12);
      // dashes: every other short piece
      for (let k = 1; k < pts.length; k += 2) this.roads.add(this.strip([pts[k - 1], pts[k]], 6, 0, 0xe8862c, 0.95));
      for (const v of [pts[0], pts[pts.length - 1]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 40, 8), new THREE.MeshBasicMaterial({ color: 0xe8862c }));
        post.position.set(v.x, v.y + 20, v.z);
        this.roads.add(post);
      }
    }
  }

  /** regional trains: run out and back along their track, evenly spaced (the same motion as the buses) */
  private moveFleet(paths: { pts: THREE.Vector3[]; len: number[]; total: number; n: number; ride: number; color: THREE.Color }[], fleet: THREE.InstancedMesh, t: number, max: number, lift: number, scale: THREE.Vector3) {
    let i = 0;
    for (const p of paths) {
      const cycle = p.ride * 2 * 60 / 40;
      for (let k = 0; k < p.n && i < max; k++, i++) {
        let u = ((t / cycle + k / p.n) % 1 + 1) % 1;
        const back = u > 0.5; u = back ? 1 - (u - 0.5) * 2 : u * 2;
        const d = u * p.total;
        let s = 1;
        while (s < p.len.length - 1 && p.len[s] < d) s++;
        const a = p.pts[s - 1], b = p.pts[s], f = (d - p.len[s - 1]) / Math.max(1e-6, p.len[s] - p.len[s - 1]);
        this.v.lerpVectors(a, b, f); this.v.y += lift + 1.4;
        this.dir.subVectors(b, a); this.dir.y = 0;
        this.q.setFromAxisAngle(this.up, Math.atan2(-this.dir.z, this.dir.x));
        this.m4.compose(this.v, this.q, scale);
        fleet.setMatrixAt(i, this.m4);
        fleet.setColorAt(i, p.color);
      }
    }
    fleet.count = i;
    fleet.instanceMatrix.needsUpdate = true;
    if (fleet.instanceColor) fleet.instanceColor.needsUpdate = true;
  }

  /** a flat strip of width w along the polyline, offset sideways by off (metres) */
  private strip(pts: THREE.Vector3[], w: number, off: number, color: number, opacity: number) {
    const pos: number[] = [];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], c = pts[k];
      const dx = c.x - a.x, dz = c.z - a.z, L = Math.hypot(dx, dz) || 1, ux = -dz / L, uz = dx / L;
      const l0 = off - w / 2, l1 = off + w / 2;
      pos.push(a.x + ux * l1, a.y + 0.05, a.z + uz * l1, c.x + ux * l1, c.y + 0.05, c.z + uz * l1, c.x + ux * l0, c.y + 0.05, c.z + uz * l0,
        a.x + ux * l1, a.y + 0.05, a.z + uz * l1, c.x + ux * l0, c.y + 0.05, c.z + uz * l0, a.x + ux * l0, a.y + 0.05, a.z + uz * l0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    mesh.renderOrder = 4;
    return mesh;
  }

  /** move the buses: each runs out and back along its route, evenly spaced; hidden when the camera is far */
  animate(t: number, camDist: number) {
    const far = camDist > 3500;
    this.fleet.visible = !far;
    this.railFleet.visible = camDist < 6000;
    this.moveFleet(this.railPaths, this.railFleet, t, 64, 1, this.one);
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
        // a tram: a long two-section car (about 30 m)
        this.m4.compose(this.v, this.q, p.tram ? this.tramScale : this.one);
        this.fleet.setMatrixAt(i, this.m4);
        this.fleet.setColorAt(i, p.color);
      }
    }
    this.fleet.count = i;
    this.fleet.instanceMatrix.needsUpdate = true;
    if (this.fleet.instanceColor) this.fleet.instanceColor.needsUpdate = true;
  }
}
