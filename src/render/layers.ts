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
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  cyl.translate(0, 0.5, 0);
  const sphere = new THREE.IcosahedronGeometry(0.5, 0);
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
/** Floats per precomputed instance record (see Layer.rec). */
export const REC = 27;

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
    const a = this.d, o = i * 8;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w; a[o + 4] = h; a[o + 5] = d; a[o + 6] = rot; a[o + 7] = yoff;
    this.mesh.setColorAt(i, Layer.c.setHex(color));
    this.set(i, 1);
    return i;
  }

  /**
   * Precomputed instance record (REC floats: placement 8, matrix 16, linear colour 3), appended to `out`: what `add` would write,
   * so static instances can be re-added later by a plain copy (`addRec`).
   */
  static rec(out: number[], x: number, y: number, z: number, w: number, h: number, d: number, rot: number, color: number, yoff = 0) {
    // the placement goes through float32 first, exactly as `add` stores it before composing the matrix
    const f = Math.fround;
    x = f(x); y = f(y); z = f(z); w = f(w); h = f(h); d = f(d); rot = f(rot); yoff = f(yoff);
    Layer.v.set(x, y + yoff, z);
    Layer.s.set(w, Math.max(0.01, h), d);
    Layer.q.setFromAxisAngle(Layer.up, rot);
    Layer.m.compose(Layer.v, Layer.q, Layer.s);
    Layer.c.setHex(color);
    out.push(x, y, z, w, h, d, rot, yoff, ...Layer.m.elements, Layer.c.r, Layer.c.g, Layer.c.b);
  }

  /** Append the records rec[o .. o + n * REC) (see `rec`). */
  addRecs(rec: ArrayLike<number>, o = 0, n = rec.length / REC) {
    const mat = this.mesh.instanceMatrix.array as Float32Array, col = this.mesh.instanceColor!.array as Float32Array, a = this.d;
    for (let k = 0; k < n && this.n < this.cap; k++) {
      const i = this.n++, b = o + k * REC;
      for (let q = 0; q < 8; q++) a[i * 8 + q] = rec[b + q];
      for (let q = 0; q < 16; q++) mat[i * 16 + q] = rec[b + 8 + q];
      col[i * 3] = rec[b + 24]; col[i * 3 + 1] = rec[b + 25]; col[i * 3 + 2] = rec[b + 26];
    }
  }

  set(i: number, p: number) {
    const a = this.d, o = i * 8;
    Layer.v.set(a[o], a[o + 1] + a[o + 7] * p, a[o + 2]);
    Layer.s.set(a[o + 3], Math.max(0.01, a[o + 4] * p), a[o + 5]);
    Layer.q.setFromAxisAngle(Layer.up, a[o + 6]);
    Layer.m.compose(Layer.v, Layer.q, Layer.s);
    this.mesh.setMatrixAt(i, Layer.m);
  }

  /** Upload only the used part of the instance buffers (they are sized for the cap, mostly empty). */
  finish() {
    this.mesh.count = this.n;
    const m = this.mesh.instanceMatrix, c = this.mesh.instanceColor;
    m.clearUpdateRanges(); m.addUpdateRange(0, Math.max(1, this.n) * 16); m.needsUpdate = true;
    if (c) { c.clearUpdateRanges(); c.addUpdateRange(0, Math.max(1, this.n) * 3); c.needsUpdate = true; }
  }

  touch() { const m = this.mesh.instanceMatrix; m.clearUpdateRanges(); m.addUpdateRange(0, Math.max(1, this.n) * 16); m.needsUpdate = true; }
}
