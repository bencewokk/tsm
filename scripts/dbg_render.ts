import { Sim } from '../src/sim/sim';
import { CELL, BT, Flag } from '../src/sim/constants';
import { MB, Quad, type Pt } from '../src/render/poly';
import { designLot, massing, pad } from '../src/render/buildings';
import { kindOf, type Kind } from '../src/render/forms';
import { vhash } from '../src/render/common';

declare const process: { argv: string[] };
const sim = new Sim(4821);
const target = Number(process.argv[2] ?? 48);
for (let m = 0; m < target; m++) {
  sim.tick();
  if (sim.pending) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: ev.id === 'docks_bought' ? 1 : 0 }); }
  if (m === 19) {
    const vs = sim.g.villages.slice().sort((a, b) => a.y - b.y);
    const ids: number[] = [];
    for (const v of vs) { const before = sim.metro.stations.length; sim.apply({ type: 'placeStation', x: v.x, y: v.y }); if (sim.metro.stations.length > before) ids.push(sim.metro.stations[before].id); }
    sim.apply({ type: 'buildLine', stations: ids });
  }
}
const L = sim.lotsMsg();
console.log('month', sim.month, 'lots', L.n);
let worst = 0, bad = 0, tri = 0;
for (let k = 0; k < L.n; k++) {
  const o = k * 8;
  const P = (i: number): Pt => [L.poly[o + i * 2] * CELL, L.poly[o + i * 2 + 1] * CELL];
  const Q = new Quad(P(0), P(1), P(2), P(3));
  if (!isFinite(Q.W) || !isFinite(Q.D) || Q.W > 300 || Q.D > 300 || Q.W < 3) { bad++; console.log('bad quad', k, Q.W, Q.D); continue; }
  let kind: Kind = kindOf(L.type[k], L.level[k] || L.target[k], L.flags[k]);
  if (kind === 'none') kind = 'yard';
  const mb = new MB();
  const seed = L.seed[k];
  const t0 = performance.now();
  const trees: any[] = [];
  const c: any = { mb, Q, id: L.id[k], seed, g: 5, kind, level: L.level[k] || L.target[k], dens: L.dens[k], sides: L.sides[k], back: L.back[k], isCom: L.type[k] === BT.Com, flags: L.flags[k], era: Math.min(1, L.built[k] / 96), lv: 0.5, trees, r: (j: number) => vhash(seed >>> 3, j) };
  designLot(c);
  massing(c);
  const dt = performance.now() - t0;
  if (dt > worst) { worst = dt; }
  if (dt > 20) console.log('slow lot', k, kind, dt.toFixed(1), Q.W.toFixed(1), Q.D.toFixed(1));
  for (const m of ['wall', 'glass', 'plain', 'lamp'] as const) tri += mb.acc[m].pos.length / 9;
}
console.log('worst ms', worst.toFixed(2), 'bad', bad, 'tris', tri);
