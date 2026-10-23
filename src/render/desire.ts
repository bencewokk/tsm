import * as THREE from 'three';
import type { DesireLine } from '../sim/protocol';
import { CELL } from '../sim/constants';

/** Arcs showing the strongest unmet transit demand (trips still going by car) between zones. */
export class DesireView {
  group = new THREE.Group();
  private mat = new THREE.MeshBasicMaterial({ color: 0xc8467e, transparent: true, opacity: 0.7, depthWrite: false });

  update(lines: DesireLine[]) {
    this.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.group.clear();
    if (!lines.length) return;
    const max = lines[0].trips;
    for (const d of lines) {
      const a = new THREE.Vector3(d.ax * CELL, 30, d.ay * CELL);
      const b = new THREE.Vector3(d.bx * CELL, 30, d.by * CELL);
      const dist = a.distanceTo(b);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y = 120 + dist * 0.28;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const r = 4 + 14 * Math.sqrt(d.trips / max);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, r, 5, false), this.mat);
      mesh.renderOrder = 15;
      this.group.add(mesh);
    }
  }
}
