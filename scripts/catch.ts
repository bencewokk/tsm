// Walk catchments on the same graph state before / after the road repair and the street-side station access.
// `npm run catch -- [month] [seeds...]`: builds the test line, runs to `month` WITHOUT repair, then measures station catchments (cells within 8 min of walk),
// applies the repair to that very graph and measures again, then also turns the street-side entrance access off to show its effect.
import { Sim, WALK } from '../src/sim/sim';
import { REPAIR } from '../src/sim/roads';
import { inCoreXY } from '../src/sim/hierarchy';
import { validateGraph, graphDefects } from '../src/sim/graphcheck';
import { testLine } from './lib';
import { N } from '../src/sim/constants';

declare const process: { argv: string[] };
const nums = process.argv.slice(2).map(Number);
const month = nums[0] ?? 48;
const seeds = nums.slice(1);
if (!seeds.length) seeds.push(4821, 187, 304, 57);

function measure(sim: Sim) {
  (sim as unknown as { walkKey: string }).walkKey = '';
  sim.refreshTransit();
  const w = (sim as unknown as { walk: Float32Array[] }).walk;
  const per = w.map((f) => { let c = 0; for (let i = 0; i < N * N; i++) if (f[i] < 8) c++; return c; });
  let any = 0;
  for (let i = 0; i < N * N; i++) if (w.some((f) => f[i] < 8)) any++;
  return { per, any, tiny: per.filter((c) => c < 40).length };
}

for (const seed of seeds) {
  REPAIR.on = false; WALK.edgeAccess = true;
  const sim = new Sim(seed);
  for (let m = 0; m < month; m++) {
    if (m === 24) testLine(sim);
    sim.tick();
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
  }
  const d0 = validateGraph(sim.roads, (x, y) => inCoreXY(sim.town, x, y));
  const a = measure(sim);
  REPAIR.on = true;
  sim.repairRoads();
  const d1 = validateGraph(sim.roads, (x, y) => inCoreXY(sim.town, x, y));
  const b = measure(sim);
  WALK.edgeAccess = false;
  const c = measure(sim);
  WALK.edgeAccess = true;
  console.log(`seed ${seed} month ${month}: ${sim.metro.stations.length} stations`);
  console.log(`  defects ${graphDefects(d0)} -> ${graphDefects(d1)}  (nodes ${d0.nodes}->${d1.nodes}, edges ${d0.edges}->${d1.edges}, components ${d0.components}->${d1.components})`);
  console.log(`  8-min walk cells, any station: unrepaired graph ${a.any} -> repaired ${b.any}; repaired but node-only entrance ${c.any}`);
  console.log(`  per station: ${a.per.join('/')} -> ${b.per.join('/')} (node-only entrance ${c.per.join('/')}); stations with a catchment under 40 cells: ${a.tiny} -> ${b.tiny}`);
}
