import './style.css';
import * as THREE from 'three';
import { Env } from './render/env';
import { buildTerrain, type TerrainView } from './render/terrain';
import { CityView } from './render/city';
import { MetroView } from './render/metro';
import type { InitMsg, StateMsg, WorkerOut, Command } from './sim/protocol';
import { Hud } from './ui/hud';
import { Planner } from './ui/planner';
import { CELL, N } from './sim/constants';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 4821) | 0 || 4821;

const app = document.getElementById('app')!;
const env = new Env(app);
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (c: Command | { type: 'start'; seed: number }) => worker.postMessage(c);

let init: InitMsg | null = null;
let terrain: TerrainView | null = null;
let city: CityView | null = null;
let metro: MetroView | null = null;
let planner: Planner | null = null;
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
    metro = new MetroView((x, z) => terrain!.sample(x, z));
    env.scene.add(metro.group);
    planner = new Planner(send, m.water);
    const vx = m.villages.reduce((a, v) => a + v.x, 0) / m.villages.length;
    const vy = m.villages.reduce((a, v) => a + v.y, 0) / m.villages.length;
    env.focus((vx + 0.5) * CELL, (vy + 0.5) * CELL, 3600);
  } else if (m.type === 'state') {
    const newMonth = !state || state.stats.month !== m.stats.month;
    const sig = (s: StateMsg) => JSON.stringify([s.lines.map((l) => [l.id, l.stations, l.trains]), s.stations.length]);
    const linesChanged = !state || sig(state) !== sig(m);
    state = m;
    if (newMonth) lastStateAt = performance.now();
    city?.update(m);
    if (linesChanged) metro?.update(m);
    planner?.onState(m);
    if (hud.toggles.heat) terrain?.setHeat(m.lv, init!.water);
    hud.update(m);
    refreshPlan();
  } else if (m.type === 'error') {
    console.error('[sim]', m.message);
  }
};
send({ type: 'start', seed });

// ------------------------------------------------------------------ tools
let savedView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
hud.handlers.onTool = (t) => {
  const c = env.controls;
  if (t === 'plan') {
    savedView = { pos: env.camera.position.clone(), target: c.target.clone() };
    const dist = Math.max(2500, env.camera.position.distanceTo(c.target));
    flyTo(new THREE.Vector3(c.target.x, dist, c.target.z + 1), c.target.clone());
    c.enableRotate = false;
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.screenSpacePanning = true;
    metro?.setPlan(true);
  } else {
    c.enableRotate = true;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.screenSpacePanning = false;
    if (savedView) flyTo(savedView.pos, savedView.target);
    metro?.setPlan(false);
    planner?.cancel();
    metro?.setCursor(null);
  }
  refreshPlan();
};
hud.handlers.onToggle = (name, on) => {
  if (name === 'heat' && terrain) { terrain.heat.visible = on; if (on && state && init) terrain.setHeat(state.lv, init.water); }
  if (name === 'xray') xrayTarget = on ? 1 : 0;
  if (name === 'night') nightTarget = on ? 1 : 0;
};

hud.onFocusDocks = () => {
  if (!state) return;
  const c = state.docks.centre;
  const target = new THREE.Vector3((c.x + 0.5) * CELL, 0, (c.y + 0.5) * CELL);
  const dir = env.camera.position.clone().sub(env.controls.target).normalize();
  flyTo(target.clone().addScaledVector(dir, 1500), target);
};

let fly: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t: number } | null = null;
function flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
  fly = { from: env.camera.position.clone(), to: pos, tf: env.controls.target.clone(), tt: target, t: 0 };
}

function refreshPlan() {
  if (!state || !planner || !metro) return;
  if (hud.tool !== 'plan') { hud.hint(null); metro.draft([], null, '#000'); return; }
  metro.draft(planner.points(state), planner.hover, planner.color(state));
  hud.hint(planner.hint(state));
}

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickCell(ev: PointerEvent): { x: number; y: number } | null {
  if (!terrain) return null;
  const r = env.renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, env.camera);
  const hit = ray.intersectObjects([terrain.mesh, terrain.water], false)[0];
  if (!hit) return null;
  const x = Math.floor(hit.point.x / CELL), y = Math.floor(hit.point.z / CELL);
  if (x < 0 || y < 0 || x >= N || y >= N) return null;
  return { x, y };
}
const canvas = env.renderer.domElement;
let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6 || hud.tool !== 'plan' || !state || !planner) return;
  const c = pickCell(e);
  if (c) planner.click(state, c.x, c.y);
  refreshPlan();
});
canvas.addEventListener('pointermove', (e) => {
  if (hud.tool !== 'plan' || !state || !planner || !metro || !init) return;
  const c = pickCell(e);
  const snap = c ? planner.stationAt(state, c.x, c.y) : null;
  planner.hover = snap ? { x: snap.x, y: snap.y } : c;
  metro.setCursor(planner.hover, !!c && (!!snap || !init.water[c.y * N + c.x]));
  if (planner.draft.length) refreshPlan();
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.code === 'Space') { send({ type: 'speed', speed: state && state.speed > 0 ? 0 : 1 }); e.preventDefault(); }
  else if (e.key === '1') send({ type: 'speed', speed: 1 });
  else if (e.key === '2') send({ type: 'speed', speed: 3 });
  else if (e.key === '3') send({ type: 'speed', speed: 10 });
  else if (e.key === 'p' || e.key === 'P') hud.setTool(hud.tool === 'plan' ? 'view' : 'plan');
  else if (e.key === 'v' || e.key === 'V') hud.setTool('view');
  else if (e.key === 'h' || e.key === 'H') hud.toggle('heat');
  else if (e.key === 'x' || e.key === 'X') hud.toggle('xray');
  else if (e.key === 'n' || e.key === 'N') hud.toggle('night');
  else if (e.key === 'd' || e.key === 'D') hud.toggle('desire');
  else if (e.key === 't' || e.key === 'T') hud.toggle('tilt');
  else if (hud.tool === 'plan' && planner) {
    if (e.key === 'Enter') planner.commit();
    else if (e.key === 'Backspace') planner.undo();
    else if (e.key === 'Escape') planner.cancel();
    refreshPlan();
  }
});

// ------------------------------------------------------------------ frame loop
const MS: Record<number, number> = { 0: Infinity, 1: 1500, 3: 500, 10: 150 };
let xray = 0, xrayTarget = 0, night = 0, nightTarget = 0;
let t0 = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt * 1.8);
    const k = fly.t * fly.t * (3 - 2 * fly.t);
    env.camera.position.lerpVectors(fly.from, fly.to, k);
    env.controls.target.lerpVectors(fly.tf, fly.tt, k);
    if (fly.t >= 1) fly = null;
  }
  env.controls.update();
  const frac = state ? Math.min(1, (now - lastStateAt) / (MS[state.speed] ?? 1500)) : 0;
  city?.animate(frac, now / 1000);
  xray += (xrayTarget - xray) * Math.min(1, dt * 5);
  night += (nightTarget - night) * Math.min(1, dt * 2);
  if (metro) { metro.setXray(xray); metro.animate(now / 1000); }
  env.renderer.render(env.scene, env.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug handle for testing
function cellToScreen(x: number, y: number) {
  const v = new THREE.Vector3((x + 0.5) * CELL, terrain ? terrain.sample((x + 0.5) * CELL, (y + 0.5) * CELL) : 0, (y + 0.5) * CELL).project(env.camera);
  const r = env.renderer.domElement.getBoundingClientRect();
  return { x: Math.round(r.left + (v.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - v.y) / 2 * r.height) };
}
(window as unknown as { tsm: unknown }).tsm = { env, send, hud, cellToScreen, get planner() { return planner; }, get state() { return state; }, get init() { return init; } };
