import type { Command, StateMsg } from '../sim/protocol';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateStr = (m: number) => `${MONTHS[m % 12]} ${2030 + Math.floor(m / 12)}`;
export const money = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${a.toFixed(0)}`;
};
export const num = (v: number) => (v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Math.round(v).toLocaleString('en-US'));

export interface HudHandlers {
  onTool?: (tool: string) => void;
  onToggle?: (name: string, on: boolean) => void;
}

export class Hud {
  root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  toggles: Record<string, boolean> = { heat: false, xray: false, night: false, desire: false, tilt: false };
  tool = 'view';
  handlers: HudHandlers = {};

  constructor(parent: HTMLElement, private send: (c: Command) => void, seed: number) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="topbar panel">
        <div class="brand">Tidewater Transit <span class="muted">seed ${seed}</span></div>
        <div class="stat"><span class="k">Date</span><span class="v" data-k="date">-</span></div>
        <div class="stat"><span class="k">Population</span><span class="v" data-k="pop">-</span></div>
        <div class="stat"><span class="k">Money</span><span class="v" data-k="money">-</span></div>
        <div class="stat"><span class="k">Income / mo</span><span class="v pos" data-k="inc">-</span></div>
        <div class="stat"><span class="k">Expenses / mo</span><span class="v neg" data-k="exp">-</span></div>
        <div class="stat"><span class="k">Transit share</span><span class="v" data-k="share">-</span></div>
        <div class="stat"><span class="k">Rating</span><span class="v" data-k="rating">-</span></div>
        <div class="spacer"></div>
        <div class="speed">
          <button data-speed="0" title="Pause (Space)">❚❚</button>
          <button data-speed="1" title="1x (1)">1x</button>
          <button data-speed="3" title="3x (2)">3x</button>
          <button data-speed="10" title="10x, test speed (3)">10x</button>
        </div>
      </div>
      <div class="side panel">
        <div class="h">City</div>
        <div class="bars">
          <div class="bar"><span>R</span><i data-k="dR"></i></div>
          <div class="bar"><span>C</span><i data-k="dC"></i></div>
          <div class="bar"><span>I</span><i data-k="dI"></i></div>
        </div>
        <div class="row"><span>Homes</span><b data-k="homes">-</b></div>
        <div class="row"><span>Jobs</span><b data-k="jobs">-</b></div>
        <div class="row"><span>Buildings</span><b data-k="bld">-</b></div>
        <div class="row"><span>Road congestion</span><b data-k="cong">-</b></div>
        <div class="row"><span>Avg drive speed</span><b data-k="spd">-</b></div>
        <div class="row"><span>Transit trips / day</span><b data-k="trips">-</b></div>
      </div>
      <div class="lines panel" data-k="linesPanel">
        <div class="h">Metro lines</div>
        <div data-k="lines"><div class="muted small">No lines yet. Open <b>Plan metro</b> (P), click the map to place stations, then click stations in order and press Enter.</div></div>
      </div>
      <div class="toolbar panel">
        <button data-tool="view" class="on" title="Orbit view (V)">View</button>
        <button data-tool="plan" title="Top-down metro planning (P)">Plan metro</button>
        <span class="sep"></span>
        <button data-toggle="heat" title="Land value heatmap (H)">Land value</button>
        <button data-toggle="xray" title="X-ray underground (X)">X-ray</button>
        <button data-toggle="night" title="Night (N)">Night</button>
        <button data-toggle="desire" title="Desire lines (D)">Desire lines</button>
        <button data-toggle="tilt" title="Tilt-shift (T)">Tilt-shift</button>
      </div>
      <div class="hint panel" data-k="hint"></div>
      <div class="ticker" data-k="ticker"></div>
      <div class="docks panel" data-k="docks"></div>
      <div class="modal-wrap" data-k="modal"></div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
      b.addEventListener('click', () => this.send({ type: 'speed', speed: Number(b.dataset.speed) })));
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.toggle!)));
    this.el.hint.style.display = 'none';
  }

  setTool(t: string) {
    this.tool = t;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.handlers.onTool?.(t);
  }

  toggle(name: string, force?: boolean) {
    const on = force ?? !this.toggles[name];
    this.toggles[name] = on;
    this.root.querySelector(`[data-toggle="${name}"]`)?.classList.toggle('on', on);
    this.handlers.onToggle?.(name, on);
  }

  hint(text: string | null) {
    this.el.hint.style.display = text ? 'block' : 'none';
    if (text) this.el.hint.innerHTML = text;
  }

  bar(el: HTMLElement, v: number) {
    const w = Math.min(50, Math.abs(v) * 50);
    el.style.width = `${w}%`;
    el.style.left = v >= 0 ? '50%' : `${50 - w}%`;
    el.className = v >= 0 ? 'up' : 'down';
  }

  update(s: StateMsg) {
    const st = s.stats, e = this.el;
    e.date.textContent = dateStr(st.month);
    e.pop.textContent = num(st.population);
    e.money.textContent = money(st.money);
    e.money.className = 'v ' + (st.money < 0 ? 'neg' : '');
    e.inc.textContent = money(st.income);
    e.exp.textContent = money(st.expenses);
    e.share.textContent = `${(st.transitShare * 100).toFixed(1)}%`;
    e.rating.textContent = s.lines.length ? `${Math.round(st.rating)}` : '-';
    e.homes.textContent = num(st.homes);
    e.jobs.textContent = num(st.jobs);
    e.bld.textContent = num(st.buildings);
    e.cong.textContent = `${Math.round(st.congestion * 100)}%`;
    e.spd.textContent = `${st.driveSpeed.toFixed(0)} km/h`;
    e.trips.textContent = num(st.transitTrips);
    this.bar(e.dR, st.resDemand);
    this.bar(e.dC, st.comDemand);
    this.bar(e.dI, st.indDemand);
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === s.speed));
    e.ticker.innerHTML = s.log.slice(-5).reverse().map((l) => {
      const [m, t] = l.split('|');
      return `<div><span class="muted">${dateStr(Number(m))}</span> ${t}</div>`;
    }).join('');
  }
}
