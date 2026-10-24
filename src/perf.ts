import type * as THREE from 'three';

/**
 * Dev performance monitor: frame interval / CPU / GPU time percentiles, draw calls, triangles, geometry and texture counts, JS heap,
 * worker message size and rate and the main-thread time spent applying each state message (split by step).
 * Always collects into small ring buffers (a few performance.now() calls per frame); the overlay shows with `?perf=1` or `tsm.perf.show()`.
 * `tsm.perf.report()` returns the numbers; `tsm.perf.bench(frames)` renders frames back to back with a GPU sync after each one
 * (for a hidden pane, where requestAnimationFrame does not run).
 */
class Ring {
  private a: Float64Array; private n = 0; private i = 0;
  constructor(size: number) { this.a = new Float64Array(size); }
  push(v: number) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; this.n = Math.min(this.n + 1, this.a.length); }
  clear() { this.n = 0; this.i = 0; }
  get count() { return this.n; }
  values(): number[] { return Array.from(this.a.subarray(0, this.n)); }
  pct(p: number) { const v = this.values().sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0; }
  mean() { const v = this.values(); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
  max() { return this.n ? Math.max(...this.values()) : 0; }
}

type Info = { calls: number; triangles: number; lines: number; points: number; geometries: number; textures: number; programs: number };

/** Bytes a structured clone of the message carries (typed arrays plus a JSON estimate of the rest). */
export function msgBytes(m: unknown): number {
  let b = 0;
  const walk = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (ArrayBuffer.isView(v)) { b += v.byteLength; return; }
    if (typeof v === 'string') { b += v.length; return; }
    if (typeof v !== 'object') { b += 8; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { b += k.length; walk(x); }
  };
  walk(m);
  return b;
}

export class PerfMon {
  interval = new Ring(600);
  cpu = new Ring(600);
  gpu = new Ring(600);
  apply = new Ring(240);
  steps = new Map<string, Ring>();
  msgSize = new Ring(240);
  msgAt = new Ring(240);
  worker = { tick: new Ring(240), snap: new Ring(240) };
  info: Info = { calls: 0, triangles: 0, lines: 0, points: 0, geometries: 0, textures: 0, programs: 0 };
  private last = 0;
  private t0 = 0;
  private renderer: THREE.WebGLRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private tq: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; pending: WebGLQuery[]; active: WebGLQuery | null } | null = null;
  private el: HTMLDivElement | null = null;
  private lastDraw = 0;
  /** measure message sizes (walks every message; on while the overlay is shown or a report is wanted) */
  sizes = false;

  attach(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    renderer.info.autoReset = false;   // the composer renders several passes per frame: count them all
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (ext) this.tq = { ext, pending: [], active: null };
  }

  frameBegin(now: number) {
    if (this.last) this.interval.push(now - this.last);
    this.last = now;
    this.t0 = performance.now();
    this.renderer?.info.reset();
    const gl = this.gl, tq = this.tq;
    if (gl && tq && !tq.active && tq.pending.length < 4) { const q = gl.createQuery(); if (q) { gl.beginQuery(tq.ext.TIME_ELAPSED_EXT, q); tq.active = q; } }
  }

  frameEnd() {
    this.cpu.push(performance.now() - this.t0);
    const gl = this.gl, tq = this.tq;
    if (gl && tq) {
      if (tq.active) { gl.endQuery(tq.ext.TIME_ELAPSED_EXT); tq.pending.push(tq.active); tq.active = null; }
      while (tq.pending.length && gl.getQueryParameter(tq.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = tq.pending.shift()!;
        if (!gl.getParameter(tq.ext.GPU_DISJOINT_EXT)) this.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    }
    if (this.renderer) {
      const i = this.renderer.info;
      this.info = { calls: i.render.calls, triangles: i.render.triangles, lines: i.render.lines, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 };
    }
    if (this.el && performance.now() - this.lastDraw > 500) this.draw();
  }

  /** Time one step of applying a state message. */
  step<T>(name: string, fn: () => T): T {
    const t = performance.now();
    try { return fn(); } finally {
      let r = this.steps.get(name);
      if (!r) this.steps.set(name, (r = new Ring(240)));
      r.push(performance.now() - t);
    }
  }

  message(m: { perf?: { tick: number; snap: number } }, applyMs: number) {
    this.msgAt.push(performance.now());
    this.apply.push(applyMs);
    if (m.perf) { this.worker.tick.push(m.perf.tick); this.worker.snap.push(m.perf.snap); }
  }

  /** call before applying: measures the message size when enabled */
  size(m: unknown) { if (this.sizes) this.msgSize.push(msgBytes(m)); }

  reset() {
    for (const r of [this.interval, this.cpu, this.gpu, this.apply, this.msgSize, this.msgAt, this.worker.tick, this.worker.snap, ...this.steps.values()]) r.clear();
    this.last = 0;
  }

  report() {
    const f = (r: Ring) => ({ p50: +r.pct(0.5).toFixed(2), p95: +r.pct(0.95).toFixed(2), max: +r.max().toFixed(2), n: r.count });
    const at = this.msgAt.values().sort((a, b) => a - b);
    const rate = at.length > 1 ? (at.length - 1) / ((at[at.length - 1] - at[0]) / 1000) : 0;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      frameInterval: f(this.interval), frameCpu: f(this.cpu), gpu: this.tq ? f(this.gpu) : 'no timer query',
      ...this.info,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
      msgKB: this.msgSize.count ? +(this.msgSize.mean() / 1024).toFixed(1) : null, msgPerSec: +rate.toFixed(2),
      apply: f(this.apply), steps: Object.fromEntries([...this.steps].map(([k, r]) => [k, { mean: +r.mean().toFixed(2), max: +r.max().toFixed(2) }])),
      worker: { tick: f(this.worker.tick), snap: f(this.worker.snap) },
    };
  }

  show(on = true) {
    this.sizes = on;
    if (!on) { this.el?.remove(); this.el = null; return; }
    if (this.el) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;font:11px/1.35 ui-monospace,Consolas,monospace;background:rgba(20,22,26,.82);color:#e8e6e0;padding:6px 8px;border-radius:4px;white-space:pre;pointer-events:none';
    document.body.appendChild(el);
    this.el = el;
  }

  private draw() {
    this.lastDraw = performance.now();
    const r = this.report();
    const g = typeof r.gpu === 'string' ? r.gpu : `${r.gpu.p50} / ${r.gpu.p95}`;
    this.el!.textContent = `frame ${r.frameInterval.p50} / ${r.frameInterval.p95} ms (p50/p95)\ncpu ${r.frameCpu.p50} / ${r.frameCpu.p95}  gpu ${g}\n` +
      `calls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  geo ${r.geometries}  tex ${r.textures}\nheap ${r.heapMB} MB  msg ${r.msgKB} KB x ${r.msgPerSec}/s\n` +
      `apply ${r.apply.p50} / ${r.apply.p95} / max ${r.apply.max} ms\nworker tick ${r.worker.tick.p50}  snap ${r.worker.snap.p50} ms`;
  }

  /**
   * Render `frames` frames, each followed by a GPU sync (1-pixel readPixels), yielding to the event loop between frames so GPU timer
   * queries resolve (they never do inside one task). Returns per-frame wall ms (CPU + GPU, no pipelining) and GPU ms percentiles.
   */
  async bench(frames: number, renderFrame: (now: number) => void) {
    const gl = this.gl!, px = new Uint8Array(4), times: number[] = [];
    const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(0); c.port2.postMessage(0); });
    this.gpu.clear();
    let now = performance.now();
    for (let k = 0; k < frames; k++) {
      const t = performance.now();
      now += 16.7;
      renderFrame(now);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t);
      await yieldNow();
    }
    renderFrame(now + 16.7);   // collect the last queries
    times.sort((a, b) => a - b);
    const p = (v: number[], q: number) => (v.length ? +v[Math.min(v.length - 1, Math.floor(q * v.length))].toFixed(2) : null);
    const g = this.gpu.values().sort((a, b) => a - b);
    return { p50: p(times, 0.5), p95: p(times, 0.95), max: p(times, 1), gpu50: p(g, 0.5), gpu95: p(g, 0.95), gpuN: g.length, ...this.info };
  }
}

export const perf = new PerfMon();
