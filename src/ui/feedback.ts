/**
 * Placeholder DOM presenter for the gameplay feedback events (gameEvents.ts): goals list, toasts, the newspaper card (ribbon cutting /
 * goal reached), coin pops over stations, the plan-button pulse and the start card's first-goal line. Presentation only: it holds no game
 * logic and reads nothing but event payloads. A diegetic presentation layer replaces this file and subscribes to the same events.
 */
import { gameEvents } from './gameEvents';
import { dateStr, money } from './hud';
import type { GoalInfo, Moment } from '../sim/goals';

export interface FeedbackHooks {
  /** fly the camera to a place (cell units) */
  focus: (x: number, y: number) => void;
  /** cell position -> screen pixels (null if behind the camera) */
  project: (x: number, y: number, lift: number) => { x: number; y: number } | null;
}

const fmtV = (v: number, u: GoalInfo['unit']) => u === 'pct' ? `${Math.round(v * 100)}%` : u === 'k' ? (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))) : String(Math.round(v));

export class FeedbackDom {
  private el: Record<string, HTMLElement> = {};
  private headlineQueue: Moment[] = [];
  private headlineBusy = false;
  /** wall-clock time of the last big headline (the auto-speed rule waits after one) */
  lastBigAt = 0;
  private floaters: { el: HTMLElement; x: number; y: number; t0: number }[] = [];
  private goalSig = '';
  private goals: GoalInfo[] = [];

  constructor(private root: HTMLElement, private hooks: FeedbackHooks) {
    root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    gameEvents.on('objectives', (e) => this.renderGoals(e.goals, e.done, e.total, e.hasLines));
    gameEvents.on('moment', (e) => { if (e.moment.big) { this.headlineQueue.push(e.moment); this.lastBigAt = performance.now(); this.pumpHeadline(); } else this.toast(e.moment); });
    gameEvents.on('fare', (e) => this.coin(e.x, e.y, `+${money(e.amount)}`));
  }

  // ---------------------------------------------------------------- goals
  private renderGoals(goals: GoalInfo[], done: number, total: number, hasLines: boolean) {
    const sig = JSON.stringify([goals.map((g) => [g.id, Math.round(g.cur * 1000), g.target]), done, hasLines]);
    if (sig === this.goalSig) return;
    this.goalSig = sig;
    this.goals = goals;
    this.el.goalcount.textContent = `${done} / ${total}`;
    this.el.goals.innerHTML = goals.map((g, k) => {
      const pct = Math.max(0, Math.min(1, g.cur / g.target));
      const first = g.id === 'first_line';
      return `<button class="goal ${first ? 'first' : ''}" data-goal="${k}" title="${g.text.replace(/"/g, '&quot;')}">
        <span class="gt">${g.title}</span>
        <span class="gb"><i style="width:${Math.round(pct * 100)}%"></i></span>
        <span class="gm"><b>${fmtV(g.cur, g.unit)}</b> / ${fmtV(g.target, g.unit)}<em>${g.reward}</em></span>
        ${first && !hasLines ? `<span class="gx">${g.text}</span>` : ''}
      </button>`;
    }).join('') || '<div class="muted small">Every goal reached. The city is yours.</div>';
    this.el.goals.querySelectorAll<HTMLButtonElement>('button.goal').forEach((b) => b.addEventListener('click', () => {
      const g = this.goals[Number(b.dataset.goal)];
      if (g && g.x !== undefined && g.y !== undefined) this.hooks.focus(g.x, g.y);
    }));
    const ig = this.root.querySelector('[data-introgoal]');
    if (ig && goals[0]) ig.innerHTML = `<span class="gl">First goal</span> <b>${goals[0].title}</b> <span class="muted">reward ${goals[0].reward}</span>`;
    this.pulsePlan(!hasLines);
  }

  /** the plan button pulses until the first line exists (not while planning or on the start card) */
  pulsePlan(on: boolean) {
    const plan = this.root.querySelector('[data-tool="plan"]');
    const planning = plan?.classList.contains('on');
    const intro = (this.el.intro?.style.display ?? '') === 'flex';
    plan?.classList.toggle('pulse', on && !planning && !intro);
  }

  // ---------------------------------------------------------------- toasts and the newspaper card
  private toast(m: Moment) {
    const el = document.createElement('div');
    el.className = `toast ${m.kind}`;
    el.style.setProperty('--c', m.color);
    el.innerHTML = `<b>${m.title}</b><span>${m.text}</span>`;
    el.addEventListener('click', () => { this.hooks.focus(m.x, m.y); el.remove(); });
    this.el.toasts.prepend(el);
    while (this.el.toasts.children.length > 3) this.el.toasts.lastElementChild?.remove();
    window.setTimeout(() => { el.classList.add('out'); window.setTimeout(() => el.remove(), 500); }, 9000);
  }

  private pumpHeadline() {
    if (this.headlineBusy) return;
    const m = this.headlineQueue.shift();
    if (!m) return;
    this.headlineBusy = true;
    const wrap = this.el.headline;
    const open = m.kind === 'open';
    const confetti = !open ? Array.from({ length: 26 }, (_, k) => `<i style="--dx:${(Math.random() * 2 - 1) * 260}px;--dy:${-80 - Math.random() * 120}px;--r:${Math.random() * 720}deg;--d:${Math.random() * 0.25}s;background:${['#e0a526', '#d9534f', '#2f7fc1', '#3a9d5d', '#8e5bb5'][k % 5]}"></i>`).join('') : '';
    wrap.innerHTML = `<div class="paper ${open ? 'opening' : 'goalcard'}" style="--c:${m.color}">
      ${open ? '<div class="ribbon"><i class="l"></i><i class="r"></i><span>&#9986;</span></div>' : `<div class="confetti">${confetti}</div>`}
      <div class="mast"><span>The Tidewater Times</span><span>${dateStr(m.month)}</span></div>
      <h3>${m.title}</h3>
      <p>${m.text}</p>
      <div class="stripe"></div>
    </div>`;
    wrap.style.display = 'flex';
    const paper = wrap.firstElementChild as HTMLElement;
    const done = () => {
      paper.classList.add('out');
      window.setTimeout(() => { wrap.innerHTML = ''; wrap.style.display = 'none'; this.headlineBusy = false; this.pumpHeadline(); }, 450);
    };
    paper.addEventListener('click', done, { once: true });
    window.setTimeout(done, this.headlineQueue.length ? 3800 : 7500);
  }

  // ---------------------------------------------------------------- coin pops
  private coin(x: number, y: number, text: string) {
    if (this.floaters.length > 30) return;
    const el = document.createElement('div');
    el.className = 'fl';
    el.textContent = text;
    this.el.floaters.appendChild(el);
    this.floaters.push({ el, x: x + (Math.random() - 0.5) * 0.8, y: y + (Math.random() - 0.5) * 0.8, t0: performance.now() });
  }

  /** call every frame: moves the coin pops */
  tick(now: number) {
    for (let k = this.floaters.length - 1; k >= 0; k--) {
      const f = this.floaters[k], age = (now - f.t0) / 1900;
      const p = age < 1 ? this.hooks.project(f.x, f.y, 14) : null;
      if (!p || age >= 1) { f.el.remove(); this.floaters.splice(k, 1); continue; }
      f.el.style.transform = `translate(${p.x.toFixed(0)}px, ${(p.y - 10 - 46 * age).toFixed(0)}px)`;
      f.el.style.opacity = String(Math.min(1, (1 - age) * 2.2));
    }
  }
}
