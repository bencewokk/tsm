// Probe: `npx tsx scripts/fieldprobe.ts <seed> <months> [--line]` prints the field around the centre.
import { Sim } from '../src/sim/sim';
import { N } from '../src/sim/constants';
import { testLine } from './lib';
declare const process: { argv: string[] };
const a = process.argv.slice(2);
const seed = Number(a[0] ?? 4821), months = Number(a[1] ?? 96);
const sim = new Sim(seed);
for (let m = 0; m < months; m++) {
  if (a.includes('--line') && m === 24) testLine(sim);
  sim.tick();
  if (sim.pending) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: 0 }); }
}
const f = sim.field, c = f.main;
console.log('main', c, 'R', f.mainR.toFixed(1), 'pop', sim.stats().population);
for (const d of [0, 2, 4, 6, 8, 10, 14, 20]) {
  const x = Math.round(c.x + d), y = Math.round(c.y), i = y * N + x;
  console.log(`d=${d} cent ${f.cent[i].toFixed(2)} jc ${f.jc[i].toFixed(2)} acc ${f.acc[i].toFixed(2)} F ${f.F[i].toFixed(2)} hmax ${f.hmax[i].toFixed(0)} jobsBlur ${(f.jc[i] * 60).toFixed(0)} lvS ${sim.lvS[i].toFixed(2)}`);
}
let mx = 0, mj = 0, ma = 0; for (let i = 0; i < N * N; i++) { mx = Math.max(mx, f.hmax[i]); mj = Math.max(mj, f.jc[i]); ma = Math.max(ma, f.acc[i]); }
console.log('max hmax', mx.toFixed(0), 'max jc', mj.toFixed(2), 'max acc', ma.toFixed(2), 'stAccess', [...sim.stAccess].map((v) => v.toFixed(2)).join(','));
