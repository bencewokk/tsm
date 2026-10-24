// Floods and landslides over a long run: `npm run hazards -- [months] [seed ...]` (decisions: defences on the first ask)
import { Sim } from '../src/sim/sim';
import { testLine } from './lib';
declare const process: { argv: string[] };
const nums = process.argv.slice(2).map(Number);
const months = nums[0] ?? 240;
const seeds = nums.slice(1).length ? nums.slice(1) : [4821, 187, 304, 57];
for (const seed of seeds) {
  const sim = new Sim(seed);
  for (let m = 0; m < months; m++) {
    if (m === 24) testLine(sim);
    sim.tick();
    for (let g = 0; sim.pending && g < 10; g++) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: ev.id.startsWith('proj_') ? Number(ev.id.slice(5)) % ev.choices.length : 0 }); }
  }
  console.log(`== seed ${seed} ${sim.cp.terrain}/${sim.cp.origin}, ${months} months`);
  for (const l of sim.hazards.log) console.log('   ' + l);
  console.log(`   strikes: ${JSON.stringify(sim.hazards.strikes)}; defences: ${JSON.stringify(sim.hazards.cut)}`);
}
