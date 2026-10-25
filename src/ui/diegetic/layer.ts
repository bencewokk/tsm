import * as THREE from 'three';
import { renderTag, type Bitmap, type TagSpec, MONO } from './paper';
import { Desk } from './desk';
import type { DiegeticEvent } from './events';
import { CELL } from '../../sim/constants';

export type { DiegeticEvent } from './events';

/**
 * The diegetic presentation layer: one 2D canvas over the 3D view that carries the objects pinned to the model (station tags with their
 * ridership, project flags, landmark tags, cost slips, rising coin pops) plus a small stack of paper slips for news. Everything is pooled by
 * id and re-rendered to an offscreen bitmap only when its content changes; a frame is a projection and a drawImage per visible item,
 * nothing touches the DOM. Items fade out with distance, keep a constant pixel size, and are placed by priority so they never overlap.
 *
 * API (the game-feedback events of DESIGN-FUN section 3 map onto it through `notify`):
 *   ui.tag(id, pos, spec, opts)   a paper tag on a pin (stations, landmarks)
 *   ui.pin(id, pos, spec, opts)   a pinned flag (projects, the docks brief)
 *   ui.untag(id) / ui.sweep(prefix, keepIds)
 *   ui.float(pos, text, color)    a coin pop / message rising from a point
 *   ui.cost(pos | null, spec)     the plan-mode cost slip (tracing paper) that follows a point
 *   ui.brief(id, cellPos, spec)   a paper brief pinned at a site for a few seconds (a beat that has a place)
 *   ui.newspaper(...) / ui.slip(...)  the table objects (desk.ts): a front page, a news slip
 *   ui.notify(event)              every kind of the fun-pass contract (events.ts, mapping in VISUAL-PASS.md)
 */
export interface World3 { x: number; y: number; z: number }
export interface TagOpts {
  /** higher is placed first and survives crowding (default 1) */
  priority?: number;
  /** hide beyond this camera distance (m); default 7600 */
  far?: number;
  /** below this distance the full tag shows, above it the mini badge (m); default 3400 */
  full?: number;
  /** stick length in px for the full tag (default 22; flags 34) */
  stick?: number;
}

interface Item {
  id: string; pos: World3; spec: TagSpec; o: Required<TagOpts>; flag: boolean;
  day?: Bitmap; night?: Bitmap; mini?: Bitmap; miniNight?: Bitmap; sig: string; pulse: number;
  /** briefs expire: performance.now() time after which the item fades out and is dropped */
  until?: number;
}
interface Floater { pos: World3; text: string; color: string; t0: number; dur: number }
interface Rect { x: number; y: number; w: number; h: number }

const fmtMoney = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`);

export class DiegeticLayer {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private items = new Map<string, Item>();
  private floaters: Floater[] = [];
  private slips = document.createElement('div');
  private costItem: Item | null = null;
  private costPos: World3 | null = null;
  private dpr = 1;
  private night = 0;
  private v = new THREE.Vector3();
  private placed: Rect[] = [];
  /** per-line load (0..) from crowding events, read by the world sync */
  lineLoad = new Map<number, number>();
  /** table objects: newspaper, clipboard, dial plate */
  readonly desk: Desk;
  /** terrain height under a world point, set by the world sync (events carry cell positions) */
  ground: (x: number, z: number) => number = () => 0;
  private lastDug: World3 | null = null;
  enabled = true;
  /** counts for the perf notes */
  stats = { items: 0, drawn: 0 };

  /** `before`: the element the canvas goes in front of in DOM order (the HUD root), so panels stay above the tags */
  constructor(parent: HTMLElement, private camera: THREE.PerspectiveCamera, before?: Element | null) {
    this.canvas.className = 'dg-canvas';
    this.canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    const frame = document.createElement('div');
    frame.className = 'dg-frame';
    parent.insertBefore(this.canvas, before ?? null);
    parent.insertBefore(frame, before ?? null);
    this.g = this.canvas.getContext('2d')!;
    this.slips.className = 'dg-slips';
    parent.appendChild(this.slips);
    this.desk = new Desk(parent);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(window.innerWidth * this.dpr)), h = Math.max(1, Math.round(window.innerHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    for (const it of this.items.values()) { it.day = it.night = it.mini = it.miniNight = undefined; }
  }

  setNight(n: number) { this.night = n; }

  // ------------------------------------------------------------------ items
  private upsert(id: string, pos: World3, spec: TagSpec, opts: TagOpts | undefined, flag: boolean) {
    const sig = `${spec.title}|${spec.sub ?? ''}|${spec.badge ?? ''}|${spec.color}|${spec.look}|${Math.round((spec.pct ?? 0) * 40)}|${spec.ok}`;
    let it = this.items.get(id);
    const o: Required<TagOpts> = { priority: opts?.priority ?? 1, far: opts?.far ?? 7600, full: opts?.full ?? 3400, stick: opts?.stick ?? (flag ? 34 : 22) };
    if (!it) { it = { id, pos, spec, o, flag, sig, pulse: -1e9 }; this.items.set(id, it); }
    else if (it.sig !== sig) { it.sig = sig; it.day = it.night = it.mini = it.miniNight = undefined; }
    it.pos = pos; it.spec = spec; it.o = o;
    return it;
  }
  tag(id: string, pos: World3, spec: TagSpec, opts?: TagOpts) { return this.upsert(id, pos, spec, opts, false); }
  pin(id: string, pos: World3, spec: TagSpec, opts?: TagOpts) { return this.upsert(id, pos, { ...spec, look: spec.look === 3 ? 3 : 1 }, opts, true); }
  untag(id: string) { this.items.delete(id); }
  /** drop every item whose id starts with `prefix` and is not in `keep` */
  sweep(prefix: string, keep: Set<string>) { for (const id of this.items.keys()) if (id.startsWith(prefix) && !keep.has(id)) this.items.delete(id); }
  pulse(id: string, now: number) { const it = this.items.get(id); if (it) it.pulse = now; }
  float(pos: World3, text: string, color = '#d9a21b', dur = 1900) { this.floaters.push({ pos, text, color, t0: performance.now(), dur }); }
  /** the plan-mode cost slip: tracing paper label that follows a point; null hides it */
  cost(pos: World3 | null, spec?: TagSpec) {
    this.costPos = pos;
    if (!pos || !spec) { this.costItem = null; return; }
    const it = this.costItem ?? ({ id: 'cost', pos, spec, o: { priority: 99, far: 1e9, full: 1e9, stick: 26 }, flag: false, sig: '', pulse: -1e9 } as Item);
    const sig = `${spec.title}|${spec.sub}|${spec.ok}|${spec.badge}`;
    if (it.sig !== sig) { it.sig = sig; it.day = it.night = undefined; }
    it.pos = pos; it.spec = { ...spec, look: 2 }; this.costItem = it;
  }

  // ------------------------------------------------------------------ events
  /** a world point from cell units */
  at(cx: number, cy: number, up = 1): World3 { const x = cx * CELL, z = cy * CELL; return { x, y: this.ground(x, z) + up, z }; }

  /**
   * A brief pinned at a site for a few seconds: a beat that has a place (cranes at a station, a tower topping out) stays at the spot
   * instead of only appearing in a toast. Replaced by id, fades out, then is dropped.
   */
  brief(id: string, cell: { x: number; y: number }, spec: { title: string; sub?: string; color: string }, ms = 9000) {
    const it = this.upsert(id, this.at(cell.x, cell.y, 1), { ...spec, look: 1 }, { priority: 75, far: 6500, full: 6500 }, true);
    it.until = performance.now() + ms;
    it.pulse = performance.now();
  }

  /** Every game-feedback event of the fun-pass contract has a place on the table or on the model (see VISUAL-PASS.md for the table). */
  notify(e: DiegeticEvent) {
    switch (e.kind) {
      case 'fare': this.float(this.at(e.x, e.y, 6), `+${fmtMoney(e.amount)}`, '#c58b00'); break;
      case 'stationOpened':
        if (e.stationId !== undefined) this.pulse(`st:${e.stationId}`, performance.now());
        this.slip(`${e.name} station opens`, 'Ribbon cut. Riders will follow the new walking routes.', e.color, false);
        break;
      case 'lineOpened': this.desk.newspaper(e.moment.title, e.moment.text, e.color, true); break;
      case 'moment': {
        const m = e.moment;
        if (m.big) this.desk.newspaper(m.title, m.text, m.color, false);
        else this.slip(m.title, m.text, m.color, false);
        if (Number.isFinite(m.x) && Number.isFinite(m.y) && m.kind !== 'goal') this.brief(`mo:${m.ref ?? m.title}`, m, { title: m.title, sub: m.text.length > 46 ? m.text.slice(0, 44) + '...' : m.text, color: m.color });
        break;
      }
      case 'objectives': {
        this.desk.goals(e.goals, e.done, e.total);
        const keep = new Set<string>();
        for (const g of e.goals) {
          if (g.x === undefined || g.y === undefined) continue;
          const id = `goal:${g.id}`; keep.add(id);
          this.pin(id, this.at(g.x, g.y, 1), { title: g.title, sub: `${Math.round(g.cur)} of ${g.target}${g.reward ? `  ·  ${g.reward}` : ''}`, color: '#c9a227', look: 1, pct: g.target ? g.cur / g.target : 0 }, { priority: 80, far: 9000, full: 9000 });
        }
        this.sweep('goal:', keep);
        break;
      }
      case 'objectiveReached':
        this.slip(e.moment.title, e.moment.text, '#c9a227', true);
        break;
      case 'crowding': for (const l of e.lines) this.lineLoad.set(l.id, l.load); break;
      case 'planCost':
        if (this.costItem && this.costPos) this.cost(this.costPos, { title: fmtMoney(e.cost), sub: `${e.km.toFixed(1)} km${e.trains ? `  ·  ${e.trains} trains` : ''}`, badge: e.affordable ? '' : 'too dear', color: e.affordable ? '#2f7d5a' : '#c0503a', look: 2, ok: e.affordable });
        break;
      case 'stationDug': {
        this.lastDug = this.at(e.x, e.y, 8);
        this.float(this.lastDug, `-${fmtMoney(e.cost)}`, '#b4402d');
        break;
      }
      case 'undo': this.float(this.lastDug ?? this.at(0, 0, 0), `+${fmtMoney(e.refund)}`, '#3f8f5a'); if (this.lastDug) this.slip('Plan taken back', `${fmtMoney(e.refund)} returned in full.`, '#3f8f5a', false); this.lastDug = null; break;
      case 'clock': this.desk.clock(e.mode, e.speed, e.auto); break;
    }
  }

  /** a front page on the table (headlines, a line opening) */
  newspaper(title: string, text: string, color: string, ribbon = false) { this.desk.newspaper(title, text, color, ribbon); }

  /** A paper slip pinned to the table edge: headline in serif, a line of text, fades after a few seconds. */
  slip(title: string, text: string, color: string, big: boolean) {
    const d = document.createElement('div');
    d.className = 'dg-slip' + (big ? ' big' : '');
    d.style.setProperty('--c', color);
    d.style.setProperty('--tilt', `${(Math.random() * 2 - 1) * 1.1}deg`);
    const h = document.createElement('b'); h.textContent = title;
    const p = document.createElement('span'); p.textContent = text;
    d.append(h, p);
    this.slips.prepend(d);
    while (this.slips.children.length > 4) this.slips.lastElementChild!.remove();
    setTimeout(() => d.classList.add('out'), big ? 9000 : 6500);
    setTimeout(() => d.remove(), big ? 9700 : 7200);
  }

  // ------------------------------------------------------------------ frame
  private bmp(it: Item, mini: boolean): Bitmap {
    const night = this.night > 0.5;
    const key = mini ? (night ? 'miniNight' : 'mini') : night ? 'night' : 'day';
    let b = it[key];
    if (!b) { b = renderTag({ ...it.spec, mini }, this.dpr, night); it[key] = b; }
    return b;
  }

  draw(now: number) {
    const g = this.g, W = this.canvas.width, H = this.canvas.height, d = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.enabled) return;
    this.camera.updateMatrixWorld();
    const cw = W / d, ch = H / d, cam = this.camera.position;
    g.setTransform(d, 0, 0, d, 0, 0);
    const vis: { it: Item; sx: number; sy: number; dist: number; mini: boolean }[] = [];
    const consider = (it: Item) => {
      if (it.until !== undefined && now > it.until + 800) { this.items.delete(it.id); return; }
      const dx = it.pos.x - cam.x, dy = it.pos.y - cam.y, dz = it.pos.z - cam.z, dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > it.o.far) return;
      this.v.set(it.pos.x, it.pos.y, it.pos.z).project(this.camera);
      if (this.v.z > 1 || this.v.z < -1) return;
      const sx = (this.v.x * 0.5 + 0.5) * cw, sy = (-this.v.y * 0.5 + 0.5) * ch;
      if (sx < -80 || sx > cw + 80 || sy < -40 || sy > ch + 120) return;
      const mini = dist > it.o.full && !it.flag && it.id !== 'cost';
      if (mini && !it.spec.badge) return;
      vis.push({ it, sx, sy, dist, mini });
    };
    for (const it of this.items.values()) consider(it);
    if (this.costItem && this.costPos) consider(this.costItem);
    this.stats.items = this.items.size;
    // priority first, then near to far; place greedily without overlap (the cost slip always shows)
    vis.sort((a, b) => b.it.o.priority - a.it.o.priority || a.dist - b.dist);
    this.placed.length = 0;
    let drawn = 0;
    for (const e of vis) {
      const b = this.bmp(e.it, e.mini);
      const stick = e.mini ? 10 : e.it.o.stick;
      const fade = (e.it.id === 'cost' ? 1 : Math.min(1, (e.it.o.far - e.dist) / 900)) * (e.it.until !== undefined ? Math.max(0, Math.min(1, (e.it.until + 800 - now) / 800)) : 1);
      const x = e.sx - b.w / 2, y = e.sy - stick - b.h;
      const r = { x: x - 2, y: y - 2, w: b.w + 4, h: b.h + stick + 4 };
      if (e.it.id !== 'cost' && e.it.o.priority < 90) {
        let hit = false;
        for (const p of this.placed) if (r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y) { hit = true; break; }
        if (hit) continue;
      }
      this.placed.push(r);
      drawn++;
      g.globalAlpha = fade;
      // ground shadow, stick and pin head
      g.fillStyle = 'rgba(20,14,6,0.25)'; g.beginPath(); g.ellipse(e.sx + 1, e.sy + 1, e.mini ? 3 : 4.5, e.mini ? 1.4 : 2, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = this.night > 0.5 ? '#9aa0a8' : '#55504a'; g.lineWidth = e.mini ? 1 : 1.3;
      g.beginPath(); g.moveTo(e.sx, e.sy); g.lineTo(e.sx, e.sy - stick); g.stroke();
      const pulse = Math.max(0, 1 - (now - e.it.pulse) / 2600);
      if (pulse > 0) { g.strokeStyle = e.it.spec.color; g.globalAlpha = fade * pulse; g.lineWidth = 2; g.beginPath(); g.arc(e.sx, e.sy, 6 + (1 - pulse) * 40, 0, Math.PI * 2); g.stroke(); g.globalAlpha = fade; }
      // the paper (flags hang a little askew from their pin)
      if (e.it.flag && e.it.spec.look !== 3) { g.save(); g.translate(e.sx, e.sy - stick); g.rotate(-0.04); g.drawImage(b.c, -b.w / 2, -b.h, b.w, b.h); g.restore(); }
      else g.drawImage(b.c, x, y, b.w, b.h);
      g.fillStyle = e.it.spec.color; g.strokeStyle = 'rgba(30,20,10,0.6)'; g.lineWidth = 0.8;
      g.beginPath(); g.arc(e.sx, e.sy, e.mini ? 2.4 : 3.2, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    this.stats.drawn = drawn;
    g.globalAlpha = 1;
    // coin pops
    const t = performance.now();
    this.floaters = this.floaters.filter((f) => t - f.t0 < f.dur);
    for (const f of this.floaters) {
      const k = (t - f.t0) / f.dur;
      this.v.set(f.pos.x, f.pos.y + 14, f.pos.z).project(this.camera);
      if (this.v.z > 1) continue;
      const sx = (this.v.x * 0.5 + 0.5) * cw, sy = (-this.v.y * 0.5 + 0.5) * ch - 30 - k * 46;
      g.globalAlpha = Math.min(1, (1 - k) * 2.2);
      g.font = `bold 15px ${MONO}`; g.textBaseline = 'middle';
      const tw = g.measureText(f.text).width;
      g.fillStyle = 'rgba(255,250,235,0.92)'; g.beginPath(); g.roundRect(sx - tw / 2 - 12, sy - 11, tw + 24, 22, 11); g.fill();
      g.fillStyle = f.color; g.beginPath(); g.arc(sx - tw / 2 - 1, sy, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a3226'; g.fillText(f.text, sx - tw / 2 + 9, sy + 0.5);
    }
    g.globalAlpha = 1;
  }
}
