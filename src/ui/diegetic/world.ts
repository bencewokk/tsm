import { CELL } from '../../sim/constants';
import type { StateMsg } from '../../sim/protocol';
import type { DiegeticLayer } from './layer';

const abbr = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

/**
 * Turn a state message into the objects pinned on the model: a tag on every station (name, ridership, line), a flag at every running
 * development project, the docks brief at the docks, a tag on each landmark. Called once per state message; the layer pools by id and
 * only re-renders a bitmap when a string changes.
 */
export function syncWorld(ui: DiegeticLayer, s: StateMsg, ground: (x: number, z: number) => number) {
  const keep = new Set<string>();
  const P = (cx: number, cy: number, up: number) => { const x = cx * CELL, z = cy * CELL; return { x, y: ground(x, z) + up, z }; };

  // stations
  const lineOf = new Map<number, number[]>(), colOf = new Map<number, string>();
  for (const l of s.lines) for (const id of l.stations) { (lineOf.get(id) ?? lineOf.set(id, []).get(id)!).push(l.id); if (!colOf.has(id)) colOf.set(id, l.color); }
  for (const st of s.stations) {
    const id = `st:${st.id}`; keep.add(id);
    const lines = lineOf.get(st.id);
    const packed = lines?.some((lid) => (ui.lineLoad.get(lid) ?? 0) > 1);
    ui.tag(id, P(st.x, st.y, 1), {
      title: st.name,
      sub: lines ? `Line ${lines.join(' + ')}${packed ? '  ·  packed' : ''}` : 'dug, not on a line yet',
      badge: lines ? abbr(st.riders) : '',
      color: packed ? '#c0503a' : colOf.get(st.id) ?? '#8a8f94',
      look: 0,
    }, { priority: 10 + Math.min(20, st.riders / 400), far: 8200, full: 3600 });
  }
  ui.sweep('st:', keep);

  // development projects and the docks brief: pinned flags
  keep.clear();
  for (const p of s.projects) {
    if (p.status !== 'proposed' && p.status !== 'assembling' && p.status !== 'building') continue;
    const id = `pr:${p.id}`; keep.add(id);
    ui.pin(id, P(p.x, p.y, 1), { title: p.name, sub: p.status === 'proposed' ? 'decision at City hall' : `${p.phase}${p.pct ? `  ${Math.round(p.pct * 100)}%` : ''}`, color: p.color, look: 1, pct: p.status === 'proposed' ? 0 : p.pct }, { priority: 40, far: 4200, full: 4200 });
  }
  ui.sweep('pr:', keep);
  keep.clear();
  const d = s.docks;
  if (d.state === 'active') {
    keep.add('docks');
    const left = d.deadline - s.stats.month;
    ui.pin('docks', P(d.centre.x, d.centre.y, 1), { title: d.title, sub: `${d.built} of ${d.planned} built  ·  ${left > 0 ? `${left} months left` : 'deadline passed'}`, color: '#b07a2a', look: 1, pct: d.planned ? d.built / d.planned : 0 }, { priority: 60, far: 6200, full: 6200 });
  }
  ui.sweep('docks', keep);

  // landmarks and big assemblies
  keep.clear();
  for (const l of s.landmarks) {
    const id = `lm:${l.id}`; keep.add(id);
    if (l.state === 'building') ui.pin(id, P(l.x, l.y, 1), { title: l.name, sub: `building  ${Math.round(l.pct * 100)}%`, color: '#8a6db0', look: 1, pct: l.pct }, { priority: 35, far: 3800, full: 3800 });
    else ui.tag(id, P(l.x, l.y, 1), { title: l.name, sub: l.served ? 'served' : l.carPark ? 'car park only' : 'no station', color: l.served ? '#4f8fb8' : '#a8a095', look: 0 }, { priority: 4, far: 2400, full: 2400 });
  }
  for (const a of s.assemblies) {
    if (a.kind === 'project') continue;
    const id = `as:${a.id}`; keep.add(id);
    ui.pin(id, P(a.x, a.y, 1), { title: a.label, sub: a.phase === 0 ? `buying plots ${a.acquired}/${a.total}` : 'site works', color: '#c0803a', look: 1, pct: a.pct }, { priority: 30, far: 3200, full: 3200 });
  }
  ui.sweep('lm:', new Set([...keep].filter((k) => k.startsWith('lm:'))));
  ui.sweep('as:', new Set([...keep].filter((k) => k.startsWith('as:'))));
}

/** News slips from the sim's log: a line opening is a headline on the table. (The game-feedback branch emits richer `moment` events; they go through `ui.notify`.) */
export function logSlips(ui: DiegeticLayer, s: StateMsg, seen: Set<string>) {
  const first = seen.size === 0;
  for (const l of s.log) {
    if (seen.has(l)) continue;
    seen.add(l);
    if (first) continue;
    const t = l.slice(l.indexOf('|') + 1);
    if (/opened:/.test(t)) ui.slip(t.split(':')[0], t.slice(t.indexOf(':') + 1).trim(), '#c0503a', true);
  }
}
