import * as THREE from 'three';
import { N, CELL, Flag } from '../sim/constants';
import { VS } from './common';

export interface TerrainView {
  mesh: THREE.Mesh;
  water: THREE.Mesh;
  heat: THREE.Mesh;
  heatTex: THREE.DataTexture;
  material: THREE.MeshStandardMaterial;
  waterMat: THREE.MeshStandardMaterial;
  /** height lookup at world x,z (bilinear on the vertex grid) */
  sample(x: number, z: number): number;
  setHeat(lv: Float32Array, water: Uint8Array): void;
  catchment: THREE.Mesh;
  setCatchment(c: Uint8Array): void;
}

export function buildTerrain(height: Float32Array, wmask: Uint8Array, flags: Uint8Array): TerrainView {
  const V = N + 1;
  const vh = new Float32Array(V * V);
  const vw = new Float32Array(V * V); // water fraction per vertex
  const vd = new Float32Array(V * V); // docks (concrete) fraction
  const vs = new Float32Array(V * V); // steep (woodland) fraction
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
        }
      vh[vy * V + vx] = (s / c) * VS;
      vw[vy * V + vx] = w / c;
      vd[vy * V + vx] /= c;
      vs[vy * V + vx] /= c;
    }

  const pos = new Float32Array(V * V * 3);
  const col = new Float32Array(V * V * 3);
  const uv = new Float32Array(V * V * 2);
  const sand = new THREE.Color('#e6dcc2');
  const low = new THREE.Color('#cdd9b6');
  const mid = new THREE.Color('#bfcfa6');
  const high = new THREE.Color('#d3dcc0');
  const bed = new THREE.Color('#9fbccb');
  const concrete = new THREE.Color('#c9c6be');
  const wood = new THREE.Color('#9fb889');
  const rock = new THREE.Color('#bdb8aa');
  const c = new THREE.Color();
  for (let vy = 0; vy < V; vy++)
    for (let vx = 0; vx < V; vx++) {
      const k = vy * V + vx;
      const h = vh[k];
      pos[k * 3] = vx * CELL; pos[k * 3 + 1] = h; pos[k * 3 + 2] = vy * CELL;
      uv[k * 2] = vx / N; uv[k * 2 + 1] = vy / N;
      if (vw[k] > 0.6) c.copy(bed);
      else if (h < 5 * VS || vw[k] > 0) c.copy(sand).lerp(low, Math.max(0, Math.min(1, (h - 2 * VS) / (3 * VS))));
      else if (h < 25 * VS) c.copy(low).lerp(mid, (h - 5 * VS) / (20 * VS));
      else c.copy(mid).lerp(high, Math.min(1, (h - 25 * VS) / (30 * VS)));
      if (h > 55 * VS) c.lerp(rock, Math.min(0.85, (h - 55 * VS) / (90 * VS)));
      if (vs[k] > 0) c.lerp(wood, vs[k] * 0.9);
      if (vd[k] > 0 && vw[k] < 0.6) c.lerp(concrete, Math.min(1, vd[k] * 1.6));
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
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, transparent: false });
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // skirt: a pale plinth under the model, like a base board
  const waterMat = new THREE.MeshStandardMaterial({ color: '#93b9d0', roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.9 });
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
    mesh, water, heat, heatTex, material, waterMat, catchment,
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
