import { gameEvents } from './gameEvents';

/** Tiny WebAudio blips (no assets). UI only: never touches the sim. Starts after the first click (browsers need a gesture) and can be muted. */
export type Blip = 'dig' | 'undo' | 'open' | 'goal' | 'cranes' | 'tower' | 'warn' | 'coin' | 'tick';

const NOTES: Record<Blip, { f: number[]; d: number; type: OscillatorType; gap: number; vol: number }> = {
  dig: { f: [330, 440], d: 0.07, type: 'square', gap: 0.05, vol: 0.5 },
  undo: { f: [330, 247], d: 0.07, type: 'square', gap: 0.05, vol: 0.4 },
  open: { f: [392, 494, 587, 784], d: 0.16, type: 'triangle', gap: 0.11, vol: 1 },
  goal: { f: [523, 659, 784, 1047, 1319], d: 0.2, type: 'triangle', gap: 0.1, vol: 1 },
  cranes: { f: [587, 880], d: 0.09, type: 'sine', gap: 0.07, vol: 0.7 },
  tower: { f: [440, 554, 659], d: 0.14, type: 'sine', gap: 0.09, vol: 0.8 },
  warn: { f: [220, 196], d: 0.18, type: 'sawtooth', gap: 0.15, vol: 0.35 },
  coin: { f: [1175, 1568], d: 0.05, type: 'sine', gap: 0.04, vol: 0.25 },
  tick: { f: [880], d: 0.03, type: 'sine', gap: 0, vol: 0.2 },
};

export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private last = new Map<Blip, number>();

  constructor() {
    try { this.enabled = localStorage.getItem('tsm.sound') !== 'off'; } catch { /* storage may be blocked */ }
  }

  /** Create / resume the audio context; call from a click handler. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.07;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
  }

  set(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem('tsm.sound', on ? 'on' : 'off'); } catch { /* ignore */ }
    if (on) this.unlock();
  }

  play(kind: Blip) {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // do not stack the same blip within 80 ms
    const prev = this.last.get(kind) ?? -1;
    if (now - prev < 0.08) return;
    this.last.set(kind, now);
    const n = NOTES[kind];
    n.f.forEach((f, k) => {
      const t0 = now + k * n.gap;
      const o = this.ctx!.createOscillator(), g = this.ctx!.createGain();
      o.type = n.type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(n.vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d);
      o.connect(g); g.connect(this.master!);
      o.start(t0); o.stop(t0 + n.d + 0.02);
    });
  }
}

/** Sound is just another presenter of the gameplay events: a blip per beat. */
export function bindSound(sound: Sound) {
  gameEvents.on('lineOpened', () => sound.play('open'));
  gameEvents.on('objectiveReached', () => sound.play('goal'));
  gameEvents.on('moment', (e) => {
    const k = e.moment.kind;
    if (k === 'growth') sound.play('cranes');
    else if (k === 'tower') sound.play('tower');
    else if (k === 'crowd') sound.play('warn');
    else if (k === 'riders') sound.play('coin');
  });
  gameEvents.on('stationDug', () => sound.play('dig'));
  gameEvents.on('undo', () => sound.play('undo'));
}
