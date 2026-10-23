import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { MAP } from './common';

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
  tilt = false;
  private composer: EffectComposer;
  private hblur: ShaderPass;
  private vblur: ShaderPass;
  private daySky = new THREE.Color('#e9eef0');
  private duskSky = new THREE.Color('#e8cdb8');
  private nightSky = new THREE.Color('#1a2233');

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
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
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -MAP * 0.75; sc.right = MAP * 0.75; sc.top = MAP * 0.75; sc.bottom = -MAP * 0.75;
    sc.near = 100; sc.far = 16000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.5;
    this.sun.shadow.radius = 4;
    this.sun.target.position.set(MAP / 2, 0, MAP / 2);
    this.scene.add(this.sun, this.sun.target);

    // base board under the model
    const board = new THREE.Mesh(new THREE.BoxGeometry(MAP + 400, 60, MAP + 400), new THREE.MeshStandardMaterial({ color: 0xece8de, roughness: 1 }));
    board.position.set(MAP / 2, -70, MAP / 2);
    board.receiveShadow = true;
    board.name = 'board';
    this.scene.add(board);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.hblur = new ShaderPass(HorizontalTiltShiftShader);
    this.vblur = new ShaderPass(VerticalTiltShiftShader);
    this.composer.addPass(this.hblur);
    this.composer.addPass(this.vblur);
    this.composer.addPass(new OutputPass());
    this.sizeBlur();

    window.addEventListener('resize', () => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.composer.setSize(container.clientWidth, container.clientHeight);
      this.sizeBlur();
    });
    this.applyTime();
  }

  private sizeBlur() {
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    this.hblur.uniforms.h.value = 2.2 / w;
    this.vblur.uniforms.v.value = 2.2 / h;
    this.hblur.uniforms.r.value = 0.5;
    this.vblur.uniforms.r.value = 0.5;
  }

  render() {
    if (this.tilt) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  focus(x: number, z: number, dist: number) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(x, 0, z);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  /** Recompute sun / sky from timeOfDay. */
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
    this.sun.intensity = 0.15 + 2.4 * day;
    this.sun.color.setHSL(0.09, 0.5 * dusk + 0.15, 0.92 - dusk * 0.12);
    this.hemi.intensity = 0.35 + 1.15 * day;
    this.hemi.color.set(day > 0.5 ? 0xf4f6f8 : 0x9fb0d0);
    const sky = this.nightSky.clone().lerp(this.daySky, day).lerp(this.duskSky, dusk * 0.5);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.renderer.toneMappingExposure = 0.85 + 0.2 * day;
  }
}
