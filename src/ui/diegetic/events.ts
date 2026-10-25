/**
 * The events the diegetic layer presents. The shapes are the game-feedback contract of the fun-pass branch (`src/ui/gameEvents.ts`,
 * DESIGN-FUN.md section 3), declared here structurally so that a `GameEvent` can be passed to `ui.notify` as is (extra fields are
 * ignored) without importing a module that is not on this branch. `x` / `y` are cell units everywhere, as in the sim.
 *
 * Wiring once the branches meet (one line in main.ts):
 *     gameEvents.onAny((e) => dg?.notify(e));
 * and remove the placeholder DOM presenter (`feedback.ts`), which would otherwise show every beat twice.
 */
export interface MomentLike {
  kind?: string;
  title: string;
  text: string;
  color: string;
  x: number; y: number;
  /** headline-sized: a newspaper front page rather than a slip */
  big: boolean;
  ref?: string;
}
export interface GoalLike {
  id: string;
  track?: string;
  title: string;
  text?: string;
  cur: number;
  target: number;
  unit?: 'n' | 'k' | 'pct' | 'mo';
  reward?: string;
  /** the first goal points at a place (cell units) while it is open */
  x?: number; y?: number;
}

export type DiegeticEvent =
  | { kind: 'stationOpened'; stationId?: number; name: string; x: number; y: number; color: string; lineId?: number }
  | { kind: 'lineOpened'; lineId?: number; color: string; moment: MomentLike }
  | { kind: 'moment'; moment: MomentLike }
  | { kind: 'objectives'; goals: GoalLike[]; done: number; total: number; hasLines?: boolean }
  | { kind: 'objectiveReached'; moment: MomentLike; unlocks?: string[] }
  | { kind: 'fare'; stationId?: number; x: number; y: number; amount: number; riders?: number }
  | { kind: 'crowding'; lines: { id: number; color: string; load: number; rating?: number }[] }
  | { kind: 'planCost'; cost: number; km: number; affordable: boolean; notice: string; draftStations?: number; trains?: number }
  | { kind: 'stationDug'; x: number; y: number; cost: number }
  | { kind: 'undo'; stationIds?: number[]; refund: number }
  | { kind: 'clock'; mode: 'held' | 'planning' | 'paused' | 'running'; speed: number; auto: boolean };

export type DiegeticEventKind = DiegeticEvent['kind'];

/** subscribe a layer to anything with `onAny` (the fun-pass `gameEvents` bus) */
export function bindEvents(ui: { notify(e: DiegeticEvent): void }, bus: { onAny(fn: (e: DiegeticEvent) => void): void }) {
  bus.onAny((e) => ui.notify(e));
}
