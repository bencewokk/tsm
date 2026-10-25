/**
 * Gameplay feedback events: the one place the game announces things the player should feel (a line opened, an objective moved, fares came
 * in, a line is overcrowded, a plan's cost changed, an undo refunded). Pure data and a tiny bus: no DOM, no Three.js. Presenters subscribe
 * with `gameEvents.on(kind, fn)` (or `onAny`): the diegetic layer (src/ui/diegetic, `ui.notify`: newspaper, clipboard, slips, briefs,
 * coin pops, station tags; mapping in VISUAL-PASS.md section 5), src/ui/sound.ts (`bindSound`), and the world layer in main.ts (ripple,
 * goal marker, camera). Presenters only read these payloads. Every event also carries the sim month it belongs to.
 */
import type { GoalInfo, Moment } from '../sim/goals';

export type GameEvent =
  /** A station came into service. `catchmentBefore` / `catchmentAfter` are walk-minute rasters (minutes x 10, 255 = out of reach, N x N cells); a cell with a lower value after than before is newly (better) served: that difference is the access gained. */
  | { kind: 'stationOpened'; month: number; stationId: number; name: string; x: number; y: number; lineId: number; color: string; catchmentBefore: Uint8Array | null; catchmentAfter: Uint8Array }
  /** A line was built and opened (the ribbon-cutting). `moment` has the headline text and the line's centre. */
  | { kind: 'lineOpened'; month: number; lineId: number; color: string; moment: Moment }
  /** Any newsworthy beat: line opened, first riders, cranes at a station, first tower, overcrowding, goal reached. `big` = headline-sized. */
  | { kind: 'moment'; month: number; moment: Moment }
  /** Objective progress: the active goal of each track (network / riders / city) and the count of goals done. Emitted when any number changes. */
  | { kind: 'objectives'; month: number; goals: GoalInfo[]; done: number; total: number; hasLines: boolean }
  /** A goal was reached (also arrives as a 'moment' of kind 'goal'): id of the goal, its reward text and the unlocks now active. */
  | { kind: 'objectiveReached'; month: number; moment: Moment; unlocks: string[] }
  /** A station's fares for the month (shown as a coin pop). `amount` is dollars for the month, `riders` trips a day. */
  | { kind: 'fare'; month: number; stationId: number; x: number; y: number; amount: number; riders: number }
  /** Per-line load: load = peak load / capacity (above 1 the platforms are packed and the rating falls). Emitted when a line's load bucket or rating changes. */
  | { kind: 'crowding'; month: number; lines: { id: number; color: string; load: number; rating: number }[] }
  /** The drafted line's cost, for a cost preview. `paidForStations` is already spent on stations dug while planning (refunded by undo / cancel). */
  | { kind: 'planCost'; draftStations: number; km: number; cost: number; paidForStations: number; money: number; affordable: boolean; notice: string; trains: number }
  /** A station was dug while planning. */
  | { kind: 'stationDug'; x: number; y: number; cost: number }
  /** Planning stations were taken back: `refund` dollars returned in full. */
  | { kind: 'undo'; stationIds: number[]; refund: number }
  /** The clock mode changed: held (stopped until the first line), planning (paused while planning), paused, running; `auto` = Auto speed is on. */
  | { kind: 'clock'; mode: 'held' | 'planning' | 'paused' | 'running'; speed: number; auto: boolean };

export type GameEventKind = GameEvent['kind'];
type Of<K extends GameEventKind> = Extract<GameEvent, { kind: K }>;

class Bus {
  private by = new Map<GameEventKind, ((e: GameEvent) => void)[]>();
  private any: ((e: GameEvent) => void)[] = [];
  on<K extends GameEventKind>(kind: K, fn: (e: Of<K>) => void) {
    const l = this.by.get(kind) ?? [];
    l.push(fn as (e: GameEvent) => void);
    this.by.set(kind, l);
    return () => { const i = l.indexOf(fn as (e: GameEvent) => void); if (i >= 0) l.splice(i, 1); };
  }
  onAny(fn: (e: GameEvent) => void) { this.any.push(fn); }
  emit(e: GameEvent) {
    for (const f of this.by.get(e.kind) ?? []) f(e);
    for (const f of this.any) f(e);
  }
}
export const gameEvents = new Bus();
