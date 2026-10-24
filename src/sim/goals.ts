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
}

interface GoalDef {
  id: string;
  track: GoalTrack;
  title: (s: Sim) => string;
  text: (s: Sim) => string;
  target: number | ((s: Sim) => number);
  unit: GoalInfo['unit'];
  cur: (s: Sim) => number;
  grant: number;           // $ million
  unlock?: 'signals' | 'atc';
  reward?: string;
  where?: (s: Sim) => { x: number; y: number } | null;
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
const share = (s: Sim) => (s.totalTrips > 0 ? s.transitTrips / s.totalTrips : 0);

export const GOALS: GoalDef[] = [
  // ---- network
  {
    id: 'first_line', track: 'network', unit: 'n', grant: 20,
    title: (s) => { const p = firstPair(s); return `Connect ${p.a.name} and ${p.b.name}`; },
    text: (s) => { const p = firstPair(s); return `Open a line with a station at ${p.a.name} and another at ${p.b.name}. Press P, click the map to dig stations, click them in order, Enter to build.`; },
    target: 2,
    cur: (s) => { const p = firstPair(s); return (reached(s, p.a) ? 1 : 0) + (reached(s, p.b) ? 1 : 0); },
    where: (s) => { const p = firstPair(s); return !reached(s, p.a) ? p.a : !reached(s, p.b) ? p.b : null; },
  },
  { id: 'stations_4', track: 'network', unit: 'n', grant: 10, title: () => 'Open 4 stations', text: () => 'More stops put more homes within a walk of the metro. Extend the line or dig a second one.', target: 4, cur: stationsOpen },
  { id: 'second_line', track: 'network', unit: 'n', grant: 20, title: () => 'Open a second line', text: () => 'A second line reaches new streets and gives riders somewhere to change.', target: 2, cur: (s) => s.metro.lines.length },
  { id: 'interchange', track: 'network', unit: 'n', grant: 25, unlock: 'signals', reward: '$25M and signalling: lines run 20% faster', title: () => 'Build an interchange', text: () => 'Make two lines share a station: riders can change there and every trip gets shorter.', target: 2, cur: maxLinesAtStation },
  { id: 'stations_12', track: 'network', unit: 'n', grant: 30, title: () => 'Open 12 stations', text: () => 'A network, not a line.', target: 12, cur: stationsOpen },
  { id: 'three_lines', track: 'network', unit: 'n', grant: 40, title: () => 'Run 3 lines', text: () => 'Three lines make a network people plan their day around.', target: 3, cur: (s) => s.metro.lines.length },
  { id: 'stations_25', track: 'network', unit: 'n', grant: 60, title: () => 'Open 25 stations', text: () => 'The metro reaches most of the city.', target: 25, cur: stationsOpen },
  // ---- ridership (trips a day)
  { id: 'riders_1500', track: 'riders', unit: 'k', grant: 8, title: () => 'Carry 1,500 trips a day', text: () => 'Stations in dense streets and places people want to go carry more. Desire lines (L) show where trips want to go.', target: 1500, cur: (s) => s.transitTrips },
  { id: 'riders_5k', track: 'riders', unit: 'k', grant: 12, title: () => 'Carry 5,000 trips a day', text: () => 'Fares pay the running costs and then some.', target: 5000, cur: (s) => s.transitTrips },
  { id: 'riders_12k', track: 'riders', unit: 'k', grant: 20, unlock: 'atc', reward: '$20M and automatic train control: trains hold 25% more', title: () => 'Carry 12,000 trips a day', text: () => 'A busy metro: watch the peak load on each line.', target: 12000, cur: (s) => s.transitTrips },
  { id: 'riders_30k', track: 'riders', unit: 'k', grant: 35, title: () => 'Carry 30,000 trips a day', text: () => 'The metro is how the city moves.', target: 30000, cur: (s) => s.transitTrips },
  { id: 'riders_60k', track: 'riders', unit: 'k', grant: 60, title: () => 'Carry 60,000 trips a day', text: () => 'A world-class system.', target: 60000, cur: (s) => s.transitTrips },
  // ---- city
  { id: 'pop_12k', track: 'city', unit: 'k', grant: 5, title: () => 'Reach 12,000 residents', text: () => 'The city grows where land is valuable. Stations make land valuable.', target: 12000, cur: (s) => s.stats().population },
  { id: 'tower_60', track: 'city', unit: 'n', grant: 15, title: () => 'Raise a 60 m tower by a station', text: () => 'Towers rise only where jobs, centre and station access overlap: connect the busy centre.', target: 1, cur: towersOnLine },
  { id: 'share_15', track: 'city', unit: 'pct', grant: 10, title: () => 'Win 15% of trips from the car', text: () => 'The rival is the road: faster, more frequent, closer to where people live.', target: 0.15, cur: share },
  { id: 'pop_25k', track: 'city', unit: 'k', grant: 10, title: () => 'Reach 25,000 residents', text: () => 'A real town.', target: 25000, cur: (s) => s.stats().population },
  { id: 'rating_75', track: 'city', unit: 'mo', grant: 15, title: () => 'Keep service rating above 75 for 6 months', text: () => 'Crowded or infrequent trains drag the rating down: add trains or a parallel line.', target: 6, cur: (s) => s.goals.calm },
  { id: 'share_30', track: 'city', unit: 'pct', grant: 20, title: () => 'Win 30% of trips from the car', text: () => 'Most of the city can leave the car at home.', target: 0.30, cur: share },
  { id: 'pop_50k', track: 'city', unit: 'k', grant: 20, title: () => 'Reach 50,000 residents', text: () => 'A city.', target: 50000, cur: (s) => s.stats().population },
  { id: 'share_45', track: 'city', unit: 'pct', grant: 30, title: () => 'Win 45% of trips from the car', text: () => 'The car is the minority choice.', target: 0.45, cur: share },
  { id: 'pop_80k', track: 'city', unit: 'k', grant: 30, title: () => 'Reach 80,000 residents', text: () => 'A metropolis.', target: 80000, cur: (s) => s.stats().population },
  { id: 'pop_120k', track: 'city', unit: 'k', grant: 50, title: () => 'Reach 120,000 residents', text: () => 'A capital.', target: 120000, cur: (s) => s.stats().population },
];

export class GoalSystem {
  done: Record<string, number> = {};
  /** consecutive months with rating >= 75 and at least 2,000 trips a day */
  calm = 0;
  constructor(private sim: Sim) {}

  private def(id: string) { return GOALS.find((g) => g.id === id)!; }
  private targetOf(g: GoalDef) { return typeof g.target === 'function' ? g.target(this.sim) : g.target; }
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
    for (const g of this.active()) {
      const t = this.targetOf(g), c = g.cur(s);
      if (c + 1e-9 < t) continue;
      this.done[g.id] = s.month;
      s.money += g.grant * 1e6;
      if (g.unlock === 'signals') { s.metro.speedMul = 1.2; s.unlocks.push('signals'); s.refreshTransit(); }
      if (g.unlock === 'atc') { s.metro.capMul = 1.25; s.unlocks.push('atc'); s.refreshTransit(); }
      const w = g.where?.(s);
      s.moment('goal', `Goal reached: ${g.title(s)}`, `${this.rewardText(g)} paid into the city account.`, '#e0a526', w?.x ?? N / 2, w?.y ?? N / 2, true);
      s.say(`Goal reached: ${g.title(s)} (${this.rewardText(g)})`);
    }
  }

  infos(): GoalInfo[] {
    const s = this.sim;
    return this.active().map((g) => {
      const target = this.targetOf(g);
      const w = g.where?.(s);
      return { id: g.id, track: g.track, title: g.title(s), text: g.text(s), cur: Math.min(g.cur(s), target), target, unit: g.unit, reward: this.rewardText(g), x: w?.x, y: w?.y };
    });
  }
  /** how many goals are done, for the HUD */
  count() { return Object.keys(this.done).length; }
  total() { return GOALS.length; }
}

export { fmt as fmtGoal };
