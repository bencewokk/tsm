import type { Command, StateMsg } from '../sim/protocol';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateStr = (m: number) => `${MONTHS[m % 12]} ${2030 + Math.floor(m / 12)}`;

export class Hud {
  root: HTMLElement;
  private date: HTMLElement;
  constructor(parent: HTMLElement, private send: (c: Command) => void, seed: number) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="topbar panel">
        <div class="brand">Tidewater Transit <span class="muted">seed ${seed}</span></div>
        <div class="stat"><span class="k">Date</span><span class="v" id="h-date">-</span></div>
      </div>`;
    parent.appendChild(this.root);
    this.date = this.root.querySelector('#h-date')!;
    void this.send;
  }
  update(s: StateMsg) {
    this.date.textContent = dateStr(s.stats.month);
  }
}
