import { N, CELL, METRO_SPEED, TRAIN_CAP, LINE_COLORS, TRAM_CAP } from './constants';
import { quoteLine, type Terr, type LineQuote } from './relief';

/**
 * Round 7 step 5: one transit graph for every mode (metro lines and bus lines over shared stations and stops). A journey costs
 * walk (at each end, from the trip model) + expected wait + in-vehicle time + transfer penalties + crowding. A change of vehicle at the
 * same station costs `xferSame`; a change to a different stop or station up to `xferCells` away walks there along the street (x1.3 at
 * 75 m a minute) and adds `xferWalk`. The expected wait is half the headway up to 12 minutes; past that people time their arrival, so
 * only a quarter of the extra counts. Crowding scales a packed line's in-vehicle time and wait (`crowdMul`).
 */
export const JOURNEY = {
  xferSame: 4,
  xferCells: 3.2,
  xferWalk: 5,
  walkMPerMin: 75,
  waitOf(h: number) { return h <= 12 ? h / 2 : 6 + (h - 12) / 4; },
};

export interface Station { id: number; x: number; y: number; name: string; riders: number; underwater: boolean; /** metres below ground level of the platforms (deep stations cost more and add access time) */ depth: number; /** month the station first came into service (-1 while it is only dug) */ opened: number;
  /** round 7, why a station is quiet: cells within an 8-minute walk, homes within it, and homes for which it is the nearest station */
  reach?: number; walkHomes?: number; ownHomes?: number;
  /** round 7 step 4b: a bus stop (kept in Metro.stops, never in stations) */
  bus?: boolean }
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
  /** round 7 step 4b: 'bus' lines run on the streets (Metro.buses); lane 0 ordinary traffic, 1 bus priority, 2 busway */
  mode?: 'metro' | 'bus';
  lane?: number;
  /** bus lines: the street edges of each segment, and the street km */
  path?: number[][];
  /** first street node of each segment's path (a tram's path starts at the nearest node on a wide street) */
  pathFrom?: number[];
  /** round 7 step 6, on a busway: whether a tram fits (a route on arterials / collectors no more than 1.5x the bus route) */
  tramCheck?: { ok: boolean; km: number; why: string };
  inherited?: boolean;
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
  /** round 7 step 4b: bus stops and bus lines (kept apart so everything metro-only still reads `stations` / `lines`) */
  stops: Station[] = [];
  buses: Line[] = [];
  /** every line in the transit graph (metro then bus), rebuilt with the graph; node.line indexes this */
  net: Line[] = [];
  /** minutes for bus segment k of a line (set by the sim: street times in traffic, by lane) */
  busTime: ((l: Line, k: number) => number) | null = null;
  private nextStop = 1;
  private nextBus = 1;
  private nextStation = 1;
  private nextLine = 1;
  // graph (rebuilt each tick)
  sIndex = new Map<number, number>();  // station id -> matrix index
  nodes: Node[] = [];
  nodesAt: number[][] = [];            // matrix index -> node ids
  T = new Float64Array(0);             // S x S transit time (min), Infinity if unreachable
  /** per station index: the stations / stops a walking transfer reaches, with its minutes (walk + penalty) */
  xferNear: { k: number; t: number }[][] = [];
  prev: Int32Array[] = [];             // per source: predecessor node for each node
  dist: Float64Array[] = [];           // per source: cost to each node
  bestNode: Int32Array[] = [];         // per source: best arrival node at each target station index
  /** per station pair (S x S), the best journey's parts in minutes: wait, in-vehicle, transfer penalties (incl. the walk between
   *  stops), crowding (the extra from packed lines); the number of changes; and the modes used (bit 1 metro, bit 2 bus, bit 4 tram) */
  jWait = new Float32Array(0); jRide = new Float32Array(0); jXfer = new Float32Array(0); jCrowd = new Float32Array(0);
  jChanges = new Uint8Array(0); jModes = new Uint8Array(0);

  station(id: number) { return this.stations.find((s) => s.id === id) ?? (id >= 10000 ? this.stops.find((s) => s.id === id) : undefined); }
  line(id: number) { return this.lines.find((l) => l.id === id) ?? this.buses.find((l) => l.id === id); }
  onLine(id: number) { return this.lines.some((l) => l.stations.includes(id)); }
  /** on any line of the transit graph, metro or bus */
  onNet(id: number) { return this.lines.some((l) => l.stations.includes(id)) || this.buses.some((l) => l.stations.includes(id)); }

  /** A bus stop (ids from 10000): at least 2 cells from another stop; it may stand next to a metro station (an interchange). */
  addStop(x: number, y: number, water: Uint8Array): Station | null {
    if (x < 0 || y < 0 || x >= N || y >= N || water[Math.floor(y) * N + Math.floor(x)]) return null;
    if (this.stops.some((s) => Math.hypot(s.x - x, s.y - y) < 2)) return null;
    const id = 10000 + this.nextStop++;
    const s: Station = { id, x, y, name: `${NAMES[(id * 7) % NAMES.length]} stop`, riders: 0, underwater: false, depth: 0, opened: -1, bus: true };
    this.stops.push(s);
    return s;
  }
  removeStop(id: number) {
    if (this.buses.some((l) => l.stations.includes(id))) return false;
    this.stops = this.stops.filter((s) => s.id !== id);
    return true;
  }

  /** A bus line over the streets (ids from 100, names B1, B2...). Stops may be bus stops or metro stations. */
  addBusLine(ids: number[], month: number, path: number[][], km: number, vehicles: number, inherited = false): Line | null {
    const clean = ids.filter((id, k) => this.station(id) && ids.indexOf(id) === k);
    if (clean.length < 2 || path.length !== clean.length - 1) return null;
    clean.forEach((id) => { const st = this.station(id)!; if (st.opened < 0) st.opened = month; });
    const id = 100 + this.nextBus++;
    const BUS_COLORS = ['#b08a3e', '#7c8f3a', '#9a6a8e', '#4f8a8b', '#a0674b', '#6d7ab0'];
    const line: Line = { id, color: BUS_COLORS[(id - 101) % BUS_COLORS.length], stations: clean, trains: vehicles, segTime: [], lengthKm: km, wetKm: 0, by: [0, 0, 0, 0, 0], rack: clean.slice(1).map(() => false), elev: clean.map(() => 0), headway: 10, capacity: 0, riders: 0, peakLoad: 0, segLoad: [], rating: 100, crowd: 0, mode: 'bus', lane: 0, path, inherited };
    this.buses.push(line);
    this.updateLine(line);
    return line;
  }

  addStation(x: number, y: number, water: Uint8Array): Station | null {
    if (x < 0 || y < 0 || x >= N || y >= N || water[Math.floor(y) * N + Math.floor(x)]) return null;
    if (this.stations.some((s) => Math.hypot(s.x - x, s.y - y) < 3)) return null;
    const id = this.nextStation++;
    const s: Station = { id, x, y, name: NAMES[(id - 1) % NAMES.length] + (id > NAMES.length ? ` ${Math.ceil(id / NAMES.length)}` : ''), riders: 0, underwater: false, depth: 0, opened: -1 };
    this.stations.push(s);
    return s;
  }

  removeStation(id: number) {
    if (this.onNet(id)) return false;
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
    const clean = ids.filter((id, k) => this.station(id) && !this.station(id)!.bus && ids.indexOf(id) === k);
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
    if (l.mode === 'bus') {
      // buses: street time by lane (the sim's callback), a dwell per stop; ordinary buses carry 70, busway buses 110
      for (let k = 1; k < l.stations.length; k++) { const t = (this.busTime ? this.busTime(l, k - 1) : 3) + 0.5; l.segTime.push(t); ride += t; }
      const rt = ride * 2 + 6;
      l.headway = Math.max(3, rt / Math.max(1, l.trains));
      l.capacity = (60 / l.headway) * (l.lane === 3 ? TRAM_CAP : l.lane === 2 ? 110 : 70);
      if (l.segLoad.length !== l.segTime.length) l.segLoad = l.segTime.map(() => 0);
      return;
    }
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
    this.net = this.lines.concat(this.buses);
    for (const l of this.net) this.updateLine(l);
    // metro stations first (their matrix indices stay as before), then bus stops
    const used = this.stations.filter((s) => this.onNet(s.id)).concat(this.stops.filter((s) => this.onNet(s.id)));
    this.sIndex = new Map(used.map((s, k) => [s.id, k]));
    const S = used.length;
    this.nodes = [];
    this.nodesAt = used.map(() => []);
    this.net.forEach((l, li) => l.stations.forEach((sid, pos) => {
      const st = this.sIndex.get(sid)!;
      this.nodesAt[st].push(this.nodes.length);
      this.nodes.push({ line: li, pos, st });
    }));
    const M = this.nodes.length;
    // node index lookup: (line, pos) -> node
    const nodeOf = this.net.map(() => [] as number[]);
    this.nodes.forEach((n, k) => (nodeOf[n.line][n.pos] = k));
    this.T = new Float64Array(S * S).fill(Infinity);
    this.prev = []; this.dist = []; this.bestNode = [];
    this.jWait = new Float32Array(S * S); this.jRide = new Float32Array(S * S); this.jXfer = new Float32Array(S * S); this.jCrowd = new Float32Array(S * S);
    this.jChanges = new Uint8Array(S * S); this.jModes = new Uint8Array(S * S);
    const crowdMul = this.net.map((l) => 1 + Math.min(1.2, Math.max(0, l.crowd - 0.75) * 1.5));
    const wait = this.net.map((l) => JOURNEY.waitOf(l.headway));
    // walking transfers: other stations / stops within xferCells, with the minutes to walk there
    const near: { k: number; t: number }[][] = used.map(() => []);
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
      if (a === b) continue;
      const d = Math.hypot(used[a].x - used[b].x, used[a].y - used[b].y);
      if (d <= JOURNEY.xferCells) near[a].push({ k: b, t: d * CELL * 1.3 / JOURNEY.walkMPerMin + JOURNEY.xferWalk });
    }
    this.xferNear = near;
    for (let s = 0; s < S; s++) {
      const dist = new Float64Array(M).fill(Infinity);
      const prev = new Int32Array(M).fill(-1);
      const done = new Uint8Array(M);
      for (const n of this.nodesAt[s]) dist[n] = wait[this.nodes[n].line] * crowdMul[this.nodes[n].line];
      for (;;) {
        let u = -1, best = Infinity;
        for (let k = 0; k < M; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
        if (u < 0) break;
        done[u] = 1;
        const nu = this.nodes[u], l = this.net[nu.line];
        const relax = (v: number, c: number) => { if (c < dist[v]) { dist[v] = c; prev[v] = u; } };
        if (nu.pos + 1 < l.stations.length) relax(nodeOf[nu.line][nu.pos + 1], best + l.segTime[nu.pos] * crowdMul[nu.line]);
        if (nu.pos > 0) relax(nodeOf[nu.line][nu.pos - 1], best + l.segTime[nu.pos - 1] * crowdMul[nu.line]);
        for (const v of this.nodesAt[nu.st]) if (v !== u && this.nodes[v].line !== nu.line)
          relax(v, best + JOURNEY.xferSame + wait[this.nodes[v].line] * crowdMul[this.nodes[v].line]);
        for (const w of near[nu.st]) for (const v of this.nodesAt[w.k]) if (this.nodes[v].line !== nu.line)
          relax(v, best + w.t + wait[this.nodes[v].line] * crowdMul[this.nodes[v].line]);
      }
      const bn = new Int32Array(S).fill(-1);
      for (let t = 0; t < S; t++) {
        if (t === s) continue;
        let b = Infinity;
        for (const n of this.nodesAt[t]) if (dist[n] < b) { b = dist[n]; bn[t] = n; }
        this.T[s * S + t] = b;
        // the journey's parts, walking the best path back from the arrival node
        let n = bn[t], g = 0, jw = 0, jr = 0, jx = 0, jc = 0, ch = 0, md = 0;
        while (n >= 0 && g++ < 500) {
          const p = prev[n], cur = this.nodes[n], li = cur.line, L = this.net[li], cm = crowdMul[li];
          if (p >= 0 && this.nodes[p].line === li) {
            const tt = L.segTime[Math.min(this.nodes[p].pos, cur.pos)];
            jr += tt; jc += tt * (cm - 1);
          } else {
            // boarding li (the first one, or a change from the line at p)
            jw += wait[li]; jc += wait[li] * (cm - 1); md |= L.mode !== 'bus' ? 1 : L.lane === 3 ? 4 : 2;
            if (p >= 0) {
              ch++;
              const ps = this.nodes[p].st;
              jx += ps === cur.st ? JOURNEY.xferSame : (near[ps].find((q) => q.k === cur.st)?.t ?? JOURNEY.xferSame);
            }
          }
          n = p;
        }
        const k = s * S + t;
        this.jWait[k] = jw; this.jRide[k] = jr; this.jXfer[k] = jx; this.jCrowd[k] = jc; this.jChanges[k] = ch; this.jModes[k] = md;
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
