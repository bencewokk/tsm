import { BT, CELL, N, Flag } from './constants';
import { LANDMARKS, LANDMARK_INDEX, landmarkAt, type LandmarkDef, type SiteChoice } from './landmarks';
import { ROAD_HALF } from './roads';
import { hash01 } from './profiles';
import type { Sim } from './sim';
import type { Lot } from './lots';
import type { AsmPlan } from './assembly';

export interface LmState {
  lot: number; def: number; state: 'building' | 'open';
  pay: 'city' | 'dev'; opened: number; served: boolean; carPark: boolean;
  eventDay: boolean; events: number; penalty: boolean;
}

export interface LandmarkInfo {
  id: string; name: string; form: string; category: string; x: number; y: number;
  state: 'building' | 'open'; pct: number; served: boolean; carPark: boolean; eventDay: boolean; visitors: number;
}

/** Placement, opening, service check, event days and trip effects of landmarks (all numbers come from landmarks.ts). */
export class LandmarkSystem {
  states = new Map<number, LmState>();
  constructor(private sim: Sim) {}

  /** Is this landmark available in this city (profile filter)? */
  allowed(def: LandmarkDef): boolean {
    const r = def.requires, cp = this.sim.cp;
    if (!r) return true;
    if (r.origin && !r.origin.includes(cp.origin)) return false;
    if (r.terrain && !r.terrain.includes(cp.terrain)) return false;
    if (r.site && !r.site.includes(cp.site)) return false;
    if (r.history && !cp.history.some((h) => r.history!.includes(h.kind)) && !(r.origin && r.origin.includes(cp.origin))) return false;
    if (r.tradition && !r.tradition.includes(cp.tradition)) return false;
    if (r.wealthAtLeast !== undefined && cp.wealth < r.wealthAtLeast) return false;
    return true;
  }

  /** Pick up landmark plots (including the day-one ones) that have no state yet. */
  sync() {
    for (const l of this.sim.lots.lots) {
      if (!l.alive || !l.lm || this.states.has(l.id)) continue;
      const def = LANDMARKS[l.lm - 1];
      const built = l.level > 0 && l.constr === 0;
      this.states.set(l.id, { lot: l.id, def: l.lm - 1, state: built ? 'open' : 'building', pay: 'city', opened: built ? 0 : -1, served: false, carPark: false, eventDay: false, events: 0, penalty: false });
      void def;
    }
  }

  // ---------------------------------------------------------------- siting
  private anchors(def: LandmarkDef, site: SiteChoice): [number, number][] {
    const s = this.sim, g = s.g, o = s.town.districts[0] ?? { x: N / 2, y: N / 2 };
    if (def.needs?.hill) site = 'hill';
    else if (def.needs?.water) site = 'water';
    const out: [number, number][] = [];
    if (site === 'centre') { out.push([o.x, o.y]); for (const d of s.town.districts.slice(1, 3)) out.push([d.x, d.y]); }
    else if (site === 'station') {
      const st = s.metro.stations.slice().sort((a, b) => b.riders - a.riders).slice(0, 3);
      for (const t of st) out.push([t.x, t.y]);
      if (!out.length) out.push([o.x + 4, o.y + 2]);
    } else if (site === 'water') {
      const cand: { x: number; y: number; d: number }[] = [];
      for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
        const i = y * N + x;
        if (g.water[i] || g.distWater[i] < 2 || g.distWater[i] > 3 || (g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Flood))) continue;
        const d = Math.hypot(x - o.x, y - o.y);
        if (d < 4 || d > 34) continue;
        cand.push({ x: x + 0.5, y: y + 0.5, d });
      }
      cand.sort((a, b) => a.d - b.d);
      for (let k = 0; k < cand.length && out.length < 14; k += 4) out.push([cand[k].x, cand[k].y]);
    } else if (site === 'hill') {
      const cand: { x: number; y: number; h: number }[] = [];
      for (let y = 3; y < N - 3; y++) for (let x = 3; x < N - 3; x++) {
        const i = y * N + x;
        if (g.water[i] || (g.flags[i] & (Flag.Steep | Flag.Docks | Flag.Flood))) continue;
        const d = Math.hypot(x - o.x, y - o.y);
        if (d > 30) continue;
        cand.push({ x: x + 0.5, y: y + 0.5, h: g.height[i] - d * 0.15 });
      }
      cand.sort((a, b) => b.h - a.h);
      for (const c of cand) { if (out.every((p) => Math.hypot(p[0] - c.x, p[1] - c.y) > 5)) out.push([c.x, c.y]); if (out.length >= 8) break; }
    } else {
      const base = hash01(LANDMARK_INDEX[def.id], 3) * Math.PI * 2;
      for (let k = 0; k < 10; k++) { const a = base + k * 0.63, r = 15 + (k % 3) * 3; out.push([o.x + Math.cos(a) * r, o.y + Math.sin(a) * r]); }
    }
    return out;
  }

  /** Venues get a bigger forecourt: a drop-off loop between the street and the entrance. */
  hasLoop(def: LandmarkDef) { return def.category === 'sport' || def.category === 'leisure' || def.category === 'health' || def.category === 'education'; }

  /** Find a site near an anchor, facing the nearest street: every plot it overlaps is bought up, local streets through it close. */
  private tryPlan(def: LandmarkDef, ax: number, ay: number): AsmPlan | null {
    const s = this.sim, R = s.roads;
    const [w, d] = def.size;
    const loop = this.hasLoop(def) ? 0.3 : 0;
    for (let ring = 0; ring <= 9; ring++) {
      const n = ring === 0 ? 1 : 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.37;
        const x = ax + Math.cos(a) * ring * 1.1, y = ay + Math.sin(a) * ring * 1.1;
        if (x < 3 || y < 3 || x > N - 3 || y > N - 3) continue;
        const e = R.nearestEdge(x, y, 4);
        if (!e) continue;
        const ea = Math.atan2(R.ny[R.eb[e.e]] - R.ny[R.ea[e.e]], R.nx[R.eb[e.e]] - R.nx[R.ea[e.e]]);
        const nx = -Math.sin(ea), ny = Math.cos(ea);
        const side = (x - e.x) * nx + (y - e.y) * ny >= 0 ? 1 : -1;
        const ang = side > 0 ? ea : ea + Math.PI;
        const vx = -Math.sin(ang), vy = Math.cos(ang);
        const setback = ROAD_HALF[R.ecls[e.e]] + 0.1 + loop + d / 2;
        for (const slide of [0, 0.6, -0.6, 1.2, -1.2]) {
          const cx = e.x + vx * setback + Math.cos(ang) * slide * w, cy = e.y + vy * setback + Math.sin(ang) * slide * w;
          const plan = s.asm.planRect(cx, cy, ang, w, d, true, 'landmark');
          if (plan) return plan;
        }
      }
    }
    return null;
  }

  private findPlan(def: LandmarkDef, site: SiteChoice): AsmPlan | null {
    for (const [ax, ay] of this.anchors(def, site)) { const p = this.tryPlan(def, ax, ay); if (p) return p; }
    return null;
  }

  /** Words for the proposal dialog: what this site would clear. */
  preview(id: string, site: SiteChoice): string {
    const def = LANDMARKS.find((l) => l.id === id);
    if (!def) return '';
    const plan = this.findPlan(def, site);
    return plan ? this.sim.asm.describe(plan, def) : 'No site found.';
  }

  /** The effect of accepting a proposal. Returns false (and the caller refunds) if no site fits. */
  place(id: string, site: SiteChoice, pay: 'city' | 'dev'): boolean {
    const def = LANDMARKS.find((l) => l.id === id);
    if (!def) return false;
    const plan = this.findPlan(def, site);
    if (!plan) { this.sim.say(`No site found for the ${def.name.toLowerCase()}`); return false; }
    this.sim.asm.start(plan, { type: BT.Landmark, level: 1, hgt: 0, months: def.buildMonths, label: def.name, form: def.form, landmark: id, pay, loop: this.hasLoop(def) });
    this.sim.say(`${def.name} approved: ${plan.members.length} plots to buy up${plan.closed.length ? `, ${plan.closed.length} street${plan.closed.length > 1 ? 's' : ''} to close` : ''}`);
    return true;
  }

  // ---------------------------------------------------------------- monthly
  tick() {
    const s = this.sim;
    this.sync();
    for (const st of this.states.values()) {
      const lot = s.lots.lots[st.lot];
      const def = LANDMARKS[st.def];
      if (!lot || !lot.alive) { this.states.delete(st.lot); continue; }
      if (st.state === 'building' && lot.constr === 0 && lot.level > 0) {
        // opening day: is there a station within walking distance?
        st.state = 'open'; st.opened = s.month;
        st.served = s.walkToStation(lot.cell) <= 8;
        if (!st.served) {
          st.carPark = true; lot.flags |= Flag.CarLocked;
          if (st.pay === 'dev') { st.penalty = true; s.money -= def.cost * 0.25; s.say(`${def.name} opens with no station in reach: car park built, ${Math.round(def.cost * 0.25 / 1e6)}M penalty`); }
          else s.say(`${def.name} opens with no station in reach: it gets a car park and its visitors drive`);
        } else s.say(`${def.name} opens, served by the metro`);
      }
      if (st.state === 'open') {
        if (!st.carPark) st.served = s.walkToStation(lot.cell) <= 8;
        st.eventDay = def.eventEvery > 0 && s.rng.next() < 1 / def.eventEvery;
        if (st.eventDay) { st.events++; if (def.category === 'sport' || def.category === 'leisure' || st.events % 3 === 0) s.say(`Event day at the ${def.name.toLowerCase()}: ${Math.round(def.eventTrips / 100) * 100} extra trips`); }
      }
    }
  }

  /** Landmark follow-up events ask whether the landmark is served. */
  servedFor(id: string): boolean {
    for (const st of this.states.values()) if (LANDMARKS[st.def].id === id && st.state === 'open') return !st.carPark && st.served;
    return false;
  }
  setCarPark(id: string) { for (const st of this.states.values()) if (LANDMARKS[st.def].id === id) st.carPark = true; }

  // ---------------------------------------------------------------- effects on the model
  /** Open landmarks: [zone, state, def]. */
  open(): { zone: number; st: LmState; def: LandmarkDef; lot: Lot }[] {
    const out: { zone: number; st: LmState; def: LandmarkDef; lot: Lot }[] = [];
    for (const st of this.states.values()) {
      if (st.state !== 'open') continue;
      const lot = this.sim.lots.lots[st.lot];
      if (!lot || !lot.alive) continue;
      out.push({ zone: this.sim.zoneOf(lot.cell), st, def: LANDMARKS[st.def], lot });
    }
    return out;
  }

  info(): LandmarkInfo[] {
    const out: LandmarkInfo[] = [];
    for (const st of this.states.values()) {
      const lot = this.sim.lots.lots[st.lot];
      if (!lot || !lot.alive) continue;
      const def = LANDMARKS[st.def];
      const pct = st.state === 'building' && lot.constrTotal ? 1 - lot.constr / lot.constrTotal : 1;
      let nm = def.name;
      if (def.start) { let bd = Infinity, vn = ''; for (const v of this.sim.g.villages) { const dd = Math.hypot(v.x - lot.x, v.y - lot.y); if (dd < bd) { bd = dd; vn = v.name; } } nm = `${def.name} (${vn})`; }
      out.push({ id: def.id, name: nm, form: def.form, category: def.category, x: lot.x, y: lot.y, state: st.state, pct, served: st.served, carPark: st.carPark, eventDay: st.eventDay, visitors: def.visitors });
    }
    return out;
  }
}

export { landmarkAt, CELL };
