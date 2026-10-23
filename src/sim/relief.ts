/**
 * Relief helpers shared by the sim (worker) and the planner (main thread): ground height lookups, slopes, Tobler walking,
 * the metro's vertical profile (station depth from the gradient limit, segment types and costs) and the car effort field.
 * Pure functions of the height / water rasters, so both threads give the same quote.
 */
import { N, CELL, ZONE, NZ, ZONES } from './constants';

export const RELIEF = {
  maxGrade: 0.04,          // metro gradient limit (m per m)
  maxDepth: 45,            // deepest station / tunnel the profile may use below the ground, metres
  boredCover: 10,          // ground more than this above the track = bored tunnel
  viaductCover: -4,        // ground more than this below the track = viaduct
  stationDepthCost: 0.14e6, // per metre of station depth
  escalatorMin: 0.03,      // minutes of extra access per metre of depth
  sampleM: 25,             // profile sampling step along a segment
};

/** Metro cost per km by construction type: [cut-and-cover / at grade, bored tunnel, viaduct, under water]. */
export const SEG_KM_COST = [11e6, 30e6, 19e6, 34e6];
export const SEG_NAMES = ['cut-and-cover', 'bored tunnel', 'viaduct', 'under water'];

export interface Terr { height: Float32Array; water: Uint8Array }

const clampI = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Ground height (m) at cell-unit position (x, y), bilinear between cell centres. */
export function hAt(height: Float32Array, x: number, y: number): number {
  const fx = clampI(x - 0.5, 0, N - 1.001), fy = clampI(y - 0.5, 0, N - 1.001);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  return (height[y0 * N + x0] * (1 - tx) + height[y0 * N + x0 + 1] * tx) * (1 - ty) + (height[(y0 + 1) * N + x0] * (1 - tx) + height[(y0 + 1) * N + x0 + 1] * tx) * ty;
}

/** Walking speed factor from slope (Tobler's hiking function, 1 on the flat, walking in the direction of the slope s = rise / run). */
export function toblerFactor(s: number): number {
  return Math.min(1.2, Math.exp(-3.5 * (Math.abs(s + 0.05) - 0.05)));
}

/** Gradient magnitude (m per m) per cell from central differences. */
export function slopeField(height: Float32Array): Float32Array {
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(N - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(N - 1, y + 1);
    const dx = (height[y * N + xp] - height[y * N + xm]) / ((xp - xm) * CELL), dy = (height[yp * N + x] - height[ym * N + x]) / ((yp - ym) * CELL);
    out[y * N + x] = Math.hypot(dx, dy);
  }
  return out;
}

/** View value 0..1: how much a cell stands above its surroundings and looks over water or lowland. */
export function viewField(height: Float32Array, water: Uint8Array): Float32Array {
  const out = new Float32Array(N * N);
  const R = 6;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    if (water[i]) continue;
    let s = 0, c = 0, wet = 0;
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const j = yy * N + xx; s += height[j]; c++; if (water[j]) wet++;
    }
    const prom = clampI((height[i] - s / c) / 22, 0, 1);
    out[i] = prom * (0.65 + 0.35 * clampI(wet / Math.max(1, c) * 6, 0, 1));
  }
  return out;
}

// ------------------------------------------------------------------ metro vertical profile
export interface Pt { x: number; y: number }
export interface SegQuote {
  km: number;
  /** km by construction type (SEG_NAMES order) */
  by: number[];
  cost: number;
  /** gradient of the track between the two stations, m per m (signed: positive rises towards the second station) */
  grade: number;
  dominant: number;
}
export interface LineQuote {
  km: number;
  wkm: number;
  by: number[];
  /** track cost only (no stations) */
  trackCost: number;
  /** extra station cost from depth */
  stationCost: number;
  cost: number;
  segs: SegQuote[];
  /** ground height, track elevation and depth below ground at each station */
  ground: number[];
  elev: number[];
  depth: number[];
  /** a station would have to lie deeper than RELIEF.maxDepth to satisfy the gradient limit: -1 = fine, else the station index */
  badStation: number;
  ok: boolean;
}

/**
 * Vertical profile of a line through the given stations: every station starts at ground level, then the lower envelope
 * under the gradient limit pulls hilltop stations down (deep stations) so no segment exceeds RELIEF.maxGrade.
 * Segment types come from the cover (ground minus track) sampled along the way.
 */
export function quoteLine(pts: Pt[], t: Terr): LineQuote {
  const n = pts.length;
  const ground = pts.map((p) => hAt(t.height, p.x, p.y));
  const L: number[] = [];
  for (let k = 1; k < n; k++) L.push(Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) * CELL);
  const elev = ground.slice();
  for (let k = 1; k < n; k++) elev[k] = Math.min(elev[k], elev[k - 1] + RELIEF.maxGrade * L[k - 1]);
  for (let k = n - 2; k >= 0; k--) elev[k] = Math.min(elev[k], elev[k + 1] + RELIEF.maxGrade * L[k]);
  const depth = ground.map((g, k) => Math.max(0, g - elev[k]));
  let badStation = -1;
  depth.forEach((d, k) => { if (d > RELIEF.maxDepth && badStation < 0) badStation = k; });
  const by = [0, 0, 0, 0];
  const segs: SegQuote[] = [];
  let trackCost = 0;
  for (let k = 1; k < n; k++) {
    const a = pts[k - 1], b = pts[k];
    const km = L[k - 1] / 1000;
    const steps = Math.max(1, Math.ceil(L[k - 1] / RELIEF.sampleM));
    const cnt = [0, 0, 0, 0];
    let deepPrem = 0;   // extra bored-tunnel cost for deep cover (km-equivalents)
    for (let s = 0; s < steps; s++) {
      const u = (s + 0.5) / steps, x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u;
      const wi = clampI(Math.floor(y), 0, N - 1) * N + clampI(Math.floor(x), 0, N - 1);
      const e = elev[k - 1] + (elev[k] - elev[k - 1]) * u;
      const cover = hAt(t.height, x, y) - e;
      const ty = t.water[wi] ? 3 : cover > RELIEF.boredCover ? 1 : cover < RELIEF.viaductCover ? 2 : 0;
      cnt[ty]++;
      if (ty === 1) deepPrem += Math.min(1.2, (cover - RELIEF.boredCover) / 60) * 0.8 / steps;   // up to +96% for tunnels under a high ridge
    }
    const sb = cnt.map((c) => (c / steps) * km);
    let cost = deepPrem * km * SEG_KM_COST[1], dom = 0;
    for (let q = 0; q < 4; q++) { cost += sb[q] * SEG_KM_COST[q]; by[q] += sb[q]; if (sb[q] > sb[dom]) dom = q; }
    segs.push({ km, by: sb, cost, grade: (elev[k] - elev[k - 1]) / L[k - 1], dominant: dom });
    trackCost += cost;
  }
  const stationCost = depth.reduce((s, d) => s + d * RELIEF.stationDepthCost, 0);
  const km = by[0] + by[1] + by[2] + by[3];
  return { km, wkm: by[3], by, trackCost, stationCost, cost: trackCost + stationCost, segs, ground, elev, depth, badStation, ok: badStation < 0 };
}

// ------------------------------------------------------------------ car effort between zones
/**
 * Terrain effort between zone centres, as a ratio of the flat-land distance (>= 1): Dijkstra over a half-resolution grid with a
 * step cost that rises with slope and crossing water. A ridge between two zones makes the detour over the pass (or the climb) cost.
 * Index a * ZONES + b.
 */
export function zoneEffort(t: Terr): Float32Array {
  const H = N >> 1, M = H * H;
  const hh = new Float32Array(M), wet = new Uint8Array(M);
  for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) {
    let s = 0, w = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const i = (y * 2 + dy) * N + x * 2 + dx; s += t.height[i]; if (t.water[i]) w++; }
    hh[y * H + x] = s / 4; wet[y * H + x] = w >= 3 ? 1 : 0;
  }
  const out = new Float32Array(ZONES * ZONES).fill(1);
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
  const dist = new Float64Array(M);
  const zn = (z: number) => { const cx = ((z % NZ) + 0.5) * ZONE / 2, cy = (((z / NZ) | 0) + 0.5) * ZONE / 2; return Math.floor(cy) * H + Math.floor(cx); };
  for (let a = 0; a < ZONES; a++) {
    dist.fill(Infinity);
    const src = zn(a);
    dist[src] = 0;
    // binary heap on (dist, node) pairs, kept simple with parallel arrays
    const hk: number[] = [0], hv: number[] = [src];
    const push = (k: number, v: number) => {
      let i = hk.length; hk.push(k); hv.push(v);
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= hk[i]) break; [hk[p], hk[i]] = [hk[i], hk[p]]; [hv[p], hv[i]] = [hv[i], hv[p]]; i = p; }
    };
    const pop = () => {
      const k = hk[0], v = hv[0], lk = hk.pop()!, lv = hv.pop()!;
      if (hk.length) {
        hk[0] = lk; hv[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < hk.length && hk[l] < hk[m]) m = l;
          if (r < hk.length && hk[r] < hk[m]) m = r;
          if (m === i) break;
          [hk[m], hk[i]] = [hk[i], hk[m]]; [hv[m], hv[i]] = [hv[i], hv[m]]; i = m;
        }
      }
      return [k, v] as const;
    };
    while (hk.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      const ux = u % H, uy = (u / H) | 0;
      for (const [dx, dy, len] of NB) {
        const vx = ux + dx, vy = uy + dy;
        if (vx < 0 || vy < 0 || vx >= H || vy >= H) continue;
        const v = vy * H + vx;
        const s = Math.abs(hh[v] - hh[u]) / (len * 2 * CELL);
        const c = len * (1 + Math.pow(s / 0.14, 2) + (wet[v] ? 0.3 : 0));   // roads follow contours and bridge rivers: only real climbs and detours cost
        if (d + c < dist[v]) { dist[v] = d + c; push(d + c, v); }
      }
    }
    const ax = a % NZ, ay = (a / NZ) | 0;
    for (let b = 0; b < ZONES; b++) {
      if (a === b) continue;
      const dx = Math.abs((b % NZ) - ax) * ZONE / 2, dy = Math.abs(((b / NZ) | 0) - ay) * ZONE / 2;
      const flat = dx + dy - (2 - Math.SQRT2) * Math.min(dx, dy);
      out[a * ZONES + b] = flat > 0 ? Math.min(3, 1 + 0.9 * Math.max(0, dist[zn(b)] / flat - 1)) : 1;
    }
  }
  return out;
}
