import * as THREE from 'three';
import { N, CELL, Flag } from '../sim/constants';
import { VS } from './common';
import { T_COLORS } from '../sim/territory';
import { skyLight, nightHooks } from './look';
import { shoreGlow } from './lights';
import { VFX } from './vfx';

export interface TerrainView {
  mesh: THREE.Mesh;
  water: THREE.Mesh;
  heat: THREE.Mesh;
  heatTex: THREE.DataTexture;
  material: THREE.MeshStandardMaterial;
  waterMat: THREE.MeshPhysicalMaterial;
  /** map-paper overlay for plan mode and far zoom (opacity 0..1) and the cork-strata skirt round the model */
  paper: THREE.Mesh;
  skirt: THREE.Mesh;
  setPaper(a: number): void;
  /** height lookup at world x,z (bilinear on the vertex grid) */
  sample(x: number, z: number): number;
  setHeat(lv: Float32Array, water: Uint8Array): void;
  catchment: THREE.Mesh;
  setCatchment(c: Uint8Array): void;
  /** contour lines (every 10 m, index line every 50 m) for plan mode and the heatmap */
  contours: THREE.Mesh;
  /** land-use territory overlay (Z) */
  zones: THREE.Mesh;
  setZones(terr: Uint8Array, water: Uint8Array): void;
}

export function buildTerrain(height: Float32Array, wmask: Uint8Array, flags: Uint8Array): TerrainView {
  const V = N + 1;
  const vh = new Float32Array(V * V);
  const vw = new Float32Array(V * V); // water fraction per vertex
  const vd = new Float32Array(V * V); // docks (concrete) fraction
  const vs = new Float32Array(V * V); // steep (woodland) fraction
  const vf = new Float32Array(V * V); // flood plain (wetland) fraction
  for (let vy = 0; vy < V; vy++)
    for (let vx = 0; vx < V; vx++) {
      let s = 0, c = 0, w = 0;
      for (let dy = -1; dy <= 0; dy++)
        for (let dx = -1; dx <= 0; dx++) {
          const x = vx + dx, y = vy + dy;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const i = y * N + x;
          s += height[i]; c++;
          if (wmask[i]) w++;
          if (!wmask[i] && (flags[i] & Flag.Docks)) vd[vy * V + vx] += 1;
          if (!wmask[i] && (flags[i] & Flag.Steep)) vs[vy * V + vx] += 1;
          if (!wmask[i] && (flags[i] & Flag.Flood)) vf[vy * V + vx] += 1;
        }
      vh[vy * V + vx] = (s / c) * VS;
      vw[vy * V + vx] = w / c;
      vd[vy * V + vx] /= c;
      vs[vy * V + vx] /= c;
      vf[vy * V + vx] /= c;
    }

  const pos = new Float32Array(V * V * 3);
  const col = new Float32Array(V * V * 3);
  const grassA = new Float32Array(V * V);   // 1 on open grass (fields), 0 on sand, water, woodland, rock, docks
  const uv = new Float32Array(V * V * 2);
  const sand = new THREE.Color('#e6dcc2');
  const low = new THREE.Color('#cdd9b6');
  const mid = new THREE.Color('#bfcfa6');
  const high = new THREE.Color('#cfd6b5');
  const bed = new THREE.Color('#9fbccb');
  const concrete = new THREE.Color('#c9c6be');
  const wood = new THREE.Color('#9fb889');
  const rock = new THREE.Color('#bdb8aa');
  const cliff = new THREE.Color('#a9a396');
  const scree = new THREE.Color('#c9c3b3');
  const snow = new THREE.Color('#eef0ec');
  const marsh = new THREE.Color('#a7b78f');
  const forest = new THREE.Color('#86a274');
  const c = new THREE.Color();
  for (let vy = 0; vy < V; vy++)
    for (let vx = 0; vx < V; vx++) {
      const k = vy * V + vx;
      const h = vh[k];
      pos[k * 3] = vx * CELL; pos[k * 3 + 1] = h; pos[k * 3 + 2] = vy * CELL;
      uv[k * 2] = vx / N; uv[k * 2 + 1] = vy / N;
      // slope (m per m) from the vertex grid
      const hxm = vh[vy * V + Math.max(0, vx - 1)], hxp = vh[vy * V + Math.min(N, vx + 1)], hym = vh[Math.max(0, vy - 1) * V + vx], hyp = vh[Math.min(N, vy + 1) * V + vx];
      const slope = Math.hypot((hxp - hxm) / (Math.min(N, vx + 1) - Math.max(0, vx - 1)), (hyp - hym) / (Math.min(N, vy + 1) - Math.max(0, vy - 1))) / (CELL * VS);
      const hm = h / VS;
      if (vw[k] > 0.6) c.copy(bed);
      else if (hm < 5 || vw[k] > 0) c.copy(sand).lerp(low, Math.max(0, Math.min(1, (hm - 2) / 3)));
      else if (hm < 25) c.copy(low).lerp(mid, (hm - 5) / 20);
      else c.copy(mid).lerp(high, Math.min(1, (hm - 25) / 30));
      if (vf[k] > 0 && vw[k] < 0.6) c.lerp(marsh, Math.min(1, vf[k] * 1.4));
      // slope materials: woodland on the flanks, bare rock on cliffs and above the tree line, snow on the tops
      if (vw[k] < 0.6) {
        const treeLine = hm < 95 ? 1 : Math.max(0, 1 - (hm - 95) / 40);
        const wooded = Math.min(1, Math.max(0, (slope - 0.06) / 0.07)) * Math.min(1, Math.max(0, (hm - 5) / 8)) * treeLine;
        c.lerp(forest, wooded * 0.85);
        const rocky = Math.min(1, Math.max(0, (slope - 0.2) / 0.14)) + Math.min(1, Math.max(0, (hm - 100) / 50)) * 0.7;
        c.lerp(slope > 0.26 ? cliff : rock, Math.min(0.92, rocky));
        if (hm > 80) c.lerp(scree, Math.min(0.5, (hm - 80) / 120));
        if (hm > 135) c.lerp(snow, Math.min(0.9, (hm - 135) / 35) * (1 - Math.min(1, Math.max(0, (slope - 0.35) / 0.2)) * 0.5));
      }
      if (vs[k] > 0 && vs[k] > 0.2) c.lerp(wood, vs[k] * 0.4);
      if (vd[k] > 0 && vw[k] < 0.6) c.lerp(concrete, Math.min(1, vd[k] * 1.6));
      if (vw[k] < 0.05 && hm > 5 && !(vd[k] > 0.05)) {
        const wooded = Math.min(1, Math.max(0, (slope - 0.06) / 0.07)), rocky = Math.min(1, Math.max(0, (slope - 0.2) / 0.14)) + Math.min(1, Math.max(0, (hm - 100) / 50));
        grassA[k] = Math.max(0, 1 - Math.max(wooded, Math.min(1, rocky), vs[k] * 2, vf[k] * 1.5)) * Math.min(1, (hm - 5) / 4);
      }
      // macro colour patches (fresher green, drier yellow-green) baked into the vertex colour: free at run time
      if (VFX.is('ground') && vw[k] < 0.6) {
        const wx = vx * CELL, wz = vy * CELL;
        let pat = vnoise(wx * 0.0011, wz * 0.0011) * 0.6 + vnoise(wx * 0.0043 + 7, wz * 0.0043 + 7) * 0.4;
        pat = Math.max(0, Math.min(1, (pat - 0.5) * 2.4 + 0.5));
        const amt = 0.55 * grassA[k] + 0.2;
        c.r *= 1 + ((0.9 + (1.07 - 0.9) * pat) - 1) * amt; c.g *= 1 + ((1.04 + (1.03 - 1.04) * pat) - 1) * amt; c.b *= 1 + ((0.95 + (0.9 - 0.95) * pat) - 1) * amt;
      }
      // cavity: ground lower than its surroundings (valleys, folds) darkens a little, ridges and knolls lighten (baked, so it costs nothing per frame)
      if (VFX.is('ground') && vw[k] < 0.6) {
        let sum = 0, cnt = 0;
        for (let dy = -3; dy <= 3; dy += 3) for (let dx = -3; dx <= 3; dx += 3) {
          if (!dx && !dy) continue;
          const xx = Math.min(N, Math.max(0, vx + dx)), yy = Math.min(N, Math.max(0, vy + dy));
          sum += vh[yy * V + xx]; cnt++;
        }
        const curv = Math.max(-1, Math.min(1, (h - sum / cnt) / (9 * VS)));
        const f = 1 + curv * 0.09;
        c.multiplyScalar(f);
      }
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  const indices: number[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const a = y * V + x, b = a + 1, d = a + V, e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aGrass', new THREE.BufferAttribute(grassA, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, transparent: false });
  // layered cork: alternating 10 m layers with a thin darker edge where each layer ends (the contour of a cardboard / cork model)
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTsmWY;\nvarying vec2 vTsmXZ;\nvarying float vTsmGrass;\nattribute float aGrass;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTsmWY = (modelMatrix * vec4(transformed, 1.0)).y;\nvTsmXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\nvTsmGrass = aGrass;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTsmWY;
        varying vec2 vTsmXZ;
        varying float vTsmGrass;
        float tsmH2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef TSM_GROUND
        {
          // open ground: large soft colour patches, then a field pattern (tints, ploughed rows, hedgerows) that fades in with the grass attribute
          vec2 q = vTsmXZ;
          float gr = clamp(vTsmGrass, 0.0, 1.0);
          float ca = 0.9, sa = 0.43;
          vec2 p = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca) / 210.0;
          vec2 w = fwidth(p) * 1.4;   // derivatives outside the branch below
          if (gr > 0.02) {
          vec2 id = floor(p);
          vec2 f = fract(p);
          float fh = tsmH2(id);
          vec3 ftint = mix(vec3(0.93, 0.98, 0.9), vec3(1.07, 1.05, 0.88), fh);
          float hedge = 1.0 - smoothstep(0.0, 1.0, min(min(f.x, 1.0 - f.x) / max(w.x, 1e-4), min(f.y, 1.0 - f.y) / max(w.y, 1e-4)));
          float fieldMask = gr * step(0.42, tsmH2(id + 3.7));   // not every parcel is a field: some stay meadow
          diffuseColor.rgb *= mix(vec3(1.0), ftint, fieldMask * 0.8);
          diffuseColor.rgb *= 1.0 - hedge * fieldMask * 0.16 * (1.0 - smoothstep(2200.0, 6500.0, length(vTsmXZ - cameraPosition.xz)) * 0.5);
          }
        }
        #endif
        {
          float band = vTsmWY / ${(10 * VS).toFixed(2)};
          float on = smoothstep(2.0, 4.5, vTsmWY / ${VS.toFixed(2)});
          float f = fract(band), id = floor(band);
          float w = max(fwidth(band), 0.002);
          float line = 1.0 - smoothstep(0.0, w * 1.6, f);
          diffuseColor.rgb *= 1.0 - on * (0.03 * mod(id, 2.0) + 0.1 * line);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.03, 0.995, 0.93), on * 0.55);
        }`);
  };
  const groundDefs = () => { material.defines = VFX.is('ground') ? { TSM_GROUND: '' } : {}; };
  groundDefs();
  VFX.onChange((n) => { if (n === 'ground') { groundDefs(); material.needsUpdate = true; } });
  material.customProgramCacheKey = () => 'tsm-cork' + VFX.key('ground');
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // skirt: a pale plinth under the model, like a base board
  const waterMat = new THREE.MeshPhysicalMaterial({ map: waterTexture(wmask), color: '#ffffff', roughness: 0.07, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.93 });
  // the city's lights in the water (night): see lights.ts shoreGlow
  waterMat.emissive.set(0xffffff); waterMat.emissiveMap = shoreGlow.t; waterMat.emissiveIntensity = 0;
  nightHooks.push((n) => { waterMat.emissiveIntensity = VFX.is('water') ? n * 1.6 : 0; });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL, N * CELL), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set((N * CELL) / 2, 0.3, (N * CELL) / 2);
  water.receiveShadow = true;
  water.renderOrder = 1;

  // land value heatmap overlay
  const data = new Uint8Array(N * N * 4);
  const heatTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  heatTex.magFilter = THREE.LinearFilter;
  heatTex.minFilter = THREE.LinearFilter;
  heatTex.needsUpdate = true;
  const heatMat = new THREE.MeshBasicMaterial({ map: heatTex, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const heat = new THREE.Mesh(geo, heatMat);
  heat.visible = false;
  heat.renderOrder = 2;
  heat.position.y = 1.5;

  // street-network walk catchment of stations (plan mode)
  const cdata = new Uint8Array(N * N * 4);
  const catchTex = new THREE.DataTexture(cdata, N, N, THREE.RGBAFormat);
  catchTex.magFilter = THREE.LinearFilter;
  catchTex.minFilter = THREE.LinearFilter;
  catchTex.needsUpdate = true;
  const catchMat = new THREE.MeshBasicMaterial({ map: catchTex, transparent: true, depthWrite: false, depthTest: false });
  const catchment = new THREE.Mesh(geo, catchMat);
  catchment.visible = false;
  catchment.renderOrder = 8;
  catchment.position.y = 2;

  // contour lines: baked from the height field at 8x the cell resolution
  const CR = N * 8;
  const cdat = new Uint8Array(CR * CR * 4);
  {
    const hs = (x: number, y: number) => {
      const fx = Math.max(0, Math.min(N - 1.001, x / 8 - 0.5)), fy = Math.max(0, Math.min(N - 1.001, y / 8 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const hv = (xx: number, yy: number) => (wmask[yy * N + xx] ? -1 : height[yy * N + xx]);
      return (hv(x0, y0) * (1 - tx) + hv(x0 + 1, y0) * tx) * (1 - ty) + (hv(x0, y0 + 1) * (1 - tx) + hv(x0 + 1, y0 + 1) * tx) * ty;
    };
    for (let y = 0; y < CR - 1; y++) for (let x = 0; x < CR - 1; x++) {
      const h = hs(x, y);
      if (h < 3) continue;
      const lv = (v: number) => Math.floor(v / 10);
      const edge = lv(h) !== lv(hs(x + 1, y)) || lv(h) !== lv(hs(x, y + 1));
      if (!edge) continue;
      const index = lv(Math.max(h, hs(x + 1, y), hs(x, y + 1))) % 5 === 0;
      const o = (y * CR + x) * 4;
      cdat[o] = 92; cdat[o + 1] = 70; cdat[o + 2] = 48; cdat[o + 3] = index ? 150 : 70;
    }
  }
  const contourTex = new THREE.DataTexture(cdat, CR, CR, THREE.RGBAFormat);
  contourTex.magFilter = THREE.LinearFilter;
  contourTex.minFilter = THREE.LinearFilter;
  contourTex.needsUpdate = true;
  const contourMat = new THREE.MeshBasicMaterial({ map: contourTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const contours = new THREE.Mesh(geo, contourMat);
  contours.visible = false;
  contours.renderOrder = 3;
  contours.position.y = 1.2;

  // land-use territories overlay
  const zdata = new Uint8Array(N * N * 4);
  const zoneTex = new THREE.DataTexture(zdata, N, N, THREE.RGBAFormat);
  zoneTex.magFilter = THREE.NearestFilter;
  zoneTex.minFilter = THREE.NearestFilter;
  zoneTex.needsUpdate = true;
  const zoneMat = new THREE.MeshBasicMaterial({ map: zoneTex, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const zones = new THREE.Mesh(geo, zoneMat);
  zones.visible = false;
  zones.renderOrder = 2;
  zones.position.y = 1.6;

  // map paper: a cream sheet with grain, slope hatching, a kilometre grid and a pale wash on the water; its opacity follows the zoom
  const paperMat = new THREE.MeshBasicMaterial({ map: paperTexture(height, wmask), transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const paper = new THREE.Mesh(geo, paperMat);
  paper.visible = false;
  paper.renderOrder = 1;
  paper.position.y = 1.0;

  // the skirt: the edge of the model shows its layers, like a core sample (10 m cork layers down to the board)
  const skirt = new THREE.Mesh(skirtGeometry(vh, V), new THREE.MeshStandardMaterial({ map: strataTexture(), roughness: 1, side: THREE.DoubleSide }));
  skirt.name = 'skirt';
  skirt.receiveShadow = true;

  const ramp = [
    [0.0, [70, 95, 160]],
    [0.3, [110, 170, 190]],
    [0.5, [230, 220, 150]],
    [0.7, [240, 150, 80]],
    [1.0, [200, 50, 60]],
  ] as const;
  const rampAt = (t: number): [number, number, number] => {
    t = Math.max(0, Math.min(1, t));
    for (let k = 1; k < ramp.length; k++) {
      if (t <= ramp[k][0]) {
        const [t0, c0] = ramp[k - 1], [t1, c1] = ramp[k];
        const f = (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return [200, 50, 60];
  };

  return {
    mesh, water, heat, heatTex, material, waterMat, catchment, contours, zones, paper, skirt,
    setPaper(a: number) {
      if (VFX.is('ground') && a < 0.7) a *= 0.7;   // in the 3D view the map paper only tints the far ground, so hills keep their shading
      paper.visible = a > 0.01; paperMat.opacity = a; waterMat.color.copy(WHITE).lerp(PAPER_WATER, a * 0.7);
      if (VFX.is('sky')) paperMat.color.copy(skyLight); else paperMat.color.setRGB(1, 1, 1);   // the sheet is unlit: follow the light so it does not glow at dusk
    },   // every frame: no allocations
    setZones(terr: Uint8Array, w: Uint8Array) {
      for (let i = 0; i < N * N; i++) {
        const t = terr[i], c = T_COLORS[t] ?? [0, 0, 0];
        zdata[i * 4] = c[0]; zdata[i * 4 + 1] = c[1]; zdata[i * 4 + 2] = c[2]; zdata[i * 4 + 3] = t && !w[i] ? 235 : 0;
      }
      zoneTex.needsUpdate = true;
    },
    setCatchment(c: Uint8Array) {
      for (let i = 0; i < N * N; i++) {
        const m = c[i] / 10; // minutes
        const a = m >= 12 ? 0 : m <= 8 ? 95 : Math.round(45 * (1 - (m - 8) / 4));
        const edge = m > 7.2 && m <= 8.2 ? 90 : 0; // 8-minute contour
        cdata[i * 4] = 60; cdata[i * 4 + 1] = 130; cdata[i * 4 + 2] = 210; cdata[i * 4 + 3] = Math.min(255, a + edge);
      }
      catchTex.needsUpdate = true;
    },
    sample(x: number, z: number) {
      const fx = Math.max(0, Math.min(N - 0.001, x / CELL)), fz = Math.max(0, Math.min(N - 0.001, z / CELL));
      const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
      const a = vh[iz * V + ix], b = vh[iz * V + ix + 1], cc = vh[(iz + 1) * V + ix], d = vh[(iz + 1) * V + ix + 1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
    },
    setHeat(lv: Float32Array, w: Uint8Array) {
      for (let i = 0; i < N * N; i++) {
        const [r, g, b] = rampAt(lv[i]);
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = w[i] ? 0 : 200;
      }
      heatTex.needsUpdate = true;
    },
  };
}


const WHITE = new THREE.Color('#ffffff'), PAPER_WATER = new THREE.Color('#e6eef0');

// ------------------------------------------------------------------ textures
const noise2 = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
  return noise2(xi, yi) * (1 - xf) * (1 - yf) + noise2(xi + 1, yi) * xf * (1 - yf) + noise2(xi, yi + 1) * (1 - xf) * yf + noise2(xi + 1, yi + 1) * xf * yf;
}

/** Water colour map: darker with distance from the shore, a foam line along the coast, faint ripples. Land texels are transparent. */
function waterTexture(wmask: Uint8Array): THREE.CanvasTexture {
  const S = N * 8;
  // distance to land (cells) for water cells, by a two-pass chamfer
  const dl = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) dl[i] = wmask[i] ? 99 : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (x > 0) dl[i] = Math.min(dl[i], dl[i - 1] + 1);
      if (y > 0) dl[i] = Math.min(dl[i], dl[i - N] + 1);
    }
    for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x;
      if (x < N - 1) dl[i] = Math.min(dl[i], dl[i + 1] + 1);
      if (y < N - 1) dl[i] = Math.min(dl[i], dl[i + N] + 1);
    }
  }
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  const deep = [74, 128, 160], shallow = [150, 205, 222];
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const fx = Math.min(N - 1.001, Math.max(0, px / 8 - 0.5)), fy = Math.min(N - 1.001, Math.max(0, py / 8 - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const d = (dl[y0 * N + x0] * (1 - tx) + dl[y0 * N + x0 + 1] * tx) * (1 - ty) + (dl[(y0 + 1) * N + x0] * (1 - tx) + dl[(y0 + 1) * N + x0 + 1] * tx) * ty;
    const o = (py * S + px) * 4;
    if (d < 0.5) { img.data[o + 3] = 0; continue; }   // land
    const t = Math.min(1, (d - 0.5) / 9);
    let r = shallow[0] + (deep[0] - shallow[0]) * t, gg = shallow[1] + (deep[1] - shallow[1]) * t, b = shallow[2] + (deep[2] - shallow[2]) * t;
    // ripples: long soft stripes
    const rip = vnoise(px * 0.05 + py * 0.02, py * 0.11) * 0.5 + vnoise(px * 0.13, py * 0.04 + px * 0.03) * 0.5;
    const k = 1 + (rip - 0.5) * 0.07;
    r *= k; gg *= k; b *= k;
    // foam along the shore, broken up by noise
    const fz = Math.max(0, 1 - (d - 0.5) / 1.1) * (0.55 + 0.6 * vnoise(px * 0.22, py * 0.22));
    const foam = Math.min(1, Math.max(0, (fz - 0.28) * 2.2));
    r += (244 - r) * foam; gg += (248 - gg) * foam; b += (248 - b) * foam;
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Cream paper: grain, diagonal hatching where the ground is steep, a 1 km grid, a pale blue wash on the water. */
function paperTexture(height: Float32Array, wmask: Uint8Array): THREE.CanvasTexture {
  const S = N * 8;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    const o = (py * S + px) * 4;
    const cx = Math.min(N - 1, px >> 3), cy = Math.min(N - 1, py >> 3);
    const wet = wmask[cy * N + cx];
    const grain = (vnoise(px * 0.9, py * 0.9) - 0.5) * 9 + (vnoise(px * 0.08, py * 0.08) - 0.5) * 10;
    let r = 239 + grain, gg = 232 + grain, b = 213 + grain;
    if (wet) { r = 206 + grain * 0.5; gg = 224 + grain * 0.5; b = 232 + grain * 0.5; }
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // 1 km grid (20 cells)
  g.strokeStyle = 'rgba(120,130,140,0.22)'; g.lineWidth = 1;
  for (let k = 0; k <= N; k += 20) { g.beginPath(); g.moveTo(k * 8, 0); g.lineTo(k * 8, S); g.stroke(); g.beginPath(); g.moveTo(0, k * 8); g.lineTo(S, k * 8); g.stroke(); }
  // hatching on slopes (strokes perpendicular to the fall line, closer together where it is steeper)
  g.strokeStyle = 'rgba(110,86,60,0.3)'; g.lineWidth = 1;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    if (wmask[y * N + x]) continue;
    const gx = (height[y * N + x + 1] - height[y * N + x - 1]) / (2 * CELL), gy = (height[(y + 1) * N + x] - height[(y - 1) * N + x]) / (2 * CELL);
    const sl = Math.hypot(gx, gy);
    if (sl < 0.16) continue;
    const n = sl > 0.32 ? 4 : sl > 0.2 ? 3 : 2;
    const ang = Math.atan2(gy, gx) + Math.PI / 2;
    for (let k = 0; k < n; k++) {
      const cx = x * 8 + 4 + ((k + 0.5) / n - 0.5) * 8, cy = y * 8 + 4 + (noise2(x, y + k) - 0.5) * 3;
      const len = 3 + sl * 14;
      g.beginPath(); g.moveTo(cx - Math.cos(ang) * len / 2, cy - Math.sin(ang) * len / 2); g.lineTo(cx + Math.cos(ang) * len / 2, cy + Math.sin(ang) * len / 2); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Core-sample strata: alternating cork and wood layers (one pair = 20 m of ground height). */
export function strataTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#d6bc92'; g.fillRect(0, 0, 8, 32);
  g.fillStyle = '#c4a47a'; g.fillRect(0, 32, 8, 32);
  g.fillStyle = 'rgba(80,58,34,0.55)'; g.fillRect(0, 0, 8, 2); g.fillRect(0, 32, 8, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A wall round the perimeter of the terrain from the ground surface down to the board. */
function skirtGeometry(vh: Float32Array, V: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const bottom = -40;
  const layer = 20 * VS;
  const edge = (pts: [number, number, number][]) => {
    const base = pos.length / 3;
    let u = 0;
    pts.forEach((p, k) => {
      if (k) u += Math.hypot(p[0] - pts[k - 1][0], p[2] - pts[k - 1][2]);
      pos.push(p[0], Math.max(p[1], bottom + 1), p[2], p[0], bottom, p[2]);
      uv.push(u / 600, Math.max(p[1], bottom + 1) / layer, u / 600, bottom / layer);
      if (k) { const o = base + (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    });
  };
  const top: [number, number, number][][] = [[], [], [], []];
  for (let k = 0; k <= N; k++) {
    top[0].push([k * CELL, vh[0 * V + k], 0]);
    top[1].push([k * CELL, vh[N * V + k], N * CELL]);
    top[2].push([0, vh[k * V + 0], k * CELL]);
    top[3].push([N * CELL, vh[k * V + N], k * CELL]);
  }
  for (const e of top) edge(e);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
