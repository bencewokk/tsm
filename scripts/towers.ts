// Tower timing: `npm run towers -- [seed ...]`
// With no metro the city must stay low / mid-rise; a good line opened at month 24 must give visible 60 m+ towers near its best stations by months 48-60.
import { Sim, BOOM } from '../src/sim/sim';
import { N } from '../src/sim/constants';
import { testLine } from './lib';

declare const process: { argv: string[] };
if (process.argv.includes('--noboom')) BOOM.on = false;
const seeds = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (!seeds.length) seeds.push(4821, 187, 304, 57);
const marks = [36, 48, 60, 72, 96];

function run(seed: number, line: boolean) {
  const sim = new Sim(seed);
  const rows: string[] = [];
  for (let m = 0; m < 96; m++) {
    if (line && m === 24) testLine(sim);
    sim.tick();
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
    if (marks.includes(sim.month)) {
      let t60 = 0, t40 = 0, mx = 0, building60 = 0;
      for (const l of sim.lots.lots) {
        if (!l.alive) continue;
        const h = l.level > 0 && l.hgt > 0 ? l.hgt : 0;
        if (h >= 60) t60++; if (h >= 40) t40++; mx = Math.max(mx, h);
        if (l.constr > 0 && l.nhgt >= 60) building60++;
      }
      // field at the busiest station
      let best = '';
      const st = sim.metro.stations.slice().sort((a, b) => b.riders - a.riders)[0];
      if (st) {
        const i = Math.floor(st.y) * N + Math.floor(st.x);
        best = ` | busiest station ${Math.round(st.riders)}/day: acc ${sim.field.acc[i].toFixed(2)} jobs ${sim.field.jc[i].toFixed(2)} cent ${sim.field.cent[i].toFixed(2)} hmax ${sim.field.hmax[i].toFixed(0)} m lv ${sim.lvS[i].toFixed(2)}`;
      }
      rows.push(`   m${String(sim.month).padStart(2)}: pop ${String(sim.stats().population).padStart(6)}  >=60 m ${String(t60).padStart(3)} (+${building60} rising)  >=40 m ${String(t40).padStart(3)}  tallest ${mx.toFixed(0).padStart(3)} m${best}`);
    }
  }
  return rows;
}
for (const seed of seeds) {
  console.log(`== seed ${seed} no metro`); console.log(run(seed, false).join('\n'));
  console.log(`== seed ${seed} test line from month 24`); console.log(run(seed, true).join('\n'));
}
