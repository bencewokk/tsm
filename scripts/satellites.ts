// Satellites with a cause: `npm run satellites -- [months=96] [seed ...]`
// Per seed: every settlement beyond the origin with its cause, distance, links (arterial / collector path, rail spur) and what it holds at the end.
import { Sim } from '../src/sim/sim';
import { N } from '../src/sim/constants';
import { RC } from '../src/sim/roads';

declare const process: { argv: string[] };
const nums = process.argv.slice(2).map(Number).filter((n) => n > 0);
const months = nums[0] ?? 96;
const seeds = nums.slice(1).length ? nums.slice(1) : [4821, 187, 304, 57, 83, 252, 369, 421, 11, 23, 7, 20];

/** Is any node near b reachable from the nodes near a using only edges of class <= maxCls? (multi-source search over the road graph) */
function reach(sim: Sim, ax: number, ay: number, bx: number, by: number, maxCls: number): boolean {
  const R = sim.roads;
  const srcs: number[] = [], dst = new Set<number>();
  for (let n = 0; n < R.nx.length; n++) {
    if (!R.adj[n].length) continue;
    if (Math.hypot(R.nx[n] - ax, R.ny[n] - ay) < 6) srcs.push(n);
    if (Math.hypot(R.nx[n] - bx, R.ny[n] - by) < 6) dst.add(n);
  }
  const seen = new Set<number>(srcs);
  let f = srcs.slice();
  for (const n of f) if (dst.has(n)) return true;
  while (f.length) {
    const next: number[] = [];
    for (const n of f) for (const e of R.adj[n]) {
      if (R.ecls[e] > maxCls) continue;
      const o = R.other(e, n);
      if (dst.has(o)) return true;
      if (!seen.has(o)) { seen.add(o); next.push(o); }
    }
    f = next;
  }
  return false;
}

const tally: Record<string, { n: number; linked: number; rail: number; homes: number }> = {};
for (const seed of seeds) {
  const sim = new Sim(seed);
  for (let m = 0; m < months; m++) { sim.tick(); if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 }); }
  const vs = sim.g.villages, o = vs[0];
  const homesAround = (x: number, y: number) => { let h = 0; for (let i = 0; i < N * N; i++) if (Math.hypot((i % N) + 0.5 - x, ((i / N) | 0) + 0.5 - y) < 9) h += sim.cHomes[i]; return Math.round(h); };
  const total = sim.homes;
  console.log(`== seed ${seed} ${sim.cp.terrain}/${sim.cp.origin} (history: ${sim.cp.history.map((h) => h.kind).join(', ') || '-'}) homes ${total}`);
  for (let k = 1; k < vs.length; k++) {
    const v = vs[k];
    const cause = v.cause ?? (v.kind === 'planned' ? 'planned quarter' : 'other');
    const art = reach(sim, o.x + 0.5, o.y + 0.5, v.x + 0.5, v.y + 0.5, RC.Collector), any = reach(sim, o.x + 0.5, o.y + 0.5, v.x + 0.5, v.y + 0.5, RC.Local);
    let rail = false;
    for (const ln of sim.g.rail) for (const p of ln) if (Math.hypot(p[0] - v.x, p[1] - v.y) < 7) rail = true;
    const hm = homesAround(v.x + 0.5, v.y + 0.5);
    console.log(`   ${cause.padEnd(15)} ${String(v.style).padEnd(9)} at ${v.x},${v.y}  ${Math.hypot(v.x - o.x, v.y - o.y).toFixed(0).padStart(2)} cells from the old town  link: ${art ? 'arterial/collector' : any ? 'local streets only' : 'NOT CONNECTED'}${rail ? ' + rail' : ''}  homes ${hm}`);
    const t = (tally[cause] ??= { n: 0, linked: 0, rail: 0, homes: 0 });
    t.n++; if (art) t.linked++; if (rail) t.rail++; t.homes += hm;
  }
}
console.log('\n== summary over seeds');
for (const [k, t] of Object.entries(tally)) console.log(`   ${k.padEnd(15)} ${t.n} settlements, ${t.linked} joined to the old town by arterials / collectors, ${t.rail} with a rail spur, mean ${Math.round(t.homes / t.n)} homes within 9 cells at the end`);
