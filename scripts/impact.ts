// Terrain impact on the game: `npm run impact -- [seed]`
//  1. metro cost per km by construction type and the cost of real lines over each terrain
//  2. walk catchment (8 min, over streets) of a hilltop station versus a flat one
//  3. a ridge splits the city: ridership and growth with and without a tunnel line that opens the second basin
import { Sim } from '../src/sim/sim';
import { N, CELL, Flag } from '../src/sim/constants';
import { SEG_KM_COST, SEG_NAMES, RELIEF, quoteLine, hAt } from '../src/sim/relief';
import { testLine } from './lib';

declare const process: { argv: string[] };
const seed = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 4821);
const M = (v: number) => `$${(v / 1e6).toFixed(Math.abs(v) < 1e6 ? 2 : 0)}M`;

console.log(`== 1. cost per km by construction type`);
SEG_NAMES.forEach((n, k) => console.log(`   ${n.padEnd(14)} ${M(SEG_KM_COST[k])}/km`));
console.log(`   grade limit ${(RELIEF.maxGrade * 100).toFixed(0)}%, deepest station ${RELIEF.maxDepth} m, +${M(RELIEF.stationDepthCost)} per metre of depth, +${RELIEF.escalatorMin} min walk per metre of depth`);

function line(sim: Sim, a: { x: number; y: number }, b: { x: number; y: number }, step = 12) {
  const n = Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / step));
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k <= n; k++) pts.push({ x: Math.round(a.x + (b.x - a.x) * k / n), y: Math.round(a.y + (b.y - a.y) * k / n) });
  return pts;
}

for (const terrain of ['coast', 'river', 'hills', 'plain'] as const) {
  const sim = new Sim(seed, { terrain });
  const vs = sim.g.villages;
  if (vs.length < 2) continue;
  const rows: string[] = [];
  for (let k = 1; k < vs.length; k++) {
    const pts = line(sim, vs[0], vs[k]);
    const q = quoteLine(pts, sim.metro.terr);
    const mix = q.by.map((km, i) => (km > 0.05 ? `${km.toFixed(1)} km ${SEG_NAMES[i]}` : '')).filter(Boolean).join(', ');
    rows.push(`   village 0 -> ${k}: ${q.km.toFixed(1)} km, ${M(q.cost)} (${M(q.cost / Math.max(0.1, q.km))}/km), deepest station ${Math.max(...q.depth).toFixed(0)} m, steepest grade ${(Math.max(...q.segs.map((s) => Math.abs(s.grade))) * 100).toFixed(1)}%${q.ok ? '' : ' NOT BUILDABLE'}; ${mix}`);
  }
  console.log(`-- ${terrain}/${sim.cp.origin}\n${rows.join('\n')}`);
}

// ------------------------------------------------------------------ 2. hilltop vs flat catchment
console.log(`\n== 2. walk catchment (8 minutes over the street network): hilltop station vs flat station`);
for (const terrain of ['hills', 'coast'] as const) {
  const sim = new Sim(seed, { terrain });
  for (let m = 0; m < 48; m++) { sim.tick(); if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 }); }
  const R = sim.roads;
  const cand: { x: number; y: number; slope: number; h: number; deg: number }[] = [];
  for (let n = 0; n < R.nx.length; n++) {
    if (!R.adj[n].length) continue;
    const x = R.nx[n], y = R.ny[n], i = Math.floor(y) * N + Math.floor(x);
    if (sim.g.water[i]) continue;
    let near = 0; for (let m2 = 0; m2 < R.nx.length; m2++) if (R.adj[m2].length && Math.hypot(R.nx[m2] - x, R.ny[m2] - y) < 5) near++;
    if (near < 14) continue;
    let sl = 0, c = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) { sl += sim.slope[yy * N + xx]; c++; } }
    cand.push({ x, y, slope: sl / c, h: hAt(sim.g.height, x, y), deg: near });
  }
  if (cand.length < 4) { console.log(`   ${terrain}: not enough streets`); continue; }
  cand.sort((a, b) => b.slope - a.slope);
  const hill = cand[0];
  const flat = cand.filter((c) => c.deg >= hill.deg * 0.8).sort((a, b) => a.slope - b.slope)[0] ?? cand[cand.length - 1];
  const area = (st: { x: number; y: number }) => {
    const priv = sim as unknown as { computeWalkFields(u: { id: number; x: number; y: number; depth?: number }[]): void; walk: Float32Array[]; walkKey: string };
    priv.walkKey = '';
    priv.computeWalkFields([{ id: 1, x: st.x, y: st.y }]);
    const f = priv.walk[0];
    let cells = 0, built = 0;
    for (let i = 0; i < N * N; i++) if (f[i] <= 8) { cells++; if (sim.cBuilt[i] > 0) built += sim.cBuilt[i]; }
    return { cells, km2: cells * CELL * CELL / 1e6, built: Math.round(built) };
  };
  const ah = area(hill), af = area(flat);
  console.log(`   ${terrain}: hilltop (${hill.x.toFixed(0)},${hill.y.toFixed(0)}) slope ${(hill.slope * 100).toFixed(1)}% height ${hill.h.toFixed(0)} m: ${ah.km2.toFixed(2)} km2, ${ah.built} plots served;  flat (${flat.x.toFixed(0)},${flat.y.toFixed(0)}) slope ${(flat.slope * 100).toFixed(1)}%: ${af.km2.toFixed(2)} km2, ${af.built} plots served  (hilltop = ${(100 * ah.km2 / af.km2).toFixed(0)}% of flat)`);
}

// ------------------------------------------------------------------ 3. a ridge splits the city
console.log(`
== 3. ridge splits the city (hills terrain): line 1 inside the origin basin, with / without line 2 = a tunnel (or viaduct) line from the origin across the ridge into the second basin`);
console.log(`   line 2 is opened at month 24 together with line 1; numbers at month 36 and 60. 'far basin' = cells nearer the far village than the origin.`);
function scenario(sd: number, tunnel: boolean) {
  const sim = new Sim(sd, { terrain: 'hills' });
  const vs = sim.g.villages;
  const o = vs[0];
  // the village whose straight line from the origin climbs the most is in the other basin
  const climb = (v: { x: number; y: number }) => { let mx = -1e9; for (let t = 0; t <= 1; t += 0.05) mx = Math.max(mx, hAt(sim.g.height, o.x + (v.x - o.x) * t, o.y + (v.y - o.y) * t)); return mx - Math.max(hAt(sim.g.height, o.x, o.y), hAt(sim.g.height, v.x, v.y)); };
  const others = vs.slice(1).sort((a, b) => climb(a) - climb(b));
  const same = others[0], far = others[others.length - 1];
  const build = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ids: number[] = [];
    for (const p of line(sim, a, b)) {
      for (let r = 0; r < 4; r++) {
        let ok = false;
        for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r && !ok; dx++) {
          const ex = sim.metro.stations.find((s) => Math.hypot(s.x - (p.x + dx), s.y - (p.y + dy)) < 3);
          if (ex) { if (!ids.includes(ex.id)) { ids.push(ex.id); ok = true; } continue; }
          const before = sim.metro.stations.length;
          sim.apply({ type: 'placeStation', x: p.x + dx, y: p.y + dy });
          if (sim.metro.stations.length > before) { ids.push(sim.metro.stations[before].id); ok = true; }
        }
        if (ok) break;
      }
    }
    const n0 = sim.metro.lines.length;
    sim.apply({ type: 'buildLine', stations: ids });
    return sim.metro.lines.length > n0 ? sim.metro.lines[sim.metro.lines.length - 1] : null;
  };
  let l1: ReturnType<typeof build> = null, l2: ReturnType<typeof build> = null;
  const snap: { trips: number; pop: number; far: number; far_riders: number }[] = [];
  const farPop = () => { let p = 0; for (let i = 0; i < N * N; i++) { const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5; if (Math.hypot(x - far.x, y - far.y) < Math.hypot(x - o.x, y - o.y)) p += sim.cHomes[i] * 2.3; } return Math.round(p); };
  for (let m = 0; m < 60; m++) {
    if (m === 24) {
      sim.money = 2e9;
      l1 = build(o, same);
      if (tunnel) l2 = build(o, far);
    }
    sim.tick();
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
    if (m === 35 || m === 59) snap.push({ trips: Math.round(sim.transitTrips), pop: sim.stats().population, far: farPop(), far_riders: l2 ? Math.round(l2.riders) : 0 });
  }
  const d = (l: typeof l1) => l ? `${l.lengthKm.toFixed(1)} km (${l.by.map((k) => k.toFixed(1)).join('/')} km cc/bored/viaduct/water), deepest station ${Math.max(...l.stations.map((id, k) => hAt(sim.g.height, sim.metro.station(id)!.x, sim.metro.station(id)!.y) - l!.elev[k])).toFixed(0)} m` : 'not buildable';
  return { snap, l1: d(l1), l2: d(l2), built1: !!l1, built2: !!l2, spend: sim.buildSpend, climb: climb(far), cost2: l2 ? 0 : 0 };
}
let sum = { dt: 0, far0: 0, far1: 0, n: 0 };
for (const sd of [seed, 57, 83, 252, 369, 421, 11, 23]) {
  const a = scenario(sd, false), b = scenario(sd, true);
  if (!a.built1 || !b.built2) { console.log(`   seed ${sd}: skipped (line 1 ${a.built1 ? 'built' : 'not buildable'}, tunnel line ${b.built2 ? 'built' : 'not buildable (grade / depth limit)'})`); continue; }
  const f = (k: number) => `m${k === 0 ? 36 : 60}: trips/day ${a.snap[k].trips} -> ${b.snap[k].trips} (${(100 * (b.snap[k].trips - a.snap[k].trips) / Math.max(1, a.snap[k].trips)).toFixed(0)}%), far-basin population ${a.snap[k].far} -> ${b.snap[k].far}`;
  console.log(`   seed ${sd}: ridge climb ${b.climb.toFixed(0)} m; line 1 ${a.l1}; line 2 ${b.l2}; extra build cost ${M(b.spend - a.spend)}
      ${f(0)}
      ${f(1)}`);
  sum.dt += (b.snap[1].trips - a.snap[1].trips) / Math.max(1, a.snap[1].trips); sum.far0 += a.snap[1].far; sum.far1 += b.snap[1].far; sum.n++;
}
if (sum.n) console.log(`   mean over ${sum.n} seeds at month 60: mean change in transit trips/day ${(100 * sum.dt / sum.n).toFixed(0)}%, mean far-basin population ${Math.round(sum.far0 / sum.n)} -> ${Math.round(sum.far1 / sum.n)}`);
void Flag;
