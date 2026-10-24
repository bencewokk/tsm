import * as THREE from 'three';
import { MAP } from './common';

/**
 * Sun shadow map: 2048 x 2048, its orthographic frustum fitted to the part of the model the camera sees (instead of a fixed box 1.5x the
 * map), bias and PCF radius scaled with the texel size so the penumbra keeps its width in metres.
 *
 * Fit: the camera's ground footprint (frustum rays to the ground, clamped to the board) is projected into light space; the frustum is
 * that box plus a margin, snapped to whole texels and to a size ladder, and refitted only when the footprint leaves it or it is far
 * larger than needed. Depth covers every caster on the board, so off-screen buildings still shade the visible ground.
 */
export const SHADOW = {
  size: 2048,
  /** smallest texel (m): keeps the penumbra as wide as with the old 4096 map over 9600 m (2.34 m texels, PCF radius 4) when zoomed in */
  minTexel: 1.57,
  /** penumbra width in metres (old: radius 4 x 2.34 m texels) */
  blur: 9.4,
  /** depth bias in metres along the light (old: 0.0004 of a 15900 m depth range) and normal bias in texels (old: 1.5 m at 2.34 m) */
  depthBias: 6.4,
  normalBiasTexels: 0.64,
  margin: 0.12,
};

export class SunShadow {
  /** light-space bounds currently fitted (left, right, bottom, top) and the light direction they were fitted for */
  private fit: { l: number; r: number; b: number; t: number } | null = null;
  private fitDir = new THREE.Vector3();
  private cam = new THREE.OrthographicCamera();
  private ray = new THREE.Raycaster();
  private v = new THREE.Vector3();
  private ndc = new THREE.Vector2();
  /** fitted texel size (m) */
  texel = 2.34;
  /** times the frustum was refitted */
  refits = 0;

  constructor(private sun: THREE.DirectionalLight, private groundTop: number, private casterTop: number) {
    sun.shadow.mapSize.set(SHADOW.size, SHADOW.size);
  }

  /** Light direction (unit, towards the sun) from the light's current placement. */
  dir(out: THREE.Vector3) { return out.copy(this.sun.position).sub(this.sun.target.position).normalize(); }

  /** Ground footprint of the camera, in light space for the light direction `d` (min / max x and y). */
  private footprint(camera: THREE.PerspectiveCamera, d: THREE.Vector3) {
    const view = this.lightView(d, new THREE.Vector3(MAP / 2, 0, MAP / 2));
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity;
    const pad = 150, lim = MAP * 2.5;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      this.ndc.set(i, j);
      this.ray.setFromCamera(this.ndc, camera);
      const o = this.ray.ray.origin, dd = this.ray.ray.direction;
      let k = dd.y < -1e-4 ? -o.y / dd.y : lim;
      if (k > lim) k = lim;
      const x = Math.max(-pad, Math.min(MAP + pad, o.x + dd.x * k)), z = Math.max(-pad, Math.min(MAP + pad, o.z + dd.z * k));
      for (const y of [0, this.groundTop]) {
        this.v.set(x, y, z).applyMatrix4(view);
        if (this.v.x < l) l = this.v.x; if (this.v.x > r) r = this.v.x;
        if (this.v.y < b) b = this.v.y; if (this.v.y > t) t = this.v.y;
      }
    }
    return { l, r, b, t };
  }

  /** World -> light view matrix for direction d, the light looking at `at` (same convention as the shadow camera). */
  private lightView(d: THREE.Vector3, at: THREE.Vector3) {
    this.cam.position.copy(at).addScaledVector(d, 12000);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(at);
    this.cam.updateMatrixWorld(true);
    return this.cam.matrixWorldInverse.clone();
  }

  /**
   * Fit the frustum for the current camera and light direction. Returns true when it changed (the shadow map must be redrawn).
   * `force` refits even if the old frustum still covers the view (the light direction changed).
   */
  update(camera: THREE.PerspectiveCamera, force = false): boolean {
    const d = this.dir(new THREE.Vector3());
    // the light always sits 12 km from the board centre along its direction, so the depth range fitted below holds
    this.sun.target.position.set(MAP / 2, 0, MAP / 2);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(MAP / 2, 0, MAP / 2).addScaledVector(d, 12000);
    const fp = this.footprint(camera, d);
    const f = this.fit;
    if (!force && f && d.distanceTo(this.fitDir) < 1e-6) {
      const inside = fp.l >= f.l && fp.r <= f.r && fp.b >= f.b && fp.t <= f.t;
      const area = (f.r - f.l) * (f.t - f.b), need = Math.max(1, (fp.r - fp.l) * (fp.t - fp.b));
      if (inside && area < need * 2.6) return false;
    }
    // frustum: the footprint plus a margin, square-ish texels, at least minTexel per texel, sizes on a 15% ladder, snapped to texels
    const S = SHADOW.size, m = SHADOW.margin;
    let w = (fp.r - fp.l) * (1 + 2 * m), h = (fp.t - fp.b) * (1 + 2 * m);
    const minW = SHADOW.minTexel * S;
    w = Math.max(w, minW); h = Math.max(h, minW);
    const ladder = (x: number) => minW * Math.pow(1.15, Math.ceil(Math.log(x / minW) / Math.log(1.15) - 1e-9));
    w = ladder(w); h = ladder(h);
    const tx = w / S, ty = h / S;
    const cx = Math.round((fp.l + fp.r) / 2 / tx) * tx, cy = Math.round((fp.b + fp.t) / 2 / ty) * ty;
    this.fit = { l: cx - w / 2, r: cx + w / 2, b: cy - h / 2, t: cy + h / 2 };
    this.fitDir.copy(d);
    this.texel = Math.max(tx, ty);
    this.apply(d);
    this.refits++;
    return true;
  }

  /** Place the light on the fitted frustum (the shadow camera follows the light: target at the centre of the board). */
  private apply(d: THREE.Vector3) {
    const f = this.fit!, sh = this.sun.shadow, c = sh.camera;
    // the light keeps its direction; it sits at a fixed distance from the board centre, the frustum is offset in light space
    const at = new THREE.Vector3(MAP / 2, 0, MAP / 2);
    // depth: every caster on the board (0..MAP, -120..casterTop) in light space
    const view = this.lightView(d, at);
    let near = Infinity, far = -Infinity;
    for (const x of [0, MAP]) for (const z of [0, MAP]) for (const y of [-120, this.casterTop]) {
      this.v.set(x, y, z).applyMatrix4(view);
      if (-this.v.z < near) near = -this.v.z; if (-this.v.z > far) far = -this.v.z;
    }
    c.left = f.l; c.right = f.r; c.bottom = f.b; c.top = f.t;
    c.near = Math.max(1, near - 50); c.far = far + 50;
    c.updateProjectionMatrix();
    const range = c.far - c.near;
    sh.bias = -SHADOW.depthBias / range;
    sh.normalBias = SHADOW.normalBiasTexels * this.texel;
    sh.radius = Math.max(1, Math.min(6, SHADOW.blur / this.texel));
  }
}
