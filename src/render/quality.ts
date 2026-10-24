/**
 * Render quality: the 3D scene renders at `scale` x the canvas resolution (the output pass upscales it; the HUD is HTML and the map
 * labels are drawn afterwards at full resolution, so text stays sharp). High = 1.0, Performance = 0.67, Auto (default) starts at 1.0 and
 * steps down towards 0.67 only while the GPU time stays over budget, and back up when there is room again (hysteresis, cool-down).
 * `?quality=auto|high|performance` picks the mode; the HUD button cycles it.
 */
export type QualityMode = 'auto' | 'high' | 'performance';
export const STEPS = [1, 0.9, 0.8, 0.72, 0.67];

export const QUALITY = {
  /** GPU ms per frame: step down above this (leaves room for the CPU inside 16.7 ms) */
  over: 15.5,
  /** step up only if the next step is predicted to stay under this */
  under: 13,
  /** frames per decision window; windows a step-up needs in a row */
  window: 30,
  upWindows: 3,
  /** ms after a change before the next decision */
  coolMs: 1200,
};

export class Quality {
  mode: QualityMode = 'auto';
  step = 0;
  get scale() { return this.mode === 'high' ? 1 : this.mode === 'performance' ? STEPS[STEPS.length - 1] : STEPS[this.step]; }
  /** changes so far (Auto) */
  changes = 0;
  private samples: number[] = [];
  private calm = 0;
  private lastChange = -1e9;

  constructor(private apply: (scale: number) => void) {}

  setMode(m: QualityMode) {
    this.mode = m;
    if (m === 'auto') this.step = 0;
    this.samples = []; this.calm = 0;
    this.apply(this.scale);
  }

  /**
   * Feed one frame: its GPU time if the timer query is available (preferred), else the frame interval (vsync-quantised: then the
   * controller only steps down on missed frames and probes upwards slowly).
   */
  frame(now: number, gpuMs: number | null, intervalMs: number) {
    if (this.mode !== 'auto') return;
    if (now - this.lastChange < QUALITY.coolMs) { this.samples = []; return; }
    const v = gpuMs ?? intervalMs;
    if (!(v > 0)) return;
    this.samples.push(v);
    if (this.samples.length < QUALITY.window) return;
    const s = this.samples.slice().sort((a, b) => a - b), med = s[s.length >> 1];
    this.samples = [];
    const over = gpuMs !== null ? QUALITY.over : 18.5;
    if (med > over && this.step < STEPS.length - 1) { this.set(this.step + 1, now); return; }
    if (this.step > 0) {
      // predicted cost one step up: the per-pixel share grows with the pixel count (assume all of it does, to be safe)
      const k = (STEPS[this.step - 1] / STEPS[this.step]) ** 2;
      const ok = gpuMs !== null ? med * k < QUALITY.under : med < 17.2;
      this.calm = ok ? this.calm + 1 : 0;
      if (this.calm >= (gpuMs !== null ? QUALITY.upWindows : 8)) this.set(this.step - 1, now);
    }
  }

  private set(step: number, now: number) {
    this.step = step; this.calm = 0; this.lastChange = now; this.changes++;
    this.apply(this.scale);
  }
}

export function qualityFromUrl(p: URLSearchParams): QualityMode {
  const q = (p.get('quality') ?? 'auto').toLowerCase();
  return q === 'high' ? 'high' : q === 'performance' || q === 'perf' ? 'performance' : 'auto';
}
