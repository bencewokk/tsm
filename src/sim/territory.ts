/**
 * Land-use territories with real borders: the city is not a noise field of building types but a set of areas, each with its own rules.
 *   Port        working quays and the warehouse belt behind them (rail yards / pithead for those sites): industry only, no homes, no towers
 *   Industry    the heavy-industry district out along the freight corridor: industry only, low
 *   Workers     the workers' terraces around the industry: homes, mid-density, low
 *   Core        the old town (organic, protected)
 *   Inner       dense mixed use round the centre and the redeveloped docks
 *   Transit     medium-density districts that follow the stations
 *   Detached    the suburbs: houses, low
 *   Green       floodplain / waterfront green (no plots)
 * Port, industry and workers are fixed when the city is laid out (they follow the harbour, the rail and the river);
 * core / inner / transit / detached are re-drawn from the density field every year.
 */
import { N, Flag } from './constants';
import { hash2 } from './rng';
import type { TownCtx } from './town';
import { inCoreXY } from './hierarchy';
import type { Sim } from './sim';

export const T = { Rural: 0, Core: 1, Inner: 2, Transit: 3, Detached: 4, Port: 5, Industry: 6, Workers: 7, Green: 8 } as const;
export const T_NAMES = ['rural', 'old core', 'inner mixed use', 'transit district', 'detached suburb', 'port / yards', 'heavy industry', "workers' district", 'green'];
/** Overlay colours (rgb). */
export const T_COLORS: [number, number, number][] = [[0, 0, 0], [196, 150, 98], [214, 98, 82], [236, 176, 70], [150, 190, 120], [88, 120, 168], [120, 120, 126], [176, 130, 160], [96, 168, 120]];
/** Height caps (m) per territory; 0 = the field alone decides. */
export const T_CAP = [0, 0, 0, 0, 16, 15, 22, 20, 0];

export const TERR = { on: true };

const buildable = (c: TownCtx, i: number) => !c.g.water[i] && !(c.g.flags[i] & (Flag.Steep | Flag.Flood));

/** Fixed territories: working port / yards, the industrial district and its workers' terraces. Returns the anchors for the freight corridor. */
export function staticTerritories(c: TownCtx): { port: [number, number] | null; industry: [number, number] | null } {
  const { g } = c;
  const terr = c.terr;
  terr.fill(0);
  if (!TERR.on || !c.districts.length) return { port: null, industry: null };
  const o = c.districts[0];
  // ---- port / yards: the old docks and the belt behind them
  let px = 0, py = 0;
  const dc = g.docksCells;
  for (const i of dc) { px += (i % N) + 0.5; py += ((i / N) | 0) + 0.5; }
  const hasPort = dc.length > 4;
  if (hasPort) { px /= dc.length; py /= dc.length; }
  const harbour = c.city.site === 'harbour';
  if (hasPort) {
    const belt = harbour ? 5 : 3;
    for (const i of dc) {
      const x0 = i % N, y0 = (i / N) | 0;
      for (let dy = -belt; dy <= belt; dy++) for (let dx = -belt; dx <= belt; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= N || y >= N || dx * dx + dy * dy > belt * belt) continue;
        const j = y * N + x;
        if (!buildable(c, j) || inCoreXY(c, x + 0.5, y + 0.5, 0.85)) continue;
        if (harbour && g.distWater[j] > 8) continue;
        terr[j] = T.Port;
      }
    }
    for (const i of dc) terr[i] = T.Port;
  }
  // rail corridor buffer (yards beside the line)
  for (let i = 0; i < N * N; i++) if ((g.flags[i] & Flag.Rail) && !g.water[i]) {
    const x0 = i % N, y0 = (i / N) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const j = y * N + x;
      if (buildable(c, j) && terr[j] === 0 && !inCoreXY(c, x + 0.5, y + 0.5, 0.85) && Math.hypot(x - o.x, y - o.y) > 6) terr[j] = T.Industry;   // working yards beside the line
    }
  }
  // ---- heavy industry: out from the old town in the direction of the port (or away from the sea), on open land
  const seaDir = hasPort ? Math.atan2(py - o.y, px - o.x) : hash2(g.seed, 91, 3) * Math.PI * 2;
  let ax = -1, ay = -1;
  const indW = c.city.dominant.ind;
  const R = 4.5 + 4 * indW;
  for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.1, -2.1]) {
    const a = seaDir + off + (hasPort ? 0.9 : 0);   // beside the port, not on it
    for (let d = 15; d <= 30; d += 2) {
      const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d;
      if (x < 6 || y < 6 || x > N - 6 || y > N - 6) break;
      let ok = 0, tot = 0;
      for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) { tot++; if (buildable(c, Math.floor(y + dy) * N + Math.floor(x + dx))) ok++; }
      if (ok / tot > 0.8 && !c.districts.some((q) => q !== o && Math.hypot(q.x - x, q.y - y) < R + 5)) { ax = x; ay = y; break; }
    }
    if (ax >= 0) break;
  }
  if (ax >= 0) {
    const ang = Math.atan2(ay - o.y, ax - o.x);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const j = y * N + x;
      if (!buildable(c, j) || terr[j] === T.Port) continue;
      const rx = x + 0.5 - ax, ry = y + 0.5 - ay;
      // an ellipse stretched along the line back to the old town (the freight corridor)
      const u = rx * Math.cos(ang) + ry * Math.sin(ang), v = -rx * Math.sin(ang) + ry * Math.cos(ang);
      const e = (u / (R * 1.35)) ** 2 + (v / R) ** 2;
      if (e <= 1 && !inCoreXY(c, x + 0.5, y + 0.5, 1.1)) terr[j] = T.Industry;
      else if (e <= 2.6 && terr[j] === 0 && !inCoreXY(c, x + 0.5, y + 0.5, 1.1)) terr[j] = T.Workers;
    }
  }
  return { port: hasPort ? [px, py] : null, industry: ax >= 0 ? [ax, ay] : null };
}

/** Yearly re-draw of the dynamic territories from the density field and the stations. Core and the fixed ones are kept. */
export function updateTerritories(sim: Sim) {
  const c = sim.town, g = sim.g, terr = c.terr;
  if (!TERR.on) return;
  const main = sim.field.main, pop = sim.homes * 2.3;
  const innerR = 12 + 0.35 * Math.sqrt(pop / 1000);
  const docksActive = sim.docks.state !== 'none';
  // the industrial district grows with industrial demand: when its vacant plots run low it spreads one ring outward over open land
  if (sim.month > 0) {
    let vacant = 0, has = false;
    for (const l of sim.lots.lots) if (l.alive && !l.type && !l.flags && (terr[l.cell] === T.Industry || terr[l.cell] === T.Port)) vacant++;
    for (let i = 0; i < N * N && !has; i++) if (terr[i] === T.Industry) has = true;
    if (has && vacant < 10 && sim.indPool > 60) {
      const add: number[] = [];
      for (let i = 0; i < N * N; i++) {
        if (terr[i] === T.Industry || g.water[i] || (g.flags[i] & (Flag.Steep | Flag.Flood | Flag.Docks))) continue;
        const x = i % N, y = (i / N) | 0;
        if (inCoreXY(c, x + 0.5, y + 0.5, 1.1) || terr[i] === T.Core || terr[i] === T.Inner || terr[i] === T.Transit) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N && terr[yy * N + xx] === T.Industry) { near = true; break; } }
        if (near) add.push(i);
      }
      for (const i of add) terr[i] = T.Industry;
    }
  }
  for (let i = 0; i < N * N; i++) {
    const cur = terr[i];
    if (cur === T.Industry || cur === T.Workers) continue;
    if (cur === T.Port) {
      // until the redevelopment project starts the old port and the warehouse belt behind it are working land; then they become a bounded inner district
      if (docksActive) terr[i] = T.Inner;
      continue;
    }
    if (g.water[i]) { terr[i] = 0; continue; }
    const x = (i % N) + 0.5, y = ((i / N) | 0) + 0.5;
    if (g.flags[i] & Flag.Flood) { terr[i] = T.Green; continue; }
    if (inCoreXY(c, x, y)) { terr[i] = T.Core; continue; }
    const F = sim.field.F[i], a = sim.accCell[i];
    if ((g.flags[i] & Flag.Docks) && docksActive) terr[i] = T.Inner;
    else if (Math.hypot(x - main.x, y - main.y) < innerR && F > 0.3) terr[i] = T.Inner;
    else if (a > 0.25 || F > 0.45) terr[i] = F > 0.6 ? T.Inner : T.Transit;
    else if (sim.lvS[i] > 0.2 || sim.cBuilt[i] > 0) terr[i] = T.Detached;
    else terr[i] = T.Rural;
  }
}
