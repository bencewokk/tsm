// Headless sim runner: `npm run headless -- [seed] [months] [--map] [--line]`
// Prints yearly stats; with --map draws an ASCII map; with --line builds a test metro line at month 6.
import { Sim } from '../src/sim/sim';
import { N, BT } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const flags = new Set(args.filter((a: string) => a.startsWith('--')));
const nums = args.filter((a: string) => !a.startsWith('--')).map(Number);
const seed = nums[0] ?? 4821;
const months = nums[1] ?? 60;

function ascii(sim: Sim) {
  const g = sim.g;
  const rows: string[] = [];
  for (let y = 0; y < N; y += 2) {
    let r = '';
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let ch = '.';
      if (g.water[i] === 1) ch = '~';
      else if (g.water[i] === 2) ch = '=';
      else if (g.btype[i] === BT.Res) ch = String(g.level[i]);
      else if (g.btype[i] === BT.Com) ch = 'cCO'[g.level[i] - 1] ?? 'c';
      else if (g.btype[i] === BT.Ind) ch = 'I';
      else if (g.btype[i] === BT.Park) ch = 'p';
      else if (g.road[i]) ch = '#';
      else if (g.flags[i] & 8) ch = '^';
      for (const s of (sim as unknown as { stations?: { x: number; y: number }[] }).stations ?? []) if (s.x === x && (s.y === y || s.y === y + 1)) ch = '@';
      r += ch;
    }
    rows.push(r);
  }
  console.log(rows.join('\n'));
}

function run(withLine: boolean) {
  const sim = new Sim(seed);
  const t0 = Date.now();
  for (let m = 0; m < months; m++) {
    if (withLine && m === 6) (globalThis as unknown as { testLine?: (s: Sim) => void }).testLine?.(sim);
    sim.tick();
    if ((m + 1) % 12 === 0 || m === months - 1) {
      const s = sim.stats();
      console.log(`m${String(s.month).padStart(3)} pop ${String(Math.round(s.population)).padStart(7)} homes ${s.homes} jobs ${s.jobs} bld ${s.buildings} $${(s.money / 1e6).toFixed(1)}M inc ${(s.income / 1e6).toFixed(2)} exp ${(s.expenses / 1e6).toFixed(2)} cong ${s.congestion.toFixed(2)} spd ${s.driveSpeed.toFixed(0)} share ${(s.transitShare * 100).toFixed(1)}% R ${s.resDemand.toFixed(2)} C ${s.comDemand.toFixed(2)}`);
    }
  }
  console.log(`ran ${months} months in ${Date.now() - t0} ms`);
  return sim;
}

const sim = run(flags.has('--line'));
if (flags.has('--map')) ascii(sim);
console.log('villages', sim.g.villages.map((v) => `${v.name}@${v.x},${v.y}`).join(' '), 'docks cells', sim.g.docksCells.length);
