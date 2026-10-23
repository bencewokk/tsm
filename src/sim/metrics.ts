// Measurement helpers for the macro-structure round: road network quality and the density / height gradient.
import { BT, Flag } from './constants';
import { RC } from './roads';
import { orientationAt } from './town';
import { angDiff } from './geom';
import { hAt } from './relief';
import type { Sim } from './sim';
import type { Lot } from './lots';

export interface RoadZone {
  edges: number; km: number;
  byClass: number[]; kmByClass: number[];
  /** non-arterial edges more than ~26 degrees off their district grid */
  diagonals: number; diagonalKm: number;
  /** dead-end nodes, and those whose street is short (< 3.5 cells = 175 m) */
  deadEnds: number; shortDeadEnds: number;
  /** enclosed faces with three corners and under 25 cells^2, and tiny faces (< 3 cells^2) */
  triangles: number; slivers: number; faces: number;
  /** nodes where a local street meets an arterial directly (the hierarchy wants a collector in between) and junctions of any kind on arterials */
  localOnArterial: number; arterialJunctions: number;
  /** mean and max gradient (m per m) along arterial edges, and the share of arterial km on ground above 8% */
  artGradeMean: number; artGradeMax: number; artSteepShare: number;
}
export interface RoadStats extends RoadZone { core: RoadZone; outside: RoadZone }

/** Planar face enumeration by half-edge walking; returns each bounded face as a node ring. */
export function roadFaces(sim: Sim): { nodes: number[]; area: number }[] {
  const R = sim.roads;
  const out: { nodes: number[]; area: number }[] = [];
  const used = new Set<number>(); // directed edge key e*2+dir
  for (const e of R.aliveEdges()) {
    for (const dir of [0, 1]) {
      if (used.has(e * 2 + dir)) continue;
      const ring: number[] = [];
      let ce = e, cd = dir, guard = 0;
      while (guard++ < 400) {
        used.add(ce * 2 + cd);
        const from = cd === 0 ? R.ea[ce] : R.eb[ce], to = cd === 0 ? R.eb[ce] : R.ea[ce];
        ring.push(from);
        // next edge: at `to`, the first edge turning from the reverse direction
        const back = Math.atan2(R.ny[from] - R.ny[to], R.nx[from] - R.nx[to]);
        let best = -1, bd = Infinity;
        for (const f of R.adj[to]) {
          if (f === ce) continue;
          const a = R.edgeAngle(f, to);
          let d = a - back; while (d <= 1e-9) d += Math.PI * 2; while (d > Math.PI * 2) d -= Math.PI * 2;
          if (d < bd) { bd = d; best = f; }
        }
        if (best < 0) best = ce; // dead end: turn around
        ce = best; cd = R.ea[best] === to ? 0 : 1;
        if (ce === e && cd === dir) break;
      }
      if (ring.length < 3) continue;
      let a2 = 0;
      for (let k = 0; k < ring.length; k++) { const p = ring[k], q = ring[(k + 1) % ring.length]; a2 += R.nx[p] * R.ny[q] - R.nx[q] * R.ny[p]; }
      if (a2 < 0) out.push({ nodes: ring, area: -a2 / 2 }); // one orientation = bounded faces, the other = the outer face
    }
  }
  return out;
}

const zone = (): RoadZone => ({ edges: 0, km: 0, byClass: [0, 0, 0], kmByClass: [0, 0, 0], diagonals: 0, diagonalKm: 0, deadEnds: 0, shortDeadEnds: 0, triangles: 0, slivers: 0, faces: 0, localOnArterial: 0, arterialJunctions: 0, artGradeMean: 0, artGradeMax: 0, artSteepShare: 0 });

/** The old core: within the core radius of an original village / origin quarter (the part that stays organic). */
export function inOldCore(sim: Sim, x: number, y: number): boolean {
  for (const d of sim.town.districts) {
    if (d.kind === 'planned' || d.kind === 'garden') continue;
    if (Math.hypot(d.x - x, d.y - y) < (d.coreR ?? 7.5)) return true;
  }
  return false;
}

export function roadStats(sim: Sim): RoadStats {
  const R = sim.roads, es = R.aliveEdges();
  const all = zone(), core = zone(), out = zone();
  for (const e of es) {
    const mx = (R.nx[R.ea[e]] + R.nx[R.eb[e]]) / 2, my = (R.ny[R.ea[e]] + R.ny[R.eb[e]]) / 2;
    const L = R.edgeLen(e) * 0.05;
    let diag = false;
    if (R.ecls[e] !== RC.Arterial && R.edgeLen(e) >= 1.2) {
      const th = orientationAt(sim.town, mx, my);
      const a = R.edgeAngle(e, R.ea[e]);
      let dev = Infinity;
      for (let k = 0; k < 4; k++) dev = Math.min(dev, angDiff(a, th + (k * Math.PI) / 2));
      diag = dev > 0.45;
    }
    let gr = 0;
    if (R.ecls[e] === RC.Arterial) gr = Math.abs(hAt(sim.g.height, R.nx[R.ea[e]], R.ny[R.ea[e]]) - hAt(sim.g.height, R.nx[R.eb[e]], R.ny[R.eb[e]])) / Math.max(1, R.edgeLen(e) * 50);
    for (const z of [all, inOldCore(sim, mx, my) ? core : out]) {
      if (R.ecls[e] === RC.Arterial) { z.artGradeMean += gr; z.artGradeMax = Math.max(z.artGradeMax, gr); if (gr > 0.08) z.artSteepShare += L; }
      z.edges++; z.km += L; z.byClass[R.ecls[e]]++; z.kmByClass[R.ecls[e]] += L;
      if (diag) { z.diagonals++; z.diagonalKm += L; }
    }
  }
  for (let n = 0; n < R.nx.length; n++) if (R.adj[n].length === 1) {
    const short = R.edgeLen(R.adj[n][0]) < 3.5;
    for (const z of [all, inOldCore(sim, R.nx[n], R.ny[n]) ? core : out]) { z.deadEnds++; if (short) z.shortDeadEnds++; }
  }
  for (let n = 0; n < R.nx.length; n++) {
    if (R.adj[n].length < 3) continue;
    let art = false, loc = false;
    for (const e of R.adj[n]) { if (R.ecls[e] === RC.Arterial) art = true; else if (R.ecls[e] === RC.Local) loc = true; }
    if (!art) continue;
    for (const z of [all, inOldCore(sim, R.nx[n], R.ny[n]) ? core : out]) { z.arterialJunctions++; if (loc) z.localOnArterial++; }
  }
  const faces = roadFaces(sim);
  for (const f of faces) {
    let corners = 0, cx = 0, cy = 0;
    for (let k = 0; k < f.nodes.length; k++) {
      const p = f.nodes[(k + f.nodes.length - 1) % f.nodes.length], c = f.nodes[k], q = f.nodes[(k + 1) % f.nodes.length];
      cx += R.nx[c]; cy += R.ny[c];
      const a1 = Math.atan2(R.ny[c] - R.ny[p], R.nx[c] - R.nx[p]), a2 = Math.atan2(R.ny[q] - R.ny[c], R.nx[q] - R.nx[c]);
      if (R.adj[c].length >= 3 || angDiff(a1, a2) > 0.5) corners++;
    }
    cx /= f.nodes.length; cy /= f.nodes.length;
    for (const z of [all, inOldCore(sim, cx, cy) ? core : out]) {
      z.faces++;
      if (corners <= 3 && f.area < 25) z.triangles++;
      if (f.area < 3) z.slivers++;
    }
  }
  for (const z of [all, core, out]) { z.artGradeMean = z.byClass[0] ? z.artGradeMean / z.byClass[0] : 0; z.artSteepShare = z.kmByClass[0] ? z.artSteepShare / z.kmByClass[0] : 0; }
  return { ...all, core, outside: out };
}

/** Height (m) a plot's building is drawn with, as the renderer would; the baseline version (before the density field). */
export type HeightFn = (l: Lot) => number;
export const baselineHeight: HeightFn = (l) => {
  if (!l.type || l.level <= 0) return 0;
  const core = (l.flags & Flag.Core) !== 0;
  if (l.type === BT.Ind) return 10;
  if (l.type === BT.Res) return core ? [0, 8, 13.5, 19][l.level] : [0, 8, 18, 54][l.level];
  if (l.type === BT.Com) return core ? [0, 8, 13.5, 19][l.level] : [0, 9, 30, 122][l.level];
  return 0;
};

export interface GradientRow { label: string; plots: number; built: number; vacant: number; mean: number; max: number; tall: number; towers: number }

/** Plot count, mean / max height and tall (>= 30 m) and tower (>= 60 m) counts by distance from the centre and by station walk time. */
export function gradient(sim: Sim, centre: { x: number; y: number }, hf: HeightFn): { byDist: GradientRow[]; byStation: GradientRow[]; skyline: number } {
  const bins = [[0, 4], [4, 8], [8, 12], [12, 18], [18, 28], [28, 999]];
  const mk = (label: string): GradientRow => ({ label, plots: 0, built: 0, vacant: 0, mean: 0, max: 0, tall: 0, towers: 0 });
  const byDist = bins.map(([a, b]) => mk(`${a}-${b > 99 ? '+' : b}`));
  const sb = [[0, 4], [4, 8], [8, 12], [12, 999]];
  const byStation = sb.map(([a, b]) => mk(`${a}-${b > 99 ? '+' : b} min`));
  let tallCount = 0;
  const add = (row: GradientRow, l: Lot, h: number) => {
    row.plots++;
    if (l.type === BT.None || l.level === 0) { row.vacant++; return; }
    if (l.type === BT.Landmark) return;
    row.built++; row.mean += h; row.max = Math.max(row.max, h);
    if (h >= 30) row.tall++;
    if (h >= 60) row.towers++;
  };
  for (const l of sim.lots.lots) {
    if (!l.alive || l.type === BT.Park || l.type === BT.Square) continue;
    const h = hf(l);
    if (h >= 60) tallCount++;
    const d = Math.hypot(l.x - centre.x, l.y - centre.y);
    add(byDist[bins.findIndex(([a, b]) => d >= a && d < b)], l, h);
    const w = Math.min(998, sim.walkToStation(l.cell));
    add(byStation[sb.findIndex(([a, b]) => w >= a && w < b)], l, h);
  }
  for (const r of [...byDist, ...byStation]) r.mean = r.built ? r.mean / r.built : 0;
  return { byDist, byStation, skyline: tallCount };
}

export function fmtRows(rows: GradientRow[]): string {
  return rows.map((r) => `${r.label.padEnd(9)} plots ${String(r.plots).padStart(4)} built ${String(r.built).padStart(4)} vacant ${String(r.vacant).padStart(4)} (${r.plots ? Math.round((100 * r.vacant) / r.plots) : 0}%)  mean ${r.mean.toFixed(1).padStart(5)} m  max ${String(Math.round(r.max)).padStart(3)}  >=30m ${String(r.tall).padStart(3)}  >=60m ${String(r.towers).padStart(3)}`).join('\n');
}
