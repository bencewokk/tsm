// Deliberate empty structure and squares: `npm run structure -- [months=96] [seed ...] [--off]`
// The test line from month 24 is built in both modes (squares need pedestrians and stations). --off = no reserves and no pressure squares (the before numbers).
import { Sim } from '../src/sim/sim';
import { N, BT } from '../src/sim/constants';
import { RES } from '../src/sim/reserves';
import { SQ, squarePressure } from '../src/sim/squares';
import { testLine } from './lib';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const off = args.includes('--off');
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const months = nums[0] ?? 96;
const seeds = nums.slice(1).length ? nums.slice(1) : [4821, 187, 304, 57];

for (const seed of seeds) {
  RES.on = !off; SQ.on = !off;
  const sim = new Sim(seed);
  const log: string[] = [];
  for (let m = 0; m < months; m++) {
    if (m === 24) testLine(sim);
    sim.tick();
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
    const last = sim.log[sim.log.length - 1];
    if (last && /planned at a busy junction/.test(last) && !log.includes(last)) log.push(last);
  }
  const by = [0, 0, 0, 0, 0, 0];
  let vacantBuiltUp = 0, vacantAll = 0;
  const squares: Lot2[] = [];
  for (const l of sim.lots.lots) {
    if (!l.alive) continue;
    if (l.type === BT.Park) by[l.deco || 0]++;
    if (l.type === BT.Square && l.deco === 5) squares.push(l);
    if (!l.type && !l.flags) { vacantAll++; if (sim.lvS[l.cell] > 0.3) vacantBuiltUp++; }
  }
  // distinct new squares (clusters of deco-5 plots)
  const sites: [number, number][] = [];
  for (const l of squares) if (!sites.some(([x, y]) => Math.hypot(x - l.x, y - l.y) < 3.5)) sites.push([l.x, l.y]);
  let minSp = Infinity;
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) minSp = Math.min(minSp, Math.hypot(sites[i][0] - sites[j][0], sites[i][1] - sites[j][1]));
  // retail on the edges of new squares: commercial jobs per plot within 2.5 cells, against all built plots of the same distance band from the centre
  let comEdge = 0, plotEdge = 0, comAll = 0, plotAll = 0;
  for (const l of sim.lots.lots) {
    if (!l.alive || !l.type || l.level <= 0 || l.type === BT.Park || l.type === BT.Square || l.type === BT.Landmark) continue;
    const isCom = l.type === BT.Com ? 1 : 0;
    plotAll++; comAll += isCom;
    if (sites.some(([x, y]) => Math.hypot(x - l.x, y - l.y) < 2.5)) { plotEdge++; comEdge += isCom; }
  }
  console.log(`== seed ${seed} ${sim.cp.terrain}/${sim.cp.origin} month ${sim.month} pop ${sim.stats().population} ${off ? '(no reserves, no pressure squares)' : '(reserves + squarePressure)'}`);
  console.log(`   deliberate open land (plots): large parks ${by[1]}, green wedge ${by[2]}, campus lawn ${by[3]}, other parks ${by[0]}; vacant plots left: ${vacantAll} (${vacantBuiltUp} in built-up land)`);
  console.log(`   new squares: ${sites.length}${sites.length ? ` (${squares.length} plots), nearest two ${minSp === Infinity ? '-' : minSp.toFixed(1) + ' cells apart'}` : ''}; shops among the plots within 2.5 cells of a new square: ${plotEdge ? Math.round(100 * comEdge / plotEdge) : 0}% vs ${plotAll ? Math.round(100 * comAll / plotAll) : 0}% city-wide`);
  for (const l of log) console.log(`   ${l}`);
  void squarePressure; void N;
}
type Lot2 = { x: number; y: number };
