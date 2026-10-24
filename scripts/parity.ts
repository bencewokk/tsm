// Render parity check for the incremental city rebuild: `npm run parity -- [seed] [months] [every]`
// Applies every monthly snapshot to one long-lived CityView (incremental: per-plot geometry reuse, cached trees), and every
// `every` months builds a fresh CityView from the same message (everything designed from scratch) and compares the merged chunk
// geometry and the tree / crane instance buffers value by value. Any difference is printed; exit code 1 on mismatch.
import { Sim } from '../src/sim/sim';
import { N, CELL } from '../src/sim/constants';
import { CityView } from '../src/render/city';
import { VS } from '../src/render/common';
import { testLine } from './lib';
import type * as THREE from 'three';

declare const process: { argv: string[]; exitCode: number };
const nums = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--budget').map(Number);
const seed = nums[0] ?? 4821, months = nums[1] ?? 72, every = nums[2] ?? 12;

const sim = new Sim(seed);
const init = sim.initMsg();
const V = N + 1, vh = new Float32Array(V * V), h = init.height;
for (let vy = 0; vy < V; vy++) for (let vx = 0; vx < V; vx++) {
  let s = 0, c = 0;
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) { const x = vx + dx, y = vy + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue; s += h[y * N + x]; c++; }
  vh[vy * V + vx] = (s / c) * VS;
}
const sample = (x: number, z: number) => {
  const fx = Math.max(0, Math.min(N - 0.001, x / CELL)), fz = Math.max(0, Math.min(N - 0.001, z / CELL));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  return (vh[iz * V + ix] * (1 - tx) + vh[iz * V + ix + 1] * tx) * (1 - tz) + (vh[(iz + 1) * V + ix] * (1 - tx) + vh[(iz + 1) * V + ix + 1] * tx) * tz;
};
const make = () => new CityView(init.water, init.flags, init.villages, sample, init);

type Any = Record<string, unknown>;
function compare(a: CityView, b: CityView, month: number): number {
  let bad = 0;
  const ca = (a as unknown as Any).chunks as Map<number, { geos: (THREE.BufferGeometry | null)[] }>;
  const cb = (b as unknown as Any).chunks as Map<number, { geos: (THREE.BufferGeometry | null)[] }>;
  if (ca.size !== cb.size) { console.log(`m${month}: chunk count ${ca.size} vs ${cb.size}`); bad++; }
  for (const [key, x] of ca) {
    const y = cb.get(key);
    if (!y) { console.log(`m${month}: chunk ${key} missing in fresh view`); bad++; continue; }
    for (let mi = 0; mi < Math.max(x.geos.length, y.geos.length); mi++) {
      const gx = x.geos[mi], gy = y.geos[mi];
      if (!gx && !gy) continue;
      if (!gx || !gy) { console.log(`m${month}: chunk ${key} material ${mi} present in one view only`); bad++; continue; }
      for (const name of ['position', 'normal', 'color', 'aH', 'aSeed']) {
        const ax = gx.getAttribute(name).array, ay = gy.getAttribute(name).array;
        if (ax.length !== ay.length) { console.log(`m${month}: chunk ${key} mat ${mi} ${name} length ${ax.length} vs ${ay.length}`); bad++; continue; }
        for (let i = 0; i < ax.length; i++) if (ax[i] !== ay[i]) { console.log(`m${month}: chunk ${key} mat ${mi} ${name}[${i}] ${ax[i]} vs ${ay[i]}`); bad++; break; }
      }
    }
  }
  const instA: THREE.InstancedMesh[] = [], instB: THREE.InstancedMesh[] = [];
  a.group.children.forEach((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) instA.push(o as THREE.InstancedMesh); });
  b.group.children.forEach((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) instB.push(o as THREE.InstancedMesh); });
  instA.forEach((ia, j) => {
    const ib = instB[j];
    if (ia.count !== ib.count) { console.log(`m${month}: instanced layer ${j} count ${ia.count} vs ${ib.count}`); bad++; return; }
    // instance order follows Map iteration order (chunks, sites, grows), which differs between a long-lived and a fresh view
    // in the old code too and has no visual effect: compare the instances as a sorted set of (matrix, colour) rows
    const rows = (im: THREE.InstancedMesh) => {
      const out: string[] = [], m = im.instanceMatrix.array, c = im.instanceColor?.array;
      for (let i = 0; i < im.count; i++) {
        const r: number[] = [];
        for (let q = 0; q < 16; q++) r.push(Math.round(m[i * 16 + q] * 1e3));
        if (c) for (let q = 0; q < 3; q++) r.push(Math.round(c[i * 3 + q] * 1e4));
        out.push(r.join(','));
      }
      return out.sort();
    };
    const ra = rows(ia), rb = rows(ib);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) { console.log(`m${month}: instanced layer ${j} row ${i}: ${ra[i]} vs ${rb[i]}`); bad++; break; }
  });
  return bad;
}

const live = make();
let bad = 0, checks = 0, maxFrames = 0;
/** --budget ms: apply each message in time-sliced steps (as the browser does) before comparing */
const bi = process.argv.indexOf('--budget'), budget = bi >= 0 ? Number(process.argv[bi + 1]) : Infinity;
for (let m = 0; m < months; m++) {
  if (m === 6) testLine(sim);
  sim.tick();
  if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
  const msg = sim.snapshot();
  live.update(msg, budget);
  let frames = 0;
  while (live.pending) { live.pump(budget); frames++; }
  maxFrames = Math.max(maxFrames, frames);
  if (sim.month % every === 0) {
    const fresh = make();
    fresh.update(msg);
    const b = compare(live, fresh, sim.month);
    bad += b; checks++;
    console.log(`m${sim.month}: ${b ? `${b} differences` : 'identical'} (slices up to ${maxFrames + 1}, designed ${live.stats.lotsDesigned}, reused ${live.stats.lotsReused}, tree rebuilds ${live.stats.treeRebuilds})`);
  }
}
console.log(bad ? `PARITY FAILED: ${bad} differences in ${checks} checks` : `parity ok: ${checks} checks identical`);
if (bad) process.exitCode = 1;
