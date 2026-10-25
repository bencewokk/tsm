import * as THREE from 'three';
import { N } from '../sim/constants';

/**
 * Opening ripple: when a line opens, a ring in the line's colour sweeps out over the streets that just came within an 8-minute walk of a
 * station, at walking speed (the front sits at each cell's walk time), then a soft wash fades. Render only: the walk times come from the
 * sim's catchment raster (minutes x 10); cells that were already near a station are skipped.
 */
export class Ripple {
  mesh: THREE.Mesh;
  private data = new Uint8Array(N * N * 4);
  private tex: THREE.DataTexture;
  private mins = new Float32Array(N * N).fill(Infinity);
  private rgb: [number, number, number] = [60, 130, 210];
  private t = -1;
  private dur = 3.4;
  private delay = 0;
  /** active cells, to keep the per-frame loop short */
  private cells: number[] = [];

  constructor(geo: THREE.BufferGeometry) {
    this.tex = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 9;
    this.mesh.position.y = 3;
  }

  get active() { return this.t >= 0; }

  /** end the sweep at once (capture helper) */
  stop() { this.t = -1; this.mesh.visible = false; this.data.fill(0); this.tex.needsUpdate = true; }

  /** `now` / `prev`: catchment rasters (walk minutes x 10, 255 = out of reach). */
  start(now: Uint8Array, prev: Uint8Array | null, color: string, delay = 0) {
    const c = new THREE.Color(color);
    this.rgb = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
    this.cells = [];
    this.mins.fill(Infinity);
    for (let i = 0; i < N * N; i++) {
      const m = now[i] / 10;
      if (m > 9.5) continue;
      if (prev && prev[i] / 10 - m < 0.6) continue;
      this.mins[i] = m;
      this.cells.push(i);
    }
    if (!this.cells.length) return;
    this.t = 0; this.delay = delay;
    this.data.fill(0);
    this.mesh.visible = true;
  }

  animate(dt: number) {
    if (this.t < 0) return;
    if (this.delay > 0) { this.delay -= dt; return; }
    this.t += dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.t = -1; this.mesh.visible = false; this.data.fill(0); this.tex.needsUpdate = true; return; }
    const ease = 1 - Math.pow(1 - Math.min(1, p * 1.25), 2);
    const front = ease * 11;   // minutes of walk the ring has reached
    const wash = Math.pow(1 - p, 1.6);
    const [r, g, b] = this.rgb;
    for (const i of this.cells) {
      const d = front - this.mins[i];
      let a = 0, mix = 0;
      if (d > -0.4) {
        const ring = Math.exp(-Math.pow(d / 1.1, 2));
        a = ring * (1 - p * 0.4);
        mix = ring;
        if (d > 0) a = Math.max(a, 0.46 * wash);
      }
      const o = i * 4;
      this.data[o] = r + (255 - r) * mix * 0.55; this.data[o + 1] = g + (255 - g) * mix * 0.55; this.data[o + 2] = b + (255 - b) * mix * 0.55;
      this.data[o + 3] = Math.min(255, Math.round(a * 255));
    }
    this.tex.needsUpdate = true;
  }
}
