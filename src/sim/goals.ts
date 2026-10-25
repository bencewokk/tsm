/**
 * Goals: three tracks of objectives (network, ridership, city), one active goal per track, each with a reward (a cash grant, some with an
 * upgrade). Goals only read the simulation's own numbers, so they are deterministic: the same seed and the same actions complete the same
 * goals in the same months. The first goal names the old town and its nearest village ("connect A and B") and gives the UI a spot to mark.
 */
import { BT, N } from './constants';
import type { Sim } from './sim';

export type GoalTrack = 'network' | 'riders' | 'city';

export interface GoalInfo {
  id: string;
  track: GoalTrack;
  title: string;
  text: string;
  cur: number;
  target: number;
  /** how to show cur / target: 'n' plain, 'k' thousands, 'pct' percent */
  unit: 'n' | 'k' | 'pct' | 'mo';
  reward: string;
  /** the first goal points at a place (cell units) while it is open */
  x?: number; y?: number;
  /** a view that frames everything the goal is about (cell units; span = the longest distance in cells), for the plan camera */
  frame?: { x: number; y: number; span: number };
}

/** A newsworthy thing that happened (a line opened, a goal reached, cranes at a new station). The UI turns these into headlines, toasts and sounds. */
export interface Moment {
  seq: number;
  month: number;
  kind: 'open' | 'growth' | 'tower' | 'goal' | 'crowd' | 'riders' | 'milestone' | 'news';
  title: string;
  text: string;
  color: string;
  x: number; y: number;
  /** headline-sized (a newspaper card) rather than a toast */
  big: boolean;
  /** what it is about: goal id, station id or line id (as a string), for presenters that pin the beat to an object */
  ref: string;
}

interface GoalDef {
  id: string;
  track: GoalTrack;
  title: (s: Sim) => string;
  text: (s: Sim) => string;
  /** a number, or a function of the sim and the goal's baseline (its `cur` when it became the active goal of its track) */
  target: number | ((s: Sim, base: number) => number);
  unit: GoalInfo['unit'];
  cur: (s: Sim) => number;
  grant: number;           // $ million
  unlock?: 'signals' | 'atc';
  /** what the relative target is measured against when the goal opens (default: cur) */
  baseOf?: (s: Sim) => number;
  reward?: string;
  where?: (s: Sim) => { x: number; y: number } | null;
  frame?: (s: Sim) => { x: number; y: number; span: number } | null;
}

const fmt = (v: number, unit: GoalInfo['unit']) => unit === 'k' ? (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v))) : unit === 'pct' ? `${Math.round(v * 100)}%` : String(Math.round(v));

/** old town and the village nearest to it: the first goal's two ends */
function firstPair(s: Sim) {
  const vs = s.g.villages, o = vs[0];
  const near = vs.slice(1).sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0] ?? vs[0];
  return { a: o, b: near };
}
/** how many of the two ends have a station of a working line within `r` cells */
const REACH = 7;
function reached(s: Sim, v: { x: number; y: number }) {
  return s.metro.stations.some((st) => st.opened >= 0 && Math.hypot(st.x - v.x, st.y - v.y) <= REACH);
}
const stationsOpen = (s: Sim) => s.metro.stations.filter((st) => st.opened >= 0 && s.metro.onLine(st.id)).length;
const maxLinesAtStation = (s: Sim) => { let b = 0; for (const st of s.metro.stations) b = Math.max(b, s.metro.lines.filter((l) => l.stations.includes(st.id)).length); return b; };
const towersOnLine = (s: Sim) => {
  let n = 0;
  for (const l of s.lots.lots) if (l.alive && l.level > 0 && !l.constr && l.hgt >= 60 && (l.type === BT.Res || l.type === BT.Com) && s.walkToStation(l.cell) <= 8) n++;
  return n;
};
const share = (s: Sim) => s.motorShare();
/** households within 7 cells of a settlement centre */
function settlementHomes(s: Sim, v: { x: number; y: number }) {
  let h = 0;
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const x = Math.round(v.x) + dx, y = Math.round(v.y) + dy;
    if (x >= 0 && y >= 0 && x < N && y < N && dx * dx + dy * dy <= 49) h += s.cHomes[y * N + x];
  }
  return h;
}
/** the most populous settlement (old quarter or village) no open station reaches: the "serve a quarter" goal's place, picked when the goal opens */
function unserved(s: Sim) {
  const pick = s.goals.pick.serve_quarter;
  if (pick !== undefined) return s.g.villages[pick] ?? null;
  let best = -1, bh = 0;
  s.g.villages.forEach((v, k) => { if (reached(s, v)) return; const h = settlementHomes(s, v); if (h > bh) { bh = h; best = k; } });
  return best >= 0 ? s.g.villages[best] : null;
}
/** metro trips a day per resident */
const perRes = (s: Sim) => s.transitTrips / Math.max(1, s.stats().population);
/**
 * A relative ridership target: `mul` times the metro trips per resident when the goal opened (at least `add` more per resident), times
 * today's population. Riders per resident stay flat while the city grows round the same stations (0.09-0.17 on eight seeds from year 2 to 6
 * with the starter line), so only new stations and lines get there; the target in trips moves with the city.
 */
const grow = (mul: number, add: number) => (s: Sim, base: number) => Math.ceil(Math.max(base * mul, base + add) * s.stats().population / 100) * 100;

export const GOALS: GoalDef[] = [
  // ---- network
  {
    id: 'first_line', track: 'network', unit: 'n', grant: 20,
    title: (s) => { const p = firstPair(s); return `Connect ${p.a.name} and ${p.b.name}`; },
    text: (s) => { const p = firstPair(s); return `Open a line with a station at ${p.a.name} and another at ${p.b.name}. Press P, click the map to dig stations, click them in order, Enter to build.`; },
    target: 2,
    cur: (s) => { const p = firstPair(s); return (reached(s, p.a) ? 1 : 0) + (reached(s, p.b) ? 1 : 0); },
    where: (s) => { const p = firstPair(s); return !reached(s, p.a) ? p.a : !reached(s, p.b) ? p.b : null; },
    frame: (s) => { const p = firstPair(s); return { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2, span: Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) }; },
  },
  { id: 'stations_4', track: 'network', unit: 'n', grant: 10, title: () => 'Open 4 stations', text: () => 'More stops put more homes within a walk of the metro. Extend the line or dig a second one.', target: 4, cur: stationsOpen },
  { id: 'second_line', track: 'network', unit: 'n', grant: 20, title: () => 'Open a second line', text: () => 'A second line reaches new streets and gives riders somewhere to change.', target: 2, cur: (s) => s.metro.lines.length },
  {
    id: 'serve_quarter', track: 'network', unit: 'n', grant: 15,
    title: (s) => `Bring ${unserved(s)?.name ?? 'a new quarter'} onto the metro`,
    text: (s) => { const v = unserved(s); return v ? `${v.name} has ${Math.round(settlementHomes(s, v) * 2.3).toLocaleString('en-US')} residents and no station within reach. A station in its streets wins their trips from the car.` : 'Every quarter has a station.'; },
    target: 1, cur: (s) => { const v = unserved(s); return !v || reached(s, v) ? 1 : 0; },
    where: (s) => unserved(s),
  },
  { id: 'interchange', track: 'network', unit: 'n', grant: 25, unlock: 'signals', reward: '$25M and signalling: lines run 20% faster', title: () => 'Build an interchange', text: () => 'Make two lines share a station: riders can change there and every trip gets shorter.', target: 2, cur: maxLinesAtStation },
  { id: 'stations_12', track: 'network', unit: 'n', grant: 30, title: () => 'Open 12 stations', text: () => 'A network, not a line.', target: 12, cur: stationsOpen },
  { id: 'three_lines', track: 'network', unit: 'n', grant: 40, title: () => 'Run 3 lines', text: () => 'Three lines make a network people plan their day around.', target: 3, cur: (s) => s.metro.lines.length },
  { id: 'stations_25', track: 'network', unit: 'n', grant: 60, title: () => 'Open 25 stations', text: () => 'The metro reaches most of the city.', target: 25, cur: stationsOpen },
  // ---- ridership (trips a day)
  { id: 'riders_1500', track: 'riders', unit: 'k', grant: 8, title: () => 'Carry 1,500 trips a day', text: () => 'Stations in dense streets and places people want to go carry more. Desire lines (L) show where trips want to go.', target: 1500, cur: (s) => s.transitTrips },
  // the middle of the ladder is relative to the riders when the goal opens: a city growing round the same stations does not get there on its
  // own in a few years, new stations and lines do
  { id: 'riders_grow', track: 'riders', unit: 'k', grant: 12, title: () => 'Half as many riders again per resident', text: () => 'Riders per resident stay flat while the city grows round the same stations. New stations in busy streets and a second line raise them; the target grows with the city.', target: grow(1.5, 0.04), cur: (s) => s.transitTrips, baseOf: perRes },
  { id: 'riders_double', track: 'riders', unit: 'k', grant: 20, unlock: 'atc', reward: '$20M and automatic train control: trains hold 25% more', title: () => 'Twice the riders per resident', text: () => 'A network people plan their day around: watch the peak load on each line. The target grows with the city.', target: grow(2, 0.08), cur: (s) => s.transitTrips, baseOf: perRes },
  { id: 'riders_30k', track: 'riders', unit: 'k', grant: 35, title: () => 'Carry 30,000 trips a day', text: () => 'The metro is how the city moves.', target: 30000, cur: (s) => s.transitTrips },
  { id: 'riders_60k', track: 'riders', unit: 'k', grant: 60, title: () => 'Carry 60,000 trips a day', text: () => 'A world-class system.', target: 60000, cur: (s) => s.transitTrips },
  // ---- city (years 3-6: shares of motorised trips and a tower, which need new lines; plain population counts only early and late)
  { id: 'pop_12k', track: 'city', unit: 'k', grant: 5, title: () => 'Reach 12,000 residents', text: () => 'The city grows where land is valuable. Stations make land valuable.', target: 12000, cur: (s) => s.stats().population },
  { id: 'share_15', track: 'city', unit: 'pct', grant: 15, title: () => 'Win 15% of motorised trips from the car', text: () => 'The rival is the road: faster, more frequent, closer to where people live. One line is not enough.', target: 0.15, cur: share },
  { id: 'tower_60', track: 'city', unit: 'n', grant: 15, title: () => 'Raise a 60 m tower by a station', text: () => 'Towers rise only where jobs, centre and station access overlap: connect the busy centre.', target: 1, cur: towersOnLine },
  { id: 'share_30', track: 'city', unit: 'pct', grant: 25, title: () => 'Win 30% of motorised trips from the car', text: () => 'Most of the city can leave the car at home.', target: 0.30, cur: share },
  { id: 'rating_75', track: 'city', unit: 'mo', grant: 15, title: () => 'Keep service rating above 75 for 6 months', text: () => 'Crowded or infrequent trains drag the rating down: add trains or a parallel line.', target: 6, cur: (s) => s.goals.calm },
  { id: 'share_45', track: 'city', unit: 'pct', grant: 30, title: () => 'Win 45% of motorised trips from the car', text: () => 'The car is the minority choice.', target: 0.45, cur: share },
  { id: 'pop_80k', track: 'city', unit: 'k', grant: 30, title: () => 'Reach 80,000 residents', text: () => 'A metropolis.', target: 80000, cur: (s) => s.stats().population },
  { id: 'pop_120k', track: 'city', unit: 'k', grant: 50, title: () => 'Reach 120,000 residents', text: () => 'A capital.', target: 120000, cur: (s) => s.stats().population },
];

export class GoalSystem {
  done: Record<string, number> = {};
  /** consecutive months with rating >= 75 and at least 2,000 trips a day */
  calm = 0;
  /** each goal's `cur` when it became its track's active goal (relative targets) */
  base: Record<string, number> = {};
  /** a place picked when a goal opened (village index), so the goal does not wander */
  pick: Record<string, number> = {};
  constructor(private sim: Sim) {}

  private def(id: string) { return GOALS.find((g) => g.id === id)!; }
  private targetOf(g: GoalDef) { return typeof g.target === 'function' ? g.target(this.sim, this.base[g.id] ?? (g.baseOf ?? g.cur)(this.sim)) : g.target; }
  /** remember the baseline and place of goals that just became active */
  private open() {
    const s = this.sim;
    for (const g of this.active()) {
      if (this.base[g.id] !== undefined) continue;
      if (g.id === 'serve_quarter') { const v = unserved(s); if (v) this.pick[g.id] = s.g.villages.indexOf(v); }
      this.base[g.id] = (g.baseOf ?? g.cur)(s);
    }
  }
  rewardText(g: GoalDef) { return g.reward ?? `$${g.grant}M grant`; }

  /** the first unfinished goal of each track */
  active(): GoalDef[] {
    const out: GoalDef[] = [];
    for (const tr of ['network', 'riders', 'city'] as GoalTrack[]) {
      const g = GOALS.find((q) => q.track === tr && this.done[q.id] === undefined);
      if (g) out.push(g);
    }
    return out;
  }

  tick() {
    const s = this.sim;
    this.calm = s.rating >= 75 && s.transitTrips >= 2000 ? this.calm + 1 : 0;
    this.open();
    for (const g of this.active()) {
      const t = this.targetOf(g), c = g.cur(s);
      if (c + 1e-9 < t) continue;
      this.done[g.id] = s.month;
      s.money += g.grant * 1e6;
      if (g.unlock === 'signals') { s.metro.speedMul = 1.2; s.unlocks.push('signals'); s.refreshTransit(); }
      if (g.unlock === 'atc') { s.metro.capMul = 1.25; s.unlocks.push('atc'); s.refreshTransit(); }
      const w = g.where?.(s);
      s.moment('goal', `Goal reached: ${g.title(s)}`, `${this.rewardText(g)} paid into the city account.`, '#e0a526', w?.x ?? N / 2, w?.y ?? N / 2, true, g.id);
      s.say(`Goal reached: ${g.title(s)} (${this.rewardText(g)})`);
    }
    this.open();
  }

  infos(): GoalInfo[] {
    const s = this.sim;
    return this.active().map((g) => {
      const target = this.targetOf(g);
      const w = g.where?.(s);
      return { id: g.id, track: g.track, title: g.title(s), text: g.text(s), cur: Math.min(g.cur(s), target), target, unit: g.unit, reward: this.rewardText(g), x: w?.x, y: w?.y, frame: g.frame?.(s) ?? undefined };
    });
  }
  /** how many goals are done, for the HUD */
  count() { return Object.keys(this.done).length; }
  total() { return GOALS.length; }
}

export { fmt as fmtGoal };
