// Macro-structure measurements: `npm run metrics -- [months] [--line] [--baseline] [seed ...]`
// Prints the height / density gradient (by distance from the centre and by station walk time) and the road statistics.
import { Sim } from '../src/sim/sim';
import { roadStats, gradient, fmtRows, baselineHeight, type RoadZone } from '../src/sim/metrics';
import { builtHeight } from '../src/sim/field';
import { testLine } from './lib';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const withLine = args.includes('--line');
const useBaseline = args.includes('--baseline');
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const months = nums[0] ?? 96;
const seeds = nums.slice(1).length ? nums.slice(1) : [4821, 187, 304];

const fmt = (r: RoadZone) => `edges ${String(r.edges).padStart(4)} (${r.km.toFixed(0).padStart(3)} km) art/col/loc ${r.byClass.join('/')}  diagonals ${String(r.diagonals).padStart(3)}  dead ends ${String(r.deadEnds).padStart(3)} (short ${r.shortDeadEnds})  faces ${r.faces} triangles ${r.triangles} slivers ${r.slivers}`;

for (const seed of seeds) {
  const sim = new Sim(seed);
  const rs0 = roadStats(sim);
  for (let m = 0; m < months; m++) {
    if (withLine && m === 24) testLine(sim);
    sim.tick();
    if (sim.pending) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: 0 }); }
  }
  const c = sim.town.districts[0];
  const centre = { x: c.x, y: c.y };
  const g = gradient(sim, centre, useBaseline ? baselineHeight : (l) => builtHeight(sim, l));
  const rs = roadStats(sim);
  console.log(`== seed ${seed} ${sim.cp.terrain}/${sim.cp.origin} month ${sim.month} pop ${sim.stats().population} ${withLine ? '(test line from month 24)' : '(no metro)'} centre ${centre.x.toFixed(0)},${centre.y.toFixed(0)}`);
  console.log('-- by distance from the centre (cells of 50 m)\n' + fmtRows(g.byDist));
  console.log('-- by station walk time\n' + fmtRows(g.byStation));
  console.log(`-- towers (>= 60 m): ${g.skyline}   re-subdivided streets: ${sim.resubdivided}  assemblies ${JSON.stringify(sim.asm.stats)} active ${sim.asm.list.length}`);
  console.log(`-- roads at start   all: ${fmt(rs0)}\n                  core: ${fmt(rs0.core)}\n               outside: ${fmt(rs0.outside)}`);
  console.log(`-- roads at month ${sim.month}  all: ${fmt(rs)}\n                  core: ${fmt(rs.core)}\n               outside: ${fmt(rs.outside)}`);
}
