import { N, Water, Flag } from './constants';
import { Rng, fbm } from './rng';

export interface Village { x: number; y: number; name: string }

export interface Grid {
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  distWater: Uint8Array;
  /** hidden raster: cells a road passes through (derived from the road graph) */
  road: Uint8Array;
  flags: Uint8Array;
  villages: Village[];
  /** cells that form the old docks district */
  docksCells: number[];
  bay: { x: number; y: number; r: number };
}

const NAMES = ['Saltmarsh', 'Oldbridge', 'Kestrel Hill', 'Fernway', 'Millford', 'Ashcombe', 'Holloway', 'Brindle'];

export const idx = (x: number, y: number) => y * N + x;
export const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;
export const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function generateTerrain(seed: number, rng: Rng): Grid {
  const height = new Float32Array(N * N);
  const water = new Uint8Array(N * N);
  const road = new Uint8Array(N * N);
  const flags = new Uint8Array(N * N);

  // --- coast + bay (sea along the south edge) ---
  const bayX = Math.round(rng.range(44, 84));
  const bayR = rng.range(15, 19);
  const coastAt = (x: number) => 114 + (fbm(x * 0.035, 3.3, seed + 7) - 0.5) * 14;
  const bayCY = coastAt(bayX) - bayR * 0.45;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (x - bayX) / bayR, dy = (y - bayCY) / (bayR * 0.85);
      const wob = (fbm(x * 0.12, y * 0.12, seed + 11) - 0.5) * 0.5;
      if (y > coastAt(x) || dx * dx + dy * dy < 1 + wob) water[idx(x, y)] = Water.Sea;
    }

  // --- river from the north edge down into the bay ---
  const x0 = Math.max(14, Math.min(N - 15, bayX + rng.range(-34, 34)));
  const yEnd = bayCY - bayR * 0.5;
  const phase = rng.range(0, Math.PI * 2);
  const meander = rng.range(6, 10);
  for (let y = -2; y <= yEnd + 2; y += 0.5) {
    const t = Math.max(0, y) / yEnd;
    const px = x0 + (bayX - x0) * t + Math.sin(t * Math.PI * 2.2 + phase) * meander * (1 - t * 0.7)
      + (fbm(y * 0.05, 9.1, seed + 3) - 0.5) * 8;
    const hw = 0.8 + t * 1.1;
    for (let yy = Math.floor(y - hw - 1); yy <= y + hw + 1; yy++)
      for (let xx = Math.floor(px - hw - 1); xx <= px + hw + 1; xx++) {
        if (!inb(xx, yy)) continue;
        if (Math.hypot(xx - px, yy - y) <= hw && water[idx(xx, yy)] === Water.Land) water[idx(xx, yy)] = Water.River;
      }
  }

  // --- distance to water (BFS, 8-neighbour) ---
  const distWater = new Uint8Array(N * N).fill(255);
  const q: number[] = [];
  for (let i = 0; i < N * N; i++) if (water[i]) { distWater[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % N, y = (i / N) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const j = idx(nx, ny);
        if (distWater[j] > distWater[i] + 1) { distWater[j] = distWater[i] + 1; q.push(j); }
      }
  }

  // --- heightmap: low hills that rise away from the water ---
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (water[i] === Water.Sea) { height[i] = -6; continue; }
      if (water[i] === Water.River) { height[i] = -2.5; continue; }
      const n = fbm(x * 0.03, y * 0.03, seed + 1, 5);
      const hills = Math.pow(Math.max(0, n - 0.3) / 0.7, 1.4) * 60;
      height[i] = 2 + Math.min(distWater[i] * 1.4, 3 + hills);
    }
  const tmp = height.slice();
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const i = idx(x, y);
      if (water[i]) continue;
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = idx(x + dx, y + dy);
        if (!water[j]) { s += tmp[j]; c++; }
      }
      height[i] = s / c;
    }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (water[i]) continue;
      let maxd = 0;
      for (const [dx, dy] of DIR4) {
        if (!inb(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (!water[j]) maxd = Math.max(maxd, Math.abs(height[j] - height[i]));
      }
      if (maxd > 5.5) flags[i] |= Flag.Steep;
    }

  const g: Grid = { seed, height, water, distWater, road, flags, villages: [], docksCells: [], bay: { x: bayX, y: bayCY, r: bayR } };

  // --- villages ---
  const buildable = (i: number) => !water[i] && !(flags[i] & Flag.Steep);
  // harbour village: good land on the north-east shore of the bay
  let best = -1, bestS = -1e9;
  for (let y = 8; y < N - 4; y++)
    for (let x = 8; x < N - 8; x++) {
      const i = idx(x, y);
      if (!buildable(i) || distWater[i] < 4 || distWater[i] > 6) continue;
      const d = Math.hypot(x - (bayX + bayR * 0.75), y - (bayCY - bayR * 0.55));
      const s = -d + rng.next() * 2;
      if (s > bestS) { bestS = s; best = i; }
    }
  const names = NAMES.slice();
  const takeName = () => names.splice(Math.floor(rng.next() * names.length), 1)[0];
  if (best >= 0) g.villages.push({ x: best % N, y: (best / N) | 0, name: takeName() });
  const nVillages = rng.next() < 0.7 ? 3 : 2;
  for (let k = 1; k < nVillages; k++) {
    let bi = -1, bs = -1e9;
    for (let y = 12; y < N - 12; y++)
      for (let x = 12; x < N - 12; x++) {
        const i = idx(x, y);
        if (!buildable(i) || distWater[i] < 3 || distWater[i] > 14) continue;
        let minD = 1e9;
        for (const v of g.villages) minD = Math.min(minD, Math.hypot(v.x - x, v.y - y));
        if (minD < 32) continue;
        const s = -Math.abs(minD - 40) * 0.3 - distWater[i] * 0.2 + rng.next() * 6;
        if (s > bs) { bs = s; bi = i; }
      }
    if (bi >= 0) g.villages.push({ x: bi % N, y: (bi / N) | 0, name: takeName() });
  }

  // old docks: waterfront strip on the bay shore by the harbour village
  const hv = g.villages[0];
  if (hv) {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        if (!buildable(i) || distWater[i] > 3) continue;
        if (Math.hypot(x - hv.x, y - hv.y) > 12) continue;
        let nearSea = false;
        for (let dy = -3; dy <= 3 && !nearSea; dy++) for (let dx = -3; dx <= 3; dx++)
          if (inb(x + dx, y + dy) && water[idx(x + dx, y + dy)] === Water.Sea) { nearSea = true; break; }
        if (!nearSea) continue;
        flags[i] |= Flag.Docks;
        g.docksCells.push(i);
      }
  }
  return g;
}

