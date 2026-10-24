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
  /** redraw policy: the shadow map is redrawn only when something it shows changed (see SunShadow.frame) */
  policy: true,
  /** reference caster height (m) for the sun criterion: redraw when its shadow tip would move more than tipTexels texels */
  tipHeight: 60,
  tipTexels: 0.5,
  /** with moving casters (crane jibs, rising buildings) the map is never older than this (ms) */
  moverMs: 250,
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
  /** set by the caller when static casters changed (city chunks, sites, construction, metro) */
  dirty = true;
  /** set by the caller while casters move on their own (crane jibs turning, buildings rising) */
  movers = false;
  /** frames seen and shadow redraws, by reason */
  frames = 0;
  redraws = 0;
  why: Record<string, number> = { first: 0, geometry: 0, sun: 0, movers: 0, camera: 0, always: 0 };
  private drawn = false;
  private lastDraw = -1e9;
  private drawDir = new THREE.Vector3();
  private d = new THREE.Vector3();

  constructor(private sun: THREE.DirectionalLight, private renderer: THREE.WebGLRenderer, private groundTop: number, private casterTop: number) {
    sun.shadow.mapSize.set(SHADOW.size, SHADOW.size);
    renderer.shadowMap.autoUpdate = false;
  }

  /**
   * Once per frame, after the sun was placed for this frame: decide whether the shadow map is redrawn. It is when the static casters
   * changed, when the sun moved enough that a 60 m building's shadow tip would shift by half a texel (so the step stays below what the
   * map resolves; at dusk the long shadows make that every frame or two, at noon about every 0.3 s; the threshold widens as the sun
   * dims), at least every 250 ms while crane jibs turn or buildings rise, and when the camera's footprint leaves the fitted frustum.
   * Between redraws the light still moves for shading; the shadow lookup keeps the matrix of the last redraw, so they stay consistent.
   */
  frame(camera: THREE.PerspectiveCamera, now: number): boolean {
    this.frames++;
    const d = this.dir(this.d);
    let why = '';
    if (!SHADOW.policy) why = 'always';
    else if (!this.drawn) why = 'first';
    else if (this.dirty) why = 'geometry';
    else if (this.sunMoved(d)) why = 'sun';
    else if (this.movers && now - this.lastDraw > SHADOW.moverMs) why = 'movers';
    else if (!this.covers(camera)) why = 'camera';
    if (!why) { this.place(d); return false; }
    this.redraw(camera, now);
    this.why[why]++;
    return true;
  }

  /** Redraw now (refit for the current sun and camera). */
  redraw(camera: THREE.PerspectiveCamera, now = performance.now()) {
    this.update(camera, true);
    this.renderer.shadowMap.needsUpdate = true;
    this.drawDir.copy(this.dir(this.d));
    this.lastDraw = now; this.dirty = false; this.drawn = true;
    this.redraws++;
  }

  /** How far (m) the shadow tip of a tipHeight building moved since the last redraw, against half a texel scaled by shadow contrast. */
  private sunMoved(d: THREE.Vector3): boolean {
    const a = this.drawDir, H = SHADOW.tipHeight;
    const ay = Math.max(0.02, a.y), dy = Math.max(0.02, d.y);
    const dx = (d.x / dy - a.x / ay) * H, dz = (d.z / dy - a.z / ay) * H;
    const contrast = Math.min(1, Math.max(0.06, (this.sun.intensity - 0.15) / 2.4));
    return Math.hypot(dx, dz) > SHADOW.tipTexels * this.texel / contrast;
  }

  /** Does the fitted frustum (in the light space of the last redraw) still cover the camera's footprint, without being far too large? */
  private covers(camera: THREE.PerspectiveCamera): boolean {
    const f = this.fit;
    if (!f) return false;
    const fp = this.footprint(camera, this.fitDir);
    const inside = fp.l >= f.l && fp.r <= f.r && fp.b >= f.b && fp.t <= f.t;
    return inside && (f.r - f.l) * (f.t - f.b) < this.need(fp) * 2.6;
  }

  /** Area the frustum needs for a footprint (with the margin, and at least minTexel per texel on each axis). */
  private need(fp: { l: number; r: number; b: number; t: number }) {
    const m = SHADOW.margin, minW = SHADOW.minTexel * SHADOW.size;
    return Math.max(minW, (fp.r - fp.l) * (1 + 2 * m)) * Math.max(minW, (fp.t - fp.b) * (1 + 2 * m));
  }

  /** The light sits 12 km from the board centre along its direction (the fitted depth range assumes it). */
  private place(d: THREE.Vector3) {
    this.sun.target.position.set(MAP / 2, 0, MAP / 2);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(MAP / 2, 0, MAP / 2).addScaledVector(d, 12000);
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
    this.place(d);
    const fp = this.footprint(camera, d);
    const f = this.fit;
    if (!force && f && d.distanceTo(this.fitDir) < 1e-6) {
      const inside = fp.l >= f.l && fp.r <= f.r && fp.b >= f.b && fp.t <= f.t;
      if (inside && (f.r - f.l) * (f.t - f.b) < this.need(fp) * 2.6) return false;
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

/**
 * Cars no longer cast into the sun's shadow map (it is not redrawn every frame, so their shadows would trail behind them). Instead each car
 * gets a soft contact shadow on the road under it, offset away from the sun by its height and faded with the daylight: one instanced
 * quad per car, drawn in one call. Trains never cast shadows; crane jibs stay in the shadow map (refreshed at least every 250 ms).
 */
export class CarBlobs {
  mesh: THREE.InstancedMesh;
  private mat: THREE.MeshBasicMaterial;
  private m = new THREE.Matrix4();

  constructor(private cars: THREE.InstancedMesh, private visible: () => boolean) {
    cars.castShadow = false;
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 64;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(16, 32, 4, 16, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.55, 'rgba(255,255,255,0.85)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 64);
    const tex = new THREE.CanvasTexture(cv);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x1d2230, alphaMap: tex, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, cars.instanceMatrix.count);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  }

  /** Follow the cars (after they moved this frame). `toSun` is the unit direction to the sun, `day` 0..1. */
  update(toSun: THREE.Vector3, day: number) {
    const on = this.visible() && day > 0.02;
    this.mesh.visible = on;
    if (!on) return;
    const src = this.cars.instanceMatrix.array as Float32Array, dst = this.mesh.instanceMatrix.array as Float32Array, n = this.cars.count;
    const k = 1.4 / Math.max(0.12, toSun.y), ox = Math.max(-8, Math.min(8, -toSun.x * k)), oz = Math.max(-8, Math.min(8, -toSun.z * k));
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      // car matrix columns: x (width 4.6), y (height 3.2), z (length 10.5), translation (car centre, 1.9 above the ground)
      dst[o] = src[o] * 1.25; dst[o + 1] = src[o + 1] * 1.25; dst[o + 2] = src[o + 2] * 1.25; dst[o + 3] = 0;
      dst[o + 4] = 0; dst[o + 5] = 1; dst[o + 6] = 0; dst[o + 7] = 0;
      dst[o + 8] = src[o + 8] * 1.12; dst[o + 9] = src[o + 9] * 1.12; dst[o + 10] = src[o + 10] * 1.12; dst[o + 11] = 0;
      const y = src[o + 13], wet = Math.abs(y - 6.6) < 0.01;   // on a bridge deck the car sits at 6.6
      dst[o + 12] = src[o + 12] + ox; dst[o + 13] = wet ? y - 0.3 : y - 0.95; dst[o + 14] = src[o + 14] + oz; dst[o + 15] = 1;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges(); this.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mat.opacity = 0.3 * day;
  }
}
