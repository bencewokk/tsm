import './style.css';
import './ui/diegetic/diegetic.css';
import * as THREE from 'three';
import { Env } from './render/env';
import { buildTerrain, type TerrainView } from './render/terrain';
import { CityView, ROADFX } from './render/city';
import { MetroView } from './render/metro';
import { DesireView } from './render/desire';
import { Labels } from './render/labels';
import { ProjectMarkers } from './render/markers';
import { Ships } from './render/ships';
import { Life } from './render/life';
import { lookUniforms } from './render/look';
import { VFX } from './render/vfx';
import type { InitMsg, StateMsg, WorkerOut, Command } from './sim/protocol';
import { Hud, money as fmtMoney } from './ui/hud';
import { Sound, bindSound } from './ui/sound';
import { gameEvents } from './ui/gameEvents';
import { FeedbackEmitter } from './ui/feedbackEmitter';
import { Ripple } from './render/ripple';
import { GoalMarker } from './render/goalmarker';
import { DiegeticLayer } from './ui/diegetic/layer';
import { syncWorld, stationLoads } from './ui/diegetic/world';
import { skinHud } from './ui/diegetic/hudskin';
import { demoEvent } from './ui/diegetic/demo';
import { Planner } from './ui/planner';
import { CELL, N, STATION_COST, TRAIN_COST, METRO_SPEED } from './sim/constants';
import { quoteLine } from './sim/relief';
import { perf } from './perf';
import { SunShadow, CarBlobs, SHADOW } from './render/shadows';
import { Quality, qualityFromUrl, type QualityMode } from './render/quality';
import { VS } from './render/common';

const params = new URLSearchParams(location.search);
if (params.get('norepair') === '1') ROADFX.on = false;
const seed = Number(params.get('seed') ?? 4821) | 0 || 4821;

const app = document.getElementById('app')!;
const env = new Env(app);
perf.attach(env.renderer);
if (params.get('perf') === '1') perf.show();
// render quality (?quality=auto|high|performance, HUD button): the 3D scene's resolution scale
const quality = new Quality((s) => env.setScale(s));
const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (c: Command | { type: 'start'; seed: number; terrain?: string; origin?: string; nohier?: boolean; noterr?: boolean; nores?: boolean; nosat?: boolean; norepair?: boolean; noboom?: boolean }) => worker.postMessage(c);

let init: InitMsg | null = null;
let markers: ProjectMarkers | null = null;
let ships: Ships | null = null;
/** dev: latest road graph validation from the worker (`tsm.graph`) */
let graphReport: StateMsg['graph'] | null = null;
let terrain: TerrainView | null = null;
let city: CityView | null = null;
let metro: MetroView | null = null;
let labels: Labels | null = null;
let life: Life | null = null;
let planner: Planner | null = null;
let sunShadow: SunShadow | null = null;
let carBlobs: CarBlobs | null = null;
let state: StateMsg | null = null;
const desire = new DesireView();
env.scene.add(desire.group);
desire.group.visible = false;
let lastStateAt = performance.now();
const sound = new Sound();
/** what the player's speed buttons / keys asked for last while planning (plan mode pauses the clock, leaving it resumes this speed) */
let planResume = 0;
let planning = false;
/** the clock stays stopped after Begin until the first line opens (or the player starts it): nothing happens to a city the player has not touched yet */
let clockHeld = false;
const userSend = (c: Command) => { if (c.type === 'speed' && c.speed > 0) { clockHeld = false; if (planning) planResume = c.speed; } send(c); };
const hud = new Hud(document.body, userSend, seed);
hud.setSound(sound.enabled);
bindSound(sound);
// diegetic presentation (src/ui/diegetic): paper tags and flags pinned on the model, newspaper, clipboard, slips and the dial plate on the table.
// It presents every gameplay beat in both HUD modes; ?hud=classic only skips the table skin (ledger strip, calendar, odometer, desk rail look).
const classicHud = params.get('hud') === 'classic';
const dg = new DiegeticLayer(document.body, env.camera, hud.root);
const skin = classicHud ? null : skinHud(hud);
/** gameplay feedback: events come from one emitter; the diegetic layer, sound and the world layer below only subscribe */
const emitter = new FeedbackEmitter();
gameEvents.onAny((e) => dg?.notify(e));
/** wall-clock time of the last big headline (the Auto speed rule waits after one) */
let lastBigAt = 0;
gameEvents.on('moment', (e) => { if (e.moment.big) lastBigAt = performance.now(); });
/** the Plan button pulses until the first line exists (not while planning or on the start card) */
function pulsePlan(on: boolean) {
  const plan = hud.root.querySelector('[data-tool="plan"]');
  plan?.classList.toggle('pulse', on && !plan.classList.contains('on') && !hud.introOpen);
}
let lastClock = '';
/** announce the clock mode when it changes */
function emitClock() {
  const mode = clockHeld ? 'held' : planning ? 'planning' : !state || state.speed === 0 ? 'paused' : 'running';
  const k = `${mode}|${state?.speed ?? 0}|${autoSpeed}`;
  if (k === lastClock) return;
  lastClock = k;
  gameEvents.emit({ kind: 'clock', mode, speed: state?.speed ?? 0, auto: autoSpeed });
}
let ripple: Ripple | null = null;
let goalMarker: GoalMarker | null = null;
let autoSpeed = false;
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => sound.unlock(), { capture: true });

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const m = ev.data;
  if (m.type === 'init') {
    init = m;
    terrain = buildTerrain(m.height, m.water, m.flags);
    { let top = 0; for (let i = 0; i < m.height.length; i++) if (m.height[i] > top) top = m.height[i]; sunShadow = new SunShadow(env.sun, env.renderer, top * VS + 10, top * VS + 320); }
    env.scene.add(terrain.mesh, terrain.water, terrain.heat, terrain.catchment, terrain.contours, terrain.zones, terrain.paper, terrain.skirt);
    city = new CityView(m.water, m.flags, m.villages, (x, z) => terrain!.sample(x, z), m);
    env.scene.add(city.group);
    life = new Life((x, z) => terrain!.sample(x, z), m.water);
    env.scene.add(life.group);
    ships = new Ships(m.water, seed);
    env.scene.add(ships.group);
    carBlobs = new CarBlobs((life as unknown as { cars: THREE.InstancedMesh }).cars, () => !!life?.group.visible);
    env.scene.add(carBlobs.mesh);
    metro = new MetroView((x, z) => terrain!.sample(x, z));
    env.scene.add(metro.group);
    markers = new ProjectMarkers((x, z) => terrain!.sample(x, z));
    env.scene.add(markers.group);
    ripple = new Ripple(terrain.catchment.geometry);
    env.scene.add(ripple.mesh);
    goalMarker = new GoalMarker((x, z) => terrain!.sample(x, z));
    env.scene.add(goalMarker.group);
    planner = new Planner(send, { height: m.height, water: m.water });
    const vx = m.villages.reduce((a, v) => a + v.x, 0) / m.villages.length;
    const vy = m.villages.reduce((a, v) => a + v.y, 0) / m.villages.length;
    env.focus((vx + 0.5) * CELL, (vy + 0.5) * CELL, 3600);
    send({ type: 'speed', speed: 0 });
    hud.showIntro(m.city, seed, () => { sound.unlock(); clockHeld = true; refreshPlan(); emitClock(); pulsePlan(true); });
  } else if (m.type === 'state') {
    if (m.graph) { graphReport = m.graph; for (const l of m.graph.log) (m.graph.defects ? console.warn : console.info)(l); }
    perf.size(m);
    const tApply = performance.now();
    const newMonth = !state || state.stats.month !== m.stats.month;
    const sig = (s: StateMsg) => JSON.stringify([s.lines.map((l) => [l.id, l.stations, l.trains]), s.stations.map((st) => (st.riders < 1200 ? 0 : st.riders < 5000 ? 1 : 2))]);
    const linesChanged = !state || sig(state) !== sig(m);
    const prevState = state;
    state = m;
    emitter.onState(prevState, m);
    emitClock();
    if (!labels && init && terrain) {
      labels = new Labels(init.villages, init.city.site, m.docks.centre, (x, z) => terrain!.sample(x, z));
      env.addText(labels.group);
    }
    perf.step('life', () => { life?.setRoads(m.roads); if (newMonth) life?.setCity(m.stats.homes, m.stations, stationLoads(m)); });
    if (newMonth) lastStateAt = performance.now();
    perf.step('city', () => city?.update(m, CITY_BUDGET));
    markers?.update(m.projects);
    if (linesChanged) { perf.step('metro', () => metro?.update(m)); if (sunShadow) sunShadow.dirty = true; }
    planner?.onState(m);
    perf.step('overlays', () => {
      if (hud.toggles.heat) terrain?.setHeat(m.lv, init!.water);
      if (hud.toggles.zones) terrain?.setZones(m.terr, init!.water);
      if (hud.toggles.desire) desire.update(m.desire);
      if (hud.tool === 'plan') terrain?.setCatchment(m.catchment);
    });
    perf.step('hud', () => { hud.update(m); refreshPlan(); });
    if (dg && terrain) { skin?.update(m); dg.desk.setMonth(m.stats.month); dg.desk.setSpeed(m.speed); syncWorld(dg, m, (x, z) => terrain!.sample(x, z)); }
    perf.message(m, performance.now() - tApply);
  } else if (m.type === 'error') {
    console.error('[sim]', m.message);
  }
};
send({ type: 'start', seed, noboom: params.get('noboom') === '1', terrain: params.get('terrain') ?? undefined, origin: params.get('origin') ?? undefined, nohier: params.get('nohier') === '1', noterr: params.get('noterr') === '1', nores: params.get('nores') === '1', nosat: params.get('nosat') === '1', norepair: params.get('norepair') === '1' });

// ------------------------------------------------------------------ tools
let savedView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
hud.handlers.onTool = (t) => {
  const c = env.controls;
  if (t === 'plan' && !planning) { planning = true; planResume = state && state.speed > 0 ? state.speed : 0; if (planResume > 0) send({ type: 'speed', speed: 0 }); }
  if (t !== 'plan' && planning) { planning = false; if (planResume > 0 && state && state.speed === 0 && !state.event) send({ type: 'speed', speed: planResume }); }
  if (t === 'plan') {
    savedView = { pos: env.camera.position.clone(), target: c.target.clone() };
    // with no line yet, frame both ends of the first goal so the target village is on screen
    const fr = state && !state.lines.length ? state.goals.find((g) => g.frame)?.frame : undefined;
    const dist = fr ? Math.max(2500, fr.span * CELL * 2.1) : Math.max(2500, env.camera.position.distanceTo(c.target));
    const tgt = fr ? new THREE.Vector3((fr.x + 0.5) * CELL, 0, (fr.y + 0.5) * CELL) : c.target.clone();
    flyTo(new THREE.Vector3(tgt.x, dist, tgt.z + 1), tgt);
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
  emitClock();
  pulsePlan(!!state && !state.lines.length);
  refreshPlan();
};
hud.handlers.onToggle = (name, on) => {
  if (name === 'heat' && terrain) { terrain.heat.visible = on; terrain.contours.visible = on || hud.tool === 'plan'; if (on && state && init) terrain.setHeat(state.lv, init.water); }
  if (name === 'zones' && terrain) { terrain.zones.visible = on; if (on && state && init) terrain.setZones(state.terr, init.water); }
  if (name === 'xray') xrayTarget = on ? 1 : 0;
  if (name === 'night') { nightTarget = on ? 1 : 0; fastDawn = !on; }
  if (name === 'desire') { desire.group.visible = on; if (on && state) desire.update(state.desire); }
};

quality.setMode(qualityFromUrl(params));
const QUALITY_CYCLE: QualityMode[] = ['auto', 'high', 'performance'];
const qualityLabel = () => `Quality: ${quality.mode === 'auto' ? `Auto (${Math.round(quality.scale * 100)}%)` : quality.mode === 'high' ? 'High' : 'Performance'}`;
hud.handlers.onQuality = () => { quality.setMode(QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(quality.mode) + 1) % 3]); hud.setQuality(qualityLabel()); };
hud.setQuality(qualityLabel());
let gpuSeq = 0;

hud.onFocusLandmark = (x, y) => { env.focus((x + 0.5) * CELL, (y + 0.5) * CELL, 800); };
/** Fly the camera to a place, keeping the viewing direction (the saved overview direction while planning). */
function flyFocus(x: number, y: number, dist: number) {
  const target = new THREE.Vector3((x + 0.5) * CELL, 0, (y + 0.5) * CELL);
  const dir = (hud.tool === 'plan' && savedView ? savedView.pos.clone().sub(savedView.target) : env.camera.position.clone().sub(env.controls.target)).normalize();
  flyTo(target.clone().addScaledVector(dir, dist), target);
}
dg.desk.onGoal = (x, y) => flyFocus(x, y, Math.max(1800, Math.min(3500, env.camera.position.distanceTo(env.controls.target))));
hud.handlers.onSound = () => { sound.set(!sound.enabled); return sound.enabled; };
hud.handlers.onAuto = (on) => { autoSpeed = on; emitClock(); };
/** world layer: what the events do to the 3D scene and the camera (placeholder; a visual layer can replace it) */
gameEvents.on('stationOpened', (e) => {
  // ripple over the streets the line just brought within an 8-minute walk (one sweep per batch of stations)
  if (ripple && !ripple.active) ripple.start(e.catchmentAfter, e.catchmentBefore, e.color);
});
gameEvents.on('objectives', (e) => {
  const gt = e.goals.find((g) => g.x !== undefined && g.y !== undefined);
  goalMarker?.set(gt ? { x: gt.x!, y: gt.y! } : null);
  pulsePlan(!e.hasLines);
  // the start card names the first goal (the clipboard on the table carries the full list)
  const ig = hud.root.querySelector('[data-introgoal]');
  if (ig && e.goals[0]) ig.innerHTML = `<span class="gl">First goal</span> <b>${e.goals[0].title}</b> <span class="muted">reward ${e.goals[0].reward}</span>`;
});
/** control: the ribbon-cutting leaves plan mode, starts a held clock and flies out over the new line */
gameEvents.on('lineOpened', (e) => {
  const m = e.moment;
  if (clockHeld) { clockHeld = false; send({ type: 'speed', speed: 1 }); }
  if (hud.tool === 'plan') hud.setTool('view');
  const sv = savedView;
  const target = new THREE.Vector3((m.x + 0.5) * CELL, 0, (m.y + 0.5) * CELL);
  const dir = (sv ? sv.pos.clone().sub(sv.target) : env.camera.position.clone().sub(env.controls.target)).normalize();
  flyTo(target.clone().addScaledVector(dir, 2800), target);
  emitClock();
});

let lastAutoCheck = 0;
window.setInterval(() => autoSpeedTick(performance.now()), 600);
function autoSpeedTick(now: number) {
  if (!autoSpeed || !state || planning || state.speed === 0 || now - lastAutoCheck < 600) return;
  lastAutoCheck = now;
  // quiet = no decision waiting and no headline in the last 9 seconds
  const quiet = !state.event && now - lastBigAt > 9000;
  const want = quiet ? 3 : 1;
  if (state.speed !== want) send({ type: 'speed', speed: want });
}
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
  if (hud.tool !== 'plan') { hud.hint(clockHeld ? '<b>The clock is stopped</b> until your first line opens. Press <b>P</b> to plan it (or press <b>1</b> to start time).' : null); metro.draft([], null, '#000'); return; }
  metro.draft(planner.points(state), planner.hover, planner.color(state), planner.profile(state, true));
  hud.hint(planner.hint(state));
  gameEvents.emit(planner.costInfo(state));
  if (dg && terrain && planner.draft.length && planner.hover) {
    const r = planner.quote(state), ok = r.cost <= state.stats.money && (!r.q || r.q.ok);
    dg.cost({ x: planner.hover.x * CELL, y: terrain.sample(planner.hover.x * CELL, planner.hover.y * CELL) + 2, z: planner.hover.y * CELL }, { title: fmtMoney(r.cost), sub: `${r.km.toFixed(1)} km  ·  ${planner.draft.length} stations  ·  ${r.trains} trains`, badge: ok ? '' : 'too dear', color: ok ? '#2f7d5a' : '#c0503a', look: 2, ok });
  } else dg?.cost(null);
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
const panV = { f: 0, r: 0 };
function panByKeys(dt: number, fast: boolean) {
  // smoothed input: the camera accelerates into a pan and glides to a stop (instant with ?novfx=cam)
  const inF = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
  const inR = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
  if (VFX.is('cam')) {
    const a = 1 - Math.exp(-dt * (inF || inR ? 12 : 6));
    panV.f += (inF - panV.f) * a; panV.r += (inR - panV.r) * a;
    if (Math.abs(panV.f) < 0.01 && Math.abs(panV.r) < 0.01) { panV.f = panV.r = 0; return; }
  } else { panV.f = inF; panV.r = inR; if (!inF && !inR) return; }
  const cam = env.camera.position, tgt = env.controls.target;
  let fx = tgt.x - cam.x, fz = tgt.z - cam.z;
  const fl = Math.hypot(fx, fz);
  if (fl < 1e-3) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
  const rx = -fz, rz = fx; // right of the facing direction
  const mag = Math.hypot(panV.f, panV.r), dist = cam.distanceTo(tgt);
  const step = Math.max(150, dist) * 0.8 * (fast ? 2.8 : 1) * dt * (mag > 1 ? 1 / mag : 1);
  let dx = (fx * panV.f + rx * panV.r) * step, dz = (fz * panV.f + rz * panV.r) * step;
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
  if (typing(e.target) || hud.introOpen) return;
  if (e.code === 'Space') { userSend({ type: 'speed', speed: state && state.speed > 0 ? 0 : 1 }); e.preventDefault(); }
  else if (e.key === '1') userSend({ type: 'speed', speed: 1 });
  else if (e.key === '2') userSend({ type: 'speed', speed: 3 });
  else if (e.key === '3') userSend({ type: 'speed', speed: 10 });
  else if (e.key === '4') document.querySelector<HTMLButtonElement>('[data-auto]')?.click();
  else if (e.key === 'p' || e.key === 'P') hud.setTool(hud.tool === 'plan' ? 'view' : 'plan');
  else if (e.key === 'v' || e.key === 'V') hud.setTool('view');
  else if (e.key === 'h' || e.key === 'H') hud.toggle('heat');
  else if (e.key === 'x' || e.key === 'X') hud.toggle('xray');
  else if (e.key === 'z' || e.key === 'Z') hud.toggle('zones');
  else if (e.key === 'n' || e.key === 'N') hud.toggle('night');
  else if (e.key === 'l' || e.key === 'L') hud.toggle('desire');
  else if (hud.tool === 'plan' && planner) {
    if (e.key === 'Enter') planner.commit();
    else if (e.key === 'Backspace') planner.undo();
    else if (e.key === 'Escape') planner.cancel();
    refreshPlan();
  }
});

// ------------------------------------------------------------------ frame loop
const MS: Record<number, number> = { 0: Infinity, 1: 1500, 3: 500, 10: 150 };
/** ms per frame the city may spend on rebuilding chunks after a state message (the rest waits for the next frames) */
const CITY_BUDGET = 6;
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
  labels?.update(dist, plan, env.night, env.camera as THREE.PerspectiveCamera, env.renderer.domElement.clientHeight || 900, !!dg);
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
const blobDir = new THREE.Vector3();
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
  env.feel.step(dt);
  env.controls.update();
  const frac = state ? Math.min(1, (now - lastStateAt) / (MS[state.speed] ?? 1500)) : 0;
  if (city?.pending) perf.step('city', () => city!.pump(CITY_BUDGET));
  city?.animate(frac, now / 1000);
  paperAndLabels();
  life?.animate(dt * (state && state.speed > 0 ? 1 : 0.4), now / 1000, env.night);
  ships?.animate(now / 1000);
  ripple?.animate(dt);
  goalMarker?.animate(now / 1000, env.camera.position.distanceTo(env.controls.target));
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
  if (sunShadow && city) {
    if (city.shadowDirty) { sunShadow.dirty = true; city.shadowDirty = false; }
    sunShadow.movers = city.moving;
  }
  sunShadow?.frame(env.camera, now);
  if (carBlobs && sunShadow) carBlobs.update(sunShadow.dir(blobDir), 1 - env.night);
  night = env.night;
  lookUniforms.uNight.value = night;
  if (city) city.roadMat.emissiveIntensity = night * 0.05;
  if (metro) { metro.setXray(xray); metro.animate(now / 1000); }
  env.render();
  if (dg) { dg.setNight(env.night); dg.draw(now); skin?.plan(hud.tool === 'plan'); }
  perf.frameEnd();
  // Auto quality: one sample per resolved GPU timer query (else the frame interval)
  const fresh = perf.gpuSeq !== gpuSeq;
  gpuSeq = perf.gpuSeq;
  if (perf.hasGpuTimer) { if (fresh) quality.frame(now, perf.lastGpu, perf.lastInterval); } else quality.frame(now, null, perf.lastInterval);
  if (quality.mode === 'auto') hud.setQuality(qualityLabel());
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
  clockHeld = false; refreshPlan();
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
/** Test helper: the same path a player takes. Enters plan mode, clicks each cell with real pointer events on the canvas (the planner picks through the camera), then presses Enter with a real key event. Resolves with what the sim did. */
async function uiLine(cells: [number, number][]) {
  const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (!state || !init || !planner) return { ok: false, why: 'not ready' };
  const linesBefore = state.lines.length;
  if (hud.tool !== 'plan') hud.setTool('plan');
  const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length, cy = cells.reduce((a, c) => a + c[1], 0) / cells.length;
  const span = Math.max(...cells.map((c) => Math.hypot(c[0] - cx, c[1] - cy))) * CELL;
  fly = null;
  view(cx, cy, Math.max(1800, span * 2.6), 0, 0.01);
  const cv = env.renderer.domElement;
  const click = (x: number, y: number) => {
    env.render();
    const sc = cellToScreen(x, y);
    const o = { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true, pointerId: 1, pointerType: 'mouse' };
    cv.dispatchEvent(new PointerEvent('pointerdown', o));
    cv.dispatchEvent(new PointerEvent('pointerup', o));
  };
  for (const [x, y] of cells) { click(x, y); await sl(250); }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  for (let k = 0; k < 20 && state.lines.length === linesBefore && planner.draft.length; k++) await sl(150);
  await sl(300);
  return { ok: state.lines.length > linesBefore, draft: planner.draft.length, notice: planner.notice, lines: state.lines.length, log: state.log.slice(-2) };
}
/** Test helper: fast-forward, take a docks deal, build a line through the villages through the UI path (used for screenshots). The line is the longest prefix of the chain the budget and the terrain allow, as a player would stop adding stations. */
async function demo(deal = 0, lineAt = 10) {
  const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await ff(lineAt, deal); await sl(200);
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
  const cells = pts.map(([x, y]) => {
    let cx = x, cy = y;
    for (let r = 0; r < 4 && init!.water[cy * N + cx]; r++) { cx = x + r; cy = y - r; }
    return [cx, cy] as [number, number];
  });
  const terr = { height: init.height, water: init.water };
  const money0 = state.stats.money;
  let n = cells.length;
  for (; n >= 2; n--) {
    const sub = cells.slice(0, n);
    const q = quoteLine(sub.map(([x, y]) => ({ x, y })), terr);
    const trains = Math.max(2, Math.round(((q.km / METRO_SPEED) * 60 * 2 + n + 4) / 5));
    if (q.ok && q.cost + trains * TRAIN_COST + n * STATION_COST <= money0) break;
  }
  if (n < 2) return { ok: false, why: 'nothing affordable' };
  return uiLine(cells.slice(0, n));
}
/** Dev helper: save the canvas at full size to screenshots/<name>.png (served by the dev server only). */
async function shot(name: string) {
  // a hidden pane does not run animation frames: settle the x-ray fade at once so the capture shows the toggled state
  city?.flush();
  xray = xrayTarget; applyXray(xray); metro?.setXray(xray);
  env.timeOfDay = phaseToTime(dayPhase);
  env.applyTime();
  sunShadow?.redraw(env.camera);
  if (carBlobs && sunShadow) carBlobs.update(sunShadow.dir(blobDir), 1 - env.night);
  lookUniforms.uNight.value = env.night;
  if (city) city.roadMat.emissiveIntensity = env.night * 0.05;
  paperAndLabels();
  life?.animate(0, performance.now() / 1000, env.night);
  ships?.animate(performance.now() / 1000);
  env.render();
  const url = env.renderer.domElement.toDataURL('image/png');
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return name;
}
/** Dev helper: like shot, but with the HUD (panels, dialog) drawn over the canvas (the DOM is rendered through an SVG foreignObject). */
async function shotUI(name: string) {
  paperAndLabels();
  env.render();
  const gl = env.renderer.domElement, W = gl.width, H = gl.height, k = W / Math.max(1, gl.clientWidth);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.drawImage(gl, 0, 0);
  if (dg) { dg.setNight(env.night); dg.draw(performance.now()); g.drawImage(dg.canvas, 0, 0, W, H); }
  const css = [...document.styleSheets].map((sh) => { try { return [...sh.cssRules].map((r) => r.cssText).join(' '); } catch { return ''; } }).join(' ');
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('canvas, script').forEach((e) => e.remove());
  const html = new XMLSerializer().serializeToString(clone).replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" class="${document.body.className}" style="position:relative;width:${gl.clientWidth}px;height:${gl.clientHeight}px;transform:scale(${k});transform-origin:0 0;overflow:hidden"><style>${css.replace(/</g, ' ')} *{animation:none !important;transition:none !important}</style>${html}</div></foreignObject></svg>`;
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  g.drawImage(img, 0, 0);
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: c.toDataURL('image/png') });
  return name;
}
/** Dev helper: point the camera at a cell position from an azimuth / polar angle. */
function view(x: number, y: number, dist: number, az = 0.6, pol = 0.9) {
  fly = null;
  const tx = x * CELL, tz = y * CELL;
  env.controls.target.set(tx, 0, tz);
  env.camera.position.set(tx + Math.sin(az) * Math.sin(pol) * dist, Math.cos(pol) * dist, tz + Math.cos(az) * Math.sin(pol) * dist);
  env.controls.update();
}
/** Dev helper: set the time of day (0..1, 0.86 is deep night) and hold it for screenshots. */
function phase(p: number) { nightTarget = 0; fastDawn = false; dayPhase = p; }
(window as unknown as { tsm: unknown }).tsm = { events: gameEvents, get ripple() { return ripple; }, sound, dg, fun: (k: Parameters<typeof demoEvent>[2] = 'all') => (dg && state ? demoEvent(dg, state, k) : 'no layer'), env, send, hud, cellToScreen, demo, uiLine, ff, shot, shotUI, view, phase, get city() { return city; }, get life() { return life; }, panStep: (dt: number) => { panByKeys(dt, shiftDown); env.controls.update(); }, get labels() { return labels; }, get planner() { return planner; }, get state() { return state; }, get init() { return init; }, get graph() { return graphReport; }, get sunShadow() { return sunShadow; }, quality, get carBlobs() { return carBlobs; }, shadowCfg: SHADOW, perf: { report: () => perf.report(), show: (on = true) => perf.show(on), reset: () => perf.reset(), sizes: (on = true) => { perf.sizes = on; }, bench: (n = 120) => perf.bench(n, drawFrame), frame: () => drawFrame(performance.now()), mon: perf } };
