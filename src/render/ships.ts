import * as THREE from 'three';
import { CELL, N } from '../sim/constants';
import { lookUniforms } from './look';
import { VFX } from './vfx';

/**
 * Ships under way on open water: a few coasters and ferries sail slow loops in the bay or along a wide river, so the water is not
 * frozen. Routes are ellipses whose every point is at least 2 cells from land; nothing here touches the sim.
 */
export class Ships {
  group = new THREE.Group();
  private hulls: THREE.InstancedMesh;
  private decks: THREE.InstancedMesh;
  private wakes: THREE.InstancedMesh;
  private wakeMat: THREE.MeshBasicMaterial;
  private routes: { cx: number; cz: number; rx: number; rz: number; rot: number; speed: number; phase: number; dir: number; color: THREE.Color }[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private s = new THREE.Vector3();

  constructor(water: Uint8Array, seed: number) {
    // open water: water cells whose 2-cell neighbourhood is all water
    const open = (x: number, y: number) => {
      const gx = Math.floor(x), gy = Math.floor(y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N || !water[yy * N + xx]) return false;
      }
      return true;
    };
    let h = (seed * 2654435761) >>> 0;
    const rnd = () => { h = (h + 0x6d2b79f5) >>> 0; let t = Math.imul(h ^ (h >>> 15), h | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const cols = [0xd8503c, 0x2f5d8a, 0xf2efe6, 0x3b7a57, 0xe0b040];
    for (let tries = 0; tries < 400 && this.routes.length < 6; tries++) {
      const cx = 4 + rnd() * (N - 8), cy = 4 + rnd() * (N - 8);
      if (!open(cx, cy)) continue;
      const rot = rnd() * Math.PI;
      for (const scale of [1, 0.7, 0.5, 0.35]) {
        const rx = (6 + rnd() * 10) * scale, rz = (3 + rnd() * 5) * scale;
        let ok = true;
        for (let k = 0; k < 24 && ok; k++) {
          const a = (k / 24) * Math.PI * 2, ex = Math.cos(a) * rx, ez = Math.sin(a) * rz;
          ok = open(cx + ex * Math.cos(rot) - ez * Math.sin(rot), cy + ex * Math.sin(rot) + ez * Math.cos(rot));
        }
        if (!ok || rx < 2.5) continue;
        if (this.routes.some((r) => Math.hypot(r.cx - cx * CELL, r.cz - cy * CELL) < (rx + 4) * CELL)) break;
        this.routes.push({ cx: cx * CELL, cz: cy * CELL, rx: rx * CELL, rz: rz * CELL, rot, speed: 0.012 + rnd() * 0.01, phase: rnd() * Math.PI * 2, dir: rnd() < 0.5 ? 1 : -1, color: new THREE.Color(cols[Math.floor(rnd() * cols.length)]) });
        break;
      }
    }
    const hull = new THREE.BoxGeometry(1, 1, 1);
    this.hulls = new THREE.InstancedMesh(hull, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), Math.max(1, this.routes.length));
    this.decks = new THREE.InstancedMesh(hull, new THREE.MeshStandardMaterial({ color: 0xf1eee6, roughness: 0.7 }), Math.max(1, this.routes.length));
    this.hulls.count = this.decks.count = this.routes.length;
    this.hulls.frustumCulled = this.decks.frustumCulled = false;
    // wakes: a V of foam arms and a turbulent streak behind the stern, fading with distance (vertex alpha); flat, unlit, tinted down at night
    this.wakeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.wakes = new THREE.InstancedMesh(wakeGeometry(), this.wakeMat, Math.max(1, this.routes.length));
    this.wakes.count = this.routes.length; this.wakes.frustumCulled = false; this.wakes.renderOrder = 2;
    VFX.onChange((n, v) => { if (n === 'water') this.wakes.visible = v; });
    this.wakes.visible = VFX.is('water');
    this.group.add(this.hulls, this.decks, this.wakes);
    this.animate(0);
  }

  animate(time: number) {
    this.routes.forEach((r, i) => {
      const a = r.phase + r.dir * time * r.speed;
      const ex = Math.cos(a) * r.rx, ez = Math.sin(a) * r.rz;
      const x = r.cx + ex * Math.cos(r.rot) - ez * Math.sin(r.rot), z = r.cz + ex * Math.sin(r.rot) + ez * Math.cos(r.rot);
      // heading along the ellipse tangent
      const tx = -Math.sin(a) * r.rx * r.dir, tz = Math.cos(a) * r.rz * r.dir;
      const hx = tx * Math.cos(r.rot) - tz * Math.sin(r.rot), hz = tx * Math.sin(r.rot) + tz * Math.cos(r.rot);
      const ang = Math.atan2(hx, hz);
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      this.v.set(x, 8, z); this.s.set(14, 6, 62);
      this.m.compose(this.v, this.q, this.s); this.hulls.setMatrixAt(i, this.m); this.hulls.setColorAt(i, r.color);
      this.v.set(x - Math.sin(ang) * 14, 15, z - Math.cos(ang) * 14); this.s.set(10, 8, 16);
      this.m.compose(this.v, this.q, this.s); this.decks.setMatrixAt(i, this.m);
      this.v.set(x, 1.0, z); this.s.set(1, 1, 1);
      this.m.compose(this.v, this.q, this.s); this.wakes.setMatrixAt(i, this.m);
    });
    this.hulls.instanceMatrix.needsUpdate = true; this.decks.instanceMatrix.needsUpdate = true;
    this.wakes.instanceMatrix.needsUpdate = true;
    const dim = 1 - 0.7 * lookUniforms.uNight.value;
    this.wakeMat.color.setRGB(dim, dim, dim);
    if (this.hulls.instanceColor) this.hulls.instanceColor.needsUpdate = true;
  }
}

/** Local space: the ship sails towards +z; the wake lies behind it. Vertex colours carry the alpha (rgb white). */
function wakeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const strip = (pts: [number, number, number, number][]) => {   // x, z, half-width, alpha along a centre line; alpha is 0 at both edges so the foam is soft
    const base = pos.length / 3;
    pts.forEach(([x, z, hw, a], k) => {
      pos.push(x - hw, 0, z, x, 0, z, x + hw, 0, z);
      col.push(1, 1, 1, 0, 1, 1, 1, a, 1, 1, 1, 0);
      if (k) { const o = base + (k - 1) * 3; idx.push(o, o + 1, o + 3, o + 1, o + 4, o + 3, o + 1, o + 2, o + 4, o + 2, o + 5, o + 4); }
    });
  };
  // turbulent centre streak
  strip([[0, -24, 4, 0.0], [0, -36, 8, 0.4], [0, -100, 13, 0.22], [0, -190, 20, 0.0]]);
  // the two arms of the V, drifting outwards
  for (const sd of [1, -1]) strip([[sd * 7, 22, 1.5, 0.0], [sd * 11, 4, 3, 0.5], [sd * 27, -60, 4.5, 0.3], [sd * 52, -150, 6, 0.0]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
