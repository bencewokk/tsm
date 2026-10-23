/// <reference lib="webworker" />
import { Sim } from './sim';
import type { Command, WorkerOut } from './protocol';

let sim: Sim | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

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
    if (!sim.paused()) sim.tick();
    post(sim.snapshot());
  } catch (e) {
    post({ type: 'error', message: String((e as Error).stack ?? e) });
  }
  schedule();
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as Command | { type: 'start'; seed: number; terrain?: string; origin?: string } | { type: 'quote'; id: number; stations: number[] };
  try {
    if (m.type === 'start') {
      sim = new Sim(m.seed, { terrain: m.terrain as never, origin: m.origin as never });
      post(sim.initMsg());
      post(sim.snapshot());
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
    sim.apply(m);
    post(sim.snapshot());
    if (m.type === 'speed' || !timer) schedule();
  } catch (e) {
    post({ type: 'error', message: String((e as Error).stack ?? e) });
  }
};
