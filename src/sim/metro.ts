import { N, CELL, METRO_SPEED, TRAIN_CAP, LINE_COLORS } from './constants';
import { quoteLine, type Terr, type LineQuote } from './relief';

export interface Station { id: number; x: number; y: number; name: string; riders: number; underwater: boolean; /** metres below ground level of the platforms (deep stations cost more and add access time) */ depth: number; /** month the station first came into service (-1 while it is only dug) */ opened: number;
  /** round 7, why a station is quiet: cells within an 8-minute walk, homes within it, and homes for which it is the nearest station */
  reach?: number; walkHomes?: number; ownHomes?: number }
export interface Line {
  id: number;
  color: string;
  stations: number[];      // station ids in order
  trains: number;
  segTime: number[];       // minutes per segment (incl. dwell)
  lengthKm: number;
  wetKm: number;
  /** km by construction type: cut-and-cover, bored tunnel, viaduct, under water */
  by: number[];
  /** per segment: rack / funicular (slower) */
  rack: boolean[];
  /** track elevation (m above datum) at each station */
  elev: number[];
  headway: number;
  capacity: number;        // pax / hour / direction
  riders: number;          // boardings / day
  peakLoad: number;        // pax / hour on the busiest segment, busiest direction
  segLoad: number[];
  rating: number;
  crowd: number;           // last month's crowding (load / capacity)
}

interface Node { line: number; pos: number; st: number }

const NAMES = ['Harbour', 'Market', 'Chapel', 'Riverside', 'Cannery', 'Mill Lane', 'Northgate', 'Quay', 'Bellfield', 'Orchard', 'Granary', 'Ropewalk',
  'Lantern', 'Saltworks', 'Ferry', 'Castle', 'Weir', 'Foundry', 'Pier', 'Common', 'Glassworks', 'Tannery', 'Old Toll', 'Meadow', 'Lighthouse', 'Wharf',
  'Abbey', 'Kiln', 'Signal Hill', 'Brewery', 'Cross Street', 'Union', 'Tidegate', 'Marsh End', 'Fishmarket', 'Bridgefoot', 'High Street', 'Customs House'];

export class Metro {
  /** ground heights, set by the sim */
  terr: Terr = { height: new Float32Array(N * N), water: new Uint8Array(N * N) };
  stations: Station[] = [];
  lines: Line[] = [];
  private nextStation = 1;
  private nextLine = 1;
  // graph (rebuilt each tick)
  sIndex = new Map<number, number>();  // station id -> matrix index
  nodes: Node[] = [];
  nodesAt: number[][] = [];            // matrix index -> node ids
  T = new Float64Array(0);             // S x S transit time (min), Infinity if unreachable
  prev: Int32Array[] = [];             // per source: predecessor node for each node
  dist: Float64Array[] = [];           // per source: cost to each node
  bestNode: Int32Array[] = [];         // per source: best arrival node at each target station index

  station(id: number) { return this.stations.find((s) => s.id === id); }
  line(id: number) { return this.lines.find((l) => l.id === id); }
  onLine(id: number) { return this.lines.some((l) => l.stations.includes(id)); }

  addStation(x: number, y: number, water: Uint8Array): Station | null {
    if (x < 0 || y < 0 || x >= N || y >= N || water[Math.floor(y) * N + Math.floor(x)]) return null;
    if (this.stations.some((s) => Math.hypot(s.x - x, s.y - y) < 3)) return null;
    const id = this.nextStation++;
    const s: Station = { id, x, y, name: NAMES[(id - 1) % NAMES.length] + (id > NAMES.length ? ` ${Math.ceil(id / NAMES.length)}` : ''), riders: 0, underwater: false, depth: 0, opened: -1 };
    this.stations.push(s);
    return s;
  }

  removeStation(id: number) {
    if (this.onLine(id)) return false;
    this.stations = this.stations.filter((s) => s.id !== id);
    return true;
  }

  quote(ids: number[]): LineQuote {
    const pts = ids.map((id) => this.station(id)).filter((s): s is Station => !!s);
    return quoteLine(pts, this.terr);
  }

  /** upgrades unlocked by goals: scale of line speed and of train capacity */
  speedMul = 1;
  capMul = 1;

  addLine(ids: number[], month = 0): Line | null {
    const clean = ids.filter((id, k) => this.station(id) && ids.indexOf(id) === k);
    if (clean.length < 2) return null;
    const q = this.quote(clean);
    if (!q.ok) return null;
    clean.forEach((id, k) => { const st = this.station(id)!; st.depth = Math.max(st.depth, q.depth[k]); if (st.opened < 0) st.opened = month; });
    const id = this.nextLine++;
    const roundTrip = (q.km / METRO_SPEED) * 60 * 2 + clean.length * 1 + 4;
    const trains = Math.max(2, Math.round(roundTrip / 5)); // aim for a 5 minute headway
    const used = new Set(this.lines.map((l) => l.color));
    const color = LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[(id - 1) % LINE_COLORS.length];
    const line: Line = { id, color, stations: clean, trains, segTime: [], lengthKm: q.km, wetKm: q.wkm, by: q.by, rack: q.segs.map((g) => g.rack), elev: q.elev, headway: 5, capacity: 0, riders: 0, peakLoad: 0, segLoad: [], rating: 100, crowd: 0 };
    this.lines.push(line);
    this.updateLine(line);
    return line;
  }

  updateLine(l: Line) {
    l.segTime = [];
    let ride = 0;
    for (let k = 1; k < l.stations.length; k++) {
      const a = this.station(l.stations[k - 1])!, b = this.station(l.stations[k])!;
      const km = (Math.hypot(a.x - b.x, a.y - b.y) * CELL) / 1000;
      const t = (km / (METRO_SPEED * this.speedMul)) * 60 * (l.rack[k - 1] ? 1.8 : 1) + 0.6;
      l.segTime.push(t);
      ride += t;
    }
    const roundTrip = ride * 2 + 4;
    l.headway = Math.max(2, roundTrip / Math.max(1, l.trains));
    l.capacity = (60 / l.headway) * TRAIN_CAP * this.capMul;
    if (l.segLoad.length !== l.segTime.length) l.segLoad = l.segTime.map(() => 0);
  }

  /** Rebuild the station graph and all-pairs best times (Dijkstra per source over line-stop nodes). */
  rebuildGraph() {
    for (const l of this.lines) this.updateLine(l);
    const used = this.stations.filter((s) => this.onLine(s.id));
    this.sIndex = new Map(used.map((s, k) => [s.id, k]));
    const S = used.length;
    this.nodes = [];
    this.nodesAt = used.map(() => []);
    this.lines.forEach((l, li) => l.stations.forEach((sid, pos) => {
      const st = this.sIndex.get(sid)!;
      this.nodesAt[st].push(this.nodes.length);
      this.nodes.push({ line: li, pos, st });
    }));
    const M = this.nodes.length;
    // node index lookup: (line, pos) -> node
    const nodeOf = this.lines.map(() => [] as number[]);
    this.nodes.forEach((n, k) => (nodeOf[n.line][n.pos] = k));
    this.T = new Float64Array(S * S).fill(Infinity);
    this.prev = []; this.dist = []; this.bestNode = [];
    const crowdMul = this.lines.map((l) => 1 + Math.min(1.2, Math.max(0, l.crowd - 0.75) * 1.5));
    for (let s = 0; s < S; s++) {
      const dist = new Float64Array(M).fill(Infinity);
      const prev = new Int32Array(M).fill(-1);
      const done = new Uint8Array(M);
      for (const n of this.nodesAt[s]) dist[n] = this.lines[this.nodes[n].line].headway / 2 * crowdMul[this.nodes[n].line];
      for (;;) {
        let u = -1, best = Infinity;
        for (let k = 0; k < M; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
        if (u < 0) break;
        done[u] = 1;
        const nu = this.nodes[u], l = this.lines[nu.line];
        const relax = (v: number, c: number) => { if (c < dist[v]) { dist[v] = c; prev[v] = u; } };
        if (nu.pos + 1 < l.stations.length) relax(nodeOf[nu.line][nu.pos + 1], best + l.segTime[nu.pos] * crowdMul[nu.line]);
        if (nu.pos > 0) relax(nodeOf[nu.line][nu.pos - 1], best + l.segTime[nu.pos - 1] * crowdMul[nu.line]);
        for (const v of this.nodesAt[nu.st]) if (v !== u && this.nodes[v].line !== nu.line)
          relax(v, best + 4 + this.lines[this.nodes[v].line].headway / 2 * crowdMul[this.nodes[v].line]);
      }
      const bn = new Int32Array(S).fill(-1);
      for (let t = 0; t < S; t++) {
        if (t === s) continue;
        let b = Infinity;
        for (const n of this.nodesAt[t]) if (dist[n] < b) { b = dist[n]; bn[t] = n; }
        this.T[s * S + t] = b;
      }
      this.prev.push(prev); this.dist.push(dist); this.bestNode.push(bn);
    }
  }

  /** Walk the best path from s to t (matrix indices), calling seg(line, segIndex, dir) and board(line). */
  tracePath(s: number, t: number, seg: (line: number, k: number, dir: number) => void, board: (line: number) => void) {
    let n = this.bestNode[s][t];
    const prev = this.prev[s];
    let guard = 0;
    while (n >= 0 && guard++ < 500) {
      const p = prev[n];
      const cur = this.nodes[n];
      if (p < 0) { board(cur.line); break; }
      const pn = this.nodes[p];
      if (pn.line === cur.line) seg(cur.line, Math.min(pn.pos, cur.pos), cur.pos > pn.pos ? 1 : -1);
      else board(cur.line); // transfer onto cur.line
      n = p;
    }
  }
}
