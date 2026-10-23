import type { StateMsg, Command } from '../sim/protocol';
import { STATION_COST, TRAIN_COST, LINE_COLORS, METRO_SPEED, segmentCost } from '../sim/constants';
import { money } from './hud';

/** Metro planning: click empty land to dig a station, click stations in order, Enter to build. */
export class Planner {
  draft: number[] = [];
  private pending: { x: number; y: number }[] = [];
  hover: { x: number; y: number } | null = null;

  constructor(private send: (c: Command) => void, private water: Uint8Array) {}

  stationAt(s: StateMsg, x: number, y: number) {
    let best = null as null | { id: number; x: number; y: number }, bd = 2.6;
    for (const st of s.stations) {
      const d = Math.hypot(st.x - x, st.y - y);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  click(s: StateMsg, x: number, y: number) {
    const st = this.stationAt(s, x, y);
    if (st) {
      if (this.draft[this.draft.length - 1] === st.id) return;
      if (this.draft.includes(st.id)) return;
      this.draft.push(st.id);
      return;
    }
    if (this.water[Math.floor(y) * 128 + Math.floor(x)]) return;
    // placeholder keeps click order while the worker digs the station
    this.pending.push({ x, y });
    this.draft.push(-this.pending.length);
    this.send({ type: 'placeStation', x, y });
  }

  /** After each state: attach a freshly dug station to the draft. */
  onState(s: StateMsg) {
    if (this.pending.length) {
      this.draft = this.draft.map((id) => {
        if (id >= 0) return id;
        const c = this.pending[-id - 1];
        const st = c && s.stations.find((q) => q.x === c.x && q.y === c.y);
        return st ? st.id : id;
      });
      if (this.draft.every((id) => id >= 0)) this.pending = [];
    }
    this.draft = this.draft.filter((id, k) => (id < 0 || s.stations.some((q) => q.id === id)) && this.draft.indexOf(id) === k);
    if (this.commitWhenReady > 0) {
      this.commitWhenReady--;
      if (this.commitWhenReady === 0 || this.draft.every((id) => id >= 0)) { this.commitWhenReady = 1; this.commit(); }
    }
  }

  undo() { this.draft.pop(); }
  cancel() { this.draft = []; this.pending = []; }

  private commitWhenReady = 0;

  commit() {
    if (this.draft.some((id) => id < 0) && this.commitWhenReady === 0) { this.commitWhenReady = 3; return; }
    this.commitWhenReady = 0;
    this.draft = this.draft.filter((id) => id >= 0);
    this.pending = [];
    if (this.draft.length >= 2) this.send({ type: 'buildLine', stations: this.draft.slice() });
    this.draft = [];
  }

  points(s: StateMsg) {
    return this.draft.map((id) => (id < 0 ? this.pending[-id - 1] : s.stations.find((q) => q.id === id)!)).filter(Boolean);
  }

  color(s: StateMsg) {
    const used = new Set(s.lines.map((l) => l.color));
    return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[0];
  }

  quote(s: StateMsg) {
    const pts = this.points(s);
    let km = 0, wkm = 0, cost = 0;
    for (let k = 1; k < pts.length; k++) {
      const c = segmentCost(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y, this.water);
      km += c.km; wkm += c.wkm; cost += c.cost;
    }
    const roundTrip = (km / METRO_SPEED) * 60 * 2 + pts.length + 4;
    const trains = Math.max(2, Math.round(roundTrip / 5));
    return { km, wkm, cost: cost + trains * TRAIN_COST, trains };
  }

  hint(s: StateMsg): string {
    if (!this.draft.length) return `Click anywhere on land to dig a station (${money(STATION_COST)}), or click existing stations in order. Blue = within an 8-minute walk over the streets. Drag to pan, wheel to zoom.`;
    const q = this.quote(s);
    const water = q.wkm > 0.05 ? `, <b>${q.wkm.toFixed(1)} km under water</b>` : '';
    const ok = q.cost <= s.stats.money;
    return `Line draft: ${this.draft.length} stations, ${q.km.toFixed(1)} km${water}, ${q.trains} trains. Cost <b class="${ok ? '' : 'neg'}">${money(q.cost)}</b>. ` +
      `<b>Enter</b> build · <b>Backspace</b> undo · <b>Esc</b> cancel`;
  }
}
