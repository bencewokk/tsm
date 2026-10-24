import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GradePass } from './grade';
import { Sky } from './sky';
import { VFX } from './vfx';
import { skyLight, lookUniforms } from './look';
import { MAP, VS } from './common';
import { strataTexture } from './terrain';

export class Env {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** 0 = noon, 0.5 = midnight; advanced by the caller */
  timeOfDay = 0.16;
  night = 0; // 0..1 derived
  /**
   * The scene renders into a linear half-float target and one output pass tone-maps it to the screen, so transparent layers (metro
   * ribbons, paper, water, ghost blocks) blend in linear light as they always have. Dev only: false renders straight to the canvas
   * (cheaper, but those layers blend after tone mapping and read paler).
   */
  linear = true;
  private composer: EffectComposer;
  sky = new Sky();
  private grade!: GradePass;
  /**
   * Render scale of the 3D scene (1 = full canvas resolution): the scene target is smaller and the output pass upscales it. Below 1 the
   * map labels (`addText`) move to an overlay drawn afterwards at full resolution, so text stays sharp; the HUD is HTML anyway.
   */
  scale = 1;
  overlay = new THREE.Scene();
  private texts: THREE.Object3D[] = [];
  private daySky = new THREE.Color('#e9eef0');
  private duskSky = new THREE.Color('#e8cdb8');
  private nightSky = new THREE.Color('#1a2233');

  constructor(container: HTMLElement) {
    // no MSAA on the canvas: the image comes from the output pass (a full-screen quad), the scene target has no MSAA either
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(32, container.clientWidth / container.clientHeight, 20, 40000);
    this.camera.position.set(MAP * 0.5 + 3600, 4200, MAP * 0.5 + 4800);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(MAP * 0.5, 0, MAP * 0.55);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 250;
    this.controls.maxDistance = 14000;
    this.controls.screenSpacePanning = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.update();

    this.scene.background = this.daySky.clone();
    this.scene.fog = new THREE.Fog(this.daySky.getHex(), 9000, 26000);

    this.hemi = new THREE.HemisphereLight(0xf4f6f8, 0xd9d4c4, 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff6e8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);   // frustum, bias and radius are fitted every frame by SunShadow (shadows.ts)
    const sc = this.sun.shadow.camera;
    sc.left = -MAP * 0.75; sc.right = MAP * 0.75; sc.top = MAP * 0.75; sc.bottom = -MAP * 0.75;
    sc.near = 100; sc.far = 16000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.5;
    this.sun.shadow.radius = 4;
    this.sun.target.position.set(MAP / 2, 0, MAP / 2);
    this.scene.add(this.sun, this.sun.target);

    // base board under the model
    // the model sits on a board whose edge shows the same cork / wood layers as the terrain's skirt
    const strata = strataTexture();
    strata.repeat.set(12, 60 / (20 * VS));
    const side = new THREE.MeshStandardMaterial({ map: strata, roughness: 1 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0xece8de, roughness: 1 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(MAP + 400, 60, MAP + 400), [side, side, faceMat, faceMat, side, side]);
    board.position.set(MAP / 2, -70, MAP / 2);
    board.receiveShadow = true;
    board.name = 'board';
    this.scene.add(board);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.grade = new GradePass();
    this.composer.addPass(this.grade);
    this.scene.add(this.sky.group);
    VFX.onChange((n) => { if (n === 'sky' || n === 'grade') this.applyTime(); });

    window.addEventListener('resize', () => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.composer.setSize(container.clientWidth, container.clientHeight);
    });
    this.applyTime();
  }

  render() {
    this.sky.follow(this.camera);
    // camera feel: the lens widens as the camera comes down to street level (more perspective close in, a compressed model view far out);
    // eased towards its target so a zoom never snaps. 32 degrees at overview, as before.
    {
      const d = this.camera.position.distanceTo(this.controls.target);
      const tf = VFX.is('cam') ? 32 + 12 * (1 - THREE.MathUtils.smoothstep(d, 400, 4800)) : 32;
      if (Math.abs(this.camera.fov - tf) > 0.01) { this.camera.fov += (tf - this.camera.fov) * 0.2; this.camera.updateProjectionMatrix(); }
    }
    lookUniforms.uTime.value = performance.now() / 1000;
    lookUniforms.uTreeKeep.value = VFX.is('thin') ? 1 - 0.55 * THREE.MathUtils.smoothstep(this.camera.position.distanceTo(this.controls.target), 3000, 6000) : 1;
    lookUniforms.uPx.value = this.composer.renderTarget1.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    if (this.linear) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    if (this.overlay.children.length) {
      const r = this.renderer, ac = r.autoClear;
      r.autoClear = false;
      r.render(this.overlay, this.camera);
      r.autoClear = ac;
    }
  }

  /** Text that should stay sharp at any render scale (map labels). */
  addText(o: THREE.Object3D) { this.texts.push(o); (this.scale < 1 ? this.overlay : this.scene).add(o); }

  setScale(s: number) {
    if (s === this.scale) return;
    this.scale = s;
    this.composer.setPixelRatio(this.renderer.getPixelRatio() * s);
    for (const o of this.texts) (s < 1 ? this.overlay : this.scene).add(o);
  }

  focus(x: number, z: number, dist: number) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(x, 0, z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  /** Recompute sun / sky / light colours from timeOfDay. */
  applyTime() {
    const a = this.timeOfDay * Math.PI * 2; // 0 = noon
    const elev = Math.cos(a); // 1 noon, -1 midnight
    const az = a + 0.6;
    const r = 7000;
    const sunUp = Math.max(0.08, elev);
    this.sun.position.set(MAP / 2 + Math.sin(az) * r * 0.8, r * sunUp, MAP / 2 + Math.cos(az) * r * 0.6 + 2000);
    const day = THREE.MathUtils.smoothstep(elev, -0.25, 0.3);
    this.night = 1 - day;
    const dusk = Math.max(0, 1 - Math.abs(elev - 0.0) / 0.35) * 0.8;
    const sky = VFX.is('sky'), grade = VFX.is('grade');
    // share of lit windows by the hour: busy evening, quiet small hours, waking towards dawn (t = timeOfDay, 0.2 dusk .. 0.5 midnight .. 0.8 dawn)
    const tn = this.timeOfDay;
    lookUniforms.uLitP.value = VFX.is('bld') ? 0.7 - 0.4 * THREE.MathUtils.smoothstep(tn, 0.22, 0.5) + 0.22 * THREE.MathUtils.smoothstep(tn, 0.6, 0.8) : 0.52;
    this.sun.intensity = sky ? 0.2 + 2.85 * day : 0.15 + 2.4 * day;   // night stays near 0.15: SunShadow redraws less often the weaker the sun
    this.hemi.intensity = sky ? 0.85 + 0.25 * day : 0.35 + 1.15 * day;
    if (!sky) {
      // the classic look
      this.sun.color.setHSL(0.09, 0.5 * dusk + 0.15, 0.92 - dusk * 0.12);
      this.hemi.color.set(day > 0.5 ? 0xf4f6f8 : 0x9fb0d0);
      this.hemi.groundColor.set(0xd9d4c4);
      const cl = this.nightSky.clone().lerp(this.daySky, day).lerp(this.duskSky, dusk * 0.5);
      (this.scene.background as THREE.Color).copy(cl);
      const f = this.scene.fog as THREE.Fog;
      f.color.copy(cl); f.near = 9000; f.far = 26000;
      this.sky.group.visible = false;
      this.renderer.toneMappingExposure = 0.85 + 0.2 * day;
    } else {
      sampleKeys(elev, this.keys);
      const k = this.keys;
      this.sun.color.copy(k.sun);
      this.hemi.color.copy(k.hemiS); this.hemi.groundColor.copy(k.hemiG);
      (this.scene.background as THREE.Color).copy(k.hor);
      const f = this.scene.fog as THREE.Fog;
      f.color.copy(k.hor).lerp(k.table, 0.12);
      f.near = 3200; f.far = 21000;
      this.sky.group.visible = true;
      const u = this.sky.u;
      u.uZenith.value.copy(k.zen); u.uHorizon.value.copy(k.hor); u.uSunCol.value.copy(k.sun); u.uTable.value.copy(k.table);
      u.uNight.value = this.night;
      u.uSunDir.value.copy(this.sun.position).sub(this.sun.target.position).normalize();
      this.renderer.toneMappingExposure = 1.0 + 0.1 * day;
      // tint for unlit layers (the paper): sun and sky light as one colour, 1 at full daylight
      const sl = skyLight, si = this.sun.intensity * 0.12, hi = this.hemi.intensity * 0.5, n = 1 / 0.92;
      sl.r = Math.min(1, (k.sun.r * si + k.hemiS.r * hi) * n); sl.g = Math.min(1, (k.sun.g * si + k.hemiS.g * hi) * n); sl.b = Math.min(1, (k.sun.b * si + k.hemiS.b * hi) * n);
    }
    // display-space grade
    const g = this.grade.grade;
    if (grade) {
      g.uSat.value = 1.1 - 0.12 * this.night; g.uContrast.value = 1.07 - 0.06 * this.night;
      // cool shadows and warm highlights
      g.uShadow.value.set(0.97, 0.99, 1.04 + 0.05 * this.night); g.uHigh.value.set(1.015 + 0.03 * dusk, 1.0, 0.98 - 0.05 * dusk);
      g.uVig.value = 0.22;
    } else { g.uSat.value = 1; g.uContrast.value = 1; g.uShadow.value.set(1, 1, 1); g.uHigh.value.set(1, 1, 1); g.uVig.value = 0; }
  }
  private keys = { hor: new THREE.Color(), zen: new THREE.Color(), sun: new THREE.Color(), hemiS: new THREE.Color(), hemiG: new THREE.Color(), table: new THREE.Color() };
}

/** Time-of-day palette keyed by the sun's elevation (-1 midnight .. 1 noon), interpolated linearly. */
const KEYS = [
  { e: -1.0, hor: '#16203a', zen: '#04070f', sun: '#a9c0f0', hemiS: '#7f9bd6', hemiG: '#2a3552', table: '#161a24' },
  { e: -0.25, hor: '#1f2a48', zen: '#070c18', sun: '#a9c0f0', hemiS: '#7f9bd6', hemiG: '#2a3552', table: '#1a1f2c' },
  { e: 0.0, hor: '#e8a47e', zen: '#46598a', sun: '#ff8a4a', hemiS: '#9aa6cc', hemiG: '#8c7566', table: '#a8907c' },
  { e: 0.16, hor: '#f0c79e', zen: '#6a90c0', sun: '#ffb676', hemiS: '#bccae6', hemiG: '#b49c82', table: '#c6b098' },
  { e: 0.34, hor: '#e0d8cc', zen: '#78a4d4', sun: '#ffe6c4', hemiS: '#cfdcf0', hemiG: '#b5a891', table: '#ccc3b4' },
  { e: 0.7, hor: '#d4e1ec', zen: '#76aae0', sun: '#fff7ee', hemiS: '#dbe8f9', hemiG: '#b9b09c', table: '#cfcac0' },
  { e: 1.0, hor: '#d4e1ec', zen: '#76aae0', sun: '#fff8f0', hemiS: '#dbe8f9', hemiG: '#b9b09c', table: '#cfcac0' },
];
type Pal = { hor: THREE.Color; zen: THREE.Color; sun: THREE.Color; hemiS: THREE.Color; hemiG: THREE.Color; table: THREE.Color };
const KC = KEYS.map((k) => ({ e: k.e, hor: new THREE.Color(k.hor), zen: new THREE.Color(k.zen), sun: new THREE.Color(k.sun), hemiS: new THREE.Color(k.hemiS), hemiG: new THREE.Color(k.hemiG), table: new THREE.Color(k.table) }));
function sampleKeys(e: number, out: Pal) {
  let i = 1;
  while (i < KC.length - 1 && e > KC[i].e) i++;
  const a = KC[i - 1], b = KC[i], t = Math.max(0, Math.min(1, (e - a.e) / (b.e - a.e)));
  out.hor.copy(a.hor).lerp(b.hor, t); out.zen.copy(a.zen).lerp(b.zen, t); out.sun.copy(a.sun).lerp(b.sun, t);
  out.hemiS.copy(a.hemiS).lerp(b.hemiS, t); out.hemiG.copy(a.hemiG).lerp(b.hemiG, t); out.table.copy(a.table).lerp(b.table, t);
}
