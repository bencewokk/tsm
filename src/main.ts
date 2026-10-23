import './style.css';
import { Env } from './render/env';
import { buildTerrain, type TerrainView } from './render/terrain';
import { CityView } from './render/city';
import type { InitMsg, StateMsg, WorkerOut, Command } from './sim/protocol';
import { Hud } from './ui/hud';
import { CELL } from './sim/constants';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 4821) | 0 || 4821;

const app = document.getElementById('app')!;
const env = new Env(app);
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (c: Command | { type: 'start'; seed: number }) => worker.postMessage(c);

let init: InitMsg | null = null;
let terrain: TerrainView | null = null;
let city: CityView | null = null;
let state: StateMsg | null = null;
let lastStateAt = performance.now();
const hud = new Hud(document.body, send, seed);

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data;
  if (m.type === 'init') {
    init = m;
    terrain = buildTerrain(m.height, m.water);
    env.scene.add(terrain.mesh, terrain.water, terrain.heat);
    city = new CityView(m.height, m.water);
    env.scene.add(city.group);
    // frame the villages
    const vx = m.villages.reduce((a, v) => a + v.x, 0) / m.villages.length;
    const vy = m.villages.reduce((a, v) => a + v.y, 0) / m.villages.length;
    env.focus((vx + 0.5) * CELL, (vy + 0.5) * CELL, 3600);
  } else if (m.type === 'state') {
    const newMonth = !state || state.stats.month !== m.stats.month;
    state = m;
    if (newMonth) lastStateAt = performance.now();
    city?.update(m);
    hud.update(m);
  } else if (m.type === 'error') {
    console.error('[sim]', m.message);
  }
};
send({ type: 'start', seed });

const MS: Record<number, number> = { 0: Infinity, 1: 1500, 3: 500, 10: 150 };
let t0 = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  env.controls.update();
  const frac = state ? Math.min(1, (now - lastStateAt) / (MS[state.speed] ?? 1500)) : 0;
  city?.animate(frac, now / 1000);
  void dt;
  env.renderer.render(env.scene, env.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug handle for testing
(window as unknown as { tsm: unknown }).tsm = { env, send, get state() { return state; }, get init() { return init; } };
