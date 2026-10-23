import { Sim } from '../src/sim/sim';
import { testLine } from './lib';
const sim = new Sim(4821);
const seen = new Set<number>();
for (let m = 0; m < 96; m++) {
  if (m === 24) testLine(sim);
  sim.tick();
  if (sim.pending) { const ev = sim.eventInfo()!; sim.apply({ type: 'choose', event: ev.id, choice: 0 }); }
  for (const a of sim.asm.list) if (!seen.has(a.id)) {
    seen.add(a.id);
    const cx = (a.quad[0] + a.quad[4]) / 2, cy = (a.quad[1] + a.quad[5]) / 2;
    console.log(`m${m} ${a.kind} ${a.label} at ${cx.toFixed(0)},${cy.toFixed(0)} plots ${a.lots.length} hgt ${a.hgt} hmax ${sim.field.hmaxAt(cx, cy).toFixed(0)} F ${sim.field.fAt(cx, cy).toFixed(2)} dist ${Math.hypot(cx - sim.field.main.x, cy - sim.field.main.y).toFixed(1)}`);
  }
}
