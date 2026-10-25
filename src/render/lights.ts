import * as THREE from 'three';
import { CELL, N } from '../sim/constants';
import type { RoadsMsg, StationInfo } from '../sim/protocol';
import { lookUniforms, nightHooks } from './look';
import { VFX } from './vfx';

/** hash for placement jitter (visual only) */
const h01 = (i: number, k: number) => { let h = (i * 2654435761 + k * 40503) | 0; h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

/**
 * The city's lights seen in the water: a 512 x 512 emissive map over the map (1 texel = 12.5 m) with a soft warm glow at every lamp and a
 * cool one at every station; the water material shows it scaled by the night factor (its transparency over land masks the rest). Redrawn
 * only when the lamps change. A cheap stand-in for reflections: no extra render pass, one texture upload.
 */
export const shoreGlow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { c, t };
})();
const glowSprite = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.35, 'rgba(255,255,255,0.28)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 32, 32);
  return c;
})();
function drawGlow(street: { pos: number[]; col: number[] }, stations: { pos: number[]; col: number[] }) {
  const g = shoreGlow.c.getContext('2d')!, S = 512, k = S / (N * CELL);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const tinted = (list: { pos: number[]; col: number[] }, rad: number, a: number) => {
    for (let i = 0; i < list.pos.length / 3; i++) {
      g.globalAlpha = a * Math.min(1.2, (list.col[i * 3] + list.col[i * 3 + 1]) * 0.55);
      g.drawImage(glowSprite, list.pos[i * 3] * k - rad, list.pos[i * 3 + 2] * k - rad, rad * 2, rad * 2);
    }
  };
  tinted(street, 5, 0.16);
  tinted(stations, 9, 0.5);
  g.globalAlpha = 1;
  // warm tint: the sprites are white, multiply by amber
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = 'rgb(255,176,96)'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  shoreGlow.t.needsUpdate = true;
}

/**
 * Night lights as additive glow sprites in ONE draw call (THREE.Points, no textures, no lights): street lamps along every street
 * (sodium amber on arterials, warm white on collectors, gas amber in the old cores, sparse on local streets) and a larger glow over
 * each station. They are a fake bloom: a bright core with a soft halo that is sized in world metres, so it shrinks to a speck at
 * overview and spreads into light pools at street level. Invisible by day.
 */
export class NightLights {
  group = new THREE.Group();
  private pts: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private streetN = 0;
  private street: { pos: number[]; col: number[]; size: number[] } = { pos: [], col: [], size: [] };
  private stationSig = '';
  private stationRec: { pos: number[]; col: number[]; size: number[] } = { pos: [], col: [], size: [] };
  /** uPx: world metres to pixels at distance 1 (render target height / 2 tan(fov/2)), set by Env */
  u = { uPx: lookUniforms.uPx, uNight: lookUniforms.uNight, uTime: lookUniforms.uTime };

  constructor(private sample: (x: number, z: number) => number, private water: Uint8Array) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: `
        attribute vec3 aCol; attribute float aSize;
        uniform float uPx; uniform float uNight;
        varying vec3 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float raw = aSize * uPx / max(-mv.z, 1.0);
          gl_PointSize = clamp(raw, 1.0, 64.0);
          // sub-pixel sprites fade instead of shimmering; very close ones fade so a single lamp never fills the screen
          float f = min(1.0, raw) * (1.0 - smoothstep(34.0, 64.0, raw) * 0.75);
          vC = aCol * f * smoothstep(0.02, 0.5, uNight);
        }`,
      fragmentShader: `
        varying vec3 vC;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r2 = dot(c, c) * 4.0;
          float a = (exp(-r2 * 9.0) * 1.0 + exp(-r2 * 2.6) * 0.32) * (1.0 - smoothstep(0.75, 1.0, r2));
          gl_FragColor = vec4(vC * a, a);
        }`,
    });
    this.pts = new THREE.Points(new THREE.BufferGeometry(), this.mat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 50;
    this.group.add(this.pts);
    this.group.visible = false;
    const show = () => { this.group.visible = VFX.is('night') && lookUniforms.uNight.value > 0.02; };
    nightHooks.push(show);
    VFX.onChange((n) => { if (n === 'night') show(); });
  }

  /** rebuild the street lamps from the road graph (called when the roads change) */
  setRoads(r: RoadsMsg, widths: number[], coreEdge: Set<number>) {
    const S = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const amber = new THREE.Color(1.0, 0.62, 0.26), white = new THREE.Color(1.0, 0.84, 0.58), gas = new THREE.Color(1.0, 0.55, 0.2);
    for (let k = 0; k < r.ea.length; k++) {
      const a = r.ea[k], b = r.eb[k];
      const ax = r.nodes[a * 2] * CELL, az = r.nodes[a * 2 + 1] * CELL, bx = r.nodes[b * 2] * CELL, bz = r.nodes[b * 2 + 1] * CELL;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 20) continue;
      const cls = r.cls[k], core = coreEdge.has(r.ids[k]);
      const space = cls === 0 ? 42 : cls === 1 ? 52 : core ? 38 : 72;
      const c = core ? gas : cls === 0 ? amber : white;
      const size = cls === 0 ? 16 : cls === 1 ? 13 : 11;
      const off = widths[k] / 2 + 1.2;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const n = Math.max(1, Math.floor(L / space));
      for (let j = 0; j < n; j++) {
        const t = ((j + 0.5) / n) * L;
        // arterials light both sides, the rest alternate
        for (const side of cls === 0 ? [1, -1] : [j % 2 ? 1 : -1]) {
          const x = ax + ux * t - uz * off * side, z = az + uz * t + ux * off * side;
          const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
          if (cx < 0 || cz < 0 || cx >= N || cz >= N || this.water[cz * N + cx]) continue;
          const v = 0.8 + 0.4 * h01(r.ids[k] * 131 + j, 3);
          S.pos.push(x, this.sample(x, z) + 6.2, z);
          S.col.push(c.r * v, c.g * v, c.b * v);
          S.size.push(size * (0.9 + 0.2 * h01(r.ids[k] * 17 + j, 5)));
        }
      }
    }
    this.street = S;
    this.rebuild();
  }

  /** a larger, cooler glow over each station entrance */
  setStations(st: StationInfo[]) {
    const sig = st.map((s) => `${s.id}:${s.x.toFixed(1)},${s.y.toFixed(1)}:${s.riders < 1200 ? 0 : s.riders < 5000 ? 1 : 2}`).join('|');
    if (sig === this.stationSig) return;
    this.stationSig = sig;
    const S = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    for (const s of st) {
      const x = s.x * CELL, z = s.y * CELL, size = s.riders < 1200 ? 55 : s.riders < 5000 ? 75 : 100;
      S.pos.push(x, this.sample(x, z) + 9, z); S.col.push(0.55, 0.9, 1.0); S.size.push(size);
      S.pos.push(x, this.sample(x, z) + 4, z); S.col.push(1.0, 0.8, 0.5); S.size.push(size * 0.45);
    }
    this.stationRec = S;
    this.rebuild();
  }

  private rebuild() {
    const A = this.street, B = this.stationRec;
    const pos = new Float32Array(A.pos.length + B.pos.length), col = new Float32Array(A.col.length + B.col.length), size = new Float32Array(A.size.length + B.size.length);
    pos.set(A.pos); pos.set(B.pos, A.pos.length); col.set(A.col); col.set(B.col, A.col.length); size.set(A.size); size.set(B.size, A.size.length);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.pts.geometry.dispose();
    this.pts.geometry = g;
    this.streetN = A.size.length;
    drawGlow(A, B);
  }

  get count() { return this.streetN; }

}
