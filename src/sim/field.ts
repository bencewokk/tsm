/**
 * The density-and-height field. It exists before any building does and caps what may be built where:
 *   centrality  - one main centre (the oldest quarter), a few smaller centres (the other quarters)
 *   job concentration - smoothed jobs around a cell
 *   station access   - how much a walkable, well-connected station reaches from a cell
 * Allowed height comes from the OVERLAP of the three: towers need a centre AND jobs AND a station. Without any transit
 * the tallest allowed building is a mid-rise; tall clusters appear only where the player's lines raise accessibility.
 * F (0..1) is the coarser density class used to pick the plot fabric (CBD / inner / medium / suburb / fringe).
 */
import { N, PERSONS_PER_HOME, Flag } from './constants';
import { baselineHeight } from './metrics';
import type { Sim } from './sim';
import type { Lot } from './lots';

export const FIELD = {
  cbdOffset: 3.4,      // cells from the old town's centre to the business district's centre
  mainR0: 6.0,         // cells: radius of the main centre's influence at the start
  mainGrow: 0.4,       // extra cells per sqrt(thousand people)
  subW: { origin: 1, village: 0.42, planned: 0.5, garden: 0.3 } as Record<string, number>,
  subR: 4.2,
  jobsRef: 45,         // mean jobs per cell (5x5 blur) that count as full job concentration
  accRef: 0.2,         // station accessibility (share of the city's jobs reached) that counts as full
  walkFull: 3,         // minutes of walk with full station weight
  walkZero: 10,        // minutes at which the station no longer counts
  hBase: 13, hRange: 175, hPow: 1.6,
  noAccess: 0.3,       // share of the height potential kept with no station at all
  noJobs: 0.3,
  level2: 12, level3: 24,   // metres of allowed height that unlock level 2 / level 3 buildings
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class DensityField {
  cent = new Float32Array(N * N);
  jc = new Float32Array(N * N);
  acc = new Float32Array(N * N);
  /** density class field 0..1 */
  F = new Float32Array(N * N);
  /** allowed building height, metres */
  hmax = new Float32Array(N * N);
  mainR = FIELD.mainR0;
  main = { x: N / 2, y: N / 2 };
  private placed = false;

  private blur = new Float32Array(N * N);
  private tmp = new Float32Array(N * N);

  update(sim: Sim) {
    const pop = sim.homes * PERSONS_PER_HOME;
    this.mainR = FIELD.mainR0 + FIELD.mainGrow * Math.sqrt(pop / 1000);
    const ds = sim.town.districts;
    if (ds.length && !this.placed) {
      // the business district forms at the flank of the old town, not on top of its protected heart: pick the side with the most free land
      let best = { x: ds[0].x, y: ds[0].y }, bs = -1;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + 0.2, px = ds[0].x + Math.cos(a) * FIELD.cbdOffset, py = ds[0].y + Math.sin(a) * FIELD.cbdOffset;
        let free = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const x = Math.floor(px + dx), y = Math.floor(py + dy);
          if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1 || dx * dx + dy * dy > 10) continue;
          const i = y * N + x;
          if (!sim.g.water[i] && !(sim.g.flags[i] & (Flag.Steep | Flag.Docks))) free++;
        }
        if (free > bs) { bs = free; best = { x: px, y: py }; }
      }
      this.main = best; this.placed = true;
    }
    // job concentration: two box passes of radius 2 over the job raster (~gaussian, 5x5 twice)
    this.blur.set(sim.cJobs);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let s = 0; for (let d = -2; d <= 2; d++) s += this.blur[y * N + clamp(x + d, 0, N - 1)];
        this.tmp[y * N + x] = s / 5;
      }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let s = 0; for (let d = -2; d <= 2; d++) s += this.tmp[clamp(y + d, 0, N - 1) * N + x];
        this.blur[y * N + x] = s / 5;
      }
    }
    for (let i = 0; i < N * N; i++) {
      const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
      let c = Math.exp(-Math.pow(Math.hypot(x - this.main.x, y - this.main.y) / this.mainR, 2));
      for (let k = 1; k < ds.length; k++) {
        const d = ds[k], w = FIELD.subW[d.kind ?? 'village'] ?? 0.4;
        c = Math.max(c, w * Math.exp(-Math.pow(Math.hypot(x - d.x, y - d.y) / FIELD.subR, 2)));
      }
      this.cent[i] = c;
      this.jc[i] = clamp(this.blur[i] / FIELD.jobsRef, 0, 1);
      const a = sim.accCell[i];
      this.acc[i] = a;
      const cc = Math.max(c, 0.4 * a);                       // transit corridors read as centres of their own
      const hp = Math.pow(cc, 0.8) * (FIELD.noAccess + (1 - FIELD.noAccess) * a) * (FIELD.noJobs + (1 - FIELD.noJobs) * this.jc[i]);
      this.hmax[i] = FIELD.hBase + FIELD.hRange * Math.pow(clamp(hp, 0, 1), FIELD.hPow);
      const lvT = clamp((sim.lvS[i] - 0.3) / 0.5, 0, 1);
      this.F[i] = clamp(0.5 * cc + 0.2 * this.jc[i] + 0.2 * a + 0.2 * lvT, 0, 1);
    }
  }

  private at(f: Float32Array, x: number, y: number) {
    const fx = clamp(x - 0.5, 0, N - 1.001), fy = clamp(y - 0.5, 0, N - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    return (f[y0 * N + x0] * (1 - tx) + f[y0 * N + x0 + 1] * tx) * (1 - ty) + (f[(y0 + 1) * N + x0] * (1 - tx) + f[(y0 + 1) * N + x0 + 1] * tx) * ty;
  }
  hmaxAt(x: number, y: number) { return this.at(this.hmax, x, y); }
  fAt(x: number, y: number) { return this.at(this.F, x, y); }
  /** highest building level the allowed height unlocks */
  maxLevel(x: number, y: number) { const h = this.hmaxAt(x, y); return h >= FIELD.level3 ? 3 : h >= FIELD.level2 ? 2 : 1; }
}

/** Height (m) of a plot's current building, as drawn. */
export const builtHeight = (_s: Sim, l: Lot) => (l.hgt > 0 && l.level > 0 ? l.hgt : baselineHeight(l));
