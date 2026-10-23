import { N, CELL, ZONE, NZ, ZONES, BT, Flag, HOMES, COM_JOBS, IND_JOBS, BUILD_MONTHS, PERSONS_PER_HOME, WORKERS_PER_HOME } from './constants';
import { Rng } from './rng';
import { generateTerrain, idx, inb, adjRoad, DIR4, type Grid } from './terrain';
import type { Command, InitMsg, StateMsg, Stats } from './protocol';

/** Tunable knobs for the growth model. Exposed so the headless runner / UI can poke them. */
export const TUNE = {
  tau: 10,               // minutes: accessibility decay
  freeSpeed: 45,         // km/h
  circuity: 1.3,
  accessMin: 4,          // minutes to park/unpark
  roadCap: 260,          // car trip-ends per road cell per day before congestion bites
  bprA: 1.5,
  bprB: 2,
  wCar: 0.95,
  wTransit: 1.25,
  base: 0.12,
  wWater: 0.12,
  wPark: 0.05,
  wInd: 0.06,
  wCentre: 0.55,
  spawnLV: 0.24,
  upLV: [0, 0.6, 0.82],    // LV to upgrade from level k -> k+1 (index = current level)
  comUpLV: [0, 0.55, 0.88],
  downLV: [0, 0.1, 0.3, 0.5],
  growth: 0.032,        // base monthly growth rate of the region's demand pool
  minGrowth: 180,        // homes per month floor
};

export class Sim {
  rng: Rng;
  g: Grid;
  month = 0;
  speed = 1;
  // per-cell
  target = new Uint8Array(N * N);
  constr = new Uint8Array(N * N);
  constrTotal = new Uint8Array(N * N);
  lv = new Float32Array(N * N);
  age = new Uint16Array(N * N);
  low = new Uint8Array(N * N);
  roadDist = new Uint8Array(N * N);
  transitCell = new Float32Array(N * N);   // transit accessibility at cell
  stationPrem = new Float32Array(N * N);   // walkable station premium
  planType = new Uint8Array(N * N);
  planLevel = new Uint8Array(N * N);
  // per-zone
  zHomes = new Float64Array(ZONES);
  zJobs = new Float64Array(ZONES);
  zRoads = new Float64Array(ZONES);
  zCong = new Float64Array(ZONES);       // volume / capacity
  zSpeed = new Float64Array(ZONES);
  zCarAcc = new Float64Array(ZONES);
  zTransitShare = new Float64Array(ZONES);
  driveTime = new Float64Array(ZONES * ZONES);
  // pools
  resPool = 0;
  comPool = 0;
  indPool = 0;
  resDemand = 0;
  comDemand = 0;
  indDemand = 0;
  homes = 0;
  jobs = 0;
  congestion = 0;
  pressure = 0;
  driveSpeed = 45;
  centre = { x: N / 2, y: N / 2 };
  money = 150e6;
  income = 0;
  expenses = 0;
  buildSpend = 0;
  log: string[] = [];
  actions: { month: number; cmd: Command }[] = [];

  constructor(public seed: number) {
    this.rng = new Rng(seed);
    this.g = generateTerrain(seed, this.rng);
    this.aggregate();
    this.computeLandValue();
  }

  // ---------------------------------------------------------------- commands
  apply(cmd: Command) {
    if (cmd.type !== 'speed') this.actions.push({ month: this.month, cmd });
    switch (cmd.type) {
      case 'speed': this.speed = cmd.speed; break;
      case 'step': for (let k = 0; k < cmd.months; k++) this.tick(); break;
      default: this.applyGame(cmd);
    }
  }

  /** Hook for game commands (metro, events); extended in later milestones. */
  protected applyGame(_cmd: Command) {}

  paused(): boolean {
    return false;
  }

  quoteLine(_stations: number[]) {
    return { cost: 0, km: 0, underwaterKm: 0 };
  }

  say(s: string) {
    this.log.push(`${this.month}|${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  // ---------------------------------------------------------------- monthly tick
  tick() {
    this.month++;
    this.progressConstruction();
    this.aggregate();
    this.computeCongestion();
    this.computeDriveTimes();
    this.computeTransit();
    this.computeLandValue();
    this.grow();
    this.extendRoads();
    this.finance();
  }

  private progressConstruction() {
    const g = this.g;
    for (let i = 0; i < N * N; i++) {
      this.age[i] = Math.min(65000, this.age[i] + 1);
      if (this.constr[i] > 0) {
        this.constr[i]--;
        if (this.constr[i] === 0) {
          g.level[i] = this.target[i];
          this.target[i] = 0;
          this.age[i] = 0;
        }
      }
    }
  }

  homesAt(i: number) { return this.g.btype[i] === BT.Res ? HOMES[this.g.level[i]] : 0; }
  jobsAt(i: number) {
    const t = this.g.btype[i], l = this.g.level[i];
    return t === BT.Com ? COM_JOBS[l] : t === BT.Ind ? IND_JOBS[l] : 0;
  }
  zoneOf(i: number) { return (((i / N) | 0) / ZONE | 0) * NZ + ((i % N) / ZONE | 0); }

  aggregate() {
    const g = this.g;
    this.zHomes.fill(0); this.zJobs.fill(0); this.zRoads.fill(0);
    let h = 0, j = 0, jx = 0, jy = 0;
    for (let i = 0; i < N * N; i++) {
      const z = this.zoneOf(i);
      const hh = this.homesAt(i), jj = this.jobsAt(i);
      this.zHomes[z] += hh; this.zJobs[z] += jj; h += hh; j += jj;
      jx += (jj + hh * 0.3) * (i % N); jy += (jj + hh * 0.3) * ((i / N) | 0);
      if (g.road[i]) this.zRoads[z]++;
    }
    this.homes = h; this.jobs = j;
    const w = j + h * 0.3;
    if (w > 0) this.centre = { x: jx / w, y: jy / w };
    // road distance (BFS up to 4)
    const rd = this.roadDist;
    rd.fill(9);
    const q: number[] = [];
    for (let i = 0; i < N * N; i++) if (g.road[i]) { rd[i] = 0; q.push(i); }
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      if (rd[i] >= 4) continue;
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const jn = idx(nx, ny);
        if (rd[jn] > rd[i] + 1) { rd[jn] = rd[i] + 1; q.push(jn); }
      }
    }
  }

  private computeCongestion() {
    // car trip-ends per zone (2 trips per worker per day + visitor trips to jobs), smoothed over 3x3 zones
    const ends = new Float64Array(ZONES);
    for (let z = 0; z < ZONES; z++) {
      const car = 1 - this.zTransitShare[z] * 0.9;
      ends[z] = (this.zHomes[z] * WORKERS_PER_HOME * 2 + this.zJobs[z] * 1.2) * car;
    }
    let vol = 0, cap = 0, wsum = 0, ssum = 0;
    for (let zy = 0; zy < NZ; zy++)
      for (let zx = 0; zx < NZ; zx++) {
        let e = 0, r = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ax = zx + dx, ay = zy + dy;
            if (ax < 0 || ay < 0 || ax >= NZ || ay >= NZ) continue;
            const wgt = dx === 0 && dy === 0 ? 1 : 0.5;
            e += ends[ay * NZ + ax] * wgt; r += this.zRoads[ay * NZ + ax] * wgt;
          }
        const z = zy * NZ + zx;
        const vc = r > 0 ? e / (r * TUNE.roadCap) : 0;
        this.zCong[z] = vc;
        this.zSpeed[z] = TUNE.freeSpeed / (1 + TUNE.bprA * Math.pow(vc, TUNE.bprB));
        vol += ends[z]; cap += this.zRoads[z] * TUNE.roadCap;
        wsum += ends[z]; ssum += ends[z] * this.zSpeed[z];
      }
    // headline congestion: trip-weighted v/c
    let wc = 0;
    for (let z = 0; z < ZONES; z++) wc += ends[z] * this.zCong[z];
    this.congestion = vol > 0 ? wc / vol : 0;
    this.driveSpeed = wsum > 0 ? ssum / wsum : TUNE.freeSpeed;
    void cap;
  }

  private computeDriveTimes() {
    const dt = this.driveTime;
    for (let a = 0; a < ZONES; a++) {
      const ax = (a % NZ) + 0.5, ay = ((a / NZ) | 0) + 0.5;
      for (let b = 0; b < ZONES; b++) {
        const bx = (b % NZ) + 0.5, by = ((b / NZ) | 0) + 0.5;
        const mx = Math.min(NZ - 1, Math.floor((ax + bx) / 2)), my = Math.min(NZ - 1, Math.floor((ay + by) / 2));
        const dist = a === b ? 300 : Math.hypot(ax - bx, ay - by) * ZONE * CELL * TUNE.circuity;
        const sp = (this.zSpeed[a] + this.zSpeed[b] + this.zSpeed[my * NZ + mx] + this.driveSpeed) / 4;
        dt[a * ZONES + b] = (dist / 1000) / sp * 60 + TUNE.accessMin;
      }
    }
    let J = this.jobs || 1;
    for (let a = 0; a < ZONES; a++) {
      let s = 0;
      for (let b = 0; b < ZONES; b++) if (this.zJobs[b] > 0) s += this.zJobs[b] * Math.exp(-dt[a * ZONES + b] / TUNE.tau);
      this.zCarAcc[a] = s / J;
    }
    J = 0;
  }

  /** Transit accessibility: filled in by the metro milestone. */
  protected computeTransit() {}

  /** Bilinear sample of a zone field at a cell. */
  zoneSample(f: Float64Array, i: number): number {
    const fx = ((i % N) + 0.5) / ZONE - 0.5, fy = (((i / N) | 0) + 0.5) / ZONE - 0.5;
    const x0 = Math.max(0, Math.min(NZ - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(NZ - 1, Math.floor(fy)));
    const x1 = Math.min(NZ - 1, x0 + 1), y1 = Math.min(NZ - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    return (f[y0 * NZ + x0] * (1 - tx) + f[y0 * NZ + x1] * tx) * (1 - ty) + (f[y1 * NZ + x0] * (1 - tx) + f[y1 * NZ + x1] * tx) * ty;
  }

  computeLandValue() {
    const g = this.g;
    // nuisance + amenity fields via small windows
    const ind = new Float32Array(N * N), park = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const t = g.btype[i];
      if (t !== BT.Ind && t !== BT.Park) continue;
      const x = i % N, y = (i / N) | 0, R = t === BT.Ind ? 4 : 3;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          if (!inb(x + dx, y + dy)) continue;
          const f = 1 - Math.hypot(dx, dy) / (R + 1);
          if (f <= 0) continue;
          const j = idx(x + dx, y + dy);
          if (t === BT.Ind) ind[j] += f * g.level[i]; else park[j] += f;
        }
    }
    const cx = this.centre.x, cy = this.centre.y;
    for (let i = 0; i < N * N; i++) {
      if (g.water[i]) { this.lv[i] = 0; continue; }
      const rdf = [1, 1, 0.85, 0.65, 0.45][Math.min(4, this.roadDist[i])] ?? 0.3;
      const car = this.zoneSample(this.zCarAcc, i) * rdf;
      const dw = g.distWater[i];
      const water = dw <= 4 ? TUNE.wWater * (1 - (dw - 1) / 4) : 0;
      const pk = Math.min(0.15, park[i] * TUNE.wPark);
      const nz = Math.min(0.4, ind[i] * TUNE.wInd);
      const dc = Math.hypot((i % N) - cx, ((i / N) | 0) - cy) / (N * 0.5);
      let v = TUNE.base + TUNE.wCar * car + TUNE.wTransit * this.transitCell[i] + this.stationPrem[i] + water + pk - nz - TUNE.wCentre * dc;
      if (g.flags[i] & Flag.Steep) v -= 0.2;
      this.lv[i] = Math.max(0, Math.min(1.5, v));
    }
  }

  // ---------------------------------------------------------------- growth
  private grow() {
    const g = this.g;
    const workers = this.homes * WORKERS_PER_HOME;
    const scale = Math.max(400, workers);
    this.resDemand = clamp((this.jobs - workers * 0.95) / scale * 3 + 0.35, -1, 1);
    this.comDemand = clamp((workers * 0.95 - this.jobs) / scale * 3 + 0.35, -1, 1);
    let indJobs = 0;
    for (let i = 0; i < N * N; i++) if (g.btype[i] === BT.Ind) indJobs += this.jobsAt(i);
    this.indDemand = clamp(0.5 - (indJobs / Math.max(1, this.jobs)) * 3, -1, 1);

    // regional demand, slowed by congestion (the city pushes back)
    let lvSum = 0, lvN = 0;
    for (let i = 0; i < N * N; i++) if (g.btype[i] === BT.Res) { lvSum += this.lv[i]; lvN++; }
    const attract = lvN ? lvSum / lvN : 0.4;
    const congPenalty = 1 / (1 + 1.2 * Math.max(0, this.congestion - 0.6));
    const B = Math.max(TUNE.minGrowth, this.homes * TUNE.growth * (0.4 + attract) * congPenalty);
    this.resPool = this.resPool * 0.85 + B * Math.max(0.05, 0.5 + 0.5 * this.resDemand);
    const jobB = B * WORKERS_PER_HOME * Math.max(0.05, 0.5 + 0.5 * this.comDemand);
    this.comPool = this.comPool * 0.85 + jobB * (this.indDemand > 0 ? 0.75 : 0.92);
    this.indPool = this.indPool * 0.85 + jobB * (this.indDemand > 0 ? 0.25 : 0.08);

    // pressure: unmet demand lets growth reach into lower-value land and denser forms
    const pR = clamp(this.resPool / (B * 4), 0, 1), pC = clamp(this.comPool / (jobB * 4 + 1), 0, 1);
    this.pressure = (pR + pC) / 2;
    const spawnR = TUNE.spawnLV - 0.14 * pR, spawnC = TUNE.spawnLV - 0.14 * pC;
    type Cand = { i: number; s: number; kind: number; to: number };
    const res: Cand[] = [], com: Cand[] = [], ind: Cand[] = [];
    for (let i = 0; i < N * N; i++) {
      if (g.water[i] || g.road[i] || this.constr[i] || (g.flags[i] & (Flag.Steep | Flag.Planned))) continue;
      const t = g.btype[i], l = g.level[i], v = this.lv[i];
      const jit = this.rng.next() * 0.12;
      if (t === BT.None) {
        if (this.roadDist[i] !== 1 || v < Math.min(spawnR, spawnC)) continue;
        if (g.flags[i] & Flag.Docks) continue;
        if (v >= spawnR) res.push({ i, s: v + jit, kind: BT.Res, to: 1 });
        if (v >= spawnC) com.push({ i, s: v * 0.8 + this.zoneSample(this.zCarAcc, i) * 0.5 + this.transitCell[i] * 0.9 + jit - 0.12, kind: BT.Com, to: 1 });
        ind.push({ i, s: 0.6 - v * 0.4 + (g.distWater[i] <= 3 ? 0.15 : 0) + this.zoneSample(this.zCarAcc, i) * 0.3 + jit, kind: BT.Ind, to: 1 });
      } else if (t === BT.Res && l < 3) {
        const cap = g.flags[i] & Flag.CarLocked ? 2 : 3;
        if (l + 1 > cap) continue;
        if (v > TUNE.upLV[l] - 0.1 * pR && this.age[i] >= (l === 1 ? 10 : 8)) res.push({ i, s: v + 0.05 + jit, kind: BT.Res, to: l + 1 });
      } else if (t === BT.Com && l < 3) {
        if (v > TUNE.comUpLV[l] - 0.1 * pC && this.age[i] >= (l === 1 ? 5 : 10)) com.push({ i, s: v + 0.1 + jit, kind: BT.Com, to: l + 1 });
      }
    }
    res.sort((a, b) => b.s - a.s || a.i - b.i);
    com.sort((a, b) => b.s - a.s || a.i - b.i);
    ind.sort((a, b) => b.s - a.s || a.i - b.i);
    const zoneOps = new Uint8Array(ZONES);
    const taken = new Uint8Array(N * N);
    const place = (list: Cand[], poolKey: 'resPool' | 'comPool' | 'indPool', per: number[], maxOps: number) => {
      let ops = 0;
      for (const c of list) {
        if (this[poolKey] <= 0 || ops >= maxOps) break;
        if (taken[c.i]) continue;
        const z = this.zoneOf(c.i);
        if (zoneOps[z] >= 6) continue;
        const cur = g.btype[c.i] === c.kind ? g.level[c.i] : 0;
        const add = per[c.to] - per[cur];
        if (add > this[poolKey] * 2.5 + 10) continue; // too big for current demand
        this[poolKey] -= add;
        taken[c.i] = 1; zoneOps[z]++; ops++;
        this.startBuild(c.i, c.kind, c.to);
      }
    };
    place(res, 'resPool', HOMES, 300);
    place(com, 'comPool', COM_JOBS, 120);
    place(ind, 'indPool', IND_JOBS, 30);

    // decline: buildings whose value falls empty out
    for (let i = 0; i < N * N; i++) {
      const t = g.btype[i];
      if (!t || t === BT.Park || this.constr[i]) continue;
      if (this.lv[i] < TUNE.downLV[g.level[i]]) this.low[i] = Math.min(255, this.low[i] + 1); else this.low[i] = 0;
      if (this.low[i] >= 6 && this.rng.next() < 0.25) {
        this.low[i] = 0;
        g.level[i]--;
        if (g.level[i] === 0) g.btype[i] = BT.None;
      }
    }
    // oversupply: if far more homes than jobs, a few of the worst homes empty out
    if (this.resDemand < -0.6) {
      for (let i = 0; i < N * N; i++)
        if (g.btype[i] === BT.Res && !this.constr[i] && this.lv[i] < 0.3 && this.rng.next() < 0.02) { g.btype[i] = BT.None; g.level[i] = 0; }
    }
    this.placeParks();
  }

  startBuild(i: number, type: number, level: number) {
    const g = this.g;
    if (g.btype[i] !== type) g.level[i] = 0;
    g.btype[i] = type;
    this.target[i] = level;
    this.constr[i] = BUILD_MONTHS[level];
    this.constrTotal[i] = BUILD_MONTHS[level];
  }

  private placeParks() {
    const g = this.g;
    for (let z = 0; z < ZONES; z++) {
      if (this.zHomes[z] < 900) continue;
      const zx = (z % NZ) * ZONE, zy = ((z / NZ) | 0) * ZONE;
      let has = false;
      const cands: number[] = [];
      for (let y = zy; y < zy + ZONE; y++)
        for (let x = zx; x < zx + ZONE; x++) {
          const i = idx(x, y);
          if (g.btype[i] === BT.Park) has = true;
          else if (!g.btype[i] && !g.road[i] && !g.water[i] && !(g.flags[i] & (Flag.Steep | Flag.Planned)) && this.roadDist[i] <= 2) cands.push(i);
        }
      if (!has && cands.length) {
        const i = cands[Math.floor(this.rng.next() * cands.length)];
        g.btype[i] = BT.Park; g.level[i] = 1;
      }
    }
  }

  // ---------------------------------------------------------------- roads
  private extendRoads() {
    const g = this.g;
    let frontier = 0;
    for (let i = 0; i < N * N; i++)
      if (!g.btype[i] && !g.road[i] && !g.water[i] && this.roadDist[i] === 1 && this.lv[i] > TUNE.spawnLV + 0.1 && !(g.flags[i] & (Flag.Steep | Flag.Docks))) frontier++;
    const want = 60 + Math.max(0, this.resPool) / 3 + this.homes / 150;
    const ops = frontier > want ? 1 : Math.min(8, 2 + Math.floor((want - frontier) / 20));
    const roadCells: number[] = [];
    for (let i = 0; i < N * N; i++) if (g.road[i]) roadCells.push(i);
    if (!roadCells.length) return;
    for (let op = 0; op < ops; op++) {
      // sample candidate start cells, prefer high value with empty land around
      let best = -1, bestS = -1e9;
      for (let k = 0; k < 160; k++) {
        const i = roadCells[Math.floor(this.rng.next() * roadCells.length)];
        const x = i % N, y = (i / N) | 0;
        let empty = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (!inb(x + dx, y + dy)) continue;
          const j = idx(x + dx, y + dy);
          if (!g.btype[j] && !g.road[j] && !g.water[j] && !(g.flags[j] & Flag.Steep)) empty++;
        }
        if (this.lv[i] < TUNE.spawnLV + 0.08 - 0.14 * this.pressure || !this.branchDirs(i).length) continue;
        const s = this.lv[i] * 1.5 + (empty / 49) * 0.35 + this.rng.next() * 0.2;
        if (s > bestS) { bestS = s; best = i; }
      }
      if (best >= 0) this.growRoadFrom(best);
    }
  }

  /** Directions a new street could branch from this road cell. */
  private branchDirs(start: number): number[] {
    const g = this.g;
    const sx = start % N, sy = (start / N) | 0;
    const out: number[] = [];
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIR4[d];
      const nx = sx + dx, ny = sy + dy;
      if (!inb(nx, ny)) continue;
      const n1 = idx(nx, ny);
      if (g.road[n1] || g.water[n1] || (g.flags[n1] & (Flag.Steep | Flag.Docks | Flag.Planned))) continue;
      // a branch may buy out a single small building at its mouth
      if (g.btype[n1] && (g.level[n1] > 1 || this.constr[n1] || g.btype[n1] === BT.Ind)) continue;
      // keep branches apart: no road directly sideways of the first cell
      let crowded = false;
      for (const sd of [-1, 1]) {
        const lx = nx + dy * sd, ly = ny + dx * sd;
        if (inb(lx, ly) && g.road[idx(lx, ly)]) crowded = true;
        const l2x = nx + dy * sd * 2, l2y = ny + dx * sd * 2;
        if (inb(l2x, l2y) && g.road[idx(l2x, l2y)] && !g.road[idx(sx + dy * sd * 2, sy + dx * sd * 2)]) crowded = true;
      }
      // need open land ahead
      const ax = sx + dx * 2, ay = sy + dy * 2;
      if (!inb(ax, ay) || g.water[idx(ax, ay)] || g.btype[idx(ax, ay)]) crowded = true;
      if (!crowded) out.push(d);
    }
    return out;
  }

  private growRoadFrom(start: number) {
    const g = this.g;
    const sx = start % N, sy = (start / N) | 0;
    let bestD = -1, bestS = -1e9;
    for (const d of this.branchDirs(start)) {
      const [dx, dy] = DIR4[d];
      const fx = sx + dx * 4, fy = sy + dy * 4;
      const ahead = inb(fx, fy) ? this.lv[idx(fx, fy)] : 0;
      const s = ahead + this.rng.next() * 0.25;
      if (s > bestS) { bestS = s; bestD = d; }
    }
    if (bestD < 0) return;
    const [dx, dy] = DIR4[bestD];
    const len = 3 + Math.floor(this.rng.next() * 7);
    let laid = 0;
    for (let k = 1; k <= len; k++) {
      const x = sx + dx * k, y = sy + dy * k;
      if (!inb(x, y)) break;
      const i = idx(x, y);
      if (g.water[i] || (g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Planned))) break;
      if (g.road[i]) break; // joined another road
      if (g.btype[i] && k > 1) break;
      if (g.btype[i]) { g.btype[i] = BT.None; g.level[i] = 0; }
      // stop if we'd run alongside an existing road
      const l1 = inb(x + dy, y + dx) && g.road[idx(x + dy, y + dx)];
      const l2 = inb(x - dy, y - dx) && g.road[idx(x - dy, y - dx)];
      if (k > 1 && (l1 || l2)) { g.road[i] = 1; laid++; break; }
      g.road[i] = 1;
      laid++;
    }
    void laid;
  }

  // ---------------------------------------------------------------- money
  protected finance() {
    this.income = 0;
    this.expenses = 0;
  }

  // ---------------------------------------------------------------- output
  initMsg(): InitMsg {
    return { type: 'init', seed: this.seed, height: this.g.height, water: this.g.water, villages: this.g.villages, bay: this.g.bay };
  }

  stats(): Stats {
    let b = 0;
    for (let i = 0; i < N * N; i++) if (this.g.btype[i] && this.g.btype[i] !== BT.Park) b++;
    return {
      month: this.month, population: Math.round(this.homes * PERSONS_PER_HOME), homes: this.homes, jobs: this.jobs,
      money: this.money, income: this.income, expenses: this.expenses, build: this.buildSpend,
      resDemand: this.resDemand, comDemand: this.comDemand, indDemand: this.indDemand,
      congestion: this.congestion, driveSpeed: this.driveSpeed, transitShare: 0, transitTrips: 0, rating: 0, buildings: b,
    };
  }

  snapshot(): StateMsg {
    const g = this.g;
    return {
      type: 'state', stats: this.stats(),
      road: g.road.slice(), btype: g.btype.slice(), level: g.level.slice(), target: this.target.slice(),
      constr: this.constr.slice(), constrTotal: this.constrTotal.slice(), lv: this.lv.slice(), flags: g.flags.slice(),
      planType: this.planType.slice(), planLevel: this.planLevel.slice(),
      stations: [], lines: [], event: null,
      docks: { state: 'none', deal: '', dealName: '', brief: '', deadline: 0, served: 0, planned: 0, carLocked: 0, built: 0, centre: { x: 0, y: 0 } },
      desire: [], log: this.log.slice(-8), speed: this.speed,
    };
  }
}

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
export { adjRoad };
