/**
 * Regional rail and the region beyond the map (round 7, step 8).
 *
 * The railway that history laid (terrain.ts: a line through a rail-junction city, a spur to the rail town) was scenery; now the player can
 * run regional trains on it. Regional stations snap to the track (cheap surface platforms, no tunnelling), trains follow the track between
 * them at 65 km/h with a minute at each stop and carry 900, so a rail town a couple of kilometres out becomes a short ride from the centre.
 *
 * Portals: where the railway leaves the map (or, for a spur, at its far end: the line runs on into the region) and where an arterial
 * reaches the map edge, the city meets its region. A share of the city's jobs is held by people who live outside it; they arrive through
 * the portals every day. Through a road portal they drive (their cars join the street assignment from the portal's zone); through a rail
 * portal they choose between the car and the train when a regional line calls at a station by the portal (a 14-minute ride from their
 * town, the wait, the ride on the city's network and the walk at the end, against the drive). `REGION.on = false` turns this off.
 */
import { N, CELL, ZONE, NZ, ZONES } from './constants';
import { RC } from './roads';
import type { Sim } from './sim';

export const REGION = {
  on: true,
  /** share of the city's jobs held by people from outside the map */
  commuterShare: 0.08,
  /** minutes from the out-of-town homes to the portal: by train (the regional line beyond the map), by car (the road beyond it) */
  offRail: 14, offCar: 16,
  /** destination decay (km) */
  decay: 5,
  rail: { speed: 65, dwell: 1, cap: 900, stationCost: 4e6, trainCost: 7e6, trainMonth: 0.15e6, electrifyKm: 2.5e6, snap: 2.5 },
};

export interface Portal { kind: 'rail' | 'road'; x: number; y: number; name: string; node: number; zone: number; line: number }
const TOWNS: Record<string, string[]> = { north: ['Northam', 'Upper Wexby'], east: ['Easterby', 'Coldharbour'], south: ['Southwold', 'Marlow Cross'], west: ['Westleigh', 'Ashford Vale'] };

export class Regional {
  portals: Portal[] = [];
  /** this month's out-of-town commuters (one-way trips a day), by car and by rail, and per portal */
  stats = { commuters: 0, car: 0, rail: 0, byPortal: [] as { name: string; kind: string; trips: number; rail: number }[] };
  private version = -1;
  constructor(private sim: Sim) {}

  private dir(x: number, y: number) {
    const d = [y, N - 1 - x, N - 1 - y, x];
    const k = d.indexOf(Math.min(...d));
    return ['north', 'east', 'south', 'west'][k];
  }

  /** portals from the railway ends and the arterials at the map edge (re-found when the streets change) */
  refresh() {
    const sim = this.sim, R = sim.roads;
    if (R.version === this.version) return;
    this.version = R.version;
    const out: Portal[] = [];
    const used = new Map<string, number>();
    const name = (x: number, y: number) => { const d = this.dir(x, y); const k = used.get(d) ?? 0; used.set(d, k + 1); return TOWNS[d][k % 2]; };
    const zoneAt = (x: number, y: number) => Math.min(NZ - 1, Math.max(0, Math.floor(y / ZONE))) * NZ + Math.min(NZ - 1, Math.max(0, Math.floor(x / ZONE)));
    const o = sim.g.villages[0];
    const edge = (x: number, y: number) => Math.min(x, y, N - 1 - x, N - 1 - y);
    sim.g.rail.forEach((pl, li) => {
      if (pl.length < 2) return;
      const ends = [pl[0], pl[pl.length - 1]];
      const atEdge = ends.filter(([x, y]) => edge(x, y) < 8);
      // a spur that stays inside the map runs on into the region from its far end
      const pick = atEdge.length ? atEdge : [ends.slice().sort((a, b) => Math.hypot(b[0] - o.x, b[1] - o.y) - Math.hypot(a[0] - o.x, a[1] - o.y))[0]];
      for (const [x, y] of pick) out.push({ kind: 'rail', x, y, name: name(x, y), node: R.nearestNode(x, y, 8), zone: zoneAt(x, y), line: li });
    });
    // road portals: arterial nodes within 3 cells of the map edge, one per stretch of edge
    for (let n = 0; n < R.nx.length; n++) {
      const x = R.nx[n], y = R.ny[n];
      if (edge(x, y) > 3 || !R.adj[n].some((e) => R.alive[e] && R.ecls[e] === RC.Arterial)) continue;
      if (out.some((p) => p.kind === 'road' && Math.hypot(p.x - x, p.y - y) < 12)) continue;
      out.push({ kind: 'road', x, y, name: name(x, y), node: n, zone: zoneAt(x, y), line: -1 });
    }
    this.portals = out.slice(0, 6);
  }

  /** the nearest point on the railway within the snap distance: polyline, distance along it (cells), the point */
  project(x: number, y: number, snap = REGION.rail.snap): { pl: number; s: number; x: number; y: number; d: number } | null {
    let best: { pl: number; s: number; x: number; y: number; d: number } | null = null;
    this.sim.g.rail.forEach((pl, li) => {
      let acc = 0;
      for (let k = 1; k < pl.length; k++) {
        const [ax, ay] = pl[k - 1], [bx, by] = pl[k], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-6;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
        const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
        if (d <= snap && (!best || d < best.d)) best = { pl: li, s: acc + L * t, x: px, y: py, d };
        acc += L;
      }
    });
    return best;
  }

  /** the points of polyline pl between distances s0 and s1 (in travel order) */
  private along(pl: number, s0: number, s1: number): [number, number][] {
    const P = this.sim.g.rail[pl], out: [number, number][] = [];
    const at = (s: number): [number, number] => {
      let acc = 0;
      for (let k = 1; k < P.length; k++) {
        const L = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
        if (acc + L >= s || k === P.length - 1) { const t = L ? Math.max(0, Math.min(1, (s - acc) / L)) : 0; return [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * t, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t]; }
        acc += L;
      }
      return [P[P.length - 1][0], P[P.length - 1][1]];
    };
    out.push(at(s0));
    let acc = 0;
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1), mids: [number, number][] = [];
    for (let k = 1; k < P.length; k++) { acc += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); if (acc > lo && acc < hi && k < P.length - 1) mids.push([P[k][0], P[k][1]]); }
    if (s1 < s0) mids.reverse();
    out.push(...mids, at(s1));
    return out;
  }

  /** the track between two points on the railway (the same line, or two lines that meet within 3 cells): points and km; null if none */
  leg(ax: number, ay: number, bx: number, by: number): { pts: [number, number][]; km: number } | null {
    const a = this.project(ax, ay), b = this.project(bx, by);
    if (!a || !b) return null;
    const len = (pts: [number, number][]) => { let s = 0; for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s; };
    if (a.pl === b.pl) { const pts = this.along(a.pl, a.s, b.s); return { pts, km: len(pts) * CELL / 1000 }; }
    // a junction: the closest pair of points of the two lines
    const PA = this.sim.g.rail[a.pl], PB = this.sim.g.rail[b.pl];
    let bd = 3, ja: [number, number] | null = null;
    for (const p of PA) for (const q of PB) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bd) { bd = d; ja = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; } }
    if (!ja) {
      // the spur may start just off the main line's segment: try its ends against the other line
      for (const p of [PB[0], PB[PB.length - 1]]) { const pa = this.project(p[0], p[1], 3); if (pa && pa.pl === a.pl) { ja = [p[0], p[1]]; break; } }
      for (const p of [PA[0], PA[PA.length - 1]]) { if (ja) break; const pb = this.project(p[0], p[1], 3); if (pb && pb.pl === b.pl) ja = [p[0], p[1]]; }
    }
    if (!ja) return null;
    const ja2 = this.projectOn(a.pl, ja[0], ja[1]), jb2 = this.projectOn(b.pl, ja[0], ja[1]);
    if (!ja2 || !jb2) return null;
    const pts = this.along(a.pl, a.s, ja2.s).concat(this.along(b.pl, jb2.s, b.s));
    return { pts, km: len(pts) * CELL / 1000 };
  }
  private projectOn(pl: number, x: number, y: number) {
    const P = this.sim.g.rail[pl];
    let acc = 0, best: { s: number; d: number } | null = null;
    for (let k = 1; k < P.length; k++) {
      const [ax, ay] = P[k - 1], [bx, by] = P[k], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
      const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      if (!best || d < best.d) best = { s: acc + L * t, d };
      acc += L;
    }
    return best;
  }

  /** the regional station serving a rail portal: the matrix index of the rail line's station nearest it, within 15 cells (the outer end of the line), or -1 */
  portalStation(p: Portal): number {
    const m = this.sim.metro;
    let best = -1, bd = 15;
    for (const l of m.lines) {
      if (l.mode !== 'rail') continue;
      for (const id of l.stations) {
        const st = m.station(id)!, d = Math.hypot(st.x - p.x, st.y - p.y);
        const k = m.sIndex.get(id);
        if (d < bd && k !== undefined) { bd = d; best = k; }
      }
    }
    return best;
  }

  info() { return { portals: this.portals.map((p) => ({ kind: p.kind, x: p.x, y: p.y, name: p.name })), ...this.stats }; }
}
void N; void ZONES;
