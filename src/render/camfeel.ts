import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VFX } from './vfx';

/**
 * Camera feel: the wheel sets a zoom goal and the camera eases towards it (a frame-rate independent exponential), scaling the whole camera
 * frame about the ground point under the cursor, so the spot you point at stays under the pointer while you zoom in or out (the stock
 * OrbitControls dolly jumps 5 % per notch about the screen centre). Rotation keeps the controls' own damping; the pinch / two-finger touch
 * zoom is left to OrbitControls (only wheel events are taken over). `?novfx=cam` or `vfx.set('cam', false)` hands the wheel back.
 * Presentation only: nothing here reads or writes game state.
 */
export class CamFeel {
  private goal: number | null = null;
  private pivot = new THREE.Vector3();
  private lastD = 0;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmp = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private controls: OrbitControls, private el: HTMLElement, private bounds: number) {
    el.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
  }

  private dist() { return this.camera.position.distanceTo(this.controls.target); }

  private onWheel(e: WheelEvent) {
    if (!VFX.is('cam') || !this.controls.enabled || !this.controls.enableZoom) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const d = this.dist();
    const base = this.goal !== null && Math.abs(this.lastD - d) < d * 0.02 ? this.goal : d;   // keep accumulating while a zoom is under way
    this.goal = THREE.MathUtils.clamp(base * Math.exp(px * 0.0009), this.controls.minDistance, this.controls.maxDistance);
    // the ground point under the cursor (plane at the target's height); none if the ray misses it, then the zoom is about the target
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin, dir = this.ray.ray.direction, y = this.controls.target.y;
    const t = Math.abs(dir.y) > 1e-4 ? (y - o.y) / dir.y : -1;
    if (t > 0 && t < 60000) this.pivot.copy(o).addScaledVector(dir, t); else this.pivot.copy(this.controls.target);
    this.lastD = d;
  }

  /** drop a zoom in progress (a fly-to or a jump has taken over the camera) */
  cancel() { this.goal = null; }

  step(dt: number) {
    if (this.goal === null) return;
    const cam = this.camera.position, tgt = this.controls.target, d = this.dist();
    if (Math.abs(d - this.lastD) > Math.max(2, this.lastD * 0.02)) { this.goal = null; return; }   // someone else moved the camera
    const nd = d + (this.goal - d) * (1 - Math.exp(-dt * 10));
    const s = nd / d;
    const p = this.pivot;
    cam.sub(p).multiplyScalar(s).add(p);
    tgt.sub(p).multiplyScalar(s).add(p);
    // keep the target on the board
    const cx = THREE.MathUtils.clamp(tgt.x, 0, this.bounds), cz = THREE.MathUtils.clamp(tgt.z, 0, this.bounds);
    if (cx !== tgt.x || cz !== tgt.z) { this.tmp.set(cx - tgt.x, 0, cz - tgt.z); cam.add(this.tmp); tgt.add(this.tmp); }
    this.lastD = this.dist();
    if (Math.abs(this.goal - this.lastD) < this.goal * 0.002) this.goal = null;
  }
}
