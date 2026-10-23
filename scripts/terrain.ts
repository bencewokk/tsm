// Terrain survey: `npm run terrain -- [seed ...] [--map]` prints per terrain type landform stats and (with --map) an ASCII relief map.
// Seeds are forced onto each terrain kind so every type can be compared.
import { Sim } from '../src/sim/sim';
import { N, Flag } from '../src/sim/constants';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const map = args.includes('--map');
const seeds = args.filter((a) => !a.startsWith('--')).map(Number);
if (!seeds.length) seeds.push(4821, 187);

for (const seed of seeds) {
  for (const terrain of ['coast', 'river', 'hills', 'plain'] as const) {
    const sim = new Sim(seed, { terrain });
    const g = sim.g;
    let land = 0, steep = 0, flood = 0, hi = -1e9;
    for (let i = 0; i < N * N; i++) {
      if (g.water[i]) continue;
      land++;
      if (g.flags[i] & Flag.Steep) steep++;
      if (g.flags[i] & Flag.Flood) flood++;
      hi = Math.max(hi, g.height[i]);
    }
    console.log(`seed ${seed} ${terrain}/${sim.cp.origin}: land ${land}  steep ${(100 * steep / land).toFixed(0)}%  floodplain ${(100 * flood / land).toFixed(0)}%  highest ${hi.toFixed(0)} m  ridges ${g.landforms.ridges.length} passes ${g.landforms.passes.map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`).join(' ')}  castle ${g.landforms.castle ? `${g.landforms.castle.x},${g.landforms.castle.y}` : '-'}  villages ${g.villages.map((v) => `${v.x},${v.y}`).join(' ')}  docks cells ${g.docksCells.length}`);
    if (map) {
      const ramp = ' .:-=+*#%@';
      for (let y = 0; y < N; y += 3) {
        let row = '';
        for (let x = 0; x < N; x += 2) {
          const i = y * N + x;
          if (g.water[i]) { row += '~'; continue; }
          if (g.villages.some((v) => Math.abs(v.x - x) < 2 && Math.abs(v.y - y) < 2)) { row += 'V'; continue; }
          if (g.flags[i] & Flag.Flood) { row += ','; continue; }
          row += ramp[Math.max(0, Math.min(9, Math.floor(g.height[i] / 15)))];
        }
        console.log(row);
      }
    }
  }
}
