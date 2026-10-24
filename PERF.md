# Performance pass

Measured on the dev machine: Intel Iris Xe (ANGLE / Direct3D 11), Chrome-based Browser pane, canvas 1920x1080 at devicePixelRatio 1.
The pane was hidden and shared with another worker's dev server and browser tab, so CPU and GPU were contended: absolute numbers
drift by up to 2x between runs. Comparisons below are therefore taken as interleaved A/B runs in the same process or page where possible.

## How to measure

- **Sim and main-thread apply (headless):** `npm run bench -- [--months 12,60,120,240] [--seeds 4821,187,304] [--noline|--lineonly] [--render] [--ab] [--json out.json]`.
  Times every monthly tick by phase (the Sim's methods are wrapped on the instance, sim code untouched), the snapshot, the structured clone
  (`v8.serialize`, the wire format of `postMessage`) and its size, and with `--render` the main-thread `CityView.update` in headless three.js
  (geometry building only, no GPU). Each checkpoint is the mean of the last 6 ticks. Seeds 4821 (coast / port), 187 (hills / rail junction),
  304 (coast / planned capital); "line" = the test line through the quarters (`scripts/lib.ts`) opened at month 6.
  `--ab` also feeds every message to the pre-change `CityView` (extract it with `git show <rev>:src/render/city.ts > src/render/city_base.ts`
  and `git show <rev>:src/render/layers.ts > src/render/layers_base.ts`, then point its import at `./layers_base`; not committed) and times both.
- **Browser:** `?perf=1` shows an overlay (frame interval / CPU / GPU p50 and p95, draw calls, triangles, geometries, textures, JS heap, message
  size and rate, apply time). Console: `tsm.perf.report()`, `tsm.perf.bench(frames)` (renders frames back to back with a GPU sync after each and
  GPU timer queries; works in a hidden pane where requestAnimationFrame does not run). Scenarios: `await import('/scripts/perf-scenarios.js')`,
  then `__ff(month)` (one month per message, times the main-thread apply), `__line()` (test line), `__scen()` (overview / street, day / night,
  x-ray, heatmap, plan mode), `__ab()` (interleaved GPU cost of parts), `__shots(tag)` (parity captures `screenshots/perf-<tag>-*.png`).
- "wall" = CPU + GPU per frame with a sync after each frame (no pipelining, an upper bound); "gpu" = GPU timer query.

## Baseline (commit 2c2e072)

### Sim tick and main-thread apply, headless (ms; docs/perf/bench-baseline.txt)

| seed | line | month | tick | snapshot | clone | msg KB | apply (CityView.update) | chunks rebuilt / month |
|---|---|---|---|---|---|---|---|---|
| 4821 | no | 12 | 33.3 | 2.4 | 0.5 | 307 | 226.9 | 12.3 |
| 4821 | no | 60 | 19.1 | 1.7 | 0.6 | 307 | 141.5 | 7.2 |
| 4821 | no | 120 | 16.5 | 0.9 | 0.4 | 315 | 79.3 | 4.7 |
| 4821 | no | 240 | 19.7 | 2.5 | 0.5 | 338 | 166.3 | 6.8 |
| 4821 | yes | 12 | 43.6 | 3.4 | 0.6 | 308 | 137.8 | 5.8 |
| 4821 | yes | 60 | 20.9 | 2.4 | 0.4 | 319 | 146.5 | 7.0 |
| 4821 | yes | 120 | 21.2 | 2.9 | 0.5 | 329 | 181.1 | 7.0 |
| 4821 | yes | 240 | 36.6 | 4.7 | 0.9 | 343 | 328.0 | 7.7 |
| 187 | no | 12 / 60 / 120 / 240 | 44.6 / 31.4 / 22.1 / 24.6 | 1-4 | 0.5 | 331-370 | 297 / 249 / 177 / 50 | 10.2 / 9.5 / 7.5 / 1.5 |
| 187 | yes | 12 / 60 / 120 / 240 | 27.8 / 26.2 / 27.8 / 30.7 | 2-4 | 0.5-0.9 | 334-395 | 215 / 211 / 187 / 285 | 9.7 / 7.8 / 7.3 / 10.3 |
| 304 | no | 12 / 60 / 120 / 240 | 23.7 / 20.8 / 34.8 / 22.5 | 1-4 | 0.5-0.9 | 320-361 | 132 / 133 / 236 / 69 | 6.7 / 8.2 / 6.8 / 2.3 |
| 304 | yes | 12 / 60 / 120 / 240 | 35.6 / 60.5 / 54.1 / 72.4 | 3-16 | 0.6-2.9 | 325-391 | 123 / 248 / 467 / 627 | 4.8 / 6.2 / 12.2 / 9.5 |

Tick by phase (4821 with line, month 60): field.update 6.1, grow 3.7, computeDriveTimes 2.8, computeLandValue 1.4, walk fields 0.6, riders 0.6.
Apply by step (same): buildChunk 125 (whole 16 x 16-cell chunks re-designed when any plot in them changes), wild trees 8, roads 2-10, the rest under 5.

### Browser, seed 4821 with the test line, 1920x1080, tilt-shift on (the default then)

| month | view | wall p50 / p95 | gpu p50 / p95 | draw calls | k tris |
|---|---|---|---|---|---|
| 12 | overview day | 65.7 / 110.7 | 34.1 / 47.5 | 533 | 1024 |
| 12 | overview night / street day / street night | | 33.4 / 31.5 / 31.2 | 533 / 284 / 284 | 1024 / 903 / 903 |
| 12 | x-ray / heatmap / tilt-shift off / plan mode | | 32.8 / 32.2 / 26.0 / 25.9 | 544 / 535 / 530 / 541 | |
| 60 | overview day / night | 40.0 / 59.2 | 28.0 / 30.6 | 599 | 1051 |
| 60 | street day / street night / x-ray / heatmap / plan | | 30.8 / 28.2 / 35.0 / 30.3 / 23.9 | 343-610 | |
| 240 | overview day | 50.0 / 78.4 | 35.2 / 36.6 | 755 | 1340 |
| 240 | overview night / street day / street night | | 35.2 / 32.0 / 28.8 | 755 / 413 / 413 | 1340 / 1182 |
| 240 | x-ray / heatmap / tilt-shift off / plan mode | | 33.1 / 31.1 / 27.1 / 30.7 | 752-766 | 1340-1405 |

Main-thread apply per monthly message in the browser: month 12 p50 187-298 ms (p95 434-541), month 60 p50 75-78 (p95 122-139),
month 240 p50 137-359 (p95 178-471). Worker tick p50 26-36 ms, snapshot 2.5 ms, message 307-334 KB, about one per month (6.7/s at 10x).
JS heap 75-250 MB (the page; most building geometry lives in typed arrays). Frame CPU (frame() body) p50 5.4 ms, p95 9.2 ms at month 240.

GPU cost split at month 240, overview, interleaved A/B (ms saved when the part is skipped): shadow map render 7.9, trees 4.1, tilt-shift
(scene rendered without MSAA into a half-float target, then two blur passes and an output pass) 2.9 net (the post chain alone costs about
11 ms over an empty scene, but the direct path pays for 4x MSAA instead), buildings 2.3, terrain 1.9, metro 0.8, water / paper / roads under 1.
Half resolution (scene and post): 32.2 -> 17.8 ms with tilt-shift, 28.4 -> 18.0 without, so about 40% of the frame is per-pixel work.

### Top costs (from the profiles above)

1. Main-thread `CityView.update`: 75-360 ms per monthly message in the browser (130-630 ms headless). At 10x (one message every 150 ms)
   the main thread is saturated and frames stall; at 1x it is a 0.1-0.3 s hitch every 1.5 s. Whole chunks are re-designed when one plot changes;
   all trees (up to 30k instances) are rebuilt and the full instance buffers (7.7 MB) uploaded every month.
2. GPU frame 28-35 ms at overview (about 30 fps) on Iris Xe: shadow map (4096^2, PCF, re-rendered every frame) about 8 ms, tilt-shift post
   chain, per-pixel shading with 4x MSAA, about 1.3 M triangles (trees are half of them, each icosahedron drawn twice: shadow and main pass).
3. Worker tick 17-70 ms per month: field.update (exp / pow / hypot per cell per district every tick), computeDriveTimes (65k zone pairs),
   grow. Within the 150 ms budget of the top speed, but it is the floor for the sim's speed.
4. Metro: 290 meshes (viaduct deck, edge stripe and pier per 25 m segment are separate meshes), about 200 extra draw calls in the main and
   shadow passes at month 240; `MetroView.update` 7-16 ms when a line changes.
5. Protocol: about 310-390 KB per message, structured clone 0.5-1 ms each side; small next to the above.

## Fix 1: blur post-processing removed (user decision: "we don't need blurs")

- Removed the tilt-shift (two separable blur passes), its shaders and uniforms, `env.tilt`, the `?notilt=1` flag, the T key and the
  Tilt-shift HUD button, and the HUD panels' CSS `backdrop-filter: blur(6px)` (a blur-based screen effect composited over the canvas
  every frame). There was no depth-of-field or bokeh pass. The T key is now free.
- Kept: the x-ray fade, the window-light shader, shadows. The scene still renders into a linear half-float target with one output pass
  (tone mapping and sRGB), as it did under tilt-shift, so transparent layers (metro ribbons, paper sheet, water, ghost blocks) blend
  exactly as before. Rendering straight to the canvas would save about 3 ms more but those layers blend after tone mapping and read
  visibly paler (the red line ribbon turns pink), so that is left as a dev switch (`tsm.env.linear = false`), not the default.
  The canvas no longer requests MSAA (`antialias: false`): it only ever showed the output quad, so nothing changes on screen.
- GPU, month 240, seed 4821, interleaved in one page (the old passes re-inserted for the A/B):

| view | before (tilt-shift) | after (no blur) | saved | direct to canvas (not used) |
|---|---|---|---|---|
| overview, day | 31.2 ms | 23.3 ms | 7.9 ms (25%) | 19.9 ms |
| street, day | 28.6 ms | 20.3 ms | 8.3 ms (29%) | 17.4 ms |

- Captures (seed 4821, month 240, same cameras): `screenshots/perf-before-m240-*.jpg` (tilt-shift) and `screenshots/perf-noblur-m240-*.jpg`
  (overview day / night, street, mid zoom, x-ray, plan mode). The only intended difference is no blur (cars are placed at random each load).
- For the planned visual pass: drop "shallow depth of field" from the architect's-model look; the T key is free.
