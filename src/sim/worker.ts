/// <reference lib="webworker" />
import { HIER } from './hierarchy';
import { TERR } from './territory';
import { RES } from './reserves';
import { SAT } from './terrain';
import { SQ } from './squares';
import { ART, REPAIR } from './roads';
import { Sim, BOOM } from './sim';
import { ENVS } from './envelopes';
import { GRAPHCHECK } from './graphcheck';
import type { Command, StateMsg, WorkerOut } from './protocol';

let sim: Sim | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

/** State snapshots are built from fresh copies every time, so their typed arrays are transferred (moved, not cloned). */
function postState(m: StateMsg) {
  const bufs: ArrayBuffer[] = [];
  const add = (v: unknown) => { if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer && !bufs.includes(v.buffer)) bufs.push(v.buffer); };
  for (const v of Object.values(m.roads)) add(v);
  for (const v of Object.values(m.lots)) add(v);
  add(m.road); add(m.lv); add(m.flags); add(m.terr); add(m.catchment);
  (self as unknown as Worker).postMessage(m, bufs);
}

/** ms per month at each speed setting */
const MS: Record<number, number> = { 1: 1500, 3: 500, 10: 150 };

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!sim || sim.speed === 0 || sim.paused()) return;
  timer = setTimeout(step, MS[sim.speed] ?? 1500);
}

function step() {
  if (!sim) return;
  try {
    const t0 = performance.now();
    if (!sim.paused()) sim.tick();
    const t1 = performance.now();
    const snap = sim.snapshot();
    snap.perf = { tick: t1 - t0, snap: performance.now() - t1 };
    postState(snap);
  } catch (e) {
    post({ type: 'error', message: String((e as Error).stack ?? e) });
  }
  schedule();
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as Command | { type: 'start'; seed: number; terrain?: string; origin?: string; nohier?: boolean; noterr?: boolean; nores?: boolean; nosat?: boolean; norepair?: boolean; noboom?: boolean; noenv?: boolean } | { type: 'quote'; id: number; stations: number[] };
  try {
    if (m.type === 'start') {
      if (m.nohier) { HIER.on = false; ART.valley = 0; ART.climb = 0; ART.steep = 6; }   // dev: the unstructured road growth, for before / after captures
      if (m.noterr) TERR.on = false;
      if (m.norepair) REPAIR.on = false;
      if (m.noboom) BOOM.on = false;
      if (m.noenv) ENVS.on = false;   // dev: no development envelopes (round 7 step 2 before / after)   // dev: no station boom, for before / after captures
      if (import.meta.env.DEV) GRAPHCHECK.on = true;   // road graph validation after generation and every growth tick (dev builds only)
      if (m.nosat) SAT.on = false;
      if (m.nores) { RES.on = false; SQ.on = false; }
      sim = new Sim(m.seed, { terrain: m.terrain as never, origin: m.origin as never });
      sim.speed = 0;   // the clock waits for the start card (the page sends the speed when the player begins)
      post(sim.initMsg());
      postState(sim.snapshot());
      schedule();
      return;
    }
    if (!sim) return;
    if (m.type === 'quote') {
      post({ type: 'quote', id: m.id, ...sim.quoteLine(m.stations) });
      return;
    }
    // Speed, station placement and choices apply immediately so the UI feels responsive;
    // they are recorded in the action log against the current month (deterministic replay).
    const t0 = performance.now();
    sim.apply(m);
    const t1 = performance.now();
    const snap = sim.snapshot();
    snap.perf = { tick: m.type === 'step' ? (t1 - t0) / Math.max(1, m.months) : 0, snap: performance.now() - t1 };
    postState(snap);
    if (m.type === 'speed' || !timer) schedule();
  } catch (e) {
    post({ type: 'error', message: String((e as Error).stack ?? e) });
  }
};
