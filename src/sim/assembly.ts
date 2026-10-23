/**
 * Large plot assembly. Every large development (tall tower, stadium, arena, hospital, campus, the docks project ...)
 * consumes several existing plots; nothing large appears on a single original plot or on empty fabric.
 *
 * A development picks a contiguous set of plots (a row, optionally with the back rows behind it, or every plot a
 * rectangle overlaps for venues), scored on the cost of the current occupants. Plots are acquired over time, with
 * holdouts that delay or reshape the site. Then, visibly and in this order:
 *   0 assembling      plots acquired one by one (a hoarding goes up round each)
 *   1 hoardings up    the whole site is fenced
 *   2 demolition      building by building, rubble
 *   3 site cleared    cabins and laydown; local streets through the site are closed (and rerouted if that would cut the network)
 *   4 foundations
 *   5 structure       the merged plot's building rises under cranes (count scales with the site)
 *   6 facade          the last quarter of construction: the skin goes on
 * then it opens, the plaza plot becomes public space. Durations scale with size.
 */
import { BT, Flag, N, CELL } from './constants';
import { RC, ROAD_HALF } from './roads';
import { quadsOverlap, isConvex, polyArea } from './geom';
import { hash01 } from './profiles';
import { LANDMARKS, LANDMARK_INDEX, type LandmarkDef } from './landmarks';
import type { Sim } from './sim';
import type { Lot } from './lots';

export type AsmKind = 'tower' | 'landmark' | 'docks';
export const ASM_PHASES = ['assembling', 'hoardings up', 'demolition', 'site cleared', 'foundations', 'structure', 'facade'] as const;

export interface AsmPlan {
  kind: AsmKind;
  members: Lot[];
  plaza: Lot[];
  quad: number[];
  closed: number[];          // road edges that run through the site
  rect: boolean;
  /** summary for previews */
  homes: number; jobs: number; buildings: number; cost: number;
}

export interface Assembly {
  id: number; kind: AsmKind; label: string; form: string;
  lots: number[]; plaza: number[]; quad: number[]; closed: number[];
  closedXY: number[][];      // [ax, ay, bx, by] of the closed streets (for the renderer)
  loop: boolean;             // venue: drop-off loop in front of the site
  phase: number; t: number; len: number; started: number;
  type: number; level: number; hgt: number; months: number;
  landmark: string; pay: 'city' | 'dev';
  merged: number;            // lot id of the merged plot once the site is cleared, else -1
  cranes: number;
  fails: Record<number, number>; hold: Record<number, number>;
  demoOrder: number[]; demoNext: number;
  /** plan fields kept for reshaping */
  rowCount: number;
}

export interface AssemblyInfo {
  id: number; kind: AsmKind; label: string; form: string; phase: number; pct: number;
  quad: number[]; lots: number[]; plaza: number[]; merged: number; cranes: number; hgt: number; loop: boolean;
  closed: number[][]; total: number; acquired: number; x: number; y: number; level: number; type: number;
}

const close = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x1 - x2, y1 - y2) < 0.06;

export class AssemblySystem {
  list: Assembly[] = [];
  private nextId = 1;
  docksPending = false;
  stats = { planTry: 0, planSeedBad: 0, planNoWindow: 0, planNoConvex: 0, started: 0, finished: 0, aborted: 0, closedStreets: 0, rerouted: 0, holdouts: 0, reshaped: 0 };

  constructor(private sim: Sim) {}

  /** how many developments may be in assembly at once, and one new tower site per month */
  canStart(pop: number): boolean {
    const towers = this.list.filter((a) => a.kind === 'tower');
    return towers.length < 3 + Math.floor(pop / 8000) && towers.filter((a) => a.started === this.sim.month).length < 2;
  }

  get active() { return this.list.filter((a) => a.phase >= 0); }
  byId(id: number) { return this.list.find((a) => a.id === id); }

  // ---------------------------------------------------------------- plot neighbours (shared sides)
  private right(a: Lot): Lot | null {
    for (const o of this.sim.lots.near(a.x, a.y, 1.4)) if (o !== a && close(a.poly[2], a.poly[3], o.poly[0], o.poly[1]) && close(a.poly[4], a.poly[5], o.poly[6], o.poly[7])) return o;
    return null;
  }
  private left(a: Lot): Lot | null {
    for (const o of this.sim.lots.near(a.x, a.y, 1.4)) if (o !== a && close(o.poly[2], o.poly[3], a.poly[0], a.poly[1]) && close(o.poly[4], o.poly[5], a.poly[6], a.poly[7])) return o;
    return null;
  }
  private behind(a: Lot): Lot | null {
    for (const o of this.sim.lots.near(a.x, a.y, 1.4)) if (o !== a && close(o.poly[0], o.poly[1], a.poly[6], a.poly[7]) && close(o.poly[2], o.poly[3], a.poly[4], a.poly[5])) return o;
    return null;
  }

  /** May this plot be bought up for a development? */
  ok(l: Lot, allowCore = false): boolean {
    if (!l.alive || l.asm || l.constr || l.demo || l.lm) return false;
    if (l.flags & (Flag.Docks | Flag.Planned)) return false;
    if (!allowCore && (l.flags & Flag.Core)) return false;
    if (l.type === BT.Landmark || l.type === BT.Square || l.type === BT.Park) return false;
    return true;
  }

  /** What the current occupants cost to buy out (relative units). */
  cost(l: Lot): number {
    if (!l.type || l.level <= 0) return 0;
    if (l.type === BT.Res || l.type === BT.Com) return [0, 1, 3, 8][l.level];
    if (l.type === BT.Ind) return 2 * l.level;
    return 2;
  }

  private tally(plan: Pick<AsmPlan, 'members' | 'plaza' | 'homes' | 'jobs' | 'buildings' | 'cost'>) {
    plan.homes = 0; plan.jobs = 0; plan.buildings = 0; plan.cost = 0;
    for (const l of [...plan.members, ...plan.plaza]) {
      plan.cost += this.cost(l);
      if (l.level > 0 && l.type) { plan.buildings++; plan.homes += this.sim.lotHomes(l); plan.jobs += this.sim.lotJobs(l); }
    }
  }

  // ---------------------------------------------------------------- planning: a row (+ back rows) of plots for a tall building
  /** Plots needed for a building of this height: width in cells and how many rows deep. */
  static need(h: number): { w: number; rows: number } {
    return { w: 0.72 + Math.max(0, h - 30) / 70, rows: h >= 70 ? 2 : 1 };
  }

  planRow(seed: Lot, h: number, kind: AsmKind = 'tower'): AsmPlan | null {
    const need = AssemblySystem.need(h);
    this.stats.planTry++;
    if (!this.ok(seed)) { this.stats.planSeedBad++; return null; }
    // the run of plots in the seed's row
    const run: Lot[] = [seed];
    for (let k = 0; k < 7; k++) { const o = this.left(run[0]); if (!o || !this.ok(o) || o.cls !== seed.cls || o.back !== seed.back) break; run.unshift(o); }
    for (let k = 0; k < 7; k++) { const o = this.right(run[run.length - 1]); if (!o || !this.ok(o) || o.cls !== seed.cls || o.back !== seed.back) break; run.push(o); }
    const si = run.indexOf(seed);
    let best: { i: number; j: number; score: number } | null = null;
    for (let i = 0; i <= si; i++) {
      let w = 0, c = 0;
      for (let j = i; j < run.length; j++) {
        w += run[j].w; c += this.cost(run[j]);
        if (j < si) continue;
        if (w >= need.w * 0.92) {
          const score = c + 0.4 * (j - i) + 0.2 * Math.abs(w - need.w) * 10;
          if (!best || score < best.score) best = { i, j, score };
          break;
        }
      }
    }
    if (!best) { this.stats.planNoWindow++; return null; }
    const win = run.slice(best.i, best.j + 1);
    // back rows behind the window, if every plot of the window has one
    const rows: Lot[][] = [win];
    for (let r = 1; r < need.rows; r++) {
      const next = rows[r - 1].map((l) => this.behind(l));
      if (next.some((o) => !o || !this.ok(o))) break;
      rows.push(next as Lot[]);
    }
    const last = rows[rows.length - 1];
    const quad = [win[0].poly[0], win[0].poly[1], win[win.length - 1].poly[2], win[win.length - 1].poly[3], last[last.length - 1].poly[4], last[last.length - 1].poly[5], last[0].poly[6], last[0].poly[7]];
    if (!isConvex(quad)) { this.stats.planNoConvex++; return null; }
    const members = rows.flat();
    // a public plaza: the cheaper neighbour of the window, for sites wide enough to want one
    const plaza: Lot[] = [];
    if (need.w >= 1.15) {
      const cands = [this.left(win[0]), this.right(win[win.length - 1])].filter((o): o is Lot => !!o && this.ok(o) && o.back === seed.back && !members.includes(o));
      cands.sort((a, b) => this.cost(a) - this.cost(b) || a.id - b.id);
      if (cands[0] && this.cost(cands[0]) <= 3) plaza.push(cands[0]);
    }
    const plan: AsmPlan = { kind, members, plaza, quad, closed: [], rect: false, homes: 0, jobs: 0, buildings: 0, cost: 0 };
    this.tally(plan);
    return plan;
  }

  // ---------------------------------------------------------------- planning: a rectangle (venues, landmarks)
  private inQuad(q: number[], x: number, y: number, m: number, sgn: number): boolean {
    for (let k = 0; k < 4; k++) {
      const x1 = q[k * 2], y1 = q[k * 2 + 1], x2 = q[((k + 1) % 4) * 2], y2 = q[((k + 1) % 4) * 2 + 1];
      const L = Math.hypot(x2 - x1, y2 - y1) || 1;
      if (((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) * sgn / L < -m) return false;
    }
    return true;
  }

  /** Every plot the rectangle overlaps plus the local streets that run through it. null if it cannot be built there. */
  planRect(cx: number, cy: number, ang: number, w: number, d: number, allowCore = true, kind: AsmKind = 'landmark'): AsmPlan | null {
    const c = Math.cos(ang), s = Math.sin(ang);
    const P = (u: number, v: number): [number, number] => [cx + u * c - v * s, cy + u * s + v * c];
    const [f0x, f0y] = P(-w / 2, -d / 2), [f1x, f1y] = P(w / 2, -d / 2), [b1x, b1y] = P(w / 2, d / 2), [b0x, b0y] = P(-w / 2, d / 2);
    const quad = [f0x, f0y, f1x, f1y, b1x, b1y, b0x, b0y];
    const lots = this.sim.lots, R = this.sim.roads, sg = polyArea(quad) >= 0 ? 1 : -1;
    // water / steep / rail on the site itself
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
      const u = (a / 4 - 0.5) * w, v = (b / 4 - 0.5) * d;
      const [px, py] = P(u, v), gx = Math.floor(px), gy = Math.floor(py);
      if (gx < 1 || gy < 1 || gx >= N - 1 || gy >= N - 1) return null;
      const i = gy * N + gx;
      if (this.sim.g.water[i] || (this.sim.g.flags[i] & (Flag.Steep | Flag.Rail | Flag.Flood))) return null;
    }
    const members: Lot[] = [];
    for (const o of lots.near(cx, cy, Math.max(w, d) + 0.8)) {
      if (!quadsOverlap(quad, o.poly)) continue;
      if (!this.ok(o, allowCore)) return null;
      members.push(o);
    }
    // streets through (or hugging) the site: local ones close, an arterial makes the site impossible
    const closed: number[] = [];
    for (const e of R.edgesNear(cx, cy, Math.max(w, d) + 1.5)) {
      const ax = R.nx[R.ea[e]], ay = R.ny[R.ea[e]], bx = R.nx[R.eb[e]], by = R.ny[R.eb[e]];
      const m = ROAD_HALF[R.ecls[e]] + 0.03;
      let hit = false;
      const L = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.ceil(L / 0.15));
      for (let k = 0; k <= n && !hit; k++) hit = this.inQuad(quad, ax + (bx - ax) * k / n, ay + (by - ay) * k / n, m, sg);
      if (!hit) continue;
      if (R.ecls[e] === RC.Arterial) return null;
      closed.push(e);
    }
    if (closed.length > 4) return null;
    const plan: AsmPlan = { kind, members, plaza: [], quad, closed, rect: true, homes: 0, jobs: 0, buildings: 0, cost: 0 };
    this.tally(plan);
    return plan;
  }

  // ---------------------------------------------------------------- start
  start(plan: AsmPlan, o: { type: number; level: number; hgt: number; months: number; label: string; form?: string; landmark?: string; pay?: 'city' | 'dev'; loop?: boolean }): Assembly {
    const area = Math.abs(polyArea(plan.quad));
    const a: Assembly = {
      id: this.nextId++, kind: plan.kind, label: o.label, form: o.form ?? '', lots: plan.members.map((l) => l.id), plaza: plan.plaza.map((l) => l.id), quad: plan.quad, closed: plan.closed, closedXY: [],
      loop: o.loop ?? false, phase: 0, t: 0, len: 0, started: this.sim.month, type: o.type, level: o.level, hgt: o.hgt, months: o.months, landmark: o.landmark ?? '', pay: o.pay ?? 'city',
      merged: -1, cranes: Math.max(1, Math.min(5, Math.round(area / 1.1))), fails: {}, hold: {}, demoOrder: [], demoNext: 0, rowCount: 0,
    };
    for (const l of [...plan.members, ...plan.plaza]) { l.asm = a.id; l.astate = 0; }
    this.list.push(a);
    this.stats.started++;
    return a;
  }

  /** The docks project: the whole old port is one assembly (land already owned: straight to hoardings, then demolition in waves). */
  startDocks(lots: Lot[], label: string): Assembly {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const l of lots) for (let k = 0; k < 4; k++) { x0 = Math.min(x0, l.poly[k * 2]); x1 = Math.max(x1, l.poly[k * 2]); y0 = Math.min(y0, l.poly[k * 2 + 1]); y1 = Math.max(y1, l.poly[k * 2 + 1]); }
    const plan: AsmPlan = { kind: 'docks', members: lots, plaza: [], quad: [x0, y0, x1, y0, x1, y1, x0, y1], closed: [], rect: true, homes: 0, jobs: 0, buildings: 0, cost: 0 };
    const a = this.start(plan, { type: BT.None, level: 0, hgt: 0, months: 0, label, form: 'docks' });
    for (const l of lots) l.astate = 1;
    a.phase = 1; a.t = 0; a.len = 1;
    this.docksPending = true;
    return a;
  }

  private allLots(a: Assembly): Lot[] { return [...a.lots, ...a.plaza].map((id) => this.sim.lots.lots[id]).filter((l) => l && l.alive); }

  // ---------------------------------------------------------------- monthly
  tick() {
    for (const a of this.list.slice()) this.step(a);
    this.list = this.list.filter((a) => a.phase >= 0);
  }

  private abort(a: Assembly, why: string) {
    for (const l of this.allLots(a)) { l.asm = 0; l.astate = 0; }
    const m = a.merged >= 0 ? this.sim.lots.lots[a.merged] : null;
    if (m && m.alive) { m.asm = 0; m.astate = 0; }
    a.phase = -1;
    this.stats.aborted++;
    this.sim.say(`${a.label}: ${why}`);
  }

  private step(a: Assembly) {
    const sim = this.sim, lots = sim.lots;
    const mem = this.allLots(a);
    if (a.merged < 0 && mem.length < a.lots.length + a.plaza.length) { this.abort(a, 'site no longer available, plans dropped'); return; }
    a.t++;
    switch (a.phase) {
      case 0: {
        // acquire plots; holdouts resist
        let pending = 0;
        for (const l of mem) {
          if (l.astate === 1) continue;
          const c = this.cost(l);
          if (l.astate === 2) {
            a.hold[l.id] = (a.hold[l.id] ?? 0) + 1;
            const hm = a.hold[l.id];
            if (hash01(l.id + a.id * 977, sim.month) < 0.14 || hm >= 8) {
              // the holdout either sells or the site is reshaped around it (only an end plot of the run can be dropped)
              if (hm >= 8 && this.dropEnd(a, l)) { this.stats.reshaped++; continue; }
              l.astate = 1;
            } else pending++;
            continue;
          }
          const p = c === 0 ? 0.95 : c <= 1 ? 0.8 : c <= 3 ? 0.6 : 0.45;
          if (hash01(l.id * 31 + a.id * 977, sim.month) < p) l.astate = 1;
          else {
            a.fails[l.id] = (a.fails[l.id] ?? 0) + 1;
            if (a.fails[l.id] >= 3 && c >= 3) { l.astate = 2; this.stats.holdouts++; }
            pending++;
          }
        }
        if (pending === 0 && this.allLots(a).every((l) => l.astate === 1)) { a.phase = 1; a.t = 0; a.len = 1; }
        break;
      }
      case 1:
        if (a.t >= a.len) {
          a.phase = 2; a.t = 0;
          a.demoOrder = mem.slice().sort((p, q) => this.cost(q) - this.cost(p) || p.id - q.id).map((l) => l.id);
          a.demoNext = 0;
        }
        break;
      case 2: {
        // building by building: a few plots per month, each shows rubble for two months
        const n = a.demoOrder.length;
        const per = a.kind === 'docks' ? Math.max(1, Math.ceil(n / 3)) : a.kind === 'tower' ? Math.max(1, Math.ceil(n / 2)) : Math.max(1, Math.ceil(n / 4));
        for (let k = 0; k < per && a.demoNext < n; k++) {
          const l = lots.lots[a.demoOrder[a.demoNext++]];
          if (!l || !l.alive) continue;
          if (l.type && l.level > 0 && !(l.flags & Flag.Planned)) { l.demo = a.kind === 'tower' ? 1 : 2; l.ntype = 0; l.target = 0; l.constr = 0; }
          else { l.type = BT.None; l.level = 0; }
          l.astate = 3;
        }
        if (a.demoNext >= n && mem.every((l) => l.demo === 0)) {
          for (const l of mem) { if (l.type && l.level === 0) l.type = BT.None; l.astate = 3; }
          a.phase = 3; a.t = 0; a.len = a.kind === 'tower' ? 1 : 1 + (n > 8 ? 1 : 0);
          this.closeStreets(a);
        }
        break;
      }
      case 3:
        if (a.t >= a.len) {
          if (a.kind === 'docks') { this.finishDocks(a); a.phase = -1; this.stats.finished++; break; }
          if (!this.merge(a)) { this.abort(a, 'the site could not be assembled, left vacant'); break; }
          a.phase = 4; a.t = 0; a.len = a.kind === 'tower' ? 1 : Math.max(1, Math.min(4, Math.round(1 + Math.abs(polyArea(a.quad)) / 1.6)));
        }
        break;
      case 4:
        if (a.t >= a.len) this.beginStructure(a);
        break;
      default: {
        const L = lots.lots[a.merged];
        if (!L || !L.alive) { a.phase = -1; break; }
        const pct = L.constrTotal ? 1 - L.constr / L.constrTotal : 1;
        a.phase = pct < 0.72 ? 5 : 6;
        if (L.constr === 0 && L.level > 0) this.finish(a, L);
      }
    }
  }

  /** Drop a holdout plot if it is an end plot of its row / the last row (the site shrinks), keeping the quad convex. */
  private dropEnd(a: Assembly, l: Lot): boolean {
    if (a.plaza.includes(l.id)) { a.plaza = a.plaza.filter((id) => id !== l.id); l.asm = 0; l.astate = 0; return true; }
    if (a.kind !== 'tower') return false;
    const left = this.left(l), right = this.right(l);
    const inA = (o: Lot | null) => !!o && a.lots.includes(o.id);
    if (inA(left) && inA(right)) return false; // in the middle: cannot be dropped
    if (a.lots.length <= 2) return false;
    // drop the whole column (this plot and the plots behind it)
    const column: Lot[] = [l];
    for (let o = this.behind(l); o && a.lots.includes(o.id); o = this.behind(o)) column.push(o);
    const keep = a.lots.filter((id) => !column.some((c) => c.id === id));
    const ls = keep.map((id) => this.sim.lots.lots[id]);
    // recompute the union quad of what remains: front row spans, last row corners
    // recompute the union: the front row is the plots with no member in front of them, ordered along the street
    const row0 = ls.filter((o) => !ls.some((p) => p !== o && close(p.poly[6], p.poly[7], o.poly[0], o.poly[1]) && close(p.poly[4], p.poly[5], o.poly[2], o.poly[3])));
    if (!row0.length) return false;
    const ux = row0[0].poly[2] - row0[0].poly[0], uy = row0[0].poly[3] - row0[0].poly[1];
    row0.sort((p, q) => (p.x - q.x) * ux + (p.y - q.y) * uy);
    let tail0 = row0[0], tailN = row0[row0.length - 1];
    for (let o: Lot | null = this.behind(tail0); o && ls.includes(o); o = this.behind(o)) tail0 = o;
    for (let o: Lot | null = this.behind(tailN); o && ls.includes(o); o = this.behind(o)) tailN = o;
    const q = [row0[0].poly[0], row0[0].poly[1], row0[row0.length - 1].poly[2], row0[row0.length - 1].poly[3], tailN.poly[4], tailN.poly[5], tail0.poly[6], tail0.poly[7]];
    if (!isConvex(q)) return false;
    a.quad = q;
    for (const c of column) { c.asm = 0; c.astate = 0; }
    a.lots = keep;
    return true;
  }

  // ---------------------------------------------------------------- streets through the site
  private closeStreets(a: Assembly) {
    const R = this.sim.roads;
    const cx = (a.quad[0] + a.quad[4]) / 2, cy = (a.quad[1] + a.quad[5]) / 2;
    for (const e of a.closed) {
      if (!R.alive[e]) continue;
      const ax = R.nx[R.ea[e]], ay = R.ny[R.ea[e]], bx = R.nx[R.eb[e]], by = R.ny[R.eb[e]];
      a.closedXY.push([ax, ay, bx, by]);
      const na = R.ea[e], nb = R.eb[e];
      R.closeEdge(e);
      this.stats.closedStreets++;
      // would that cut the network? then a detour round the site keeps the two ends joined
      if (!R.connected(na, nb, 90) && R.adj[na].length && R.adj[nb].length) {
        const near = (px: number, py: number) => { let bi = 0, bd = Infinity; for (let k = 0; k < 4; k++) { const d = Math.hypot(a.quad[k * 2] - px, a.quad[k * 2 + 1] - py); if (d < bd) { bd = d; bi = k; } } return bi; };
        const out = (k: number): [number, number] => {
          const qx = a.quad[k * 2], qy = a.quad[k * 2 + 1], dx = qx - cx, dy = qy - cy, L = Math.hypot(dx, dy) || 1;
          return [qx + (dx / L) * 0.45, qy + (dy / L) * 0.45];
        };
        const ka = near(ax, ay), kb = near(bx, by);
        const pts: [number, number][] = [[ax, ay], out(ka)];
        if (kb !== ka) {
          // go round via the corner(s) between the two
          const mid = (ka + 1) % 4 === kb || (kb + 1) % 4 === ka ? [] : [out((ka + 1) % 4)];
          for (const m of mid) pts.push(m);
          pts.push(out(kb));
        }
        pts.push([bx, by]);
        for (let k = 0; k + 1 < pts.length; k++) R.corridor?.clear(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
        R.polyline(pts, RC.Local, 2030 + Math.floor(this.sim.month / 12), 0.9);
        this.stats.rerouted++;
        this.sim.say(`${a.label}: a street through the site is closed and rerouted round it`);
      } else this.sim.say(`${a.label}: a street through the site is closed`);
    }
  }

  // ---------------------------------------------------------------- merge the cleared plots into the site plot
  private merge(a: Assembly): boolean {
    const lots = this.sim.lots;
    const mem = this.allLots(a);
    const keep = mem.filter((l) => a.lots.includes(l.id));
    const first = keep[0];
    if (!first) return false;
    const plazaLots = mem.filter((l) => a.plaza.includes(l.id));
    const saved = keep.map((l) => ({ l, was: l.alive }));
    void saved;
    for (const l of keep) lots.remove(l);
    const L = lots.tryAddQuad(a.quad, first.cls, first.prof, 0, 0);
    if (!L) {
      // restore the members as vacant plots rather than lose the land
      for (const l of keep) { l.alive = true; lots.restore(l); l.asm = 0; l.astate = 0; }
      for (const l of plazaLots) { l.asm = 0; l.astate = 0; }
      return false;
    }
    L.flags = first.flags & Flag.Docks;
    L.asm = a.id; L.astate = 3;
    L.sides = (first.sides & 1) | (keep[keep.length - 1].sides & 2);
    a.merged = L.id;
    for (const l of plazaLots) l.astate = 3;
    return true;
  }

  private beginStructure(a: Assembly) {
    const sim = this.sim, L = sim.lots.lots[a.merged];
    if (!L || !L.alive) { a.phase = -1; return; }
    L.type = a.type; L.level = 0; L.target = a.level; L.nhgt = a.hgt; L.demo = 0; L.ntype = 0; L.age = 0;
    L.constr = a.months; L.constrTotal = a.months;
    if (a.landmark) {
      const def = LANDMARKS.find((d) => d.id === a.landmark)!;
      L.type = BT.Landmark; L.lm = LANDMARK_INDEX[a.landmark]; L.target = 1; L.nhgt = 0;
      sim.lm.states.set(L.id, { lot: L.id, def: L.lm - 1, state: 'building', pay: a.pay, opened: -1, served: false, carPark: false, eventDay: false, events: 0, penalty: false });
      sim.say(`${def.name}: the site is cleared, ${a.months} months of construction begin`);
    }
    a.phase = 5; a.t = 0;
  }

  private finish(a: Assembly, L: Lot) {
    L.asm = 0; L.astate = 0;
    for (const id of a.plaza) {
      const p = this.sim.lots.lots[id];
      if (p && p.alive) { p.asm = 0; p.astate = 0; p.type = BT.Square; p.level = 1; p.demo = 0; }
    }
    a.phase = -1;
    this.stats.finished++;
    this.sim.say(`${a.label} opens`);
  }

  /** The docks project: the cleared old port plots become the planned blocks, ghosts appear. */
  private finishDocks(a: Assembly) {
    for (const l of this.allLots(a)) { l.asm = 0; l.astate = 0; l.flags |= Flag.Planned; l.type = BT.None; l.level = 0; }
    this.docksPending = false;
    this.sim.say('Old port buildings are cleared: the redevelopment blocks are staked out');
  }

  // ---------------------------------------------------------------- info for the renderer / HUD
  infos(): AssemblyInfo[] {
    return this.list.filter((a) => a.phase >= 0).map((a) => {
      const L = a.merged >= 0 ? this.sim.lots.lots[a.merged] : null;
      let pct = 0;
      if (a.phase === 0) { const m = this.allLots(a); pct = m.length ? m.filter((l) => l.astate >= 1).length / m.length : 0; }
      else if (a.phase === 1 || a.phase === 3 || a.phase === 4) pct = a.len ? Math.min(1, a.t / a.len) : 1;
      else if (a.phase === 2) pct = a.demoOrder.length ? a.demoNext / a.demoOrder.length : 1;
      else if (L && L.constrTotal) { const f = 1 - L.constr / L.constrTotal; pct = a.phase === 5 ? Math.min(1, f / 0.72) : Math.min(1, (f - 0.72) / 0.28); }
      const cx = (a.quad[0] + a.quad[2] + a.quad[4] + a.quad[6]) / 4, cy = (a.quad[1] + a.quad[3] + a.quad[5] + a.quad[7]) / 4;
      return { id: a.id, kind: a.kind, label: a.label, form: a.form, phase: a.phase, pct, quad: a.quad, lots: a.lots, plaza: a.plaza, merged: a.merged, cranes: a.cranes, hgt: a.hgt, loop: a.loop,
        closed: a.closedXY, total: a.lots.length + a.plaza.length, acquired: this.allLots(a).filter((l) => l.astate >= 1).length, x: cx, y: cy, level: a.level, type: a.type };
    });
  }

  /** Text for the proposal dialog: what a site would clear. */
  describe(plan: AsmPlan, def: LandmarkDef): string {
    const n = plan.members.length;
    const parts: string[] = [];
    if (plan.buildings) parts.push(`${plan.buildings} building${plan.buildings > 1 ? 's' : ''} demolished${plan.homes ? `, about ${Math.round(plan.homes / 10) * 10} homes lost` : ''}${plan.jobs ? `, ${Math.round(plan.jobs / 10) * 10} jobs` : ''}`);
    else parts.push('open plots only');
    if (plan.closed.length) parts.push(`${plan.closed.length} street${plan.closed.length > 1 ? 's' : ''} closed`);
    const months = 2 + 1 + Math.ceil(n / 4) + 1 + 2 + def.buildMonths;
    return `${n} plots bought up (${parts.join('; ')}). About ${months} months from first hoarding to opening.`;
  }
}

void CELL;
