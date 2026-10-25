/**
 * Gateways (round 7, step 9): the places where the city meets the wider world, abstract (no flights or ships animated): an intercity
 * station, a motorway junction, a ferry terminal, an airport. Each is a data entry in GATEWAY_TYPES, a variant of one shape:
 *
 *   externalDemand   travellers a day through it (one way) = base + perPop x population
 *   passengerType    business (intercity), air, ferry (foot passengers), freight (the motorway)
 *   cargoPotential   lorries a day per 1000 residents, loaded on the streets between the gateway and the industrial zones
 *   accessModeNeeds  how travellers reach it: the luggage factor on their walk to a station, the car's edge (taxis, drop-offs) or handicap
 *                    (foot passengers), and a line to the player about what serves it well
 *   districtEffects  jobs at the site, and a land value change around it (offices round an intercity station, noise round an airport)
 *
 * A gateway opens once its gate holds (population, month, the railway / water / a road portal it needs; 18 months at least between two)
 * on the site its finder picks; a headline
 * says what it needs. Its travellers go to and from homes and jobs across the city (6 km decay) and choose between the car and transit
 * (stations within a walk of the gateway, the city network, the walk at the end), in the same logit as the city's trips; their cars and the
 * lorries join the street assignment. `GATEWAYS.on = false` turns gateways off.
 */
import { N, CELL, ZONE, NZ, ZONES } from './constants';
import type { Sim } from './sim';

export const GATEWAYS = { on: true, decay: 6, gap: 18 };

export type GatewayId = 'intercity' | 'motorway' | 'ferry' | 'airport';
export interface GatewayType {
  id: GatewayId; name: string;
  gate: { pop: number; month: number; needs?: 'rail' | 'water' | 'roadPortal' };
  site: 'railCentre' | 'roadPortal' | 'shore' | 'edgeFlat';
  externalDemand: { base: number; perPop: number };
  passengerType: 'business' | 'air' | 'ferry' | 'freight';
  cargoPotential: number;
  accessModeNeeds: { walkMul: number; carMin: number; serve: string };
  districtEffects: { jobs: number; lv: number; radius: number };
}

export const GATEWAY_TYPES: GatewayType[] = [
  {
    id: 'intercity', name: 'Intercity station', gate: { pop: 30000, month: 36, needs: 'rail' }, site: 'railCentre',
    externalDemand: { base: 600, perPop: 0.03 }, passengerType: 'business', cargoPotential: 0,
    accessModeNeeds: { walkMul: 1.2, carMin: 4, serve: 'a metro or regional station at the hall; travellers with bags walk slowly and parking is short' },
    districtEffects: { jobs: 900, lv: 0.12, radius: 6 },
  },
  {
    id: 'motorway', name: 'Motorway junction', gate: { pop: 40000, month: 60, needs: 'roadPortal' }, site: 'roadPortal',
    externalDemand: { base: 800, perPop: 0.02 }, passengerType: 'freight', cargoPotential: 12,
    accessModeNeeds: { walkMul: 1, carMin: -6, serve: 'nothing on rails: it pours cars and lorries onto the arterials; buses with priority and park-and-ride keep them moving' },
    districtEffects: { jobs: 1200, lv: -0.04, radius: 4 },
  },
  {
    id: 'ferry', name: 'Ferry terminal', gate: { pop: 25000, month: 48, needs: 'water' }, site: 'shore',
    externalDemand: { base: 500, perPop: 0.015 }, passengerType: 'ferry', cargoPotential: 1,
    accessModeNeeds: { walkMul: 1.1, carMin: 10, serve: 'foot passengers: a tram or bus stop at the pier, a station within a short walk' },
    districtEffects: { jobs: 300, lv: 0.06, radius: 4 },
  },
  {
    id: 'airport', name: 'Airport', gate: { pop: 60000, month: 96 }, site: 'edgeFlat',
    externalDemand: { base: 1500, perPop: 0.035 }, passengerType: 'air', cargoPotential: 3,
    accessModeNeeds: { walkMul: 1.4, carMin: -4, serve: 'a rail link to the terminal (metro or regional rail): air travellers take taxis unless a train is at the door' },
    districtEffects: { jobs: 2500, lv: -0.1, radius: 7 },
  },
];

export interface Gateway {
  id: GatewayId; x: number; y: number; ang: number; cell: number; zone: number; name: string; opened: number;
  stats: { trips: number; transit: number; car: number; cargo: number };
}

export class GatewaySystem {
  list: Gateway[] = [];
  /** land value change per cell from the open gateways (rebuilt when one opens) */
  lv = new Float32Array(N * N);
  constructor(private sim: Sim) {}

  /** monthly: open the gateways whose gate now holds (at most one a month) */
  tick() {
    if (!GATEWAYS.on) return;
    const sim = this.sim, pop = sim.homes * 2.3;
    const last = this.list.reduce((m, g) => Math.max(m, g.opened), -99);
    if (sim.month - last < GATEWAYS.gap) return;
    for (const t of GATEWAY_TYPES) {
      if (this.list.some((g) => g.id === t.id)) continue;
      if (pop < t.gate.pop || sim.month < t.gate.month) continue;
      const site = this.find(t);
      if (!site) continue;
      const z = Math.min(NZ - 1, Math.floor(site.y / ZONE)) * NZ + Math.min(NZ - 1, Math.floor(site.x / ZONE));
      const g: Gateway = { id: t.id, x: site.x, y: site.y, ang: site.ang, cell: Math.floor(site.y) * N + Math.floor(site.x), zone: z, name: `${t.name} (${sim.projects.placeName(site.x, site.y).replace(/^(near|in) /, '').replace(/ station$/, '')})`, opened: sim.month, stats: { trips: 0, transit: 0, car: 0, cargo: 0 } };
      this.list.push(g);
      this.rasterLV();
      const P = t.externalDemand.base + t.externalDemand.perPop * pop;
      sim.moment('open', `${t.name} opens ${sim.projects.placeName(site.x, site.y)}`,
        `About ${Math.round(P / 100) * 100} travellers a day will come and go through it${t.cargoPotential ? `, and ${Math.round(t.cargoPotential * pop / 1000)} lorries` : ''}. What serves it: ${t.accessModeNeeds.serve}.`, '#5a6b7a', site.x, site.y, true, `gw_${t.id}`);
      return;
    }
  }

  private rasterLV() {
    this.lv.fill(0);
    for (const g of this.list) {
      const t = GATEWAY_TYPES.find((q) => q.id === g.id)!, R = t.districtEffects.radius;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(g.x) + dx, y = Math.floor(g.y) + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const f = Math.max(0, 1 - Math.hypot(dx, dy) / (R + 0.5));
        this.lv[y * N + x] += t.districtEffects.lv * f;
      }
    }
  }

  /** the site a type's finder picks, or null when the city has nothing that fits */
  private find(t: GatewayType): { x: number; y: number; ang: number } | null {
    const sim = this.sim, g = sim.g, o = g.villages[0];
    if (t.site === 'railCentre') {
      if (!g.rail.length) return null;
      // the railway nearest the old town; an existing station within 3 cells becomes the intercity hall
      let best: { x: number; y: number; ang: number; d: number } | null = null;
      for (const pl of g.rail) for (let k = 1; k < pl.length; k++) {
        const [ax, ay] = pl[k - 1], [bx, by] = pl[k];
        for (let q = 0; q <= 4; q++) {
          const x = ax + (bx - ax) * q / 4, y = ay + (by - ay) * q / 4, d = Math.hypot(x - o.x, y - o.y);
          if (!best || d < best.d) best = { x, y, ang: Math.atan2(by - ay, bx - ax), d };
        }
      }
      if (!best || best.d > 14) return null;
      const st = sim.metro.stations.find((s) => Math.hypot(s.x - best!.x, s.y - best!.y) < 3);
      return st ? { x: st.x, y: st.y, ang: best.ang } : best;
    }
    if (t.site === 'roadPortal') {
      const ps = sim.regional.portals.filter((p) => p.kind === 'road');
      if (!ps.length) return null;
      // the road portal with most cars on its zone pairs
      let bp = ps[0], bv = -1;
      for (const p of ps) { let v = 0; for (let b = 0; b < ZONES; b++) v += sim.demand.pCar[Math.min(p.zone, b) * ZONES + Math.max(p.zone, b)]; if (v > bv) { bv = v; bp = p; } }
      // a few cells in from the edge, where the junction meets the arterial
      const cx = N / 2, cy = N / 2, L = Math.hypot(cx - bp.x, cy - bp.y) || 1;
      return { x: bp.x + (cx - bp.x) / L * 4, y: bp.y + (cy - bp.y) / L * 4, ang: Math.atan2(cy - bp.y, cx - bp.x) };
    }
    if (t.site === 'shore') {
      // a shore cell near the old town, on a street, facing open water
      let best: { x: number; y: number; ang: number; s: number } | null = null;
      for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
        const i = y * N + x;
        if (g.water[i] || sim.roadDist[i] > 2) continue;
        let wx = 0, wy = 0, wn = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (g.water[(y + dy) * N + (x + dx)]) { wx += dx; wy += dy; wn++; }
        if (wn < 14) continue;
        const d = Math.hypot(x - o.x, y - o.y);
        if (d > 16) continue;
        const s = wn - d * 0.8;
        if (!best || s > best.s) best = { x: x + 0.5, y: y + 0.5, ang: Math.atan2(wy, wx), s };
      }
      return best;
    }
    // edgeFlat: an airport needs a large flat open site well away from the centre, near a road, with no plots under the runway
    let best: { x: number; y: number; ang: number; s: number } | null = null;
    const H = g.height;
    for (let y = 8; y < N - 8; y += 2) for (let x = 8; x < N - 8; x += 2) {
      const d = Math.hypot(x - o.x, y - o.y);
      if (d < 30) continue;
      const i = y * N + x;
      if (g.water[i] || sim.roadDist[i] > 6) continue;
      for (const ang of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4]) {
        // the runway: 11 cells long, 1 wide; flat (height spread under 6 m), dry, off the streets, no plots within a cell of it
        let lo = Infinity, hi = -Infinity, ok = true;
        for (let s = -5.5; s <= 5.5 && ok; s += 0.5) {
          const px = x + Math.cos(ang) * s, py = y + Math.sin(ang) * s, cx = Math.floor(px), cy = Math.floor(py);
          if (cx < 1 || cy < 1 || cx >= N - 1 || cy >= N - 1) { ok = false; break; }
          const j = cy * N + cx;
          if (g.water[j] || sim.cBuilt[j] > 0 || g.road[j]) { ok = false; break; }
          // the terminal and apron beside it (one to two cells to the side) stay off the streets too
          for (const off of [1, 2]) {
            const tx = Math.floor(px - Math.sin(ang) * off), ty = Math.floor(py + Math.cos(ang) * off);
            if (Math.abs(s) <= 2.5 && tx >= 0 && ty >= 0 && tx < N && ty < N && (g.road[ty * N + tx] || g.water[ty * N + tx])) ok = false;
          }
          lo = Math.min(lo, H[j]); hi = Math.max(hi, H[j]);
        }
        if (!ok || hi - lo > 6) continue;
        if (sim.lots.near(x, y, 6).some((l) => l.type && l.level > 0)) continue;
        const s = Math.min(d, 50) - (hi - lo) * 1.5 - sim.roadDist[i];
        if (!best || s > best.s) best = { x: x + 0.5, y: y + 0.5, ang, s };
      }
    }
    return best;
  }

  /** gateway jobs (the district effect) added to the cells after the plots are counted */
  addJobs() {
    const sim = this.sim;
    for (const g of this.list) {
      const t = GATEWAY_TYPES.find((q) => q.id === g.id)!;
      sim.cJobs[g.cell] += t.districtEffects.jobs; sim.zJobs[g.zone] += t.districtEffects.jobs; sim.jobs += t.districtEffects.jobs;
    }
  }

  info() {
    return this.list.map((g) => {
      const t = GATEWAY_TYPES.find((q) => q.id === g.id)!;
      return { id: g.id, type: t.name, name: g.name, x: g.x, y: g.y, ang: g.ang, opened: g.opened, serve: t.accessModeNeeds.serve, ...g.stats };
    });
  }
}
void CELL;
