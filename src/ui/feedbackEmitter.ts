/**
 * Turns consecutive sim snapshots into gameplay feedback events (gameEvents.ts). Pure logic: no DOM, no Three.js, no randomness.
 * Call `onState(previous, next)` for every state message; every event is emitted from here.
 */
import type { StateMsg } from '../sim/protocol';
import { FARE } from '../sim/constants';
import { gameEvents } from './gameEvents';

export class FeedbackEmitter {
  private seenSeq = -1;
  private objSig = '';
  private crowdSig = '';

  onState(prev: StateMsg | null, s: StateMsg) {
    const month = s.stats.month;

    // objectives: whenever a number moved
    const sig = JSON.stringify([s.goals.map((g) => [g.id, Math.round(g.cur * 1000), g.target]), s.goalsDone, s.lines.length]);
    if (sig !== this.objSig) {
      this.objSig = sig;
      gameEvents.emit({ kind: 'objectives', month, goals: s.goals, done: s.goalsDone, total: s.goalsTotal, hasLines: s.lines.length > 0 });
    }

    // a station came into service: how much access it brought is the difference of the two catchment rasters
    if (prev) {
      for (const st of s.stations) {
        if (st.opened < 0) continue;
        const before = prev.stations.find((q) => q.id === st.id);
        if (before && before.opened >= 0) continue;
        const line = s.lines.find((l) => l.stations.includes(st.id));
        gameEvents.emit({ kind: 'stationOpened', month, stationId: st.id, name: st.name, x: st.x, y: st.y, lineId: line?.id ?? 0, color: line?.color ?? '#2f7fc1', catchmentBefore: prev.catchment, catchmentAfter: s.catchment });
      }
    }

    // moments (each has a unique seq; the first snapshot only records what already happened)
    if (this.seenSeq < 0) this.seenSeq = s.moments.reduce((a, m) => Math.max(a, m.seq), 0);
    else for (const m of s.moments) {
      if (m.seq <= this.seenSeq) continue;
      this.seenSeq = m.seq;
      if (m.kind === 'open') gameEvents.emit({ kind: 'lineOpened', month: m.month, lineId: Number(m.ref) || 0, color: m.color, moment: m });
      if (m.kind === 'goal') gameEvents.emit({ kind: 'objectiveReached', month: m.month, moment: m, unlocks: s.unlocks });
      gameEvents.emit({ kind: 'moment', month: m.month, moment: m });
    }

    // fares: once per month, each busy station's income for the month
    if (prev && prev.stats.month !== month && s.speed > 0 && (s.speed < 10 || month % 3 === 0)) {
      const busy = s.stations.filter((st) => st.opened >= 0 && st.riders >= 250).sort((a, b) => b.riders - a.riders).slice(0, 10);
      for (const st of busy) gameEvents.emit({ kind: 'fare', month, stationId: st.id, x: st.x, y: st.y, amount: st.riders * FARE * 30, riders: st.riders });
    }

    // crowding: load buckets of 10%
    const lines = s.lines.map((l) => ({ id: l.id, color: l.color, load: l.capacity > 0 ? l.peakLoad / l.capacity : 0, rating: l.rating }));
    const cs = JSON.stringify(lines.map((l) => [l.id, Math.round(l.load * 10), Math.round(l.rating / 10)]));
    if (cs !== this.crowdSig) { this.crowdSig = cs; if (lines.length) gameEvents.emit({ kind: 'crowding', month, lines }); }
  }
}
