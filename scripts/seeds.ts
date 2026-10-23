// Headless seed survey: `npm run seeds -- [months] [seed ...]` prints each city's story and fabric stats.
import { Sim } from '../src/sim/sim';
import { BT, N } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2).map(Number).filter((n) => !isNaN(n));
const months = args[0] ?? 96;
const seeds = args.slice(1).length ? args.slice(1) : [4821, 11, 23, 37, 58, 71, 94, 107];
for (const seed of seeds) {
  const t0 = Date.now();
  const sim = new Sim(seed);
  for (let m = 0; m < months; m++) {
    sim.tick();
    if (sim.pending) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: 0 }); }
  }
  const s = sim.stats();
  const lots = sim.lots.lots.filter((l) => l.alive);
  const built = lots.filter((l) => l.type && l.level > 0);
  const cont = built.filter((l) => l.dens > 0).length / Math.max(1, built.length);
  // density gradient: built plots per cell within 8 cells of the origin vs 20-30 cells out
  const o = sim.g.villages[0];
  const ring = (r0: number, r1: number) => { let b = 0, area = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const d = Math.hypot(x - o.x, y - o.y); if (d >= r0 && d < r1 && !sim.g.water[y * N + x]) area++; } for (const l of built) { const d = Math.hypot(l.x - o.x, l.y - o.y); if (d >= r0 && d < r1) b++; } return b / Math.max(1, area); };
  const types = [BT.Res, BT.Com, BT.Ind].map((t) => built.filter((l) => l.type === t).length);
  console.log(`seed ${seed} [${sim.cp.terrain}/${sim.cp.origin}/${sim.cp.site} plan ${sim.cp.planningStrength.toFixed(2)} wealth ${sim.cp.wealth.toFixed(2)}] pop ${s.population} bld ${s.buildings} lots ${lots.length} continuous ${(cont * 100).toFixed(0)}% density core ${ring(0, 8).toFixed(2)} mid ${ring(8, 20).toFixed(2)} edge ${ring(20, 32).toFixed(2)} R/C/I ${types.join('/')} quarters ${sim.g.villages.map((v) => `${v.kind}:${v.style}`).join(',')} (${Date.now() - t0} ms)`);
  console.log('   ' + sim.cp.story);
}
