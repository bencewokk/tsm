import * as THREE from 'three';
import { MAP } from './common';

/**
 * The model's surroundings: a sky dome (zenith to horizon gradient, a sun glow, a few stars at night) and the studio table the model
 * stands on (warm grey, a soft contact shadow round the board, falling off to the horizon colour). Two draw calls, no textures, no
 * lights. Colours are pushed by `Env.applyTime`; both meshes follow the camera so the horizon never moves.
 */
export class Sky {
  group = new THREE.Group();
  u = {
    uZenith: { value: new THREE.Color('#78aae0') },
    uHorizon: { value: new THREE.Color('#d6e2ec') },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color('#fff2de') },
    uNight: { value: 0 },
    uTable: { value: new THREE.Color('#cbc3b4') },
    uDim: { value: 1 },
  };
  private dome: THREE.Mesh;
  private table: THREE.Mesh;

  constructor() {
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.u, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() { vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }`,
      fragmentShader: `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform float uNight;
        varying vec3 vDir;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float t = clamp(d.y, 0.0, 1.0);
          vec3 c = mix(uHorizon, uZenith, pow(t, 0.5));
          // haze band hugging the horizon
          c = mix(c, uHorizon, exp(-t * 14.0) * 0.5);
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          c += uSunCol * (pow(s, 6.0) * 0.18 + pow(s, 80.0) * 0.5 + pow(s, 1800.0) * 3.0) * (1.0 - uNight * 0.9);
          // stars
          if (uNight > 0.3 && d.y > 0.02) {
            vec2 g = floor(vec2(atan(d.z, d.x) * 140.0, d.y * 260.0));
            float r = h21(g);
            c += vec3(1.0, 0.95, 0.85) * step(0.9965, r) * (0.35 + 0.65 * h21(g + 7.0)) * smoothstep(0.3, 0.9, uNight) * smoothstep(0.02, 0.25, d.y) * 0.8;
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(30000, 24, 12), domeMat);
    this.dome.renderOrder = 100;   // drawn after the opaque scene so early-z skips every covered pixel
    this.dome.frustumCulled = false;

    const tableMat = new THREE.ShaderMaterial({
      uniforms: this.u, fog: false,
      vertexShader: `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform vec3 uHorizon; uniform vec3 uTable; uniform float uDim;
        varying vec3 vW;
        void main() {
          float c = ${(MAP / 2).toFixed(1)};
          float d = max(abs(vW.x - c), abs(vW.z - c)) - (c + 200.0);   // distance outside the board
          float contact = exp(-max(d, 0.0) / 260.0);
          vec3 col = uTable * (1.0 - 0.5 * contact) * uDim;
          // the studio light is a pool round the model: darker with distance, then fading into the horizon colour
          col *= mix(1.0, 0.62, smoothstep(1500.0, 9000.0, d));
          float haze = smoothstep(6000.0, 26000.0, length(vW - cameraPosition));
          col = mix(col, uHorizon, haze);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.table = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000, 1, 1), tableMat);
    this.table.rotation.x = -Math.PI / 2;
    this.table.position.set(MAP / 2, -101, MAP / 2);
    this.table.renderOrder = 90;
    this.table.frustumCulled = false;
    this.group.add(this.dome, this.table);
  }

  follow(cam: THREE.Camera) { this.dome.position.copy(cam.position); }
}
