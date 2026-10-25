import type { Command, StateMsg } from '../sim/protocol';
import type { CityProfile } from '../sim/cityprofile';

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
  onQuality?: () => void;
  onSound?: () => boolean;
  onAuto?: (on: boolean) => void;
}

export class Hud {
  root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  toggles: Record<string, boolean> = { heat: false, zones: false, xray: false, night: false, desire: false };
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
        <div class="stat" title="Share of all trips made by metro; the rest go by car. Goals reward beating the car."><span class="k">Metro vs car</span><span class="v" data-k="share">-</span><span class="mbar"><i data-k="sharebar"></i></span></div>
        <div class="stat"><span class="k">Rating</span><span class="v" data-k="rating">-</span></div>
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
        <div class="h lmh">Projects <span class="muted small" data-k="projbudget"></span></div>
        <div class="lmlist" data-k="projlist"></div>
        <div class="news" data-k="news"></div>
        <div class="h lmh">Landmarks</div>
        <div class="lmlist" data-k="lmlist"></div>
      </div>
      <div class="lines panel" data-k="linesPanel">
        <div class="h">Metro lines</div>
        <div data-k="lines"><div class="muted small">No lines yet. Open <b>Plan metro</b> (P), click the map to place stations, then click stations in order and press Enter.</div></div>
      </div>
      <div class="toolbar panel">
        <div class="speed">
          <button data-speed="0" title="Pause (Space)">❚❚</button>
          <button data-speed="1" title="1x (1)">1x</button>
          <button data-speed="3" title="3x (2)">3x</button>
          <button data-speed="10" title="10x test speed (3)">10x</button>
        </div>
        <span class="sep"></span>
        <button data-tool="view" class="on" title="Orbit view (V)">View</button>
        <button data-tool="plan" title="Top-down metro planning (P)">Plan metro</button>
        <span class="sep"></span>
        <button data-toggle="heat" title="Land value heatmap (H)">Land value</button>
        <button data-toggle="zones" title="Land-use territories (Z)">Zones</button>
        <button data-toggle="xray" title="X-ray underground (X)">X-ray</button>
        <button data-toggle="night" title="Night (N)">Night</button>
        <button data-toggle="desire" title="Desire lines (L)">Desire lines</button>
        <span class="sep"></span>
        <button data-auto title="Auto speed (4): runs at 3x while nothing needs you, back to 1x for decisions and headlines">Auto</button>
        <button data-sound title="Sound blips on / off">Sound: on</button>
        <button data-quality title="Render quality: Auto lowers the 3D resolution while the frame is over budget; High = full, Performance = 67%">Quality: Auto</button>
      </div>
      <div class="hint panel" data-k="hint"></div>
      <div class="ticker" data-k="ticker"></div>
      <div class="docks panel" data-k="docks"></div>
      <div class="modal-wrap" data-k="modal"></div>
      <div class="modal-wrap" data-k="intro"></div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
      b.addEventListener('click', () => this.send({ type: 'speed', speed: Number(b.dataset.speed) })));
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool!)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.toggle!)));
    this.root.querySelector<HTMLButtonElement>('[data-quality]')?.addEventListener('click', () => this.handlers.onQuality?.());
    const soundBtn = this.root.querySelector<HTMLButtonElement>('[data-sound]')!;
    soundBtn.addEventListener('click', () => this.setSound(this.handlers.onSound?.() ?? false));
    this.root.querySelector<HTMLButtonElement>('[data-auto]')?.addEventListener('click', (e) => { const b = e.currentTarget as HTMLButtonElement; b.classList.toggle('on'); this.handlers.onAuto?.(b.classList.contains('on')); });
    this.el.hint.style.display = 'none';
    this.el.lines.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-line]');
      if (!b || !this.last) return;
      const id = Number(b.dataset.line), l = this.last.lines.find((q) => q.id === id);
      if (!l) return;
      if (b.dataset.act === 'add') this.send({ type: 'setTrains', line: id, trains: l.trains + 1 });
      if (b.dataset.act === 'sub') this.send({ type: 'setTrains', line: id, trains: l.trains - 1 });
      if (b.dataset.act === 'del' && confirm(`Close line ${id}? Tunnels are written off.`)) this.send({ type: 'deleteLine', line: id });
    });
  }

  /** Start card: the city's story from its profile; the clock starts when the player begins. */
  /** the start card is up: keys do nothing yet */
  introOpen = false;
  showIntro(cp: CityProfile, seed: number, onBegin: () => void) {
    this.introOpen = true;
    const wrap = this.el.intro;
    const chip = (k: string, v: string) => `<span class="chip"><i>${k}</i> ${v}</span>`;
    const lvl = (v: number) => (v > 0.7 ? 'high' : v < 0.3 ? 'low' : 'medium');
    wrap.style.display = 'flex';
    wrap.innerHTML = `<div class="modal panel">
      <div class="h">Tidewater Transit · seed ${seed}</div>
      <h2>${cp.story.split('. ')[0]}.</h2>
      <p>${cp.story.split('. ').slice(1).join('. ')}</p>
      <div class="chips">${chip('terrain', cp.terrain)}${chip('origin', cp.origin.replace('-', ' '))}${chip('old industry', cp.site === 'harbour' ? 'docks' : cp.site === 'railyard' ? 'rail yards' : 'mine')}${chip('style', cp.tradition)}${chip('planning', lvl(cp.planningStrength))}${chip('wealth', lvl(cp.wealth))}</div>
      <div class="firstgoal" data-introgoal></div>
      <div class="choices"><button class="choice" data-begin><b>Begin</b><span>Build the metro, grow the city. Time stands still while you plan a line (P).</span></button></div>
    </div>`;
    wrap.querySelector<HTMLButtonElement>('[data-begin]')!.addEventListener('click', () => { wrap.innerHTML = ''; wrap.style.display = 'none'; this.introOpen = false; onBegin(); });
  }

  private last: StateMsg | null = null;
  private eventSig = '';
  private docksSig = '';
  onFocusDocks?: () => void;
  onFocusLandmark?: (x: number, y: number) => void;
  private lmSig = '';

  private renderLandmarks(s: StateMsg) {
    const sig = JSON.stringify([s.landmarks.map((l) => [l.id, l.state, Math.round(l.pct * 10), l.served, l.carPark, l.eventDay]), s.assemblies.map((a) => [a.id, a.phase, Math.round(a.pct * 10), a.acquired])]);
    if (sig === this.lmSig) return;
    this.lmSig = sig;
    const el = this.el.lmlist;
    const PH = ['buying plots', 'hoardings up', 'demolition', 'site cleared', 'foundations', 'structure', 'facade'];
    const dev = s.assemblies.filter((a) => a.kind !== 'project').map((a) => `<button class="lm" data-lx="${a.x}" data-ly="${a.y}"><span>${a.label}</span><i class="b">${PH[a.phase] ?? ''}${a.phase === 0 ? ` ${a.acquired}/${a.total}` : ''}</i></button>`).join('');
    if (!s.landmarks.length && !s.assemblies.length) { el.innerHTML = '<div class="muted small">None yet.</div>'; return; }
    el.innerHTML = dev + s.landmarks.slice().sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'building' ? -1 : 1)).map((l) => {
      const badge = l.state === 'building' ? `<i class="b">building ${Math.round(l.pct * 100)}%</i>` : l.eventDay ? '<i class="ev">event day</i>' : l.carPark ? '<i class="cp">car park</i>' : l.served ? '<i class="sv">served</i>' : '<i class="ns">no station</i>';
      return `<button class="lm" data-lx="${l.x}" data-ly="${l.y}"><span>${l.name}</span>${badge}</button>`;
    }).join('');
    el.querySelectorAll<HTMLButtonElement>('button.lm').forEach((b) => b.addEventListener('click', () => this.onFocusLandmark?.(Number(b.dataset.lx), Number(b.dataset.ly))));
  }

  private projSig = '';
  /** Active development projects (projects.ts): type colour, place, phase, the service promise; then the latest notifications. */
  private renderProjects(s: StateMsg) {
    const sig = JSON.stringify([s.projects.map((p) => [p.id, p.status, p.phase, Math.round(p.pct * 10), p.promise, p.carLock]), s.notices.map((n) => n.text), s.stats.month]);
    if (sig === this.projSig) return;
    this.projSig = sig;
    const live = s.projects.filter((p) => p.status === 'proposed' || p.status === 'assembling' || p.status === 'building');
    this.el.projbudget.textContent = live.length ? `${live.length} running` : '';
    const badge = (p: StateMsg['projects'][number]) => {
      if (p.status === 'proposed') return '<i class="ev">decision</i>';
      if (p.status === 'assembling' || p.status === 'building') {
        const left = p.deadline - s.stats.month;
        const prom = p.promise === 'open' ? ` <i class="${left <= 4 ? 'ns' : 'b'}">station in ${left} mo</i>` : p.promise === 'kept' ? ' <i class="sv">served</i>' : p.carLock ? ' <i class="cp">car-first</i>' : '';
        return `<i class="b">${p.phase}${p.pct ? ` ${Math.round(p.pct * 100)}%` : ''}</i>${prom}`;
      }
      return `<i class="${p.status === 'done' ? (p.carLock ? 'cp' : 'sv') : 'ns'}">${p.outcome}</i>`;
    };
    const rows = s.projects.map((p) => `<button class="lm proj" data-lx="${p.x}" data-ly="${p.y}" title="${p.title}"><span class="t"><span><b class="dot" style="background:${p.color}"></b>${p.name}</span><span class="bd">${badge(p)}</span></span><span class="pl muted">${p.place}</span></button>`).join('');
    this.el.projlist.innerHTML = rows || '<div class="muted small">None yet. Developers come where land is valuable, plots stand empty or a new station opens.</div>';
    this.el.news.innerHTML = s.notices.slice(-3).reverse().map((n) => `<div class="small"><b class="dot" style="background:${n.color}"></b>${dateStr(n.month)} · ${n.text}</div>`).join('');
    this.el.projlist.querySelectorAll<HTMLButtonElement>('button.lm').forEach((b) => b.addEventListener('click', () => this.onFocusLandmark?.(Number(b.dataset.lx), Number(b.dataset.ly))));
  }

  private renderEvent(s: StateMsg) {
    const ev = s.event;
    const sig = ev ? ev.id + ev.title : '';
    if (sig === this.eventSig) return;
    this.eventSig = sig;
    const wrap = this.el.modal;
    if (!ev) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    wrap.innerHTML = `<div class="modal panel">
      <div class="h">${dateStr(s.stats.month)} · City hall</div>
      <h2>${ev.title}</h2>
      <p>${ev.text}</p>
      <div class="choices">${ev.choices.map((c, k) => `<button class="choice" data-choice="${k}"><b>${c.label}</b><span>${c.detail}</span></button>`).join('')}</div>
    </div>`;
    wrap.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((b) => b.addEventListener('click', () => {
      this.send({ type: 'choose', event: ev.id, choice: Number(b.dataset.choice) });
      wrap.innerHTML = ''; wrap.style.display = 'none';
    }));
  }

  private renderDocks(s: StateMsg) {
    const d = s.docks;
    const left = d.deadline ? d.deadline - s.stats.month : 0;
    const sig = JSON.stringify([d.state, d.served, d.planned, d.carLocked, d.built, left]);
    if (sig === this.docksSig) return;
    this.docksSig = sig;
    const el = this.el.docks;
    if (d.state !== 'active') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const pct = (v: number) => `${Math.round((v / Math.max(1, d.planned)) * 100)}%`;
    const dl = !d.deadline ? '<span class="muted">no deadline</span>'
      : left > 0 ? `<b class="${left <= 4 ? 'neg' : ''}">${left} months</b> left (deadline ${dateStr(d.deadline)})` : '<b class="neg">deadline passed</b>';
    el.innerHTML = `<div class="h">${d.title} · ${d.dealName}</div>
      <div class="small">${d.brief}</div>
      <div class="dbar"><i class="b" style="width:${pct(d.built)}"></i><i class="s" style="width:${pct(Math.max(0, d.served - d.built))}"></i><i class="l" style="width:${pct(d.carLocked)}"></i></div>
      <div class="small"><span class="lk b"></span>built ${d.built} · <span class="lk s"></span>served ${d.served} · <span class="lk l"></span>car-locked ${d.carLocked} / ${d.planned}</div>
      <div class="small">${dl} <button class="mini" data-focus>Show me</button></div>`;
    el.querySelector('[data-focus]')?.addEventListener('click', () => this.onFocusDocks?.());
  }
  private linesSig = '';

  private renderLines(s: StateMsg) {
    const sig = JSON.stringify(s.lines.map((l) => [l.id, l.trains, Math.round(l.riders / 50), Math.round(l.rating), Math.round(l.peakLoad / 50)]));
    if (sig === this.linesSig) return;
    this.linesSig = sig;
    if (!s.lines.length) {
      this.el.lines.innerHTML = `<div class="muted small">No lines yet. Open <b>Plan metro</b> (P), click the map to dig stations, click stations in order, then press <b>Enter</b>.</div>`;
      return;
    }
    this.el.lines.innerHTML = s.lines.map((l) => {
      const load = l.capacity > 0 ? l.peakLoad / l.capacity : 0;
      const cls = load > 1 ? 'neg' : load > 0.8 ? 'warn' : '';
      return `<div class="line">
        <div class="lh"><i class="sw" style="background:${l.color}"></i><b>Line ${l.id}</b><span class="muted">${l.stations.length} st · ${l.lengthKm.toFixed(1)} km</span>
          <span class="spacer"></span><button class="mini" data-line="${l.id}" data-act="del" title="Close line">✕</button></div>
        <div class="lg">
          <span>Riders/day</span><b>${num(l.riders)}</b>
          <span>Peak load</span><b class="${cls}">${Math.round(load * 100)}%</b>
          <span>Rating</span><b>${Math.round(l.rating)}</b>
          <span>Trains</span><b><button class="mini" data-line="${l.id}" data-act="sub">−</button> ${l.trains} <button class="mini" data-line="${l.id}" data-act="add">+</button></b>
          <span>Headway</span><b>${l.headway.toFixed(1)} min</b>
          <span>Capacity</span><b>${num(l.capacity)}/h</b>
        </div></div>`;
    }).join('');
  }

  /** Quality button text, e.g. "Quality: Auto (80%)". */
  setQuality(label: string) { const b = this.root.querySelector<HTMLButtonElement>('[data-quality]'); if (b && b.textContent !== label) b.textContent = label; }

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


  setSound(on: boolean) {
    const b = this.root.querySelector<HTMLButtonElement>('[data-sound]');
    if (b) { b.textContent = `Sound: ${on ? 'on' : 'off'}`; b.classList.toggle('on', on); }
  }

  update(s: StateMsg) {
    this.last = s;
    this.renderLines(s);
    this.renderEvent(s);
    this.renderDocks(s);
    this.renderLandmarks(s);
    this.renderProjects(s);
    const st = s.stats, e = this.el;
    e.date.textContent = dateStr(st.month);
    e.pop.textContent = num(st.population);
    e.money.textContent = money(st.money);
    e.money.className = 'v ' + (st.money < 0 ? 'neg' : '');
    e.inc.textContent = money(st.income);
    e.exp.textContent = money(st.expenses);
    e.share.textContent = `${(st.transitShare * 100).toFixed(1)}%`;
    e.sharebar.style.width = `${Math.min(100, st.transitShare * 100).toFixed(1)}%`;
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
