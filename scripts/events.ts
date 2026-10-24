// Dynamic development projects over a long headless run: `npm run events -- [months] [seed] [--quiet]`
// Builds the test line at month 24 and a second line across the city at month 90, answers every decision with a rotating policy
// (instance id mod number of choices, so deals, declines and refurbishments all occur), and logs every project instance
// (type, site, month, outcome) plus counts per type, the area trust / interest at the end and the most projects running at once.
import { Sim } from '../src/sim/sim';
import { PROJECT_TYPES } from '../src/sim/projects';
import { testLine } from './lib';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const months = nums[0] ?? 240, seed = nums[1] ?? 4821;
const quiet = args.includes('--quiet');

/** a second line, west to east through the quarters (testLine runs north to south) */
let crossIds: number[] | null = null;
function crossLine(sim: Sim) {
  const vs = sim.g.villages.slice().sort((a, b) => a.x - b.x);
  if (crossIds) return buildPrefix(sim, crossIds);
  if (sim.money < 60e6) return 0;   // dig the stations only once there is money for a line
  const ids: number[] = (crossIds = []);
  for (const v of vs) {
    for (let r = 0; r < 4; r++) {
      const before = sim.metro.stations.length;
      sim.apply({ type: 'placeStation', x: v.x + r, y: v.y + 2 });
      if (sim.metro.stations.length > before) { ids.push(sim.metro.stations[before].id); break; }
    }
  }
  return buildPrefix(sim, ids);
}
function buildPrefix(sim: Sim, ids: number[]) {
  for (let n = ids.length; n >= 2; n--) {
    const q = sim.metro.quote(ids.slice(0, n));
    if (q.ok && q.cost + 4e6 <= sim.money) { sim.apply({ type: 'buildLine', stations: ids.slice(0, n) }); return n; }
  }
  return 0;
}

const t0 = Date.now();
const sim = new Sim(seed);
let maxActive = 0, maxAsm = 0, simult: string[] = [];
const decisions: Record<string, number[]> = {};
const tried = new Set<number>(), spurs: string[] = [], moneyLog: string[] = [];
for (let m = 0; m < months; m++) {
  if (m === 24) testLine(sim);
  if (m % 24 === 0) moneyLog.push(`m${m} ${(sim.money / 1e6).toFixed(0)}M`);
  if (m >= 90 && m <= 200 && m % 6 === 0 && sim.metro.lines.length < 2) crossLine(sim);   // retried until it is affordable
  sim.tick();
  for (let guard = 0; sim.pending && guard < 10; guard++) {
    const ev = sim.eventInfo()!;
    let choice = 0;
    if (ev.id.startsWith('proj_')) {
      const id = Number(ev.id.slice(5));
      choice = id % ev.choices.length;
      (decisions[ev.id] ??= []).push(choice);
    }
    sim.apply({ type: 'choose', event: ev.id, choice });
  }
  // a player who keeps every other promise: a few months after the deal, a station at the site joined to the nearest station on a line
  for (const p of sim.projects.list) {
    if (p.promise !== 'open' || p.id % 2 || tried.has(p.id) || sim.month < p.month + 5) continue;
    tried.add(p.id);
    const used = new Set(sim.metro.lines.flatMap((l) => l.stations));
    const near = sim.metro.stations.filter((s) => used.has(s.id)).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (!near) continue;
    let sid = -1;
    for (let r = 0; r < 3 && sid < 0; r++) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const before = sim.metro.stations.length;
      sim.apply({ type: 'placeStation', x: Math.round(p.x) + dx, y: Math.round(p.y) + dy });
      if (sim.metro.stations.length > before) { sid = sim.metro.stations[before].id; break; }
    }
    if (sid >= 0) { sim.apply({ type: 'buildLine', stations: [near.id, sid] }); spurs.push(`m${sim.month} spur for #${p.id} ${p.type}: ${sim.metro.lines.some((l) => l.stations.includes(sid)) ? 'built' : 'not affordable'}`); }
  }
  const act = sim.projects.active().filter((p) => p.status !== 'proposed');
  if (act.length > maxActive) { maxActive = act.length; simult = act.map((p) => `#${p.id} ${p.type} ${p.place} (${p.status})`); }
  maxAsm = Math.max(maxAsm, sim.asm.list.filter((a) => a.kind === 'project').length);
}
if (!quiet) for (const l of sim.projects.log) console.log(l);
console.log(`\nseed ${seed}, ${months} months (${(months / 12).toFixed(0)} years), population ${Math.round(sim.homes * 2.3)}, lines ${sim.metro.lines.length}, ${Date.now() - t0} ms`);
console.log('per type: instances / distinct sites / quarters / outcomes');
for (const t of PROJECT_TYPES) {
  const ps = sim.projects.list.filter((p) => p.type === t.id);
  const areas = new Set(ps.map((p) => p.area)).size;
  // distinct sites: instances more than 3 cells (150 m) from every earlier one of the same type
  const sites = ps.filter((p, i) => ps.slice(0, i).every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 3)).length;
  const out: Record<string, number> = {};
  for (const p of ps) { const k = p.status === 'done' ? `done${p.carLock ? ' car-first' : ''}` : p.status; out[k] = (out[k] ?? 0) + 1; }
  const months0 = ps.map((p) => p.month);
  const gaps = months0.slice(1).map((v, i) => v - months0[i]);
  const promises = ps.filter((p) => p.promise !== 'none').map((p) => p.promise);
  console.log(`  ${t.id.padEnd(22)} ${String(ps.length).padStart(3)} at ${sites} sites in ${areas} quarters | ${Object.entries(out).map(([k, v]) => `${k} ${v}`).join(', ')}` +
    `${gaps.length ? ` | mean gap ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)} months` : ''}${promises.length ? ` | promises: kept ${promises.filter((x) => x === 'kept').length}, broken ${promises.filter((x) => x === 'broken').length}, open ${promises.filter((x) => x === 'open').length}` : ''}`);
}
for (const l of spurs) console.log('  ' + l);
console.log("money: " + moneyLog.join(", "));
console.log(`total instances ${sim.projects.list.length}; most running at once ${maxActive} (assemblies at once ${maxAsm}):`);
for (const s of simult) console.log('   ' + s);
console.log('area trust / interest at the end: ' + sim.g.villages.map((v, i) => `${v.name} ${sim.projects.trust[i]?.toFixed(2) ?? '1.00'}/${sim.projects.interest[i]?.toFixed(2) ?? '1.00'}`).join(', '));
