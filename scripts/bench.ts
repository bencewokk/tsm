// Performance benchmark: `npm run bench -- [--months 12,60,120,240] [--seeds 4821,187,304] [--noline|--lineonly] [--render] [--json out.json]`
// Times every sim tick by phase (wrapping the Sim's methods on the instance, so sim code is untouched), the worker snapshot and its
// structured-clone payload (v8.serialize is the same wire format postMessage uses), and with --render the main-thread CityView.update
// in headless three.js (geometry build only, no GPU). At each checkpoint month it prints the mean over the last WINDOW ticks.
// node built-ins without @types/node in the project
const nodeMod = (n: string): Promise<any> => import(n);   // eslint-disable-line @typescript-eslint/no-explicit-any
const v8 = await nodeMod('node:v8') as { serialize(v: unknown): { length: number }; deserialize(b: unknown): unknown };
const { writeFileSync } = await nodeMod('node:fs') as { writeFileSync(p: string, d: string): void };
import { Sim } from '../src/sim/sim';
import { N, CELL } from '../src/sim/constants';
import { testLine } from './lib';
import type { StateMsg } from '../src/sim/protocol';

declare const process: { argv: string[]; memoryUsage(): { heapUsed: number; rss: number; arrayBuffers: number }; exit(n: number): void };
declare const global: { gc?: () => void };

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const marks = opt('--months', '12,60,120,240').split(',').map(Number);
const seeds = opt('--seeds', '4821,187,304').split(',').map(Number);
const withRender = args.includes('--render') || args.includes('--ab');
/** --ab: also feed every message to a reference CityView loaded from src/render/city_base.ts (the pre-change code extracted from git,
 *  not committed) and time both in the same process, alternating which goes first (fair A/B on a noisy machine). */
const ab = args.includes('--ab');
const modes: boolean[] = args.includes('--noline') ? [false] : args.includes('--lineonly') ? [true] : [false, true];
const jsonOut = opt('--json', '');
const WINDOW = 6;   // ticks averaged at each checkpoint
const LINE_MONTH = 6;

/** Phases timed exclusively (a nested phase's time is not counted in its parent). */
const SIM_PHASES = ['progressConstruction', 'aggregate', 'computeCongestion', 'computeDriveTimes', 'computeTransit', 'computeWalkFields', 'computeRiders',
  'computeLandValue', 'grow', 'resubdivide', 'docksTick', 'extendRoads', 'upgradeRoads', 'finance', 'checkEvents'] as const;
/** Report groups (the task's phase names). */
const GROUPS: Record<string, string[]> = {
  construction: ['progressConstruction'],
  assemblies: ['asm.tick', 'lm.tick', 'docksTick'],
  aggregate: ['aggregate', 'computeLandValue', 'field.update'],
  traffic: ['computeCongestion', 'computeDriveTimes'],
  catchments: ['computeWalkFields', 'computeTransit'],
  trips: ['computeRiders'],
  growth: ['grow', 'resubdivide'],
  roads: ['extendRoads', 'upgradeRoads'],
  events: ['checkEvents', 'finance'],
};

type Rec = Record<string, number>;

function wrapper(acc: Rec) {
  const stack: number[] = [];
  return (obj: Record<string, unknown>, name: string, label: string) => {
    const fn = obj[name] as (...a: unknown[]) => unknown;
    if (typeof fn !== 'function') throw new Error(`no method ${label}`);
    obj[name] = function (this: unknown, ...a: unknown[]) {
      const t0 = performance.now();
      stack.push(0);
      try { return fn.apply(this, a); } finally {
        const dt = performance.now() - t0, inner = stack.pop()!;
        acc[label] = (acc[label] ?? 0) + dt - inner;
        if (stack.length) stack[stack.length - 1] += dt;
      }
    };
  };
}

function instrument(sim: Sim, acc: Rec) {
  const wrap = wrapper(acc);
  const s = sim as unknown as Record<string, unknown>;
  for (const p of SIM_PHASES) wrap(s, p, p);
  wrap(sim.asm as unknown as Record<string, unknown>, 'tick', 'asm.tick');
  wrap(sim.lm as unknown as Record<string, unknown>, 'tick', 'lm.tick');
  wrap(sim.field as unknown as Record<string, unknown>, 'update', 'field.update');
}

/** CityView.update steps timed with --render. */
const RENDER_PHASES = ['rebuildRoads', 'buildChunk', 'designInto', 'rebuildGrows', 'rebuildSites', 'rebuildTrees', 'stampLots', 'wildTrees', 'treeAt', 'animate'];

// ---------------------------------------------------------------- headless render apply (three.js geometry only)
type CityViewT = import('../src/render/city').CityView;
async function makeCity(sim: Sim, modPath = '../src/render/city'): Promise<{ city: CityViewT; life: import('../src/render/life').Life }> {
  const { CityView } = await import(modPath) as typeof import('../src/render/city');
  const { Life } = await import('../src/render/life');
  const { VS } = await import('../src/render/common');
  const init = sim.initMsg();
  // the terrain view's height lookup: bilinear on the vertex grid (cell heights averaged at the corners), as in render/terrain.ts
  const V = N + 1, vh = new Float32Array(V * V), h = init.height;
  for (let vy = 0; vy < V; vy++) for (let vx = 0; vx < V; vx++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) { const x = vx + dx, y = vy + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue; s += h[y * N + x]; c++; }
    vh[vy * V + vx] = (s / c) * VS;
  }
  const sample = (x: number, z: number) => {
    const fx = Math.max(0, Math.min(N - 0.001, x / CELL)), fz = Math.max(0, Math.min(N - 0.001, z / CELL));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = vh[iz * V + ix], b = vh[iz * V + ix + 1], cc = vh[(iz + 1) * V + ix], d = vh[(iz + 1) * V + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
  };
  return { city: new CityView(init.water, init.flags, init.villages, sample, init), life: new Life(sample, init.water) };
}

/** Triangle count of everything the CityView holds (merged chunks, grows, sites, instanced layers). */
function cityTris(city: CityViewT) {
  let tris = 0, meshes = 0, inst = 0;
  city.group.traverse((o) => {
    const m = o as import('three').Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry, n = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    const im = o as import('three').InstancedMesh;
    if (im.isInstancedMesh) { tris += n * im.count; inst += im.count; } else tris += n;
    meshes++;
  });
  return { tris, meshes, inst };
}

// ---------------------------------------------------------------- run
interface Row { seed: number; line: boolean; month: number; tick: number; phases: Rec; rphases: Rec; applyBase: number; bufMB: number; snap: number; clone: number; bytes: number; apply: number; heapMB: number; tris: number; meshes: number; chunksBuilt: number; pop: number; lots: number; edges: number; stations: number }
const rows: Row[] = [];

async function run(seed: number, line: boolean) {
  const sim = new Sim(seed);
  const acc: Rec = {};
  instrument(sim, acc);
  const view = withRender ? await makeCity(sim) : null;
  const baseView = ab ? await makeCity(sim, '../src/render/city_' + 'base') : null;
  const racc: Rec = {};
  if (view) { const w = wrapper(racc); for (const p of RENDER_PHASES) if (typeof (view.city as unknown as Record<string, unknown>)[p] === 'function') w(view.city as unknown as Record<string, unknown>, p, p); }
  const maxM = Math.max(...marks);
  const win: { tick: number; phases: Rec; snap: number; clone: number; bytes: number; apply: number; chunks: number; rphases: Rec; base: number }[] = [];
  let lastChunks = 0;
  for (let m = 0; m < maxM; m++) {
    if (line && m === LINE_MONTH) testLine(sim);
    for (const k of Object.keys(acc)) acc[k] = 0;
    const t0 = performance.now();
    sim.tick();
    const tick = performance.now() - t0;
    if (sim.pending) sim.apply({ type: 'choose', event: sim.eventInfo()!.id, choice: 0 });
    const t1 = performance.now();
    const snap = sim.snapshot();
    const tSnap = performance.now() - t1;
    const t2 = performance.now();
    const buf = v8.serialize(snap);
    const msg = v8.deserialize(buf) as StateMsg;
    const tClone = performance.now() - t2;
    let tApply = 0, tBase = 0;
    for (const k of Object.keys(racc)) racc[k] = 0;
    const applyBase = () => { if (!baseView) return; const t = performance.now(); baseView.life.setRoads(msg.roads); baseView.city.update(msg); tBase = performance.now() - t; };
    if (baseView && m % 2 === 0) applyBase();
    if (view) {
      const t3 = performance.now();
      view.life.setRoads(msg.roads);
      view.city.update(msg);
      tApply = performance.now() - t3;
      racc.other = tApply - Object.entries(racc).filter(([k]) => k !== 'other').reduce((a, [, b]) => a + b, 0);
    }
    if (baseView && m % 2 === 1) applyBase();
    const chunks = view ? view.city.stats.chunksBuilt : 0;
    win.push({ tick, phases: { ...acc, other: tick - Object.values(acc).reduce((a, b) => a + b, 0) }, snap: tSnap, clone: tClone, bytes: buf.length, apply: tApply, chunks: chunks - lastChunks, rphases: { ...racc }, base: tBase });
    lastChunks = chunks;
    if (win.length > WINDOW) win.shift();
    if (marks.includes(sim.month)) {
      global.gc?.();
      const mean = (f: (w: typeof win[0]) => number) => win.reduce((a, w) => a + f(w), 0) / win.length;
      const phases: Rec = {};
      for (const w of win) for (const [k, v] of Object.entries(w.phases)) phases[k] = (phases[k] ?? 0) + v / win.length;
      const rph: Rec = {};
      for (const w of win) for (const [k, v] of Object.entries(w.rphases)) rph[k] = (rph[k] ?? 0) + v / win.length;
      const t = view ? cityTris(view.city) : { tris: 0, meshes: 0 };
      const st = sim.stats();
      rows.push({ seed, line, month: sim.month, tick: mean((w) => w.tick), phases, snap: mean((w) => w.snap), clone: mean((w) => w.clone), bytes: mean((w) => w.bytes),
        apply: mean((w) => w.apply), applyBase: mean((w) => w.base), rphases: rph, heapMB: process.memoryUsage().heapUsed / 1048576, bufMB: process.memoryUsage().arrayBuffers / 1048576, tris: t.tris, meshes: t.meshes, chunksBuilt: mean((w) => w.chunks), pop: st.population,
        lots: sim.lots.lots.filter((l) => l.alive).length, edges: sim.roads.aliveEdges().length, stations: sim.metro.stations.length });
      const r = rows[rows.length - 1];
      console.log(`seed ${seed} ${line ? 'line' : 'none'} m${String(r.month).padStart(3)}  tick ${r.tick.toFixed(1).padStart(6)} ms  snap ${r.snap.toFixed(1)} clone ${r.clone.toFixed(1)} msg ${(r.bytes / 1024).toFixed(0)} KB` +
        (view ? `  apply ${r.apply.toFixed(1)} ms${baseView ? ` (reference ${r.applyBase.toFixed(1)} ms)` : ''} (${r.chunksBuilt.toFixed(1)} chunks/tick, ${(r.tris / 1000).toFixed(0)}k tris, ${r.meshes} meshes)` : '') +
        `  heap ${r.heapMB.toFixed(0)} MB buffers ${r.bufMB.toFixed(0)} MB  pop ${r.pop} lots ${r.lots} edges ${r.edges}`);
      const g = Object.entries(GROUPS).map(([name, ks]) => `${name} ${ks.reduce((a, k) => a + (phases[k] ?? 0), 0).toFixed(1)}`);
      console.log(`      ${g.join('  ')}  other ${(phases.other ?? 0).toFixed(1)}`);
      if (view) console.log(`      apply: ${Object.entries(rph).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
      console.log(`      top: ${Object.entries(phases).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
    }
  }
}

const tAll = performance.now();
for (const seed of seeds) for (const line of modes) await run(seed, line);
console.log(`total ${((performance.now() - tAll) / 1000).toFixed(1)} s`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
