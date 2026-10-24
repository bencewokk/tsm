// Fun diagnosis: `npm run fun -- [seeds...] [--open=3] [--months=60] [--events]`
// For each seed: what a sensible first line costs against the money in hand, the money curve of a player who builds it at month `open`,
// when the first growth shows up round its stations compared with the same city without the line (determinism makes the control exact),
// and how often the player has a decision to make.
import { Sim, BOOM } from '../src/sim/sim';
import { N, STATION_COST, TRAIN_COST, METRO_SPEED, START_MONEY } from '../src/sim/constants';
import { quoteLine } from '../src/sim/relief';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const open = opt('open', 3), months = opt('months', 60);
const showEvents = args.includes('--events');
if (args.includes('--noboom')) BOOM.on = false;
{ const x = opt('boomx', 1); BOOM.res *= x; BOOM.com *= x; }
let seeds = args.filter((a) => !a.startsWith('--')).map(Number).filter((n) => n > 0);
if (!seeds.length) seeds = [4821, 187, 304, 57, 83, 421, 369, 252];

type Pt = [number, number];
function land(sim: Sim, x: number, y: number): Pt {
  for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const cx = Math.round(x) + dx, cy = Math.round(y) + dy;
    if (cx >= 0 && cy >= 0 && cx < N && cy < N && !sim.g.water[cy * N + cx]) return [cx, cy];
  }
  return [Math.round(x), Math.round(y)];
}
function costOf(sim: Sim, pts: Pt[]) {
  const q = quoteLine(pts.map(([x, y]) => ({ x, y })), sim.metro.terr);
  const trains = Math.max(2, Math.round(((q.km / METRO_SPEED) * 60 * 2 + pts.length + 4) / 5));
  return { ok: q.ok, km: q.km, total: q.cost + trains * TRAIN_COST + pts.length * STATION_COST, trains };
}
/** the obvious first line: the old town to its nearest village, a station at each end plus one per ~14 cells between */
function starter(sim: Sim): Pt[] {
  const vs = sim.g.villages, o = vs[0];
  const near = vs.slice(1).sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0];
  if (!near) return [];
  const n = Math.max(1, Math.round(Math.hypot(near.x - o.x, near.y - o.y) / 14));
  const pts: Pt[] = [land(sim, o.x, o.y)];
  for (let j = 1; j < n; j++) pts.push(land(sim, o.x + (near.x - o.x) * j / n, o.y + (near.y - o.y) * j / n));
  pts.push(land(sim, near.x, near.y));
  return pts;
}
function build(sim: Sim, pts: Pt[]) {
  const ids: number[] = [];
  for (const [x, y] of pts) {
    const before = sim.metro.stations.length;
    sim.apply({ type: 'placeStation', x, y });
    if (sim.metro.stations.length > before) ids.push(sim.metro.stations[before].id);
  }
  const n = sim.metro.lines.length;
  sim.apply({ type: 'buildLine', stations: ids });
  return sim.metro.lines.length > n;
}
/** cells within an 8-minute walk of the line's stations (recorded when the line opens) so the control city is measured on the same ground */
let zone: Set<number> | null = null;
function markZone(sim: Sim) { zone = new Set(); for (let i = 0; i < N * N; i++) if (sim.walkToStation(i) <= 8) zone.add(i); }
function catchStats(sim: Sim) {
  let homes = 0, jobs = 0, rising = 0, blds = 0, tall = 0, vacant = 0, lots = 0;
  for (const l of sim.lots.lots) {
    if (!l.alive || !zone || !zone.has(l.cell)) continue;
    lots++;
    if (l.constr > 0) rising++;
    if (!l.type) vacant++;
    else if (l.level > 0 && !l.constr) { blds++; if (l.hgt >= 36) tall++; }
    homes += sim.lotHomes(l); jobs += sim.lotJobs(l);
  }
  return { homes, jobs, rising, blds, tall, vacant, lots };
}
const M = (v: number) => (v / 1e6).toFixed(0).padStart(4);

for (const seed of seeds) {
  const probe = new Sim(seed);
  const pts = starter(probe), c = costOf(probe, pts);
  const vs = probe.g.villages;
  const chain: Pt[] = []; // the demo chain, as main.ts demo()
  const sorted = vs.slice().sort((a, b) => a.y - b.y);
  for (let k = 0; k < sorted.length; k++) {
    if (k > 0) { const a = sorted[k - 1], b = sorted[k]; const n = Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 11)); for (let j = 1; j < n; j++) chain.push(land(probe, a.x + (b.x - a.x) * j / n, a.y + (b.y - a.y) * j / n)); }
    chain.push(land(probe, sorted[k].x, sorted[k].y));
  }
  const cc = costOf(probe, chain);
  console.log(`\n== seed ${seed} (${probe.cp.terrain} / ${probe.cp.origin}): start money ${M(START_MONEY)}M; starter line ${pts.length} st ${c.km.toFixed(1)} km costs ${M(c.total)}M${c.ok ? '' : ' (NOT BUILDABLE)'}; demo chain ${chain.length} st ${cc.km.toFixed(1)} km costs ${M(cc.total)}M${cc.ok ? '' : ' (NOT BUILDABLE)'}`);

  const run = (line: boolean) => {
    const sim = new Sim(seed);
    const rows: { m: number; money: number; inc: number; exp: number; pop: number; c: ReturnType<typeof catchStats>; riders: number; ev: number; evSpend: number }[] = [];
    let ev = 0, evSpend = 0, built = false, openAt = -1, buildMoney = 0;
    const evLog: string[] = [];
    for (let m = 0; m < months; m++) {
      if (line && m === open) { buildMoney = sim.money; built = build(sim, pts); if (built) { openAt = sim.month; markZone(sim); } }
      sim.tick();
      while (sim.pending) {
        const info = sim.eventInfo()!, before = sim.money;
        sim.apply({ type: 'choose', event: info.id, choice: 0 });
        ev++; evSpend += before - sim.money;
        evLog.push(`m${sim.month} ${info.title} (${info.choices.length} choices, pick 0: ${M(before - sim.money)}M)`);
      }
      if ((sim.month % 6) === 0 || sim.month === open + 1) {
        const s = sim.stats();
        rows.push({ m: sim.month, money: s.money, inc: s.income, exp: s.expenses, pop: s.population, c: catchStats(sim), riders: s.transitTrips, ev, evSpend });
      }
    }
    return { rows, built, openAt, buildMoney, evLog, sim };
  };
  zone = null;
  const a = run(true), b = run(false);
  if (!a.built) { console.log(`  starter line NOT built at month ${open} (money ${M(a.buildMoney)}M < ${M(c.total)}M)`); }
  console.log(`  month | money inc/mo exp/mo | trips/day | pop (ctl) | catch homes+jobs (ctl) rising(ctl) tall bld vacant/lots | events spent`);
  for (let k = 0; k < a.rows.length; k++) {
    const r = a.rows[k], q = b.rows[k];
    console.log(`  ${String(r.m).padStart(4)} | ${M(r.money)}M ${(r.inc / 1e6).toFixed(2).padStart(5)} ${(r.exp / 1e6).toFixed(2).padStart(5)} | ${String(Math.round(r.riders)).padStart(6)} | ${String(r.pop).padStart(6)} (${q.pop}) | ${String(r.c.homes + r.c.jobs).padStart(6)} (${q.c.homes + q.c.jobs}) ${String(r.c.rising).padStart(3)}(${q.c.rising}) ${r.c.tall} ${r.c.blds} ${r.c.vacant}/${r.c.lots} | ${r.ev} ${M(r.evSpend)}M`);
  }
  // first visible growth round the line's stations: first month after opening where the line city has more buildings rising than control
  if (a.built) {
    const sim = new Sim(seed), ctl = new Sim(seed);
    const pts2 = pts;
    let first = -1, firstTall = -1, firstHomes = -1, baseHomes = 0;
    for (let m = 0; m < months; m++) {
      if (m === open) { build(sim, pts2); markZone(sim); }
      sim.tick(); ctl.tick();
      for (const s of [sim, ctl]) while (s.pending) s.apply({ type: 'choose', event: s.eventInfo()!.id, choice: 0 });
      if (m >= open) {
        const x = catchStats(sim), y = catchStats(ctl);
        if (m === open) baseHomes = x.homes;
        if (first < 0 && x.rising > y.rising + 1) first = sim.month - open;
        if (firstHomes < 0 && x.homes + x.jobs > (y.homes + y.jobs) * 1.1 + 50) firstHomes = sim.month - open;
        if (firstTall < 0 && x.tall > y.tall) firstTall = sim.month - open;
      }
    }
    console.log(`  after opening (month ${open}): first extra construction round the stations +${first} mo; catchment homes+jobs 10% over control +${firstHomes} mo; first extra 36 m+ tower +${firstTall} mo`);
  }
  if (showEvents) for (const l of a.evLog.slice(0, 14)) console.log('    ' + l);
  if (showEvents) for (const mo of a.sim.moments) console.log(`    moment m${mo.month} [${mo.kind}] ${mo.title}`);
  {
    const done = Object.entries(a.sim.goals.done).sort((x, y) => x[1] - y[1]);
    console.log(`  goals reached in ${months} months: ${done.length} (${done.map(([id, mo]) => `${id}@m${mo}`).join(', ')}); headline moments (incl. goals): ${(a.sim as unknown as { momentSeq: number }).momentSeq}; open-line to first grant ${done.length ? done[0][1] - open : '-'} mo`);
  }
  const decs = a.evLog.filter((l) => !/hazard|flood|landslide/i.test(l)).length;
  console.log(`  decisions (events) in ${months} months: ${a.evLog.length}; first at ${a.evLog[0]?.split(' ')[0] ?? 'none'}`);
}
