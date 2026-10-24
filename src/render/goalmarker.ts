import * as THREE from 'three';
import { CELL } from '../sim/constants';

/**
 * A pulsing ring and a soft beam over the place the first goal points at ("connect Ashcombe and Holloway"). It scales with the camera
 * distance so it reads from the overview and in plan mode, and is only shown while that goal has a place. Render only.
 */
export class GoalMarker {
  group = new THREE.Group();
  private ring: THREE.Mesh;
  private ring2: THREE.Mesh;
  private beam: THREE.Mesh;
  private spot: { x: number; y: number } | null = null;

  constructor(private sample: (x: number, z: number) => number) {
    const mk = (c: string, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), mk('#e0a526', 0.9));
    this.ring2 = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), mk('#e0a526', 0.5));
    for (const r of [this.ring, this.ring2]) { r.rotation.x = -Math.PI / 2; r.renderOrder = 20; }
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 12, 1, true), mk('#f2c14e', 0.35));
    this.beam.renderOrder = 19;
    this.group.add(this.ring, this.ring2, this.beam);
    this.group.visible = false;
    this.group.name = 'goal-marker';
  }

  set(spot: { x: number; y: number } | null) {
    this.spot = spot;
    this.group.visible = !!spot;
  }

  animate(t: number, camDist: number) {
    if (!this.spot) return;
    const x = (this.spot.x + 0.5) * CELL, z = (this.spot.y + 0.5) * CELL, y = this.sample(x, z);
    const R = Math.max(110, camDist * 0.045);          // metres: constant apparent size
    const k = (t * 0.9) % 1;
    this.ring.position.set(x, y + 6, z); this.ring.scale.setScalar(R);
    this.ring2.position.set(x, y + 6, z); this.ring2.scale.setScalar(R * (1 + k * 1.4));
    (this.ring2.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
    const H = R * 3.2;
    this.beam.scale.set(R, H, R); this.beam.position.set(x, y + H / 2, z);
  }
}
