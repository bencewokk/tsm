// Playability check: `npm run routes -- [seeds=50] [firstSeed=1]`
// For every landform (coast, river, hills, plain) and N seeds: is there a buildable, affordable metro route between the old town
// and its nearest neighbour? Prints a summary per landform and every failing seed. Exit code 1 when any seed fails.
import { Sim } from '../src/sim/sim';
import { bestRoute, ROUTE_CAP } from '../src/sim/relief';

declare const process: { argv: string[]; exit(code: number): void };
const args = process.argv.slice(2).map(Number);
const count = args[0] || 50, first = args[1] || 1;
let failures = 0;
for (const terrain of ['coast', 'river', 'hills', 'plain'] as const) {
  let ok = 0, carved = 0, rack = 0, totals: number[] = [], lines: string[] = [];
  for (let seed = first; seed < first + count; seed++) {
    const sim = new Sim(seed, { terrain });
    const vs = sim.g.villages;
    if (vs.length < 2) { lines.push(`   seed ${seed}: only one settlement`); failures++; continue; }
    const o = vs[0];
    const nb = vs.slice(1).sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0];
    const r = bestRoute(sim.metro.terr, o, nb, sim.g.landforms.passes.map(([x, y]) => ({ x, y })));
    if (r && r.total <= ROUTE_CAP) {
      ok++; totals.push(r.total);
      if (sim.g.landforms.carved) carved++;
      if (r.q.by[4] > 0.05) rack++;
    } else { failures++; lines.push(`   seed ${seed} (${sim.cp.origin}): ${r ? `cheapest route $${(r.total / 1e6).toFixed(0)}M > cap` : 'no buildable route'}`); }
  }
  totals.sort((a, b) => a - b);
  const med = totals.length ? totals[totals.length >> 1] : 0, mx = totals.length ? totals[totals.length - 1] : 0;
  console.log(`${terrain}: ${ok}/${count} seeds have an affordable route (cap $${ROUTE_CAP / 1e6}M); median $${(med / 1e6).toFixed(0)}M, max $${(mx / 1e6).toFixed(0)}M; saddle cut needed on ${carved}; cheapest route uses a rack segment on ${rack}`);
  for (const l of lines) console.log(l);
}
console.log(failures === 0 ? 'ALL SEEDS PLAYABLE (0 failures)' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
