/**
 * The station card (round 7, step 2): click a station's tag on the map to see what its walk catchment holds, the zoning around it, and the
 * plans the city can put to the council (a station area plan, a CBD edge, protecting the old town), each with its cost, what it would let the
 * area hold, a ridership estimate and how the council is likely to take it. Plans already submitted show their state and what they paid.
 */
import type { StateMsg, Command } from '../sim/protocol';

const M = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${Math.round(v / 1e3)}k`);
const K = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const STATE: Record<string, string> = { review: 'with the council', conditions: 'approved with conditions, answer at City hall', approved: 'approved', refused: 'refused', withdrawn: 'withdrawn' };

export class StationCard {
  readonly el = document.createElement('div');
  station: number | null = null;
  private sig = '';

  constructor(parent: HTMLElement, private send: (c: Command) => void) {
    this.el.className = 'dg-card';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.close !== undefined) { this.close(); return; }
      const kind = b.dataset.kind as 'station' | 'cbd' | 'protect' | undefined;
      if (kind && this.station !== null) { this.send({ type: 'proposePlan', station: this.station, kind }); b.disabled = true; b.textContent = 'Submitted'; }
    });
  }

  open(id: number) {
    this.station = id; this.sig = '';
    this.send({ type: 'planPreview', station: id });
    this.el.style.display = '';
    this.el.innerHTML = '<div class="muted small">Asking the planners...</div>';
  }
  close() {
    this.station = null;
    this.el.style.display = 'none';
    this.send({ type: 'planPreview', station: null });
  }
  get isOpen() { return this.station !== null; }

  update(s: StateMsg) {
    if (this.station === null) return;
    const st = s.stations.find((q) => q.id === this.station);
    if (!st) { this.close(); return; }
    const pv = s.planPreview && s.planPreview.station === st.id ? s.planPreview : null;
    const sig = JSON.stringify([st.riders, st.walkHomes, pv, s.stats.money > 5e6, Math.floor(s.stats.month / 3)]);
    if (sig === this.sig) return;
    this.sig = sig;
    const lines = s.lines.filter((l) => l.stations.includes(st.id)).map((l) => `<b class="dot" style="background:${l.color}"></b>Line ${l.id}`).join(' ');
    const hasHistoric = s.env.some((e) => e === 1);
    const opts = (pv?.kinds ?? []).map((k) => {
      const busy = pv?.plans.some((p) => p.kind === k.kind && (p.state === 'review' || p.state === 'conditions' || p.state === 'approved'));
      return `<div class="opt"><div class="t"><b>${k.title}</b><i class="odds ${k.odds === 'likely' ? 'ok' : k.odds === 'unlikely' ? 'no' : 'mid'}">${k.odds}</i></div>
        <div class="small">${k.blurb}</div>
        <div class="small num">Homes + jobs in the walk: ${K(k.now)} now, up to ${K(k.could)} &nbsp;·&nbsp; riders about ${K(k.riders)}/day (now ${K(st.riders)})</div>
        <button data-kind="${k.kind}" ${busy || s.stats.money < k.cost ? 'disabled' : ''}>${busy ? 'Already submitted' : `Submit to the council (${M(k.cost)})`}</button></div>`;
    }).join('');
    const prot = hasHistoric ? `<div class="opt"><div class="t"><b>Protect the old town</b></div><div class="small">Three floors and no demolition in the historic core: more visitors and higher value, no growth there.</div><button data-kind="protect" ${s.stats.money < 2e6 ? 'disabled' : ''}>Submit to the council ($2.0M)</button></div>` : '';
    const plans = (pv?.plans ?? []).map((p) => `<div class="small plan ${p.state}">${p.kind === 'protect' ? 'Old town protection' : p.kind === 'cbd' ? 'CBD edge plan' : 'Station area plan'}: <b>${STATE[p.state] ?? p.state}</b>${p.cap ? `, up to ${Math.round(p.cap / 3.3)} floors` : ''}${p.park ? ', with a park' : ''}${p.why && p.state !== 'review' ? ` (${p.why})` : ''}${p.paid > 0 ? ` · value captured ${M(p.paid)}` : ''}</div>`).join('');
    this.el.innerHTML = `<button class="x" data-close>×</button>
      <div class="hd">${st.name} <span class="small">${lines}</span></div>
      <div class="small num">${K(st.riders)} riders a day · ${K((st.walkHomes ?? 0) * 2.3)} residents within an 8-minute walk</div>
      <div class="small">Zoning here: <b>${pv?.envAround ?? '...'}</b></div>
      ${plans}
      ${pv ? opts + prot : '<div class="muted small">Asking the planners...</div>'}`;
  }
}
