import './style.css';
import * as THREE from 'three';
import { Env } from './render/env';
import { buildTerrain, type TerrainView } from './render/terrain';
import { CityView } from './render/city';
import { MetroView } from './render/metro';
import { DesireView } from './render/desire';
import { Labels } from './render/labels';
import { Life } from './render/life';
import { lookUniforms } from './render/look';
import type { InitMsg, StateMsg, WorkerOut, Command } from './sim/protocol';
import { Hud } from './ui/hud';
import { Planner } from './ui/planner';
import { CELL, N } from './sim/constants';
import { perf } from './perf';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 4821) | 0 || 4821;

const app = document.getElementById('app')!;
const env = new Env(app);
perf.attach(env.renderer);
if (params.get('perf') === '1') perf.show();
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (c: Command | { type: 'start'; seed: number; terrain?: string; origin?: string; nohier?: boolean; noterr?: boolean; nores?: boolean; nosat?: boolean }) => worker.postMessage(c);

let init: InitMsg | null = null;
let terrain: TerrainView | null = null;
let city: CityView | null = null;
let metro: MetroView | null = null;
let labels: Labels | null = null;
let life: Life | null = null;
let planner: Planner | null = null;
let state: StateMsg | null = null;
const desire = new DesireView();
env.scene.add(desire.group);
desire.group.visible = false;
let lastStateAt = performance.now();
const hud = new Hud(document.body, send, seed);

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data;
  if (m.type === 'init') {
    init = m;
    terrain = buildTerrain(m.height, m.water, m.flags);
    env.scene.add(terrain.mesh, terrain.water, terrain.heat, terrain.catchment, terrain.contours, terrain.zones, terrain.paper, terrain.skirt);
    city = new CityView(m.water, m.flags, m.villages, (x, z) => terrain!.sample(x, z), m);
    env.scene.add(city.group);
    life = new Life((x, z) => terrain!.sample(x, z), m.water);
    env.scene.add(life.group);
    metro = new MetroView((x, z) => terrain!.sample(x, z));
    env.scene.add(metro.group);
    planner = new Planner(send, { height: m.height, water: m.water });
    const vx = m.villages.reduce((a, v) => a + v.x, 0) / m.villages.length;
    const vy = m.villages.reduce((a, v) => a + v.y, 0) / m.villages.length;
    env.focus((vx + 0.5) * CELL, (vy + 0.5) * CELL, 3600);
    send({ type: 'speed', speed: 0 });
    hud.showIntro(m.city, seed, () => send({ type: 'speed', speed: 1 }));
  } else if (m.type === 'state') {
    perf.size(m);
    const tApply = performance.now();
    const newMonth = !state || state.stats.month !== m.stats.month;
    const sig = (s: StateMsg) => JSON.stringify([s.lines.map((l) => [l.id, l.stations, l.trains]), s.stations.map((st) => (st.riders < 1200 ? 0 : st.riders < 5000 ? 1 : 2))]);
    const linesChanged = !state || sig(state) !== sig(m);
    state = m;
    if (!labels && init && terrain) {
      labels = new Labels(init.villages, init.city.site, m.docks.centre, (x, z) => terrain!.sample(x, z));
      env.scene.add(labels.group);
    }
    perf.step('life', () => { life?.setRoads(m.roads); if (newMonth) life?.setCity(m.stats.homes, m.stations); });
    if (newMonth) lastStateAt = performance.now();
    perf.step('city', () => city?.update(m));
    if (linesChanged) perf.step('metro', () => metro?.update(m));
    planner?.onState(m);
    perf.step('overlays', () => {
      if (hud.toggles.heat) terrain?.setHeat(m.lv, init!.water);
      if (hud.toggles.zones) terrain?.setZones(m.terr, init!.water);
      if (hud.toggles.desire) desire.update(m.desire);
      if (hud.tool === 'plan') terrain?.setCatchment(m.catchment);
    });
    perf.step('hud', () => { hud.update(m); refreshPlan(); });
    perf.message(m, performance.now() - tApply);
  } else if (m.type === 'error') {
    console.error('[sim]', m.message);
  }
};
send({ type: 'start', seed, terrain: params.get('terrain') ?? undefined, origin: params.get('origin') ?? undefined, nohier: params.get('nohier') === '1', noterr: params.get('noterr') === '1', nores: params.get('nores') === '1', nosat: params.get('nosat') === '1' });

// ------------------------------------------------------------------ tools
let savedView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
hud.handlers.onTool = (t) => {
  const c = env.controls;
  env.tilt = hud.toggles.tilt && t !== 'plan';
  if (t === 'plan') {
    savedView = { pos: env.camera.position.clone(), target: c.target.clone() };
    const dist = Math.max(2500, env.camera.position.distanceTo(c.target));
    flyTo(new THREE.Vector3(c.target.x, dist, c.target.z + 1), c.target.clone());
    c.enableRotate = false;
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: -1 as unknown as THREE.MOUSE, RIGHT: THREE.MOUSE.PAN };
    c.screenSpacePanning = true;
    metro?.setPlan(true);
    if (terrain && state) { terrain.setCatchment(state.catchment); terrain.catchment.visible = true; }
    if (terrain) terrain.contours.visible = true;
  } else {
    c.enableRotate = true;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: -1 as unknown as THREE.MOUSE, RIGHT: THREE.MOUSE.PAN };
    c.screenSpacePanning = false;
    if (savedView) flyTo(savedView.pos, savedView.target);
    metro?.setPlan(false);
    if (terrain) { terrain.catchment.visible = false; terrain.contours.visible = hud.toggles.heat; }
    planner?.cancel();
    metro?.setCursor(null);
  }
  refreshPlan();
};
hud.handlers.onToggle = (name, on) => {
  if (name === 'heat' && terrain) { terrain.heat.visible = on; terrain.contours.visible = on || hud.tool === 'plan'; if (on && state && init) terrain.setHeat(state.lv, init.water); }
  if (name === 'zones' && terrain) { terrain.zones.visible = on; if (on && state && init) terrain.setZones(state.terr, init.water); }
  if (name === 'xray') xrayTarget = on ? 1 : 0;
  if (name === 'night') { nightTarget = on ? 1 : 0; fastDawn = !on; }
  if (name === 'desire') { desire.group.visible = on; if (on && state) desire.update(state.desire); }
  if (name === 'tilt') env.tilt = on && hud.tool !== 'plan';
};

if (params.get('notilt') !== '1') hud.toggle('tilt', true);

hud.onFocusLandmark = (x, y) => { env.focus((x + 0.5) * CELL, (y + 0.5) * CELL, 800); };
hud.onFocusDocks = () => {
  if (!state) return;
  const c = state.docks.centre;
  const target = new THREE.Vector3(c.x * CELL, 0, c.y * CELL);
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
  metro.draft(planner.points(state), planner.hover, planner.color(state), planner.profile(state, true));
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
  // stations go anywhere: continuous coordinates in cell units
  const x = hit.point.x / CELL, y = hit.point.z / CELL;
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
  metro.setCursor(planner.hover, !!c && (!!snap || !init.water[Math.floor(c.y) * N + Math.floor(c.x)]));
  if (planner.draft.length) refreshPlan();
});

// ------------------------------------------------------------------ camera: WASD / arrows pan, middle-drag orbits
const held = new Set<string>();
let shiftDown = false;
const PAN_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };
window.addEventListener('keydown', (e) => {
  shiftDown = e.shiftKey;
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || !PAN_KEYS.has(e.code)) return;
  held.add(e.code); fly = null; e.preventDefault();
});
window.addEventListener('keyup', (e) => { held.delete(e.code); shiftDown = e.shiftKey; });
window.addEventListener('blur', () => { held.clear(); shiftDown = false; });
/** Move camera and target together over the ground plane, relative to where the camera faces. Speed scales with the camera distance. */
function panByKeys(dt: number, fast: boolean) {
  if (!held.size) return;
  const cam = env.camera.position, tgt = env.controls.target;
  let fx = tgt.x - cam.x, fz = tgt.z - cam.z;
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
  const rx = -fz, rz = fx; // right of the facing direction
  const f = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
  const r = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  if (!f && !r) return;
  const len = Math.hypot(f, r), dist = cam.distanceTo(tgt);
  const step = Math.max(150, dist) * 0.8 * (fast ? 2.8 : 1) * dt / len;
  let dx = (fx * f + rx * r) * step, dz = (fz * f + rz * r) * step;
  const lim = N * CELL;
  dx = Math.max(-tgt.x, Math.min(lim - tgt.x, dx)); dz = Math.max(-tgt.z, Math.min(lim - tgt.z, dz));
  cam.x += dx; cam.z += dz; tgt.x += dx; tgt.z += dz;
}
let spin: { x: number; y: number; id: number } | null = null;
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 1) return;
  e.preventDefault(); fly = null;
  spin = { x: e.clientX, y: e.clientY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!spin || e.pointerId !== spin.id) return;
  const dx = e.clientX - spin.x, dy = e.clientY - spin.y;
  spin.x = e.clientX; spin.y = e.clientY;
  const off = env.camera.position.clone().sub(env.controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta -= dx * 0.006; // yaw
  // pitch: dragging down lifts the camera towards a top view, dragging up lowers it towards the horizon (clamped); plan mode stays top-down and only turns (yaw)
  if (hud.tool !== 'plan') sph.phi = Math.max(0.12, Math.min(Math.PI * 0.46, sph.phi - dy * 0.005));
  env.camera.position.copy(env.controls.target).add(off.setFromSpherical(sph));
  env.camera.lookAt(env.controls.target);
});
const endSpin = (e: PointerEvent) => { if (spin && e.pointerId === spin.id) { spin = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } };
canvas.addEventListener('pointerup', endSpin);
canvas.addEventListener('pointercancel', endSpin);

window.addEventListener('keydown', (e) => {
  if (typing(e.target)) return;
  if (e.code === 'Space') { send({ type: 'speed', speed: state && state.speed > 0 ? 0 : 1 }); e.preventDefault(); }
  else if (e.key === '1') send({ type: 'speed', speed: 1 });
  else if (e.key === '2') send({ type: 'speed', speed: 3 });
  else if (e.key === '3') send({ type: 'speed', speed: 10 });
  else if (e.key === 'p' || e.key === 'P') hud.setTool(hud.tool === 'plan' ? 'view' : 'plan');
  else if (e.key === 'v' || e.key === 'V') hud.setTool('view');
  else if (e.key === 'h' || e.key === 'H') hud.toggle('heat');
  else if (e.key === 'x' || e.key === 'X') hud.toggle('xray');
  else if (e.key === 'z' || e.key === 'Z') hud.toggle('zones');
  else if (e.key === 'n' || e.key === 'N') hud.toggle('night');
  else if (e.key === 'l' || e.key === 'L') hud.toggle('desire');
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
const DAY_SECONDS = 160;
let dayPhase = 0.05;
let fastDawn = false;
/** phase 0..1 -> timeOfDay (0 noon, 0.5 midnight): 72% of the cycle is daylight */
function phaseToTime(p: number) {
  const day = 0.72;
  return p < day ? -0.2 + (p / day) * 0.4 : 0.2 + ((p - day) / (1 - day)) * 0.6;
}
/** Zoom-dependent map layers: the paper sheet and the settlement tags. */
function paperAndLabels() {
  const dist = env.camera.position.distanceTo(env.controls.target);
  const plan = hud.tool === 'plan';
  const k = plan ? 0.8 : 0.55 * THREE.MathUtils.smoothstep(dist, 3200, 5600);
  terrain?.setPaper(k * (1 - 0.92 * env.night));
  labels?.update(dist, plan, env.night);
  if (life) life.group.visible = dist < 6500 && !plan;
}
let lastXray = -1;
function applyXray(v: number) {
  if (v === lastXray || !terrain || !city) return;
  lastXray = v;
  const fade = (m: THREE.Material, min: number) => {
    m.transparent = v > 0.001;
    m.opacity = 1 - (1 - min) * v;
    m.depthWrite = v < 0.5;
  };
  fade(terrain.material, 0.14);
  for (const m of city.surfaceMats) fade(m, 0.1);
  terrain.waterMat.opacity = 0.88 * (1 - 0.8 * v);
  const board = env.scene.getObjectByName('board') as THREE.Mesh | undefined;
  if (board) for (const m of board.material as THREE.Material[]) fade(m, 0.05);
}
let t0 = performance.now();
function frame(now: number) {
  drawFrame(now);
  requestAnimationFrame(frame);
}
/** One frame: camera, animation, day / night, render (also driven by `tsm.perf.bench` in a hidden pane). */
function drawFrame(now: number) {
  perf.frameBegin(now);
  const dt = Math.min(0.1, (now - t0) / 1000);
  t0 = now;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt * 1.8);
    const k = fly.t * fly.t * (3 - 2 * fly.t);
    env.camera.position.lerpVectors(fly.from, fly.to, k);
    env.controls.target.lerpVectors(fly.tf, fly.tt, k);
    if (fly.t >= 1) fly = null;
  }
  panByKeys(dt, shiftDown);
  env.controls.update();
  const frac = state ? Math.min(1, (now - lastStateAt) / (MS[state.speed] ?? 1500)) : 0;
  city?.animate(frac, now / 1000);
  paperAndLabels();
  life?.animate(dt * (state && state.speed > 0 ? 1 : 0.4), now / 1000, env.night);
  xray += (xrayTarget - xray) * Math.min(1, dt * 5);
  if (Math.abs(xray - xrayTarget) < 0.002) xray = xrayTarget;
  applyXray(xray);
  // day/night: a slow cycle (long day, short night); the Night toggle holds it at night
  if (nightTarget > 0) dayPhase += (0.86 - dayPhase) * Math.min(1, dt * 1.5);
  else {
    // after the Night toggle is released, hurry through to dawn
    const rate = fastDawn && dayPhase > 0.6 ? 0.25 : 1 / DAY_SECONDS;
    dayPhase += dt * rate;
    if (dayPhase >= 1) { dayPhase -= 1; fastDawn = false; }
  }
  env.timeOfDay = phaseToTime(dayPhase);
  env.applyTime();
  night = env.night;
  lookUniforms.uNight.value = night;
  if (city) city.roadMat.emissiveIntensity = night * 0.05;
  if (metro) { metro.setXray(xray); metro.animate(now / 1000); }
  env.render();
  perf.frameEnd();
}
requestAnimationFrame(frame);

// debug handle for testing
function cellToScreen(x: number, y: number) {
  const v = new THREE.Vector3(x * CELL, terrain ? terrain.sample(x * CELL, y * CELL) : 0, y * CELL).project(env.camera);
  const r = env.renderer.domElement.getBoundingClientRect();
  return { x: Math.round(r.left + (v.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - v.y) / 2 * r.height) };
}
/** Dev helper: run the sim to a month in small batches, picking `deal` for the docks event and the first option otherwise. */
async function ff(target: number, deal = 0, picks: Record<string, number> = {}) {
  // MessageChannel yields are not throttled in a hidden pane, unlike timers
  const sl = (_ms: number) => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(0); c.port2.postMessage(0); });
  send({ type: 'speed', speed: 0 });
  const until = async (cond: () => boolean) => { const t0 = performance.now(); while (state && !cond() && performance.now() - t0 < 4000) await sl(0); };
  while (state && state.stats.month < target) {
    const before = state.stats.month;
    if (state.event) {
      const id = state.event.id;
      send({ type: 'choose', event: id, choice: id === 'docks_bought' ? deal : (picks[id] ?? 0) });
      await until(() => !state!.event || state!.event.id !== id);
    } else {
      send({ type: 'step', months: Math.max(1, Math.min(4, target - before)) });
      await until(() => state!.stats.month !== before);
    }
  }
}
/** Test helper: fast-forward, take a docks deal, build a line through the villages (used for screenshots). */
async function demo(deal = 0, lineAt = 10) {
  const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitMonth = async (m: number) => { await ff(m, deal); await sl(200); };
  await waitMonth(lineAt);
  if (!state || !init || !planner) return;
  const vs = init.villages.slice().sort((a, b) => a.y - b.y);
  const pts: [number, number][] = [];
  for (let k = 0; k < vs.length; k++) {
    if (k > 0) {
      const a = vs[k - 1], b = vs[k];
      const n = Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 11));
      for (let j = 1; j < n; j++) pts.push([Math.round(a.x + (b.x - a.x) * j / n), Math.round(a.y + (b.y - a.y) * j / n)]);
    }
    pts.push([vs[k].x, vs[k].y]);
  }
  for (const [x, y] of pts) {
    let cx = x, cy = y;
    for (let r = 0; r < 4 && init.water[cy * N + cx]; r++) { cx = x + r; cy = y - r; }
    planner.click(state, cx, cy);
    await sl(120);
  }
  planner.commit();
  await sl(400);
}
/** Dev helper: save the canvas at full size to screenshots/<name>.png (served by the dev server only). */
async function shot(name: string) {
  // a hidden pane does not run animation frames: settle the x-ray fade at once so the capture shows the toggled state
  xray = xrayTarget; applyXray(xray); metro?.setXray(xray);
  env.timeOfDay = phaseToTime(dayPhase);
  env.applyTime();
  lookUniforms.uNight.value = env.night;
  if (city) city.roadMat.emissiveIntensity = env.night * 0.05;
  paperAndLabels();
  life?.animate(0, performance.now() / 1000, env.night);
  env.render();
  const url = env.renderer.domElement.toDataURL('image/png');
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return name;
}
/** Dev helper: point the camera at a cell position from an azimuth / polar angle. */
function view(x: number, y: number, dist: number, az = 0.6, pol = 0.9) {
  const tx = x * CELL, tz = y * CELL;
  env.controls.target.set(tx, 0, tz);
  env.camera.position.set(tx + Math.sin(az) * Math.sin(pol) * dist, Math.cos(pol) * dist, tz + Math.cos(az) * Math.sin(pol) * dist);
  env.controls.update();
}
/** Dev helper: set the time of day (0..1, 0.86 is deep night) and hold it for screenshots. */
function phase(p: number) { nightTarget = 0; fastDawn = false; dayPhase = p; }
(window as unknown as { tsm: unknown }).tsm = { env, send, hud, cellToScreen, demo, ff, shot, view, phase, get city() { return city; }, get life() { return life; }, panStep: (dt: number) => { panByKeys(dt, shiftDown); env.controls.update(); }, get labels() { return labels; }, get planner() { return planner; }, get state() { return state; }, get init() { return init; }, perf: { report: () => perf.report(), show: (on = true) => perf.show(on), reset: () => perf.reset(), sizes: (on = true) => { perf.sizes = on; }, bench: (n = 120) => perf.bench(n, drawFrame), mon: perf } };
