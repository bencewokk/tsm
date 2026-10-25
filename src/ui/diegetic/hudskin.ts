import type { Hud } from '../hud';
import type { StateMsg } from '../../sim/protocol';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const el = (cls: string, html: string) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };

/**
 * Re-skins the existing HUD as objects on the architect's table without touching hud.ts: a tear-off desk calendar and a brass odometer
 * replace the Date and Money readouts (the originals stay in the DOM, hidden, so `Hud.update` keeps working), and every other panel is
 * dressed by diegetic.css (everything is scoped under `body.dg`; `?hud=classic` never adds that class).
 * Returns `update(state)` for the two replaced readouts and `plan(on)` for the tracing-paper frame.
 */
export function skinHud(hud: Hud) {
  document.body.classList.add('dg');
  const top = hud.root.querySelector('.topbar')!;
  const first = top.querySelector('.stat')!;
  const cal = el('dg-cal', '<i class="m">JAN</i><b class="y">2030</b>');
  const till = el('dg-till', '<span class="k">Treasury</span><span class="dg-digits"></span>');
  top.insertBefore(cal, first);
  top.insertBefore(till, first);
  for (const k of ['date', 'money']) top.querySelector(`[data-k="${k}"]`)?.closest('.stat')?.classList.add('dg-hide');
  const digits = till.querySelector('.dg-digits') as HTMLElement;
  const m = cal.querySelector('.m') as HTMLElement, y = cal.querySelector('.y') as HTMLElement;
  let lastMoney = '';
  return {
    update(s: StateMsg) {
      const mo = s.stats.month;
      m.textContent = MONTHS[mo % 12];
      y.textContent = String(2030 + Math.floor(mo / 12));
      const v = Math.round(s.stats.money);
      const txt = `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
      if (txt !== lastMoney) {
        lastMoney = txt;
        digits.classList.toggle('neg', v < 0);
        digits.innerHTML = [...txt].map((c) => `<i class="${c === ',' ? 'sep' : c === '$' || c === '-' ? 'cur' : ''}">${c}</i>`).join('');
      }
    },
    plan(on: boolean) { document.body.classList.toggle('dg-plan', on); },
  };
}
