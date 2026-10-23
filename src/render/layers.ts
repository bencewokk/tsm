import * as THREE from 'three';

/** Unit geometries, base at y = 0, footprint [-0.5, 0.5] in x and z. */
export function unitGeos() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  // gable roof: triangular prism, ridge along x
  const tri = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]);
  const gable = new THREE.ExtrudeGeometry(tri, { depth: 1, bevelEnabled: false });
  gable.translate(0, 0, -0.5);
  gable.rotateY(Math.PI / 2);
  // sawtooth roof: four teeth across x, ridges along z
  const sp: THREE.Vector2[] = [new THREE.Vector2(-0.5, 0)];
  for (let k = 0; k < 4; k++) { const x0 = -0.5 + k / 4; sp.push(new THREE.Vector2(x0, 1), new THREE.Vector2(x0 + 0.25, 0)); }
  const saw = new THREE.ExtrudeGeometry(new THREE.Shape(sp), { depth: 1, bevelEnabled: false });
  saw.translate(0, 0, -0.5);
  const pyr = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  pyr.rotateY(Math.PI / 4);
  pyr.translate(0, 0.5, 0);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  cyl.translate(0, 0.5, 0);
  const sphere = new THREE.IcosahedronGeometry(0.5, 1);
  sphere.translate(0, 0.5, 0);
  const cone = new THREE.ConeGeometry(0.5, 1, 7);
  cone.translate(0, 0.5, 0);
  // glass barrel vault (station halls): half cylinder, axis along x
  const barrel = new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1, true, 0, Math.PI);
  barrel.rotateZ(Math.PI / 2);
  barrel.scale(1, 2, 1);
  return { box, gable, saw, pyr, cyl, sphere, cone, barrel };
}

/**
 * An InstancedMesh with per-instance placement kept on the side, so instances can "rise out of the ground":
 * height and base offset scale with a 0..1 progress value.
 */
export class Layer {
  mesh: THREE.InstancedMesh;
  n = 0;
  private d: Float32Array; // x, y, z, w, h, d, rot, yoff
  private static m = new THREE.Matrix4();
  private static q = new THREE.Quaternion();
  private static v = new THREE.Vector3();
  private static s = new THREE.Vector3();
  private static up = new THREE.Vector3(0, 1, 0);
  private static c = new THREE.Color();

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, public cap: number, shadow = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.d = new Float32Array(cap * 8);
    this.mesh.setColorAt(0, Layer.c.set(0xffffff));
  }

  reset() { this.n = 0; }

  /** y = base of the lot; yoff is lifted with progress (roofs sit on walls). Returns the instance index or -1. */
  add(x: number, y: number, z: number, w: number, h: number, d: number, rot: number, color: number, yoff = 0): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.d.set([x, y, z, w, h, d, rot, yoff], i * 8);
    this.mesh.setColorAt(i, Layer.c.setHex(color));
    this.set(i, 1);
    return i;
  }

  set(i: number, p: number) {
    const a = this.d, o = i * 8;
    Layer.v.set(a[o], a[o + 1] + a[o + 7] * p, a[o + 2]);
    Layer.s.set(a[o + 3], Math.max(0.01, a[o + 4] * p), a[o + 5]);
    Layer.q.setFromAxisAngle(Layer.up, a[o + 6]);
    Layer.m.compose(Layer.v, Layer.q, Layer.s);
    this.mesh.setMatrixAt(i, Layer.m);
  }

  finish() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  touch() { this.mesh.instanceMatrix.needsUpdate = true; }
}
