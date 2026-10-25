import { CELL } from '../../sim/constants';
import type { StateMsg } from '../../sim/protocol';
import type { DiegeticLayer } from './layer';

const abbr = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

/** Peak-hour load (peak / capacity, 1 = every seat taken) of the busiest line through each station: the crowds at the entrances grow and pack with it. */
export function stationLoads(s: StateMsg): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of s.lines) {
    const load = l.capacity > 0 ? l.peakLoad / l.capacity : 0;
    for (const id of l.stations) out.set(id, Math.max(out.get(id) ?? 0, load));
  }
  return out;
}

/** why a station on a line carries (almost) nobody: what its walk catchment reaches */
function quiet(st: StateMsg['stations'][number], month: number) {
  if ((st.reach ?? 99) < 20) return 'no street within reach';
  if ((st.walkHomes ?? 0) > 150 && (st.ownHomes ?? 0) < 40) return 'a nearer station takes its streets';
  if ((st.walkHomes ?? 0) < 150) return st.opened >= 0 && month - st.opened < 24 ? 'new: empty land, waiting for growth' : 'empty land round it';
  return 'few trips to anywhere on the line';
}

/**
 * Turn a state message into the objects pinned on the model: a tag on every station (name, ridership, line), a flag at every running
 * development project, the docks brief at the docks, a tag on each landmark. Called once per state message; the layer pools by id and
 * only re-renders a bitmap when a string changes.
 */
export function syncWorld(ui: DiegeticLayer, s: StateMsg, ground: (x: number, z: number) => number) {
  ui.ground = ground;
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
      sub: lines ? `Line ${lines.join(' + ')}${packed ? '  ·  packed' : ''}${st.riders < 50 ? `  ·  ${quiet(st, s.stats.month)}` : ''}` : 'dug, not on a line yet',
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
    // round 7: a small site pin (a dot far away, one short line close in), never as loud as a district or a station; a decision waiting
    // at City hall keeps the flag
    if (p.status === 'proposed') ui.pin(id, P(p.x, p.y, 1), { title: p.name, sub: 'decision at City hall', color: p.color, look: 1, pct: 0 }, { priority: 40, far: 5200, full: 5200 });
    else ui.pin(id, P(p.x, p.y, 1), { title: p.name, sub: `${p.phase}${p.pct ? ` ${Math.round(p.pct * 100)}%` : ''}`, color: p.color, look: 4, pct: p.pct }, { priority: 6, far: 6000, full: 1500, stick: 16 });
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
    if (l.state === 'building') ui.pin(id, P(l.x, l.y, 1), { title: l.name, sub: `building ${Math.round(l.pct * 100)}%`, color: '#8a6db0', look: 4, pct: l.pct }, { priority: 7, far: 6000, full: 1800, stick: 16 });
    else ui.tag(id, P(l.x, l.y, 1), { title: l.name, sub: l.served ? 'served' : l.carPark ? 'car park only' : 'no station', color: l.served ? '#4f8fb8' : '#a8a095', look: 0 }, { priority: 4, far: 2400, full: 2400 });
  }
  for (const a of s.assemblies) {
    if (a.kind === 'project') continue;
    const id = `as:${a.id}`; keep.add(id);
    ui.pin(id, P(a.x, a.y, 1), { title: a.label.replace(/^Residential tower/, 'Tower').replace(/^Office tower/, 'Offices'), sub: a.phase === 0 ? `buying ${a.acquired}/${a.total}` : '', color: '#c0803a', look: 4, pct: a.pct }, { priority: 5, far: 5000, full: 1300, stick: 14 });
  }
  ui.sweep('lm:', new Set([...keep].filter((k) => k.startsWith('lm:'))));
  ui.sweep('as:', new Set([...keep].filter((k) => k.startsWith('as:'))));
}
