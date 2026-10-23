import { N, BT, Water, Flag } from './constants';
import { Rng, fbm } from './rng';
import { MinHeap } from './heap';

export interface Village { x: number; y: number; name: string }

export interface Grid {
  seed: number;
  height: Float32Array;
  water: Uint8Array;
  distWater: Uint8Array;
  road: Uint8Array;
  btype: Uint8Array;
  level: Uint8Array;
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
  const btype = new Uint8Array(N * N);
  const level = new Uint8Array(N * N);
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

  const g: Grid = { seed, height, water, distWater, road, btype, level, flags, villages: [], docksCells: [], bay: { x: bayX, y: bayCY, r: bayR } };

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

  for (const v of g.villages) layVillage(g, v, rng);
  // connect villages with country roads (each to its nearest earlier village)
  for (let k = 1; k < g.villages.length; k++) {
    let bj = 0, bd = 1e9;
    for (let j = 0; j < k; j++) {
      const d = Math.hypot(g.villages[j].x - g.villages[k].x, g.villages[j].y - g.villages[k].y);
      if (d < bd) { bd = d; bj = j; }
    }
    routeRoad(g, g.villages[k], g.villages[bj]);
  }
  // regional road off the north edge
  const north = g.villages.slice().sort((a, b) => a.y - b.y)[0];
  if (north) {
    let tx = north.x;
    while (tx < N - 1 && g.water[idx(tx, 0)]) tx++;
    routeRoad(g, north, { x: tx, y: 0 });
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
    // a dock road along the strip, then warehouses
    for (const i of g.docksCells) {
      const x = i % N, y = (i / N) | 0;
      if (distWater[i] === 2 && !road[i]) road[i] = 1;
      void x; void y;
    }
    connectToNet(g, g.docksCells.filter((i) => road[i]), hv);
    for (const i of g.docksCells) {
      if (road[i] || btype[i] === BT.Park) continue;
      btype[i] = BT.Ind; level[i] = rng.next() < 0.2 ? 2 : 1;
    }
  }
  return g;
}

function connectToNet(g: Grid, cells: number[], hub: { x: number; y: number }) {
  if (!cells.length) return;
  // connect the dock road to the village centre
  let bi = cells[0], bd = 1e9;
  for (const c of cells) {
    const d = Math.hypot((c % N) - hub.x, ((c / N) | 0) - hub.y);
    if (d < bd) { bd = d; bi = c; }
  }
  routeRoad(g, { x: bi % N, y: (bi / N) | 0 }, hub);
}

function layVillage(g: Grid, v: Village, rng: Rng) {
  const ok = (x: number, y: number) => inb(x, y) && !g.water[idx(x, y)] && !(g.flags[idx(x, y)] & Flag.Steep);
  const horiz = rng.next() < 0.5;
  const len = rng.int(5, 7);
  const lay = (x: number, y: number, dx: number, dy: number, n: number) => {
    for (let s = 0; s < n; s++) {
      const xx = x + dx * s, yy = y + dy * s;
      if (!ok(xx, yy)) break;
      g.road[idx(xx, yy)] = 1;
    }
  };
  const [mdx, mdy] = horiz ? [1, 0] : [0, 1];
  lay(v.x, v.y, mdx, mdy, len);
  lay(v.x, v.y, -mdx, -mdy, len);
  const crosses = rng.int(2, 3);
  const offs = [0, -4, 4].slice(0, crosses);
  for (const o of offs) {
    const cx = v.x + mdx * o, cy = v.y + mdy * o;
    const l = rng.int(3, 5);
    lay(cx, cy, mdy, mdx, l);
    lay(cx, cy, -mdy, -mdx, l);
  }
  let parkPlaced = false;
  for (let y = v.y - 10; y <= v.y + 10; y++)
    for (let x = v.x - 10; x <= v.x + 10; x++) {
      if (!ok(x, y)) continue;
      const i = idx(x, y);
      if (g.road[i] || g.btype[i]) continue;
      if (!adjRoad(g.road, x, y)) continue;
      const d = Math.hypot(x - v.x, y - v.y);
      if (d > 9 || rng.next() > 1.05 - d * 0.07) continue;
      if (!parkPlaced && d < 4 && rng.next() < 0.3) { g.btype[i] = BT.Park; g.level[i] = 1; parkPlaced = true; continue; }
      if (d < 2.5 && rng.next() < 0.6) { g.btype[i] = BT.Com; g.level[i] = 1; }
      else { g.btype[i] = BT.Res; g.level[i] = 1; }
    }
}

export function adjRoad(road: Uint8Array, x: number, y: number): boolean {
  for (const [dx, dy] of DIR4) {
    const nx = x + dx, ny = y + dy;
    if (inb(nx, ny) && road[idx(nx, ny)]) return true;
  }
  return false;
}

/** A* (4-neighbour) road between two points, with a turn penalty so roads stay straight-ish. */
function routeRoad(g: Grid, a: { x: number; y: number }, b: { x: number; y: number }) {
  const S = N * N * 4;
  const cost = new Float32Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const open = new MinHeap();
  const heur = (x: number, y: number) => Math.abs(x - b.x) + Math.abs(y - b.y);
  for (let d = 0; d < 4; d++) { const s = idx(a.x, a.y) * 4 + d; cost[s] = 0; open.push(s, heur(a.x, a.y)); }
  let found = -1;
  while (open.size) {
    const s = open.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const c = s >> 2, dir = s & 3, x = c % N, y = (c / N) | 0;
    if (x === b.x && y === b.y) { found = s; break; }
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR4[d][0], ny = y + DIR4[d][1];
      if (!inb(nx, ny)) continue;
      const j = idx(nx, ny);
      let step = 1;
      if (g.water[j]) step = g.water[j] === Water.Sea ? 80 : 10;
      else if (g.flags[j] & Flag.Steep) step = 4;
      else step += Math.abs(g.height[j] - g.height[c]) * 0.15;
      if (g.road[j]) step *= 0.35;
      if (g.btype[j]) step += 3;
      if (d !== dir) step += 2.5;
      const ns = j * 4 + d;
      const nc = cost[s] + step;
      if (nc < cost[ns]) { cost[ns] = nc; prev[ns] = s; open.push(ns, nc + heur(nx, ny)); }
    }
  }
  for (let s = found; s >= 0; s = prev[s]) {
    const c = s >> 2;
    g.road[c] = 1;
    if (g.btype[c]) { g.btype[c] = BT.None; g.level[c] = 0; }
  }
}
