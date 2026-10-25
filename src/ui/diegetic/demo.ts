import type { StateMsg } from '../../sim/protocol';
import type { DiegeticLayer } from './layer';
import type { DiegeticEvent, MomentLike } from './events';

/**
 * Dev helper (`tsm.fun(kind)` in the console): fires a sample of each event of the fun-pass contract through `ui.notify`, with positions
 * taken from the current state, so every presentation can be looked at without the gameplay branch. Presentation only.
 */
export function demoEvent(ui: DiegeticLayer, s: StateMsg, kind: DiegeticEvent['kind'] | 'all'): string {
  const st = s.stations[0] ?? { id: 0, x: 60, y: 90, name: 'Chapel', riders: 5000 };
  const st2 = s.stations[1] ?? st;
  const mom = (over: Partial<MomentLike>): MomentLike => ({ kind: 'news', title: 'Headline', text: 'Body text.', color: '#b4402d', x: st.x, y: st.y, big: false, ...over });
  const samples: Record<DiegeticEvent['kind'], DiegeticEvent[]> = {
    stationOpened: [{ kind: 'stationOpened', stationId: st.id, name: st.name, x: st.x, y: st.y, color: '#c0392b', lineId: 1 }],
    lineOpened: [{ kind: 'lineOpened', lineId: 1, color: '#c0392b', moment: mom({ kind: 'open', big: true, title: 'Line 1 opens: 987 homes and 4,111 jobs within an 8-minute walk', text: 'The ribbon was cut at Chapel at noon. Trains run every five minutes, and the first riders crowded the platforms before the speeches were over.' }) }],
    moment: [{ kind: 'moment', moment: mom({ kind: 'tower', title: 'A 62 m tower tops out by ' + st2.name, text: 'The crane comes down next week.', x: st2.x, y: st2.y, color: '#7a6bb0', ref: 'demo-tower' }) }],
    objectives: [{ kind: 'objectives', done: 3, total: 22, hasLines: true, goals: [
      { id: 'g1', track: 'network', title: 'Open a second line', cur: 1, target: 2, unit: 'n', reward: '$20M grant', x: st2.x, y: st2.y },
      { id: 'g2', track: 'riders', title: 'Carry 5k trips a day', cur: 3200, target: 5000, unit: 'k', reward: '$10M grant' },
      { id: 'g3', track: 'city', title: 'A 60 m tower by a station', cur: 42, target: 60, unit: 'n', reward: '$8M grant' },
    ] }],
    objectiveReached: [{ kind: 'objectiveReached', unlocks: ['signals'], moment: mom({ kind: 'goal', title: 'Goal reached: 4 stations', text: 'The council releases a $10M grant.', color: '#c9a227' }) }],
    fare: [{ kind: 'fare', stationId: st.id, x: st.x, y: st.y, amount: 89000, riders: st.riders }],
    crowding: [{ kind: 'crowding', lines: s.lines.map((l) => ({ id: l.id, color: l.color, load: 1.25, rating: 60 })) }],
    planCost: [{ kind: 'planCost', cost: 48e6, km: 5.4, affordable: true, notice: '', trains: 4 }],
    stationDug: [{ kind: 'stationDug', x: st2.x + 2, y: st2.y + 2, cost: 5e6 }],
    undo: [{ kind: 'undo', refund: 5e6 }],
    clock: [{ kind: 'clock', mode: 'planning', speed: 1, auto: false }],
  };
  const list = kind === 'all' ? Object.values(samples).flat() : samples[kind];
  list.forEach((e, i) => setTimeout(() => ui.notify(e), i * 250));
  return `${list.length} event(s)`;
}
