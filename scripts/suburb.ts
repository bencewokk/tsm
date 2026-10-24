// Garden suburb with and without a station on its safeguarded site: `npm run suburb` (seeds 23, 7, 187, 57; homes within 9 cells at month 96)
import { Sim } from '../src/sim/sim';
import { SAT } from '../src/sim/terrain';
for (const seed of [23, 7, 187, 57]) for (const mode of ['no line', 'stub', 'stub, no satellite rules']) {
  SAT.on = true;
  const sim = new Sim(seed);
  const site = sim.stationSites[0]; if (!site) continue;
  let note = '';
  for (let m = 0; m < 96; m++) {
    if (mode !== 'no line' && m === 24) {
      // the suburb's station on its safeguarded site, joined to the nearest other settlement's centre
      const o = sim.g.villages.filter((v) => v.cause !== 'commuter').sort((a, b) => Math.hypot(a.x - site.x, a.y - site.y) - Math.hypot(b.x - site.x, b.y - site.y))[0];
      const ids: number[] = []; const m0 = sim.money;
      for (const [x, y] of [[Math.floor(site.x), Math.floor(site.y)], [o.x, o.y]]) for (let r = 0; r < 3; r++) { const b = sim.metro.stations.length; sim.apply({ type: 'placeStation', x: x + r, y }); if (sim.metro.stations.length > b) { ids.push(sim.metro.stations[b].id); break; } }
      if (ids.length === 2) sim.apply({ type: 'buildLine', stations: ids });
      note = `lines ${sim.metro.lines.length}, spent ${((m0 - sim.money) / 1e6).toFixed(1)}M, ${sim.log.slice(-1)[0]}`;
      if (mode.includes('no satellite')) SAT.on = false;
    }
    sim.tick(); while (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 }); }
  let homes = 0; for (const l of sim.lots.near(site.x, site.y, 9)) if (l.alive) homes += sim.lotHomes(l);
  console.log(seed, site.name, mode.padEnd(24), 'homes within 9 cells at m96', homes, note);
}
SAT.on = true;
