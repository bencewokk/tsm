// Road graph validation: `npm run graph -- [months] [--line] [--each] [seed ...]`
// Validates after generation and after every tick (the maximum and final counts are printed), for several seeds / origins.
import { Sim } from '../src/sim/sim';
import { validateGraph, formatReport, GRAPH_KEYS, graphDefects, type GraphReport } from '../src/sim/graphcheck';
import { testLine } from './lib';
import { REPAIR } from '../src/sim/roads';
import { inCoreXY } from '../src/sim/hierarchy';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const nums = args.filter((a) => !a.startsWith('--'));
if (flags.has('--norepair')) REPAIR.on = false;
const months = Number(nums[0] ?? 60);
const seeds = nums.slice(1).map(Number);
if (!seeds.length) seeds.push(4821, 187, 304);
const origin: Record<number, string | undefined> = {};
for (const a of args) { const m = a.match(/^--origin=(\w+)$/); if (m) for (const s of seeds) origin[s] = m[1]; }

for (const seed of seeds) {
  const t0 = Date.now();
  const sim = new Sim(seed, { origin: origin[seed] as never });
  const start = validateGraph(sim.roads, (x, y) => inCoreXY(sim.town, x, y));
  console.log(`seed ${seed} [generation] ${formatReport(start)}`);
  const max: Record<string, number> = {};
  const total: Record<string, number> = {};
  let first: GraphReport | null = null, last: GraphReport = start, anyTicks = 0;
  for (let m = 0; m < months; m++) {
    if (flags.has('--line') && m === 24) testLine(sim);
    sim.tick();
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
    const r = validateGraph(sim.roads, (x, y) => inCoreXY(sim.town, x, y));
    if (!first) first = r;
    for (const k of GRAPH_KEYS) { max[k] = Math.max(max[k] ?? 0, r[k] as number); total[k] = (total[k] ?? 0) + (r[k] as number); }
    if (flags.has('--each') && (m + 1) % 6 === 0) console.log(`   m${m + 1} defects ${graphDefects(r)} ${formatReport(r)}`);
    if (graphDefects(r) > 0) anyTicks++;
    last = r;
  }
  console.log(`seed ${seed} [month ${months}] ${formatReport(last)}`);
  console.log(`seed ${seed} defect-ticks (sum over ${months} ticks of all defects): ${GRAPH_KEYS.map((k) => `${k} ${total[k]}`).join(', ')}; ticks with any defect: ${anyTicks}`);
  console.log(`seed ${seed} max over ticks: ${GRAPH_KEYS.map((k) => `${k} ${max[k]}`).join(', ')}  (${Date.now() - t0} ms)`);
}
