// Headless sim runner: `npm run headless -- [seed] [months] [--map] [--line]`
// Prints yearly stats; with --map draws an ASCII map; with --line builds a test metro line at month 6.
import { Sim } from '../src/sim/sim';
import { N, BT } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const flags = new Set(args.filter((a: string) => a.startsWith('--')));
const nums = args.filter((a: string) => !a.startsWith('--')).map(Number);
const seed = nums[0] ?? 4821;
const months = nums[1] ?? 60;
const deal = nums[2] ?? 0;

function ascii(sim: Sim) {
  const g = sim.g;
  const cellCh = new Array(N * N).fill('');
  for (const l of sim.lots.lots) {
    if (!l.alive) continue;
    let ch = l.type === BT.Res ? String(l.level) : l.type === BT.Com ? ('cCO'[l.level - 1] ?? 'c') : l.type === BT.Ind ? 'I' : l.type === BT.Park ? 'p' : (l.flags & 4 ? 'g' : '');
    if (ch && (!cellCh[l.cell] || ch > cellCh[l.cell])) cellCh[l.cell] = ch;
  }
  const rows: string[] = [];
  for (let y = 0; y < N; y += 2) {
    let r = '';
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let ch = '.';
      if (g.water[i] === 1) ch = '~';
      else if (g.water[i] === 2) ch = '=';
      else if (cellCh[i]) ch = cellCh[i];
      else if (g.road[i]) ch = '#';
      else if (g.flags[i] & 8) ch = '^';
      for (const s of sim.metro.stations) if (Math.floor(s.x) === x && (Math.floor(s.y) === y || Math.floor(s.y) === y + 1)) ch = '@';
      r += ch;
    }
    rows.push(r);
  }
  console.log(rows.join(String.fromCharCode(10)));
}

const lineMonth = 24;
/** Build a line through the villages with stations every ~14 cells. */
function testLine(sim: Sim) {
  const vs = sim.g.villages.slice().sort((a, b) => a.y - b.y);
  const pts: [number, number][] = [];
  for (let k = 0; k < vs.length; k++) {
    if (k > 0) {
      const a = vs[k - 1], b = vs[k];
      const n = Math.floor(Math.hypot(a.x - b.x, a.y - b.y) / 14);
      for (let j = 1; j < n; j++) pts.push([Math.round(a.x + (b.x - a.x) * j / n), Math.round(a.y + (b.y - a.y) * j / n)]);
    }
    pts.push([vs[k].x, vs[k].y]);
  }
  const ids: number[] = [];
  for (const [x, y] of pts) {
    let ok = false;
    for (let r = 0; r < 4 && !ok; r++) for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r && !ok; dx++) {
      const before = sim.metro.stations.length;
      sim.apply({ type: 'placeStation', x: x + dx, y: y + dy });
      if (sim.metro.stations.length > before) { ids.push(sim.metro.stations[before].id); ok = true; }
    }
  }
  sim.apply({ type: 'buildLine', stations: ids });
  console.log('built line', ids.length, 'stations', sim.metro.lines.map((l) => `${l.lengthKm.toFixed(1)}km trains ${l.trains} hw ${l.headway.toFixed(1)}`).join(','), 'money', (sim.money / 1e6).toFixed(0));
}

function nearStats(sim: Sim) {
  const cnt = [0, 0, 0, 0];
  let nearLV = 0, nN = 0, farLV = 0, nF = 0;
  for (const l of sim.lots.lots) {
    if (!l.alive || !l.type) continue;
    const near = sim.walkToStation(l.cell) <= 8;
    if (near) { nearLV += sim.lv[l.cell]; nN++; if (l.type === BT.Res) cnt[l.level]++; } else { farLV += sim.lv[l.cell]; nF++; }
  }
  console.log(`within 8 min walk of stations: ${nN} bld, avg LV ${(nearLV / Math.max(1, nN)).toFixed(2)}, res levels ${cnt.join('/')}; elsewhere avg LV ${(farLV / Math.max(1, nF)).toFixed(2)}`);
}

function run(withLine: boolean) {
  const sim = new Sim(seed);
  const t0 = Date.now();
  for (let m = 0; m < months; m++) {
    if (withLine && m === lineMonth) testLine(sim);
    sim.tick();
    if (sim.pending) {
      const ev = sim.eventInfo()!;
      const pick = ev.id === 'docks_bought' ? deal : 0;
      console.log(`[event m${sim.month}] ${ev.title} -> ${ev.choices[pick].label}
   ${ev.text.replace(/<[^>]+>/g, ' ').slice(0, 300)}`);
      sim.apply({ type: 'choose', event: ev.id, choice: pick });
    }
    if (sim.docks.state !== 'none' && m % 6 === 0) { const d = sim.docksInfo(); console.log(`   docks m${sim.month}: planned ${d.planned} served ${d.served} built ${d.built} carLocked ${d.carLocked}`); }
    if ((m + 1) % 12 === 0 || m === months - 1) {
      const s = sim.stats();
      console.log(`m${String(s.month).padStart(3)} pop ${String(Math.round(s.population)).padStart(7)} homes ${s.homes} jobs ${s.jobs} bld ${s.buildings} $${(s.money / 1e6).toFixed(1)}M inc ${(s.income / 1e6).toFixed(2)} exp ${(s.expenses / 1e6).toFixed(2)} cong ${s.congestion.toFixed(2)} spd ${s.driveSpeed.toFixed(0)} share ${(s.transitShare * 100).toFixed(1)}% R ${s.resDemand.toFixed(2)} C ${s.comDemand.toFixed(2)}`);
    }
  }
  const lc = [0, 0, 0, 0];
  for (const l of sim.lots.lots) if (l.alive && l.type === BT.Res) lc[l.level]++;
  const R = sim.roads, cls = [0, 0, 0];
  for (const e of R.aliveEdges()) cls[R.ecls[e]]++;
  console.log(`res levels ${lc.join('/')}; lots ${sim.lots.lots.filter((l) => l.alive).length}; road nodes ${R.nx.length} edges ${R.aliveEdges().length} (art/col/loc ${cls.join('/')})`);
  if (withLine) { nearStats(sim); for (const l of sim.metro.lines) console.log(`line ${l.id}: riders/day ${Math.round(l.riders)} peak ${Math.round(l.peakLoad)}/h cap ${Math.round(l.capacity)}/h rating ${l.rating.toFixed(0)}`); }
  console.log(`ran ${months} months in ${Date.now() - t0} ms`);
  return sim;
}

const sim = run(flags.has('--line'));
if (flags.has('--map')) ascii(sim);
console.log('villages', sim.g.villages.map((v) => `${v.name}@${v.x},${v.y}`).join(' '), 'docks cells', sim.g.docksCells.length);
