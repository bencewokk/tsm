// Land-use territories: `npm run zones -- [months=96] [seed ...] [--off]`
// Prints the territory shares and how well the city respects them (industry inside the port / industry areas, homes and towers outside them).
// --off runs the old unstructured land use (TERR.on = false), classified with the same fixed territories, for the before numbers.
import { Sim } from '../src/sim/sim';
import { N, BT } from '../src/sim/constants';
import { TERR, T, T_NAMES, staticTerritories } from '../src/sim/territory';
import type { TownCtx } from '../src/sim/town';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const off = args.includes('--off');
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const months = nums[0] ?? 96;
const seeds = nums.slice(1).length ? nums.slice(1) : [4821, 187, 304, 57];

for (const seed of seeds) {
  TERR.on = !off;
  const sim = new Sim(seed);
  for (let m = 0; m < months; m++) { sim.tick(); if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 }); }
  // classification: the fixed territories of this city (port / industry / workers) in either mode
  let terr = sim.town.terr;
  if (off) {
    TERR.on = true;
    const ctx = { ...sim.town, terr: new Uint8Array(N * N) } as TownCtx;
    staticTerritories(ctx);
    terr = ctx.terr;
  }
  const area = new Array(9).fill(0), plots = new Array(9).fill(0), h = new Array(9).fill(0), hn = new Array(9).fill(0);
  let indJobs = 0, indJobsIn = 0, resPlots = 0, resInHeavy = 0, comInHeavy = 0, tall = 0, tallInPort = 0, maxPort = 0, indPlots = 0, indPlotsIn = 0;
  for (let i = 0; i < N * N; i++) if (!sim.g.water[i]) area[terr[i]]++;
  for (const l of sim.lots.lots) {
    if (!l.alive) continue;
    const t = terr[l.cell];
    plots[t]++;
    const hh = l.level > 0 && l.hgt > 0 ? l.hgt : 0;
    if (l.type === BT.Ind && l.level > 0) {
      const j = sim.lotJobs(l); indJobs += j; indPlots++;
      if (t === T.Port || t === T.Industry) { indJobsIn += j; indPlotsIn++; }
    }
    if (l.type === BT.Res && l.level > 0) { resPlots++; if (t === T.Port || t === T.Industry) resInHeavy++; }
    if (l.type === BT.Com && l.level > 0 && (t === T.Port || t === T.Industry)) comInHeavy++;
    if (hh >= 36) { tall++; if (t === T.Port) tallInPort++; }
    if (t === T.Port) maxPort = Math.max(maxPort, hh);
    if (l.level > 0 && l.type && l.type < 4) { h[t] += hh || 10; hn[t]++; }
  }
  const land = area.reduce((a, b) => a + b, 0);
  console.log(`== seed ${seed} ${sim.cp.terrain}/${sim.cp.origin}/${sim.cp.site} month ${sim.month} pop ${sim.stats().population} ${off ? '(old unstructured land use)' : '(territories)'}`);
  console.log('   territory      area%  plots  mean height');
  for (let t = 0; t < 9; t++) if (area[t]) console.log(`   ${T_NAMES[t].padEnd(18)} ${String((100 * area[t] / land).toFixed(0)).padStart(3)}%  ${String(plots[t]).padStart(5)}  ${(hn[t] ? h[t] / hn[t] : 0).toFixed(1).padStart(5)} m`);
  console.log(`   industry plots inside port / industry areas: ${indPlotsIn}/${indPlots} (${indPlots ? Math.round(100 * indPlotsIn / indPlots) : 0}%), jobs ${indJobsIn}/${indJobs} (${indJobs ? Math.round(100 * indJobsIn / indJobs) : 0}%)`);
  console.log(`   homes plots inside port / industry areas: ${resInHeavy}/${resPlots};  shops inside: ${comInHeavy};  towers (>= 36 m) on port land: ${tallInPort} of ${tall}; tallest building on port land ${maxPort.toFixed(0)} m`);
}
