/**
 * New public squares form where `squarePressure` is high.
 *   squarePressure = sum of weights x terms - existingPublicSpaceNearby weight x term, every term normalised to 0..1:
 *     pedestrianCentrality   junction degree x road importance (no betweenness: it stands in for the walking legs of the trips)
 *     nearbyRetailAndJobs    commercial jobs within 3 cells
 *     landmarkDemand         open landmarks within 6 cells (value-weighted)
 *     transitBoardings       riders of stations within 4 cells
 *     crossingOrWaterfront   a junction at the water's edge or on an arterial next to a river crossing
 *     existingPublicSpace    parks and squares within 4 cells (subtracts)
 * Evaluated once a year; a square forms only above a high threshold for two evaluations in a row (hysteresis), at least `spacing` cells from
 * any other square; squares persist (never removed). The site is carved at the junction by buying the adjacent plots through the assembly
 * pipeline (hoardings, demolition, paving), size from pressure. A square raises value and the retail share on its edges and counts as public space.
 */
import { N, BT, Flag } from './constants';
import { RC } from './roads';
import { T } from './territory';
import { landmarkAt } from './landmarks';
import { inCoreXY } from './hierarchy';
import type { Sim } from './sim';
import type { Lot } from './lots';

export const SQ = {
  on: true,
  threshold: 0.36,
  hysteresis: 0.08,    // pressure must stay above threshold - hysteresis to keep its streak
  streak: 2,           // evaluations in a row above the threshold before a square forms
  spacing: 9,          // cells between squares (centre to centre)
  existingW: 0.34,
  w: { ped: 0.22, retail: 0.24, landmark: 0.14, transit: 0.2, water: 0.1 },
  everyMonths: 12,
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export interface PressureTerms { ped: number; retail: number; landmark: number; transit: number; water: number; existing: number; pressure: number }

export function squarePressure(sim: Sim, node: number): PressureTerms {
  const R = sim.roads, x = R.nx[node], y = R.ny[node];
  // pedestrianCentrality
  let cls = 0, imp = 0;
  for (const e of R.adj[node]) { cls = Math.max(cls, R.ecls[e] === RC.Arterial ? 1 : R.ecls[e] === RC.Collector ? 0.65 : 0.35); imp = Math.max(imp, R.eimp[e]); }
  const ped = clamp(R.adj[node].length / 4, 0, 1) * (0.75 * cls + 0.25 * clamp(imp / 200, 0, 1));
  // retail and jobs, landmarks, public space
  let jobs = 0, lm = 0, pub = 0;
  for (const l of sim.lots.near(x, y, 6)) {
    if (!l.alive) continue;
    const d = Math.hypot(l.x - x, l.y - y);
    if (d <= 3 && l.type === BT.Com && l.level > 0) jobs += sim.lotJobs(l);
    if (d <= 6 && l.type === BT.Landmark && l.level > 0) lm += landmarkAt(l.lm)?.value ?? 0.5;
    if (d <= 4 && (l.type === BT.Park || l.type === BT.Square)) pub += l.type === BT.Square ? 1.4 : 0.8;
  }
  const retail = clamp(jobs / 300, 0, 1), landmark = clamp(lm / 1.2, 0, 1), existing = clamp(pub / 5, 0, 1);
  // transitBoardings
  let rid = 0;
  for (const st of sim.metro.stations) if (Math.hypot(st.x - x, st.y - y) < 4) rid += st.riders;
  const transit = clamp(rid / 2000, 0, 1);
  // crossingOrWaterfrontBonus
  let water = 0;
  const g = sim.g;
  for (let dy = -2; dy <= 2 && water < 1; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N && g.water[yy * N + xx]) { water = 1; break; } }
  if (water < 1 && cls === 1) for (let dy = -5; dy <= 5 && water < 0.5; dy++) for (let dx = -5; dx <= 5; dx++) { const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N && g.water[yy * N + xx]) { water = 0.5; break; } }
  const W = SQ.w;
  const pressure = W.ped * ped + W.retail * retail + W.landmark * landmark + W.transit * transit + W.water * water - SQ.existingW * existing;
  return { ped, retail, landmark, transit, water, existing, pressure };
}

/** Yearly evaluation: at most one new square per year. */
export function evaluateSquares(sim: Sim) {
  if (!SQ.on || sim.month < 18) return;
  const R = sim.roads, c = sim.town;
  const squares: [number, number][] = [];
  // spacing is kept from other pressure squares (deco 5), not from the small forecourt plazas that towers and projects leave (those used to block every square)
  for (const l of sim.lots.lots) if (l.alive && l.type === BT.Square && l.deco === 5) squares.push([l.x, l.y]);
  for (const a of sim.asm.list) if (a.kind === 'square' && a.phase >= 0) squares.push([a.quad[0], a.quad[1]]);
  let best: { node: number; p: number } | null = null;
  const seen = new Set<number>();
  for (let n = 0; n < R.nx.length; n++) {
    if (R.adj[n].length < 3) { sim.sqStreak.delete(n); continue; }
    const x = R.nx[n], y = R.ny[n];
    const i = Math.floor(y) * N + Math.floor(x);
    // the redeveloped docks district may get its square once the project is done (while it is being built its plots are spoken for)
    const docksOk = sim.docks.state === 'done';
    if (sim.g.water[i] || (sim.g.flags[i] & (Flag.Steep | Flag.Flood)) || ((sim.g.flags[i] & Flag.Docks) && !docksOk) || inCoreXY(c, x, y, 0.95)) continue;
    const t = c.terr[i];
    if (t === T.Port || t === T.Industry || t === T.Workers) continue;
    const { pressure } = squarePressure(sim, n);
    const had = sim.sqStreak.get(n) ?? 0;
    if (pressure >= SQ.threshold) sim.sqStreak.set(n, had + 1);
    else if (pressure < SQ.threshold - SQ.hysteresis) sim.sqStreak.delete(n);
    seen.add(n);
    if ((sim.sqStreak.get(n) ?? 0) >= SQ.streak && squares.every(([sx, sy]) => Math.hypot(sx - x, sy - y) >= SQ.spacing) && (!best || pressure > best.p)) best = { node: n, p: pressure };
  }
  if (!best) return;
  carveSquare(sim, best.node, best.p);
}

/** Buy the plots round the junction (cost <= 3: vacant, houses, shops, small blocks) and start the paving through the assembly pipeline. */
function carveSquare(sim: Sim, node: number, pressure: number) {
  const R = sim.roads, x = R.nx[node], y = R.ny[node];
  const size = clamp((pressure - SQ.threshold) / 0.3, 0, 1);
  const target = 2 + Math.round(size * 4);                 // plots
  const radius = 1.6 + size * 1.6;
  const cand: Lot[] = [];
  for (const l of sim.lots.near(x, y, radius + 0.8)) {
    const docksLot = sim.docks.state === 'done' && (l.flags & Flag.Docks) && !(l.flags & Flag.Planned) && l.alive && !l.asm && !l.constr && !l.demo && !l.lm && l.type !== BT.Square && l.type !== BT.Park;
    if (!(sim.asm.ok(l) || docksLot) || l.back || l.type === BT.Landmark || sim.asm.cost(l) > 3) continue;
    if (Math.hypot(l.x - x, l.y - y) > radius + 0.4) continue;
    cand.push(l);
  }
  cand.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id - b.id);
  const lots = cand.slice(0, target);
  if (lots.length < 2) return;
  const label = pressure > 0.6 ? 'Grand square' : 'Public square';
  sim.asm.startSquare(lots, label);
  sim.sqStreak.delete(node);
  sim.say(`${label} planned at a busy junction: ${lots.length} plots bought`);
}
