import * as THREE from 'three';
import type { StateMsg, StationInfo } from '../sim/protocol';
import { CELL } from '../sim/constants';
import { unitGeos } from './layers';

export const TUNNEL_Y = -42;

/** Metro visuals: surface ribbons (map layer), stations, tunnels (x-ray) and trains. */
export class MetroView {
  group = new THREE.Group();
  private ribbons = new THREE.Group();
  private stations = new THREE.Group();
  private under = new THREE.Group();
  private draftGroup = new THREE.Group();
  private trains: THREE.InstancedMesh;
  private cursor: THREE.Mesh;
  private ribbonMats: THREE.MeshBasicMaterial[] = [];
  private discMats: THREE.Material[] = [];
  private innerDiscs: THREE.MeshBasicMaterial[] = [];
  private plazaGeo = new THREE.CylinderGeometry(34, 34, 1, 28);
  private barrelGeo = unitGeos().barrel;
  private ribGeo = (() => { const g = new THREE.TorusGeometry(0.5, 0.02, 5, 18, Math.PI); g.rotateY(Math.PI / 2); g.scale(1, 2, 1); return g; })();
  private signGeo = new THREE.CylinderGeometry(3.4, 3.4, 1, 20);
  private ringGeo = new THREE.RingGeometry(1.5, 2.6, 20);
  private stationMats = {
    stone: new THREE.MeshStandardMaterial({ color: 0xe3dbc9, roughness: 1 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x4d5257, roughness: 0.8 }),
    white: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0xa9c8d8, roughness: 0.15, metalness: 0.35, transparent: true, opacity: 0.72, side: THREE.DoubleSide, emissive: 0x7fa8bf, emissiveIntensity: 0.12 }),
  };
  private paths: { color: THREE.Color; pts: THREE.Vector3[]; len: number[]; total: number; trains: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  plan = false;
  private dark = new THREE.Color('#2c2f33');
  xray = 0;

  constructor(private sample: (x: number, z: number) => number) {
    const tg = new THREE.BoxGeometry(1, 1, 1);
    this.trains = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, emissive: 0x222222 }), 600);
    this.trains.count = 0;
    this.trains.frustumCulled = false;
    this.trains.renderOrder = 12;
    const cm = new THREE.MeshBasicMaterial({ color: 0x2c2f33, transparent: true, opacity: 0.35, depthTest: false });
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(46, 60, 40), cm);
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.visible = false;
    this.cursor.renderOrder = 20;
    this.group.add(this.ribbons, this.stations, this.under, this.draftGroup, this.trains, this.cursor);
  }

  private surf(x: number, z: number) { return Math.max(0.4, this.sample(x, z)); }

  /** Terrain-following ribbon between world points. */
  private ribbon(pts: THREE.Vector3[], width: number, mat: THREE.Material, lift: number): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1) continue;
      const nx = -(b.z - a.z) / len * width / 2, nz = (b.x - a.x) / len * width / 2;
      const steps = Math.max(1, Math.ceil(len / 30));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const y = this.surf(x, z) + lift;
        pos.push(x + nx, y, z + nz, x - nx, y, z - nz);
        if (j > 0) { const o = base + (j - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      }
      base += (steps + 1) * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 10;
    return mesh;
  }

  private stationXZ(st: { x: number; y: number }) {
    return new THREE.Vector3(st.x * CELL, 0, st.y * CELL);
  }

  /** Smooth curve through the stations (centripetal Catmull-Rom), sampled every ~25 m. */
  private smooth(pts: THREE.Vector3[]): THREE.Vector3[] {
    if (pts.length < 3) {
      if (pts.length < 2) return pts;
      const out: THREE.Vector3[] = [];
      const L = pts[0].distanceTo(pts[1]), n = Math.max(1, Math.ceil(L / 25));
      for (let k = 0; k <= n; k++) out.push(pts[0].clone().lerp(pts[1], k / n));
      return out;
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = Math.max(8, Math.ceil(curve.getLength() / 25));
    return curve.getSpacedPoints(n);
  }

  update(s: StateMsg) {
    for (const g of [this.ribbons, this.stations, this.under]) {
      g.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
      g.clear();
    }
    this.ribbonMats = [];
    this.discMats = [];
    this.innerDiscs = [];
    this.paths = [];
    const byId = new Map(s.stations.map((st) => [st.id, st]));
    const stationColor = new Map<number, string>();
    const stationDir = new Map<number, number>();
    s.lines.forEach((l, li) => {
      const pts = this.smooth(l.stations.map((id) => this.stationXZ(byId.get(id)!)));
      // offset parallel lines a little so shared corridors read as bundles
      const off = (li % 3 - 1) * 7;
      const shifted = pts.map((p, k) => {
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return new THREE.Vector3(p.x - (b.z - a.z) / len * off, 0, p.z + (b.x - a.x) / len * off);
      });
      const mat = new THREE.MeshBasicMaterial({ color: l.color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
      this.ribbonMats.push(mat);
      this.ribbons.add(this.ribbon(shifted, 12, mat, 3));
      // tunnels
      const tmat = new THREE.MeshStandardMaterial({ color: l.color, emissive: l.color, emissiveIntensity: 0.35, roughness: 0.6 });
      const tpts = pts.map((p) => new THREE.Vector3(p.x, TUNNEL_Y - li * 6, p.z));
      const curve = new THREE.CatmullRomCurve3(tpts, false, 'centripetal');
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, tpts.length), 6, 8, false), tmat);
      this.under.add(tube);
      const lens: number[] = [];
      let total = 0;
      for (let k = 1; k < pts.length; k++) { const d = pts[k].distanceTo(pts[k - 1]); lens.push(d); total += d; }
      this.paths.push({ color: new THREE.Color('#ffffff').lerp(new THREE.Color(l.color), 0.35), pts: shifted, len: lens, total, trains: l.trains });
      for (const id of l.stations) if (!stationColor.has(id)) stationColor.set(id, l.color);
      l.stations.forEach((id, k) => {
        if (stationDir.has(id)) return;
        const a = byId.get(l.stations[Math.max(0, k - 1)])!, b = byId.get(l.stations[Math.min(l.stations.length - 1, k + 1)])!;
        stationDir.set(id, Math.atan2(-(b.y - a.y), b.x - a.x));
      });
    });
    // stations
    const pav = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    for (const st of s.stations) this.addStation(st, stationColor.get(st.id) ?? '#8a8f96', pav, boxGeo, stationDir.get(st.id) ?? 0);
    this.setPlan(this.plan);
  }

  private addStation(st: StationInfo, color: string, pav: THREE.Material, boxGeo: THREE.BufferGeometry, dir: number) {
    const p = this.stationXZ(st);
    const y = this.surf(p.x, p.z);
    const grp = new THREE.Group();
    grp.position.set(p.x, y, p.z);
    grp.rotation.y = dir; // local +x runs along the line
    this.stations.add(grp);
    const box = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, yy: number, z: number, shadow = true) => {
      const m = new THREE.Mesh(boxGeo, mat);
      m.scale.set(sx, sy, sz); m.position.set(x, yy + sy / 2, z); m.castShadow = shadow; m.receiveShadow = true;
      grp.add(m); return m;
    };
    const stone = this.stationMats.stone, wall = this.stationMats.wall;
    const lineMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    // paved forecourt
    const plaza = new THREE.Mesh(this.plazaGeo, stone);
    plaza.position.y = 0.5; plaza.receiveShadow = true;
    grp.add(plaza);
    const busy = st.riders;
    if (busy < 1200) {
      // small entrance pavilion with a canopy in the line colour
      box(wall, 24, 8, 12, 0, 0.9, -8);
      box(lineMat, 30, 0.9, 20, 0, 8.9, -6);
      box(this.stationMats.glass, 14, 5, 0.6, 0, 1.2, -1.6, false);
    } else if (busy < 5000) {
      // glass hall
      box(this.stationMats.glass, 38, 13, 22, 0, 0.9, -6);
      box(wall, 40, 1.2, 24, 0, 13.9, -6);
      box(lineMat, 40.4, 2.2, 1.6, 0, 13.4, 5.6);
      box(wall, 14, 7, 10, -10, 0.9, 12);
    } else {
      // great arched glass hall with wings
      const barrel = new THREE.Mesh(this.barrelGeo, this.stationMats.glass);
      barrel.scale.set(64, 20, 34); barrel.position.set(0, 0.9, -6); barrel.castShadow = true;
      grp.add(barrel);
      for (let k = -3; k <= 3; k++) { const rib = new THREE.Mesh(this.ribGeo, lineMat); rib.scale.set(30, 20, 34); rib.position.set(k * 10, 0.9, -6); grp.add(rib); }
      box(wall, 14, 8, 30, -38, 0.9, -6);
      box(wall, 14, 8, 30, 38, 0.9, -6);
      box(lineMat, 66, 1, 2, 0, 20.9, -6);
    }
    // station sign: a pole with a line-coloured roundel
    box(this.stationMats.dark, 1.2, 18, 1.2, -20, 0.9, 16);
    const sign = new THREE.Mesh(this.signGeo, lineMat);
    sign.position.set(-20, 19.5, 16); sign.rotation.x = Math.PI / 2;
    grp.add(sign);
    const ring = new THREE.Mesh(this.ringGeo, this.stationMats.white);
    ring.position.set(-20, 19.5, 16.8);
    grp.add(ring);
    // plan-mode map marker (drawn over everything)
    const discMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
    this.discMats.push(discMat);
    const disc = new THREE.Mesh(new THREE.RingGeometry(37, 44, 40), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x, y + 4, p.z);
    disc.renderOrder = 11;
    this.stations.add(disc);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(36, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: false }));
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(p.x, y + 4.2, p.z);
    inner.renderOrder = 11;
    this.discMats.push(inner.material as THREE.Material);
    this.innerDiscs.push(inner.material as THREE.MeshBasicMaterial);
    this.stations.add(inner);
    // underground hall + shaft (x-ray)
    const hall = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0xf4efe4, emissive: color, emissiveIntensity: 0.15 }));
    hall.scale.set(90, 16, 34);
    hall.position.set(p.x, TUNNEL_Y, p.z);
    this.under.add(hall);
    const shaft = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0xe8e2d4, transparent: true, opacity: 0.8 }));
    shaft.scale.set(10, y - TUNNEL_Y, 10);
    shaft.position.set(p.x + 30, (y + TUNNEL_Y) / 2, p.z);
    this.under.add(shaft);
  }

  /** Plan mode draws the network as a diagram over everything. */
  setPlan(on: boolean) {
    this.plan = on;
    for (const m of [...this.ribbonMats, ...this.discMats]) { m.depthTest = !on; m.needsUpdate = true; }
    for (const m of this.innerDiscs) m.opacity = on ? 0.95 : 0;
    this.setXray(this.xray);
  }

  setXray(v: number) {
    this.xray = v;
    this.under.visible = v > 0.02;
    for (const m of this.ribbonMats) m.opacity = (this.plan ? 0.9 : 0.6) * (1 - v * 0.8);
  }

  draft(points: { x: number; y: number }[], hover: { x: number; y: number } | null, color: string) {
    this.draftGroup.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.draftGroup.clear();
    const raw = points.map((p) => this.stationXZ(p));
    if (hover && raw.length) raw.push(this.stationXZ(hover));
    const pts = this.smooth(raw.filter((p, k) => k === 0 || p.distanceTo(raw[k - 1]) > 1));
    if (pts.length >= 2) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      this.draftGroup.add(this.ribbon(pts, 22, mat, 4));
    }
  }

  setCursor(cell: { x: number; y: number } | null, ok = true) {
    this.cursor.visible = !!cell;
    if (!cell) return;
    const p = this.stationXZ(cell);
    this.cursor.position.set(p.x, this.surf(p.x, p.z) + 5, p.z);
    (this.cursor.material as THREE.MeshBasicMaterial).color.set(ok ? 0x2c2f33 : 0xc0503a);
  }

  animate(time: number) {
    let n = 0;
    const speed = 140; // world m per real second (time-compressed)
    for (const p of this.paths) {
      if (p.total <= 0) continue;
      for (let k = 0; k < p.trains && n < 600; k++) {
        let u = ((time * speed) / p.total + (k / p.trains) * 2) % 2;
        const fwd = u < 1;
        if (!fwd) u = 2 - u;
        let d = u * p.total, seg = 0;
        while (seg < p.len.length - 1 && d > p.len[seg]) { d -= p.len[seg]; seg++; }
        const a = p.pts[seg], b = p.pts[seg + 1];
        const t = Math.min(1, d / p.len[seg]);
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const y = this.xray > 0.5 ? TUNNEL_Y : this.surf(x, z) + 7;
        const ang = Math.atan2(b.x - a.x, b.z - a.z);
        this.v.set(x + (fwd ? 4 : -4) * Math.cos(ang), y, z - (fwd ? 4 : -4) * Math.sin(ang));
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        if (this.plan && this.xray < 0.5) this.s.set(30, 10, 130); else this.s.set(13, 9, 80);
        this.m.compose(this.v, this.q, this.s);
        this.trains.setMatrixAt(n, this.m);
        this.trains.setColorAt(n, this.plan && this.xray < 0.5 ? this.dark : p.color);
        n++;
      }
    }
    this.trains.count = n;
    this.trains.instanceMatrix.needsUpdate = true;
    if (this.trains.instanceColor) this.trains.instanceColor.needsUpdate = true;
    const tm = this.trains.material as THREE.MeshStandardMaterial;
    tm.depthTest = !this.plan || this.xray > 0.5;
  }
}
