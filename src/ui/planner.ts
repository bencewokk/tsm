import type { StateMsg, Command } from '../sim/protocol';
import { STATION_COST, TRAIN_COST, LINE_COLORS, METRO_SPEED, BUS_STOP_COST, BUS_COST } from '../sim/constants';
import { quoteLine, RELIEF, SEG_NAMES, type Terr, type LineQuote } from '../sim/relief';
import { money } from './hud';
import { gameEvents } from './gameEvents';

/** Metro planning: click empty land to dig a station, click stations in order, Enter to build. */
export class Planner {
  draft: number[] = [];
  /** round 7 step 4: 'bus' plans a bus line (stops on streets, the route follows the streets); B toggles it in plan mode */
  mode: 'metro' | 'bus' = 'metro';
  setMode(m: 'metro' | 'bus') { if (m === this.mode) return; this.cancel(); this.mode = m; }
  private all(s: StateMsg) { return this.mode === 'bus' ? s.stations.concat(s.stops ?? []) : s.stations; }
  private unit() { return this.mode === 'bus' ? BUS_STOP_COST : STATION_COST; }
  private pending: { x: number; y: number }[] = [];
  /** states seen since a placeholder was added: one the sim never fills (it refused the site) is dropped with a reason */
  private pendingAge = 0;
  hover: { x: number; y: number } | null = null;
  /** why the last Enter did not build (shown in the hint; the draft is kept so it can be fixed) */
  notice = '';
  private last: StateMsg | null = null;
  /** stations dug while planning that are not on a line yet: Backspace / Esc / leaving plan mode gives the full price back */
  dug = new Set<number>();

  private water: Uint8Array;
  constructor(private send: (c: Command) => void, private terr: Terr) { this.water = terr.water; }

  stationAt(s: StateMsg, x: number, y: number) {
    let best = null as null | { id: number; x: number; y: number }, bd = this.mode === 'bus' ? 2.0 : 3.05;
    for (const st of this.all(s)) {
      const d = Math.hypot(st.x - x, st.y - y);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  click(s: StateMsg, x: number, y: number) {
    this.notice = '';
    const st = this.stationAt(s, x, y);
    if (st) {
      if (this.draft[this.draft.length - 1] === st.id) return;
      if (this.draft.includes(st.id)) return;
      this.draft.push(st.id);
      return;
    }
    if (this.water[Math.floor(y) * 128 + Math.floor(x)]) return;
    if (s.stats.money < this.unit()) { this.notice = `Not enough money for another ${this.mode === 'bus' ? 'stop' : 'station'} (${money(this.unit())}).`; return; }
    gameEvents.emit({ kind: 'stationDug', x, y, cost: this.unit() });
    // placeholder keeps click order while the worker digs the station
    this.pending.push({ x, y });
    this.pendingAge = 0;
    this.draft.push(-this.pending.length);
    this.send(this.mode === 'bus' ? { type: 'placeStation', x, y, kind: 'bus' } : { type: 'placeStation', x, y });
  }

  /** After each state: attach a freshly dug station to the draft. */
  onState(s: StateMsg) {
    this.last = s;
    if (this.pending.length) {
      this.draft = this.draft.map((id) => {
        if (id >= 0) return id;
        const c = this.pending[-id - 1];
        const st = c && this.all(s).find((q) => q.x === c.x && q.y === c.y);
        if (st) this.dug.add(st.id);
        return st ? st.id : id;
      });
      if (this.draft.every((id) => id >= 0)) this.pending = [];
      else if (++this.pendingAge >= 4 && !this.commitWhenReady) {
        this.draft = this.draft.filter((id) => id >= 0); this.pending = [];
        this.notice = this.mode === 'bus' ? 'No stop there: a bus stop needs a street within about 75 m and 100 m from the next stop.' : 'No station there: the site was refused.';
      }
    }
    this.draft = this.draft.filter((id, k) => (id < 0 || this.all(s).some((q) => q.id === id)) && this.draft.indexOf(id) === k);
    if (this.commitWhenReady > 0) {
      this.commitWhenReady--;
      if (this.commitWhenReady === 0 || this.draft.every((id) => id >= 0)) { this.commitWhenReady = 1; this.commit(); }
    }
  }

  /** Take a station dug in this planning session back (full refund); stations that were already on the map stay. */
  private refund(id: number) {
    if (id >= 0 && this.dug.delete(id)) this.send({ type: 'removeStation', id, full: true });
  }
  private announceUndo(ids: number[]) { if (ids.length) gameEvents.emit({ kind: 'undo', stationIds: ids, refund: ids.length * this.unit() }); }
  undo() { const id = this.draft.pop(); if (id !== undefined) { const was = id >= 0 && this.dug.has(id); this.refund(id); if (was) this.announceUndo([id]); } this.notice = ''; }
  cancel() {
    const ids = new Set<number>([...this.draft.filter((id) => id >= 0 && this.dug.has(id)), ...this.dug]);
    for (const id of ids) this.refund(id);
    this.announceUndo([...ids]);
    this.draft = []; this.pending = []; this.notice = '';
  }

  /** The draft's cost as data (for the preview and for any presenter). */
  costInfo(s: StateMsg) {
    const r = this.quote(s), q = r.q;
    const paid = this.draft.filter((id) => this.dug.has(id)).length * this.unit();
    return { kind: 'planCost' as const, draftStations: this.draft.length, km: r.km, cost: r.cost, paidForStations: paid, money: s.stats.money, affordable: r.cost <= s.stats.money && (!q || q.ok), notice: this.notice, trains: r.trains };
  }

  private commitWhenReady = 0;

  commit() {
    if (this.draft.some((id) => id < 0) && this.commitWhenReady === 0) { this.commitWhenReady = 3; return; }
    this.commitWhenReady = 0;
    this.draft = this.draft.filter((id) => id >= 0);
    this.pending = [];
    if (this.draft.length < 2) { this.notice = 'A line needs at least two stations.'; return; }
    // refuse here with a reason (and keep the draft) instead of sending a command the sim will silently reject and then wiping the draft
    if (this.last) {
      const r = this.quote(this.last);
      if (r.q && !r.q.ok) { this.notice = `Cannot build: segment ${r.q.badSeg + 1} is too steep. Add a station on easier ground, or Backspace.`; return; }
      if (r.cost > this.last.stats.money) { this.notice = `Not enough money: the line costs ${money(r.cost)}, you have ${money(this.last.stats.money)}. Backspace removes the last station, or wait for more income.`; return; }
    }
    this.notice = '';
    this.send(this.mode === 'bus' ? { type: 'buildLine', stations: this.draft.slice(), mode: 'bus' } : { type: 'buildLine', stations: this.draft.slice() });
    this.dug.clear();
    this.draft = [];
  }

  points(s: StateMsg) {
    return this.draft.map((id) => (id < 0 ? this.pending[-id - 1] : this.all(s).find((q) => q.id === id)!)).filter(Boolean);
  }

  color(s: StateMsg) {
    const used = new Set(s.lines.map((l) => l.color));
    return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[0];
  }

  /** Vertical profile and cost of the draft (plus the hovered point as a trial next station). */
  profile(s: StateMsg, withHover = false): LineQuote | null {
    if (this.mode === 'bus') return null;
    const pts = this.points(s).map((p) => ({ x: p.x, y: p.y }));
    if (withHover && this.hover && pts.length) pts.push({ x: this.hover.x, y: this.hover.y });
    return pts.length >= 2 ? quoteLine(pts, this.terr) : null;
  }

  quote(s: StateMsg) {
    if (this.mode === 'bus') {
      // buses: the street route is about a quarter longer than the straight line; enough buses for an 8-minute wait
      const pts = this.points(s);
      let km = 0;
      for (let k = 1; k < pts.length; k++) km += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) * 0.05 * 1.25;
      const trains = Math.max(2, Math.round((km / 20 * 60 * 2 + pts.length + 6) / 8));
      return { km, wkm: 0, cost: trains * BUS_COST, trains, q: null as LineQuote | null };
    }
    const q = this.profile(s);
    const km = q?.km ?? 0, wkm = q?.wkm ?? 0;
    const pts = this.points(s);
    const roundTrip = (km / METRO_SPEED) * 60 * 2 + pts.length + 4;
    const trains = Math.max(2, Math.round(roundTrip / 5));
    return { km, wkm, cost: (q?.cost ?? 0) + trains * TRAIN_COST, trains, q };
  }

  hint(s: StateMsg): string {
    if (this.mode === 'bus') {
      if (!this.draft.length) return `<b>Bus planning</b> (B switches back to the metro). Click a street to place a stop (${money(BUS_STOP_COST)}), or click existing stops and metro stations in order; the route follows the streets and runs in their traffic until you give it priority or a busway (Lines panel).`;
      const r = this.quote(s), ok = r.cost <= s.stats.money;
      const warn = this.notice ? `<b class="neg">${this.notice}</b><br>` : '';
      return `${warn}Bus line draft: ${this.draft.length} stops, about ${r.km.toFixed(1)} km of street, ${r.trains} buses. Cost <b class="${ok ? '' : 'neg'}">${money(r.cost)}</b>, you have ${money(s.stats.money)}. <b>Enter</b> build · <b>Backspace</b> undo · <b>Esc</b> cancel · <b>B</b> metro`;
    }
    if (!this.draft.length) return `<b>Time is paused while you plan.</b> Click anywhere on land to dig a station (${money(STATION_COST)}), or click existing stations in order. Blue = within an 8-minute walk over the streets (slower uphill). Drag to pan, wheel to zoom. <b>B</b>: plan a bus line instead.`;
    const r = this.quote(s);
    const q = r.q;
    const ok = r.cost <= s.stats.money && (!q || q.ok);
    let types = '';
    if (q) {
      const parts = q.by.map((km, k) => (km > 0.05 ? `${km.toFixed(1)} km ${SEG_NAMES[k]}` : '')).filter(Boolean);
      if (parts.length) types = ` (${parts.join(', ')})`;
    }
    let extra = '';
    if (q) {
      const dmax = Math.max(0, ...q.depth), gmax = Math.max(0, ...q.segs.map((g) => Math.abs(g.grade)));
      if (dmax > 6) extra += ` Deepest station ${dmax.toFixed(0)} m (+${money(q.stationCost)}, longer walk to the platform).`;
      if (gmax > 0.005) extra += ` Steepest grade ${(gmax * 100).toFixed(1)}% (metro limit ${(RELIEF.maxGrade * 100).toFixed(0)}%, rack railway up to ${(RELIEF.maxRack * 100).toFixed(0)}%).`;
      if (q.by[4] > 0.05) extra += ` ${q.by[4].toFixed(1)} km is steeper than the metro limit and is built as a rack railway / funicular (x${RELIEF.rackMult} cost, slow).`;
      if (!q.ok) extra += ` <b class="neg">Too steep: segment ${q.badSeg + 1} climbs more than ${(RELIEF.maxRack * 100).toFixed(0)}%; add a station on easier ground.</b>`;
    }
    const warn = this.notice ? `<b class="neg">${this.notice}</b><br>` : '';
    const paid = this.draft.filter((id) => this.dug.has(id)).length * STATION_COST;
    return `${warn}Line draft: ${this.draft.length} stations, ${r.km.toFixed(1)} km${types}, ${r.trains} trains. Cost <b class="${ok ? '' : 'neg'}">${money(r.cost)}</b>${paid ? ` (+ ${money(paid)} already paid for new stations; Backspace / Esc refunds them)` : ''}, you have ${money(s.stats.money)}.${extra} ` +
      `<b>Enter</b> build · <b>Backspace</b> undo · <b>Esc</b> cancel`;
  }
}
