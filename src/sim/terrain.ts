import { N, Water, Flag } from './constants';
import { Rng, fbm } from './rng';
import type { CityProfile } from './cityprofile';

export type QuarterStyle = 'organic' | 'planned' | 'terraces' | 'radial' | 'rail';
/** An original settlement / quarter centre. villages[0] is the origin of the city. */
export interface Village {
  x: number; y: number; name: string;
  kind?: 'origin' | 'village' | 'planned' | 'garden';
  style?: QuarterStyle;
}

export interface Grid {
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  distWater: Uint8Array;
  /** hidden raster: cells a road passes through (derived from the road graph) */
  road: Uint8Array;
  flags: Uint8Array;
  villages: Village[];
  /** cells that form the old industrial district (docks / rail yards / mine yards) */
  docksCells: number[];
  bay: { x: number; y: number; r: number };
  /** railway lines, polylines in cell coordinates */
  rail: [number, number][][];
  /** pithead position for mining origins */
  mine: { x: number; y: number } | null;
  /** roundabout centres of planned boulevards (cells) */
  rondpoints: [number, number][];
}

const NAMES = ['Saltmarsh', 'Oldbridge', 'Kestrel Hill', 'Fernway', 'Millford', 'Ashcombe', 'Holloway', 'Brindle'];

export const idx = (x: number, y: number) => y * N + x;
export const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;
export const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

interface Land { water: Uint8Array; bay: { x: number; y: number; r: number }; hillAmp: number; hillPow: number; hillThresh?: number; distGain?: number; ridge?: number }

function distField(water: Uint8Array): Uint8Array {
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
  return distWater;
}

/** Sea along the south edge with a bay, and a river running into the bay (the original port landscape). */
function coastLand(seed: number, rng: Rng): Land {
  const water = new Uint8Array(N * N);
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
  return { water, bay: { x: bayX, y: bayCY, r: bayR }, hillAmp: 60, hillPow: 1.4 };
}

/** No sea: one river crossing the map from north to south (wide for 'river', thin for hills and plains). */
function inlandLand(seed: number, rng: Rng, kind: 'river' | 'hills' | 'plain'): Land {
  const water = new Uint8Array(N * N);
  const x0 = rng.range(34, N - 34), x1 = Math.max(18, Math.min(N - 18, x0 + rng.range(-30, 30)));
  const phase = rng.range(0, Math.PI * 2), meander = rng.range(5, 11);
  const hw0 = kind === 'river' ? rng.range(2.1, 2.8) : rng.range(1.15, 1.7);
  for (let y = -2; y <= N + 2; y += 0.5) {
    const t = Math.max(0, Math.min(1, y / N));
    const px = x0 + (x1 - x0) * t + Math.sin(t * Math.PI * 2.4 + phase) * meander + (fbm(y * 0.05, 9.1, seed + 3) - 0.5) * 8;
    const hw = hw0 * (0.85 + 0.3 * fbm(y * 0.08, 4.4, seed + 5));
    for (let yy = Math.floor(y - hw - 1); yy <= y + hw + 1; yy++)
      for (let xx = Math.floor(px - hw - 1); xx <= px + hw + 1; xx++) {
        if (!inb(xx, yy)) continue;
        if (Math.hypot(xx - px, yy - y) <= hw) water[idx(xx, yy)] = Water.River;
      }
  }
  return { water, bay: { x: N / 2, y: N * 1.4, r: 1 }, hillAmp: kind === 'hills' ? 250 : kind === 'plain' ? 9 : 40, hillPow: kind === 'hills' ? 1.1 : 1.5, hillThresh: kind === 'hills' ? 0.14 : 0.3, distGain: kind === 'hills' ? 4.8 : 1.4, ridge: kind === 'hills' ? 48 : 0 };
}

function heights(seed: number, land: Land, distWater: Uint8Array): { height: Float32Array; flags: Uint8Array } {
  const { water } = land;
  const height = new Float32Array(N * N);
  const flags = new Uint8Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (water[i] === Water.Sea) { height[i] = -6; continue; }
      if (water[i] === Water.River) { height[i] = -2.5; continue; }
      const n = fbm(x * 0.03, y * 0.03, seed + 1, 5);
      const th = land.hillThresh ?? 0.3;
      let hills = Math.pow(Math.max(0, n - th) / (1 - th), land.hillPow) * land.hillAmp;
      if (land.ridge) hills += (fbm(x * 0.075, y * 0.075, seed + 9, 3) - 0.35) * land.ridge * Math.min(1, hills / 25);
      height[i] = 2 + Math.min(distWater[i] * (land.distGain ?? 1.4), 3 + Math.max(0, hills));
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
  return { height, flags };
}

function markSteep(height: Float32Array, water: Uint8Array, flags: Uint8Array) {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      flags[i] &= ~Flag.Steep;
      if (water[i]) continue;
      let maxd = 0;
      for (const [dx, dy] of DIR4) {
        if (!inb(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (!water[j]) maxd = Math.max(maxd, Math.abs(height[j] - height[i]));
      }
      if (maxd > 5.5) flags[i] |= Flag.Steep;
    }
}

export function generateTerrain(seed: number, rng: Rng, cp: CityProfile): Grid {
  const land = cp.terrain === 'coast' ? coastLand(seed, rng) : inlandLand(seed, rng, cp.terrain);
  const water = land.water;
  const distWater = distField(water);
  const { height, flags } = heights(seed, land, distWater);
  markSteep(height, water, flags);
  const road = new Uint8Array(N * N);
  const g: Grid = { seed, height, water, distWater, road, flags, villages: [], docksCells: [], bay: land.bay, rail: [], mine: null, rondpoints: [] };
  placeSettlements(g, cp, rng);
  return g;
}

// ------------------------------------------------------------------ settlements: the origin first, then older villages, then later layers
function placeSettlements(g: Grid, cp: CityProfile, rng: Rng) {
  const { water, distWater, flags, height } = g;
  const buildable = (i: number) => !water[i] && !(flags[i] & Flag.Steep);
  const names = NAMES.slice();
  const takeName = () => names.splice(Math.floor(rng.next() * names.length), 1)[0];
  const farFrom = (x: number, y: number, d: number) => g.villages.every((v) => Math.hypot(v.x - x, v.y - y) >= d);
  /** open buildable land around a point (fraction of buildable cells in radius r) */
  const openness = (x: number, y: number, r: number) => {
    let ok = 0, tot = 0;
    for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) { const xx = x + dx, yy = y + dy; tot++; if (inb(xx, yy) && buildable(idx(xx, yy))) ok++; }
    return ok / tot;
  };
  const bestCell = (score: (x: number, y: number, i: number) => number | null, x0 = 10, x1 = N - 10, y0 = 10, y1 = N - 10) => {
    let best = -1, bs = -1e9;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = idx(x, y);
      if (!buildable(i)) continue;
      const s = score(x, y, i);
      if (s === null) continue;
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  };
  const add = (i: number, kind: Village['kind'], style: QuarterStyle) => { g.villages.push({ x: i % N, y: (i / N) | 0, name: takeName(), kind, style }); };

  // ---- origin
  const hasSea = cp.terrain === 'coast';
  let origin = -1;
  if (cp.origin === 'port' && hasSea) {
    // the original harbour village: good land on the north-east shore of the bay
    origin = bestCell((x, y, i) => {
      if (y < 8 || x < 8 || x >= N - 8 || y >= N - 4 || distWater[i] < 4 || distWater[i] > 6) return null;
      return -Math.hypot(x - (g.bay.x + g.bay.r * 0.75), y - (g.bay.y - g.bay.r * 0.55)) + rng.next() * 2;
    }, 8, N - 8, 8, N - 4);
    if (origin >= 0) add(origin, 'origin', 'organic');
  } else if (cp.origin === 'port') {
    // wharves on the river
    origin = bestCell((x, y, i) => (distWater[i] < 4 || distWater[i] > 6 ? null : -Math.abs(y - N * 0.58) - Math.abs(x - N * 0.5) * 0.25 + rng.next() * 3));
    if (origin >= 0) add(origin, 'origin', 'organic');
  } else if (cp.origin === 'market-town') {
    origin = bestCell((x, y, i) => (distWater[i] < 3 || distWater[i] > 9 ? null : openness(x, y, 6) * 8 - Math.hypot(x - N * 0.5, y - N * 0.5) * 0.25 + rng.next() * 3));
    if (origin < 0) origin = bestCell((x, y) => openness(x, y, 6) * 8 - Math.hypot(x - N * 0.5, y - N * 0.5) * 0.25);
    if (origin >= 0) add(origin, 'origin', 'radial');
  } else if (cp.origin === 'rail-junction') {
    origin = bestCell((x, y, i) => (distWater[i] < 6 ? null : openness(x, y, 7) * 8 - Math.hypot(x - N * 0.48, y - N * 0.5) * 0.25 + rng.next() * 3));
    if (origin < 0) origin = bestCell((x, y) => openness(x, y, 6) * 8 - Math.hypot(x - N * 0.5, y - N * 0.5) * 0.25);
    if (origin >= 0) add(origin, 'origin', 'rail');
  } else if (cp.origin === 'mining') {
    // miners' terraces on a hillside; the pithead sits uphill (a mound is raised if the land is flat)
    let hi = 0;
    for (let i = 0; i < N * N; i++) if (!water[i]) hi = Math.max(hi, height[i]);
    if (hi < 26) {
      let bx = N * 0.4 + rng.range(-12, 12), by = N * 0.4 + rng.range(-8, 8);
      for (let k = 0; k < 6 && (distWater[idx(Math.round(bx), Math.round(by))] < 8); k++) { bx = rng.range(24, N - 24); by = rng.range(24, N * 0.7); }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        if (water[i]) continue;
        const d = Math.hypot(x - bx, y - by);
        if (d < 16) height[i] += 44 * Math.exp(-(d * d) / 70);
      }
      markSteep(height, water, flags);
    }
    // village on the lower slope, a few cells below a good high point
    const target = bestCell((x, y, i) => (height[i] < 20 || distWater[i] < 6 ? null : height[i] + openness(x, y, 4) * 10 + rng.next() * 4), 14, N - 14, 14, N - 14);
    const hx = target >= 0 ? target % N : N / 2, hy = target >= 0 ? (target / N) | 0 : N / 2;
    origin = bestCell((x, y, i) => {
      const d = Math.hypot(x - hx, y - hy);
      if (d < 5 || d > 11 || distWater[i] < 4 || height[i] > height[idx(hx, hy)] - 3) return null;
      return -Math.abs(d - 7) * 2 + openness(x, y, 3) * 4 + rng.next();
    }, 10, N - 10, 10, N - 10);
    if (origin < 0) origin = target;
    if (origin >= 0) { add(origin, 'origin', 'terraces'); g.mine = { x: hx, y: hy }; }
  } else {
    // planned capital: a broad, open, level site
    origin = bestCell((x, y, i) => (distWater[i] < 4 || distWater[i] > 16 ? null : openness(x, y, 8) * 12 - Math.hypot(x - N * 0.5, y - N * 0.55) * 0.3 + rng.next() * 2));
    if (origin < 0) origin = bestCell((x, y) => openness(x, y, 6) * 8);
    if (origin >= 0) add(origin, 'origin', 'planned');
  }
  if (origin < 0) { add(idx(N >> 1, N >> 1), 'origin', 'organic'); }

  // ---- older neighbouring villages (organic old cores)
  const nVillages = rng.next() < 0.7 ? 3 : 2;
  for (let k = 1; k < nVillages; k++) {
    const bi = bestCell((x, y, i) => {
      if (x < 12 || y < 12 || x >= N - 12 || y >= N - 12 || distWater[i] < 3 || distWater[i] > 14) return null;
      let minD = 1e9;
      for (const v of g.villages) minD = Math.min(minD, Math.hypot(v.x - x, v.y - y));
      if (minD < 32) return null;
      return -Math.abs(minD - 40) * 0.3 - distWater[i] * 0.2 + rng.next() * 6;
    }, 12, N - 12, 12, N - 12);
    if (bi >= 0) add(bi, 'village', cp.origin === 'mining' ? 'terraces' : cp.origin === 'planned-capital' ? 'organic' : 'organic');
  }

  // ---- later layers add quarters on top
  for (const layer of cp.history) {
    if (layer.kind === 'planned') {
      const o = g.villages[0];
      const bi = bestCell((x, y, i) => {
        if (distWater[i] < 3 || !farFrom(x, y, 22)) return null;
        const d = Math.hypot(x - o.x, y - o.y);
        if (d > 46) return null;
        return openness(x, y, 8) * 14 - Math.abs(d - 30) * 0.3 + rng.next() * 3;
      }, 14, N - 14, 14, N - 14);
      if (bi >= 0) add(bi, 'planned', 'planned');
    } else if (layer.kind === 'garden') {
      const o = g.villages[0];
      const bi = bestCell((x, y, i) => {
        if (distWater[i] < 3 || !farFrom(x, y, 24)) return null;
        const d = Math.hypot(x - o.x, y - o.y);
        if (d < 22 || d > 48) return null;
        return openness(x, y, 6) * 8 - Math.abs(d - 34) * 0.2 + rng.next() * 4;
      }, 12, N - 12, 12, N - 12);
      if (bi >= 0) add(bi, 'garden', 'organic');
    }
  }

  // ---- the old industrial site (docks / rail yards / mine yards) next to the origin
  const hv = g.villages[0];
  if (!hv) return;
  if (cp.site === 'harbour') {
    const sea = (x: number, y: number) => inb(x, y) && (hasSea ? water[idx(x, y)] === Water.Sea : water[idx(x, y)] !== 0);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        if (!buildable(i) || distWater[i] > 3) continue;
        if (Math.hypot(x - hv.x, y - hv.y) > 12) continue;
        let near = false;
        for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (sea(x + dx, y + dy)) { near = true; break; }
        if (!near) continue;
        flags[i] |= Flag.Docks;
        g.docksCells.push(i);
      }
  }
  if (cp.site === 'harbour' && g.docksCells.length < 8) cp.site = 'railyard';
  if (cp.site === 'railyard') {
    // a railway through the origin: straight line at a seeded angle; the yards are a strip beside it
    const ang = rng.range(-0.5, 0.5) + (cp.terrain === 'coast' ? Math.PI * 0.5 : 0.1);
    const pts: [number, number][] = [];
    for (let t = -90; t <= 90; t += 6) {
      const x = hv.x + Math.cos(ang) * t + Math.sin(ang) * Math.sin(t * 0.05) * 3, y = hv.y + Math.sin(ang) * t - Math.cos(ang) * Math.sin(t * 0.05) * 3;
      if (x < 1 || y < 1 || x > N - 2 || y > N - 2) continue;
      pts.push([x, y]);
    }
    if (pts.length > 3) g.rail.push(pts);
    const offAngle = ang + Math.PI / 2;
    const side = rng.next() < 0.5 ? 1 : -1;
    for (let t = -9; t <= 9; t += 0.5) {
      const bx = hv.x + Math.cos(ang) * t + Math.cos(offAngle) * side * 5, by = hv.y + Math.sin(ang) * t + Math.sin(offAngle) * side * 5;
      for (let w = -2; w <= 2; w += 0.5) {
        const x = Math.floor(bx + Math.cos(offAngle) * w), y = Math.floor(by + Math.sin(offAngle) * w);
        if (!inb(x, y)) continue;
        const i = idx(x, y);
        if (!buildable(i) || (flags[i] & Flag.Docks)) continue;
        flags[i] |= Flag.Docks;
        g.docksCells.push(i);
      }
    }
    // rail corridor cells (no plots on the line itself)
    for (const line of g.rail) for (let k = 0; k + 1 < line.length; k++) {
      const [ax, ay] = line[k], [bx, by] = line[k + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
      for (let s = 0; s <= n; s++) { const x = Math.floor(ax + (bx - ax) * s / n), y = Math.floor(ay + (by - ay) * s / n); if (inb(x, y)) flags[idx(x, y)] |= Flag.Rail; }
    }
  }
  if (cp.site === 'mine' && g.mine) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (!buildable(i)) continue;
      if (Math.hypot(x - g.mine.x, y - g.mine.y) <= 3.6) { flags[i] |= Flag.Docks; g.docksCells.push(i); }
    }
    if (g.docksCells.length < 6) cp.site = 'railyard';
  }
}
