// Demand calibration: `npm run calib -- [seeds...] [--months=240] [--every=60]`
// A player-like network: the starter line (old town to its nearest village) at month 3 and a short, dense six-station line through the
// busiest part of the city at month 30 (about 360 m between stations, as in the user's late-game screenshot), more trains whenever a line is
// packed and the money allows. Prints population, trips, mode share, riders per line / per km / per station, zero-rider stations, and the
// height mix (to check whether inflated demand -> land value -> towers everywhere).
// Envelopes (round 7 step 2): `--noenv` turns them off (before); `--plans=M` makes the player submit a station area plan for the two busiest
// stations of the dense line at month M (and a CBD edge plan for the busiest station near the core), taking the park when the council
// offers conditions. Each checkpoint prints the height mix by distance from the centre and by walk to a station, and towers per envelope.
import { Sim } from '../src/sim/sim';
import { ENVS, ENV_DEF, ENV } from '../src/sim/envelopes';
import { TRAFFIC } from '../src/sim/traffic';
import { N, BT, CELL, PERSONS_PER_HOME, TRAIN_COST } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const months = opt('months', 240), every = opt('every', 60), l2month = opt('l2', 30), nLines = opt('lines', 2), plansAt = opt('plans', -1);
if (args.includes('--noenv')) ENVS.on = false;
if (args.includes('--notraffic')) TRAFFIC.on = false;
let seeds = args.filter((a) => !a.startsWith('--')).map(Number).filter((n) => n > 0);
if (!seeds.length) seeds = [4821];

import { build, starter, dense } from './calibLib';
const k1 = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));

for (const seed of seeds) {
  const sim = new Sim(seed);
  const firstTower = new Map<number, number>();
  console.log(`\n== seed ${seed} (${sim.cp.terrain} / ${sim.cp.origin}); start money ${(sim.money / 1e6).toFixed(0)}M`);
  for (let m = 0; m < months; m++) {
    if (m === 3 && nLines >= 1) console.log(`  m3 line 1 (starter) ${build(sim, starter(sim)) ? 'built' : 'NOT built'}; money ${(sim.money / 1e6).toFixed(0)}M`);
    if (m === l2month && nLines >= 2) console.log(`  m${m} line 2 (dense 6 st) ${build(sim, dense(sim)) ? 'built' : 'NOT built'}; money ${(sim.money / 1e6).toFixed(0)}M`);
    if (nLines >= 2 && m > l2month && m % 6 === 0 && sim.metro.lines.length < 2) build(sim, dense(sim));
    // a player adds trains to a packed line when the money allows
    for (const l of sim.metro.lines) if (l.crowd > 0.95 && sim.money > TRAIN_COST * 3 && l.trains < 40) sim.apply({ type: 'setTrains', line: l.id, trains: l.trains + 1 });
    if (m === plansAt && sim.metro.lines.length >= 2) {
      const l2 = sim.metro.lines[1];
      const sts = l2.stations.map((id) => sim.metro.station(id)!).sort((a, b) => b.riders - a.riders);
      for (const st of sts.slice(0, 2)) { sim.apply({ type: 'proposePlan', station: st.id, kind: 'station' }); console.log(`  m${m} station area plan for ${st.name}: ${sim.log[sim.log.length - 1]}`); }
      const main = sim.field.main;
      const near = sim.metro.stations.filter((st) => sim.metro.onLine(st.id)).sort((a, b) => Math.hypot(a.x - main.x, a.y - main.y) - Math.hypot(b.x - main.x, b.y - main.y))[0];
      if (near) { sim.apply({ type: 'proposePlan', station: near.id, kind: 'cbd' }); console.log(`  m${m} CBD edge plan for ${near.name}: ${sim.log[sim.log.length - 1]}`); }
    }
    sim.tick();
    // months from a plan's approval to the first finished 36 m+ tower inside it (the "towers are slow" number)
    if (ENVS.on) for (const p of sim.envs.plans) {
      if (p.state !== 'approved' || firstTower.has(p.id)) continue;
      const set = new Set(p.cells);
      if (sim.lots.lots.some((l) => l.alive && set.has(l.cell) && l.level === 3 && !l.constr && l.hgt >= 36 && l.built >= p.decided && ENV_DEF[sim.envs.prior[l.cell]].maxH > 0 && ENV_DEF[sim.envs.prior[l.cell]].maxH < 36)) { firstTower.set(p.id, sim.month - p.decided); console.log(`  m${sim.month} first 36 m+ tower the plan made possible (zoning there allowed under 36 m before) in the ${p.name} plan, ${sim.month - p.decided} months after approval`); }
    }
    while (sim.pending) { const ev = sim.eventInfo()!; const want = ev.id.startsWith('plan_') ? 1 : 0; sim.apply({ type: 'choose', event: ev.id, choice: ev.choices[want].ok === false ? Math.max(0, ev.choices.findIndex((c) => c.ok !== false)) : want }); }
    if (sim.month % every === 0 || sim.month === months) {
      const s = sim.stats();
      const pop = s.population;
      console.log(`  m${sim.month}: pop ${k1(pop)} (households ${k1(s.homes)}, jobs ${k1(s.jobs)}), trips/day ${k1(sim.totalTrips)} (${(sim.totalTrips / Math.max(1, pop)).toFixed(2)} per resident), transit ${k1(sim.transitTrips)} = ${(s.transitShare * 100).toFixed(1)}% share, money ${(s.money / 1e6).toFixed(0)}M inc ${(s.income / 1e6).toFixed(2)}M/mo exp ${(s.expenses / 1e6).toFixed(2)}M/mo`);
      { const mt = sim.modeTrips, T = Math.max(1, sim.totalTrips); console.log(`    mode split (all trips): car ${(mt.car / T * 100).toFixed(0)}%, metro ${(mt.transit / T * 100).toFixed(1)}%, walk ${(mt.walk / T * 100).toFixed(0)}%, bike ${(mt.bike / T * 100).toFixed(0)}%; congestion ${s.congestion.toFixed(2)}, drive speed ${s.driveSpeed.toFixed(0)} km/h, rating ${s.rating.toFixed(0)}; metro boardings per resident ${(sim.metro.lines.reduce((t, l) => t + l.riders, 0) / Math.max(1, pop)).toFixed(3)}`); }
      for (const l of sim.metro.lines) {
        const sts = l.stations.map((id) => sim.metro.station(id)!);
        console.log(`    line ${l.id}: ${sts.length} st ${l.lengthKm.toFixed(1)} km, boardings/day ${k1(l.riders)} (${k1(l.riders / Math.max(0.1, l.lengthKm))}/km), trains ${l.trains} hw ${l.headway.toFixed(1)} min, peak ${Math.round(l.peakLoad)}/h of cap ${Math.round(l.capacity)}/h (${Math.round(l.crowd * 100)}%), rating ${l.rating.toFixed(0)}; stations ${sts.map((st) => `${st.name} ${k1(st.riders)}`).join(', ')}`);
      }
      const zero = sim.metro.stations.filter((st) => sim.metro.onLine(st.id) && st.riders < 50);
      if (zero.length) console.log(`    stations under 50 riders: ${zero.map((st) => st.name).join(', ')}`);
      // heights
      const hb = [0, 0, 0, 0, 0, 0]; // <=10, <=16, <=24, <=36, <=60, >60
      let tall = 0, tallNearDetached = 0;
      for (const l of sim.lots.lots) {
        if (!l.alive || !l.type || l.level <= 0 || (l.type !== BT.Res && l.type !== BT.Com)) continue;
        const h = l.level === 1 ? 7 : l.hgt || 12;
        hb[h <= 10 ? 0 : h <= 16 ? 1 : h <= 24 ? 2 : h <= 36 ? 3 : h <= 60 ? 4 : 5]++;
        if (h > 36) {
          tall++;
          // a detached house (level 1 res) within 2 cells: the "tower next to a house" problem
          const near = sim.lots.lots.some((o) => o.alive && o.type === BT.Res && o.level === 1 && Math.hypot(o.x - l.x, o.y - l.y) < 2);
          if (near) tallNearDetached++;
        }
      }
      if (ENVS.on && sim.envs.plans.length) console.log(`    plans: ${sim.envs.plans.map((p) => `${p.kind} ${p.name} ${p.state}${p.cap ? ` cap ${p.cap} m` : ''}${p.park ? ' +park' : ''} (score ${p.score.toFixed(2)}: ${p.why}) paid ${(p.paid / 1e6).toFixed(1)}M`).join('; ')}`);
      {
        // height mix by distance from the centre and by walk to the nearest station; towers per envelope type
        const bandsD = [0, 8, 16, 24, 32, 99], bandsW = [0, 4, 8, 12, 99];
        const byD = bandsD.slice(1).map(() => ({ n: 0, h: 0, t: 0 })), byW = bandsW.slice(1).map(() => ({ n: 0, h: 0, t: 0 }));
        const perEnv = ENV_DEF.map(() => ({ n: 0, t: 0, t60: 0 }));
        const c = sim.field.main;
        for (const l of sim.lots.lots) {
          if (!l.alive || !l.type || l.level <= 0 || (l.type !== BT.Res && l.type !== BT.Com)) continue;
          const h = l.level === 1 ? 7 : l.hgt || 12;
          const d = Math.hypot(l.x - c.x, l.y - c.y), w = sim.walkToStation(l.cell);
          const kd = bandsD.findIndex((b, j) => j > 0 && d < b) - 1, kw = bandsW.findIndex((b, j) => j > 0 && w < b) - 1;
          for (const [arr, k] of [[byD, kd], [byW, kw]] as const) { if (k >= 0) { arr[k].n++; arr[k].h += h; if (h > 36) arr[k].t++; } }
          const e = perEnv[sim.envs.env[l.cell]]; e.n++; if (h > 36) e.t++; if (h >= 60) e.t60++;
        }
        const fmtB = (arr: { n: number; h: number; t: number }[], bands: number[], u: string) => arr.map((b, j) => `${bands[j]}-${bands[j + 1] === 99 ? '' : bands[j + 1]}${u} mean ${(b.h / Math.max(1, b.n)).toFixed(1)} m, ${b.t} >36 m of ${b.n}`).join(' | ');
        console.log(`    by distance from the centre (cells): ${fmtB(byD, bandsD, '')}`);
        console.log(`    by walk to a station (min): ${fmtB(byW, bandsW, '')}`);
        console.log(`    towers >36 m (>=60 m) per envelope: ${perEnv.map((e, j) => e.n ? `${ENV_DEF[j].id} ${e.t} (${e.t60}) of ${e.n}` : '').filter(Boolean).join(', ')}; value capture this month ${(sim.envs.capture / 1e6).toFixed(2)}M`);
      }
      console.log(`    heights (res+com buildings): <=10m ${hb[0]}, 11-16 ${hb[1]}, 17-24 ${hb[2]}, 25-36 ${hb[3]}, 37-60 ${hb[4]}, >60 ${hb[5]}; towers >36 m next to a detached house (<100 m): ${tallNearDetached}/${tall}`);
    }
  }
  console.log(`  goals: ${Object.entries(sim.goals.done).sort((x, y) => x[1] - y[1]).map(([id, mo]) => `${id}@m${mo}`).join(", ")}`);
  void CELL; void PERSONS_PER_HOME;
}
