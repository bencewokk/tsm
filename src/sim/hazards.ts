/**
 * Natural hazards (round 5, optional): river floods and landslides, data-driven like the projects.
 * Each hazard has a trigger on the city state (built plots next to the floodplain / on the edge of steep ground, the season),
 * a monthly probability, a cooldown, damage (buildings lose a level or are wrecked, the city pays for the clean-up), and after a
 * repeat a decision: pay for defences (flood walls, retaining walls) that stop or cut that hazard for good, or accept the risk.
 */
import { BT, Flag, N } from './constants';
import { hash01 } from './profiles';
import type { Sim } from './sim';
import type { Lot } from './lots';

export interface HazardDef {
  id: 'flood' | 'landslide';
  name: string; color: string;
  /** raster flag the hazard comes from, and how close (cells) a building must be to it */
  flag: number; reach: number;
  /** months of the year (0 = January) it can strike */
  season: number[];
  prob: number; cooldown: number;
  /** buildings hit at most, and how hard: levels lost (a building at level 1 is wrecked) */
  maxHit: number; levels: number;
  /** clean-up cost per building hit */
  cost: number;
  /** after this many strikes the council is asked about defences */
  askAfter: number;
  defence: { label: string; detail: string; cost: number; cut: number };
  text: string;
}

export const HAZARDS: HazardDef[] = [
  {
    id: 'flood', name: 'River flood', color: '#4a7fb5', flag: Flag.Flood, reach: 1.6, season: [10, 11, 0, 1, 2], prob: 0.05, cooldown: 10,
    maxHit: 8, levels: 1, cost: 0.6e6, askAfter: 2,
    defence: { label: 'Build flood walls along the river', detail: 'The city pays {cost}. Floods stop for good on this river.', cost: 14e6, cut: 1 },
    text: 'The river burst its banks {place}: {hit} buildings on the edge of the floodplain were flooded ({wrecked} wrecked), clean-up {clean}.',
  },
  {
    id: 'landslide', name: 'Landslide', color: '#9a7a52', flag: Flag.Steep, reach: 1.2, season: [9, 10, 11, 0, 1, 2, 3], prob: 0.03, cooldown: 14,
    maxHit: 4, levels: 2, cost: 0.9e6, askAfter: 2,
    defence: { label: 'Build retaining walls and drains', detail: 'The city pays {cost}. Landslides become rare (a quarter as likely).', cost: 9e6, cut: 0.75 },
    text: 'After weeks of rain the slope gave way {place}: {hit} buildings on the edge of the steep ground were damaged ({wrecked} wrecked), clean-up {clean}.',
  },
];

const M = (v: number) => `$${Math.round(v / 1e5) / 10}M`;

export class HazardSystem {
  strikes: Record<string, number> = {};
  last: Record<string, number> = {};
  /** 0..1: share of each hazard removed by defences */
  cut: Record<string, number> = {};
  asked: Record<string, boolean> = {};
  queue: string[] = [];
  log: string[] = [];
  private exposedCache: Record<string, number[]> = {};
  private cacheMonth = -1;

  constructor(private sim: Sim) {}

  /** built homes / shops close to the hazard's ground (recomputed yearly) */
  private exposed(h: HazardDef): Lot[] {
    const sim = this.sim;
    if (this.cacheMonth < 0 || sim.month - this.cacheMonth >= 12) {
      this.cacheMonth = sim.month;
      for (const d of HAZARDS) {
        const out: number[] = [];
        for (const l of sim.lots.lots) {
          if (!l.alive || !(l.type === BT.Res || l.type === BT.Com) || !l.level || l.asm || l.constr) continue;
          let hit = false;
          const r = Math.ceil(d.reach);
          for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
            const x = Math.floor(l.x) + dx, y = Math.floor(l.y) + dy;
            if (x < 0 || y < 0 || x >= N || y >= N || Math.hypot(dx, dy) > d.reach) continue;
            if (sim.g.flags[y * N + x] & d.flag) hit = true;
          }
          if (hit) out.push(l.id);
        }
        this.exposedCache[d.id] = out;
      }
    }
    return (this.exposedCache[h.id] ?? []).map((id) => sim.lots.lots[id]).filter((l) => l && l.alive && l.level > 0 && !l.asm && !l.constr);
  }

  tick() {
    const sim = this.sim;
    HAZARDS.forEach((h, hi) => {
      if (!h.season.includes(sim.month % 12)) return;
      if (sim.month - (this.last[h.id] ?? -999) < h.cooldown) return;
      const ex = this.exposed(h);
      if (ex.length < 3) return;
      const p = h.prob * (1 - (this.cut[h.id] ?? 0)) * Math.min(2, ex.length / 20);
      if (hash01(sim.seed * 13 + hi * 7919, sim.month) >= p) return;
      this.strike(h, ex);
    });
  }

  private strike(h: HazardDef, ex: Lot[]) {
    const sim = this.sim;
    // the event hits one stretch: the exposed buildings nearest a random exposed one
    const c = ex[Math.floor(hash01(sim.month * 31 + ex.length, 5) * ex.length)];
    const hitL = ex.slice().sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y) || a.id - b.id).slice(0, h.maxHit);
    let wrecked = 0;
    for (const l of hitL) {
      // a flooded house is usually dried out and repaired (it ages and loses value), only some are written off
      if (h.id === 'flood' && l.level === 1 && hash01(l.id, sim.month) < 0.6) { l.low = Math.min(255, l.low + 3); l.age = 0; continue; }
      l.level = Math.max(0, l.level - h.levels);
      l.hgt = 0;
      if (l.level === 0) { l.type = BT.None; wrecked++; }
      l.age = 0;
    }
    const clean = hitL.length * h.cost;
    sim.money -= clean;
    this.last[h.id] = sim.month;
    this.strikes[h.id] = (this.strikes[h.id] ?? 0) + 1;
    const place = sim.projects.placeName(c.x, c.y);
    const text = h.text.replace('{place}', place).replace('{hit}', String(hitL.length)).replace('{wrecked}', String(wrecked)).replace('{clean}', M(clean));
    sim.projects.notices.push({ month: sim.month, text, x: c.x, y: c.y, color: h.color });
    if (sim.projects.notices.length > 12) sim.projects.notices.shift();
    sim.say(text);
    this.log.push(`m${sim.month}\t${h.id}\t${place}\thit ${hitL.length}, wrecked ${wrecked}, clean-up ${M(clean)}`);
    if (this.strikes[h.id] >= h.askAfter && !this.asked[h.id] && !(this.cut[h.id] ?? 0)) { this.asked[h.id] = true; this.queue.push(h.id); }
  }

  nextDecision(): { id: string; title: string; text: string; choices: { label: string; detail: string }[] } | null {
    const id = this.queue[0];
    const h = HAZARDS.find((x) => x.id === id);
    if (!h) { this.queue.shift(); return null; }
    return {
      id: 'haz_' + h.id, title: `${h.name}s: defend the city?`,
      text: `${h.name}s have struck ${this.strikes[h.id]} times now (the last one ${this.sim.month - (this.last[h.id] ?? 0)} months ago). Engineers propose defences.`,
      choices: [
        { label: h.defence.label, detail: h.defence.detail.replace('{cost}', M(h.defence.cost)) },
        { label: 'Accept the risk', detail: 'Nothing is built; the council will be asked again after the next strikes.' },
      ],
    };
  }

  defenceCost(id: string) { return HAZARDS.find((x) => x.id === id)?.defence.cost ?? 0; }

  choose(id: string, k: number) {
    const h = HAZARDS.find((x) => x.id === id);
    this.queue = this.queue.filter((q) => q !== id);
    if (!h) return;
    if (k === 0) { this.sim.money -= h.defence.cost; this.cut[h.id] = h.defence.cut; this.log.push(`m${this.sim.month}\t${h.id}\tdefences built (-${M(h.defence.cost)})`); this.sim.say(`${h.defence.label}: done`); }
    else { this.asked[h.id] = false; this.strikes[h.id] = 0; this.log.push(`m${this.sim.month}\t${h.id}\trisk accepted`); }
  }
}
