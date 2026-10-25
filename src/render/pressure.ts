import * as THREE from 'three';
import { CELL } from '../sim/constants';
import type { LinkCandidate } from '../sim/pressure';

const COL: Record<string, number> = { walk: 0x2f9a5a, car: 0xd9772b, transit: 0x3d6fd6 };

/**
 * The demand pressure overlay (round 7, step 3): the missing-link candidates as dashed ribbons just above the ground (green = a path or
 * footbridge would shorten many walks, orange = a road connector would shorten many drives), width by score. The pressure fields themselves are
 * painted on the terrain (terrain.setPressure).
 */
export class PressureView {
  group = new THREE.Group();
  private mats = new Map<string, THREE.MeshBasicMaterial>();
  private sig = '';

  private mat(kind: string) {
    let m = this.mats.get(kind);
    if (!m) { m = new THREE.MeshBasicMaterial({ color: COL[kind] ?? 0x888888, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false }); this.mats.set(kind, m); }
    return m;
  }

  update(cands: LinkCandidate[], ground: (x: number, z: number) => number) {
    const sig = cands.map((c) => `${c.kind}${c.a},${c.b},${Math.round(c.score)}`).join(';');
    if (sig === this.sig) return;
    this.sig = sig;
    this.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.group.clear();
    if (!cands.length) return;
    const max = Math.max(...cands.map((c) => c.score));
    for (const c of cands) {
      const ax = c.ax * CELL, az = c.ay * CELL, bx = c.bx * CELL, bz = c.by * CELL;
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(2, Math.floor(L / 90));
      const r = 5 + 12 * Math.sqrt(c.score / max);
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = t0 + 0.6 / n;
        const p0 = new THREE.Vector3(ax + (bx - ax) * t0, 0, az + (bz - az) * t0), p1 = new THREE.Vector3(ax + (bx - ax) * t1, 0, az + (bz - az) * t1);
        p0.y = ground(p0.x, p0.z) + 18; p1.y = ground(p1.x, p1.z) + 18;
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(p0, p1), 1, r, 4, false), this.mat(c.kind));
        mesh.renderOrder = 16;
        this.group.add(mesh);
      }
    }
  }
}
