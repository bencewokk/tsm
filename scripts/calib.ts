// Demand calibration: `npm run calib -- [seeds...] [--months=240] [--every=60]`
// A player-like network: the starter line (old town to its nearest village) at month 3 and a short, dense six-station line through the
// busiest part of the city at month 30 (about 360 m between stations, as in the user's late-game screenshot), more trains whenever a line is
// packed and the money allows. Prints population, trips, mode share, riders per line / per km / per station, zero-rider stations, and the
// height mix (to check whether inflated demand -> land value -> towers everywhere).
import { Sim } from '../src/sim/sim';
import { N, BT, CELL, PERSONS_PER_HOME, TRAIN_COST } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const opt = (k: string, d: number) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const months = opt('months', 240), every = opt('every', 60), l2month = opt('l2', 30), nLines = opt('lines', 2);
let seeds = args.filter((a) => !a.startsWith('--')).map(Number).filter((n) => n > 0);
if (!seeds.length) seeds = [4821];

import { build, starter, dense } from './calibLib';
const k1 = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));

for (const seed of seeds) {
  const sim = new Sim(seed);
  console.log(`\n== seed ${seed} (${sim.cp.terrain} / ${sim.cp.origin}); start money ${(sim.money / 1e6).toFixed(0)}M`);
  for (let m = 0; m < months; m++) {
    if (m === 3 && nLines >= 1) console.log(`  m3 line 1 (starter) ${build(sim, starter(sim)) ? 'built' : 'NOT built'}; money ${(sim.money / 1e6).toFixed(0)}M`);
    if (m === l2month && nLines >= 2) console.log(`  m${m} line 2 (dense 6 st) ${build(sim, dense(sim)) ? 'built' : 'NOT built'}; money ${(sim.money / 1e6).toFixed(0)}M`);
    if (nLines >= 2 && m > l2month && m % 6 === 0 && sim.metro.lines.length < 2) build(sim, dense(sim));
    // a player adds trains to a packed line when the money allows
    for (const l of sim.metro.lines) if (l.crowd > 0.95 && sim.money > TRAIN_COST * 3 && l.trains < 40) sim.apply({ type: 'setTrains', line: l.id, trains: l.trains + 1 });
    sim.tick();
    while (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
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
      console.log(`    heights (res+com buildings): <=10m ${hb[0]}, 11-16 ${hb[1]}, 17-24 ${hb[2]}, 25-36 ${hb[3]}, 37-60 ${hb[4]}, >60 ${hb[5]}; towers >36 m next to a detached house (<100 m): ${tallNearDetached}/${tall}`);
    }
  }
  void CELL; void PERSONS_PER_HOME;
}
