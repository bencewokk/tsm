import type { GoalLike } from './events';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = '') => { const d = document.createElement(tag); d.className = cls; if (html) d.innerHTML = html; return d; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** how a goal's numbers read: 'k' thousands, 'pct' percent (the sim's values are fractions, 0.15 = 15%), 'mo' months, else plain */
export function fmtGoal(v: number, unit?: string) {
  if (unit === 'k') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`;
  if (unit === 'pct') return `${Math.round(v * 100)}%`;
  return `${Math.round(v)}`;
}

/**
 * The objects that live on the table rather than in the world, all plain DOM that is touched only when something changes (never per
 * frame): the newspaper that is laid down for a headline, the clipboard with the open goals, and the dial plate on the desk rail that
 * shows the clock (speed needle, held / planning / paused). The money ledger, desk calendar and cost slip are in `hudskin.ts` / `layer.ts`.
 */
export class Desk {
  private news = h('div', 'dg-news');
  private clip = h('div', 'dg-clip');
  private plate = h('div', 'dg-dial');
  private newsTimer = 0;
  private clipSig = '';
  private date = '';
  private mode: 'held' | 'planning' | 'paused' | 'running' = 'running';
  private speed = 1;
  private auto = false;
  /** a goal row with a place was clicked (cell units): main.ts flies the camera there */
  onGoal: ((x: number, y: number) => void) | null = null;
  private clipGoals: GoalLike[] = [];
  /** once a `clock` event has been seen it decides the label; before that the state's speed does */
  private fromEvents = false;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.news.style.display = 'none';
    this.clip.style.display = 'none';
    parent.append(this.news, this.clip);
    this.clip.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('.g[data-goal]');
      const g = row ? this.clipGoals[Number(row.dataset.goal)] : undefined;
      if (g && g.x !== undefined && g.y !== undefined) this.onGoal?.(g.x, g.y);
    });
    this.news.addEventListener('click', () => { clearTimeout(this.newsTimer); this.news.classList.add('out'); this.newsTimer = window.setTimeout(() => { this.news.style.display = 'none'; this.news.classList.remove('in'); }, 400); });
    const rail = document.querySelector('.toolbar .speed');
    if (rail) {
      this.plate.innerHTML = `<svg viewBox="0 0 56 32" width="56" height="32"><path class="arc" d="M6 28 A22 22 0 0 1 50 28" fill="none"/><g class="ticks"></g><g class="needle"><path d="M28 28 L28 9" /><circle cx="28" cy="28" r="3"/></g></svg><span class="lab"></span>`;
      const ticks = this.plate.querySelector('.ticks')!;
      for (const [i, t] of ['0', '1x', '3x', '10x'].entries()) {
        const a = (-70 + i * 46.7) * Math.PI / 180, x1 = 28 + Math.sin(a) * 19, y1 = 28 - Math.cos(a) * 19, x2 = 28 + Math.sin(a) * 23, y2 = 28 - Math.cos(a) * 23;
        ticks.insertAdjacentHTML('beforeend', `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/><title>${t}</title>`);
      }
      rail.append(this.plate);
      this.paintClock();
    }
  }

  /** the date line of the newspaper ("JAN 2040" from the state's month) */
  setMonth(month: number) { this.date = `${MONTHS[month % 12]} ${2030 + Math.floor(month / 12)}`; }

  // ------------------------------------------------------------------ newspaper
  /** Lay a front page on the table: masthead, headline, a few lines. `ribbon` hangs the red ribbon of an opening across the corner. */
  newspaper(title: string, text: string, color: string, ribbon: boolean, ms = 9000) {
    const n = this.news;
    clearTimeout(this.newsTimer);
    n.style.setProperty('--c', color);
    n.classList.toggle('rib', ribbon);
    n.innerHTML = `<div class="mast"><i>The Tidewater Times</i><u>${esc(this.date)}  ·  Special edition</u></div><b>${esc(title)}</b><p>${esc(text)}</p>`;
    n.style.setProperty('--tilt', `${(Math.random() * 2 - 1) * 1.4}deg`);
    n.style.display = '';
    n.classList.remove('out');
    void n.offsetWidth;
    n.classList.add('in');
    this.newsTimer = window.setTimeout(() => { n.classList.add('out'); this.newsTimer = window.setTimeout(() => { n.style.display = 'none'; n.classList.remove('in'); }, 700); }, ms);
  }

  // ------------------------------------------------------------------ clipboard
  goals(goals: GoalLike[], done: number, total: number) {
    const sig = goals.map((g) => `${g.id}:${Math.round(g.cur)}/${g.target}`).join('|') + `#${done}/${total}`;
    if (sig === this.clipSig) return;
    this.clipSig = sig;
    if (!goals.length) { this.clip.style.display = 'none'; return; }
    this.clip.style.display = '';
    this.clipGoals = goals;
    this.clip.innerHTML = `<div class="clipper"></div><div class="hd"><span>Goals</span><i>${done} of ${total} ticked</i></div>` + goals.map((g, k) => {
      const p = Math.max(0, Math.min(1, g.target ? g.cur / g.target : 0));
      const at = g.x !== undefined && g.y !== undefined ? ` data-goal="${k}" title="Show on the map"` : '';
      return `<div class="g"${at} style="--c:${esc(g.track === 'city' ? '#4f8f6a' : g.track === 'riders' ? '#b8741e' : '#2f6fa8')}"><b>${esc(g.title)}</b><div class="bar"><u style="width:${(p * 100).toFixed(0)}%"></u></div><span>${fmtGoal(g.cur, g.unit)} of ${fmtGoal(g.target, g.unit)}${g.reward ? `  ·  ${esc(g.reward)}` : ''}</span></div>`;
    }).join('');
  }

  // ------------------------------------------------------------------ dial plate
  setSpeed(speed: number) { this.speed = speed; if (!this.fromEvents) this.mode = speed === 0 ? 'paused' : 'running'; this.paintClock(); }
  clock(mode: 'held' | 'planning' | 'paused' | 'running', speed: number, auto: boolean) { this.fromEvents = true; this.mode = mode; this.speed = speed; this.auto = auto; this.paintClock(); }
  private paintClock() {
    const k = `${this.mode}|${this.speed}|${this.auto}`;
    if (k === this.shown || !this.plate.firstChild) return;
    this.shown = k;
    const idx = this.mode === 'running' ? (this.speed >= 10 ? 3 : this.speed >= 3 ? 2 : 1) : 0;
    const needle = this.plate.querySelector('.needle') as SVGGElement;
    needle.setAttribute('transform', `rotate(${(-70 + idx * 46.7).toFixed(1)} 28 28)`);
    const lab = { held: 'WAITING', planning: 'PLANNING', paused: 'PAUSED', running: this.auto ? 'AUTO' : 'RUNNING' }[this.mode];
    (this.plate.querySelector('.lab') as HTMLElement).textContent = lab;
    this.plate.dataset.mode = this.mode;
  }
}
