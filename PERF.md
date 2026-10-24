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
  `__live(seconds, speed)` plays the sim (10 = top speed) while rendering frames back to back.
- **Render parity:** `npm run parity -- [seed] [months] [every] [--budget ms]` checks that the incremental city view matches a freshly built one.
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

## Summary: baseline vs final (browser, seed 4821, test line, month 240, 1920x1080, Iris Xe)

Two tabs side by side, the baseline (commit d2c9c0f, tilt-shift on as it was) and the final branch, measured alternately at the same camera:

| | baseline | final |
|---|---|---|
| overview, day: wall p50 / p95 (CPU + GPU, synced) | 49.7 / 70.6 and 48.8 / 77.7 ms | 35.3 / 53.9 and 33.5 / 59.6 ms |
| overview, day: GPU p50 / p95 | 30.5 / 34.0 and 33.9 / 36.5 ms | 25.3 / 27.7 and 24.9 / 27.3 ms |
| street, day: wall p50 / GPU p50 | 40.7 / 30.1 ms | 29.6 / 22.4 ms |
| draw calls overview / street | 755 / 413 | 382 / 235 |
| main-thread apply per month, p50 (months 60-240) | 75-360 ms | 11-18 ms in the handler, then 7-8 ms slices |
| worker tick (headless, quiet machine, month 240 with line) | 36.6 ms | 13.5-17 ms |
| simulation result (population at month 240) | 117949 | 117949 |

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

## Fix 2: main-thread city rebuild (top cost 1)

Profile (headless `--render`, `node --cpu-prof`): `buildChunk` re-ran the building designer for every plot of a 16 x 16-cell chunk when any
one of them changed (about 7 chunks a month, a few hundred plots each); then the tree layers (up to 30k instances) were rebuilt from
scratch and their full 7.7 MB instance buffers uploaded every month, and wild trees re-sampled the terrain 5 times per cell every month.

What changed (`src/render/city.ts`, `layers.ts`, `poly.ts`; commits bc83d0d, 1f12ca4, 070c149, ed8578b):
- Each chunk keeps, per plot, its vertex range in the merged arrays and its signature; a rebuilt chunk copies unchanged plots out of the
  old arrays (in runs) and designs only the changed ones. Bounding spheres come from cached per-plot boxes. Same arrays in the same order.
- Trees: per-plot, per-street and wild instances are precomputed records (matrix and linear colour); the layers are refilled by copying,
  only when a chunk, a site, the roads or the plot shapes changed; wild-tree candidates are computed once; uploads cover only the used part.
- The rebuild is a queue of small steps (roads, occupancy, designs six plots at a time, chunk assembly, construction sites, assembly sites)
  run within 6 ms per frame. Every step prepares off-scene and a final commit step swaps everything in at once, so a month still changes in
  one frame. If the next message arrives first, the rest of the queue is finished then. `tsm.shot` flushes first.
- Road normals computed on the typed arrays (identical to computeVertexNormals), hex colours converted once, no per-frame allocations in `animate`.
- Parity: `npm run parity` (incremental view vs a fresh view, optionally time-sliced with `--budget`) and an exact comparison against the
  original implementation (`scripts/parity_base.ts`, not committed): all chunk geometry arrays and all tree and crane instance matrices and
  colours identical, seeds 4821, 187 and 304, months 12-96.

Main-thread apply per monthly message, headless, A/B in one process (new vs the original `CityView`; docs/perf/bench-final.txt).
"diff" = work done in the message handler (including its first step); "longest step" = the most a single frame gets:

| seed | line | months | before | after (total) | diff | longest step |
|---|---|---|---|---|---|---|
| 4821 | no | 12 / 60 / 120 / 240 | 325 / 254 / 89 / 408 | 61 / 38 / 20 / 87 | 12 / 8 / 7 / 24 | 31 / 18 / 12 / 69 (roads) |
| 4821 | yes | 12 / 60 / 120 / 240 | 160 / 259 / 251 / 187 | 30 / 64 / 59 / 39 | 6 / 7 / 11 / 8 | 21 / 48 / 22 / 18 |
| 187 | no | 12 / 60 / 120 / 240 | 165 / 140 / 138 / 38 | 41 / 24 / 33 / 6 | 9 / 3 / 7 / 2 | 16 / 15 / 18 / 5 |
| 187 | yes | 12 / 60 / 120 / 240 | 158 / 158 / 139 / 217 | 38 / 25 / 36 / 45 | 9 / 2 / 9 / 13 | 17 / 14 / 18 / 16 |
| 304 | no | 12 / 60 / 120 / 240 | 103 / 88 / 112 / 48 | 20 / 24 / 21 / 10 | 6 / 5 / 5 / 1 | 15 / 14 / 13 / 17 |
| 304 | yes | 12 / 60 / 120 / 240 | 90 / 126 / 181 / 171 | 20 / 36 / 47 / 43 | 8 / 10 / 10 / 11 | 13 / 16 / 13 / 31 |

All in ms, mean of the 6 months before each checkpoint. The machine was contended during this run, so the ratio is what holds: 4-7x less
work, and at most one step (usually 10-20 ms) per frame instead of the whole 90-400 ms in one frame.

Browser, seed 4821 with the line, months 60-360, one month per message: apply in the message handler p50 11-18 ms (before 75-360),
p95 20-60 ms; rebuild slices in the following frames p50 7-8 ms, p95 10-14 ms on a quiet machine (26-30 ms while it was saturated).
At the top speed (a month every 150 ms) the main thread now spends 20-60 ms of every 150 ms on the city, before 140-400 ms (saturated).
This is derived from the measured per-message work: the hidden pane could not run a real 60 Hz frame loop alongside (see "Synthetic vs real").

## Fix 3: GPU (top cost 2)

Interleaved A/B in one page at month 240, overview, day (GPU ms per frame; the GPU was shared with another worker's tab):
- Blur removal (fix 1): 31.2 -> 23.3.
- Leaf crowns as an indexed icosahedron (12 vertices instead of 60; the material is flat shaded, so the shading is unchanged): 25.2 -> 22.6.
- Metro viaducts instanced (deck, stripe, piers: one instanced mesh each per line instead of a mesh per 25 m segment): draw calls 755 -> 446.
- `setPaper` no longer parses a colour string and allocates a Color every frame.

Where the frame goes now (month 240, overview, A/B of skipping each part): shadow map render 10.1 ms of about 24, buildings 2.7,
trees 1.9, terrain 1.4, metro 0.8, water and roads under 0.7 each. The shadow pass is fill-bound: a 2048 map instead of 4096 saves 5.3 ms.

## Fix 4: sim tick (top cost 3) and protocol (top cost 5)

- `field.update`: the centrality of the smaller centres does not move and is cached (the main centre grows with population and is still
  computed every month). `computeDriveTimes`: zone-pair distances and midpoints are static and cached. `computeLandValue` no longer
  allocates arrays per cell. A/B in one process with an exact equality check every month (`scripts/simab.ts`, not committed):
  field.update 6.6 -> 3.6 ms (4821) and 13.7 -> 5.0 ms (187); computeDriveTimes 3.2 -> 0.5 ms and 4.6 -> 0.8 ms. Populations at months 60, 120
  and 240 are identical to the baseline on every seed and mode (the sim stays deterministic and unchanged).
- The worker transfers the snapshot's typed arrays (fresh copies every month) instead of structured-cloning them.
- Sim tick now 10-23 ms per month at month 240 (20-72 ms in the noisy baseline run), well inside the 150 ms of the top speed.
- Not done: delta snapshots (the message is 310-395 KB and its clone was under 1 ms, not worth the protocol churn while master changes it).

## Memory

Browser, seed 4821 with the line, months 30 to 360 in 30-month steps: geometries on the GPU track the scene's live geometries
(always 4 fewer: hidden overlays) between 126 and 371 as construction sites come and go; textures stay at 14; JS heap 150-265 MB
(mostly the typed arrays of the chunk geometry, kept for the incremental rebuild). No growth that does not follow the city.
Headless: heap 22-28 MB, array buffers 55-110 MB with the render view.

## Targets

- 60 fps at overview on a 20-year city at 1080p on Iris Xe: not reached. GPU about 22-24 ms per frame (from about 31-35 ms), CPU frame 5-9 ms.
  The rest is the 4096 x 4096 shadow map re-rendered every frame (about 10 ms, fill-bound) and per-pixel shading. Not reachable without a
  visual trade-off. Measured options, for a decision (none applied):
  1. Shadow map 2048 instead of 4096: -5.3 ms (softer shadow edges, 4.7 m per texel instead of 2.3 m).
  2. Re-render the shadow map only when the sun has moved more than a small angle or geometry changed: up to -10 ms on the frames that skip it
     (shadow edges step slightly at dusk; shadows of moving cars, trains and crane jibs update less often).
  3. Render scale 0.67, upscaled: about -9 ms (softer image).
  With 1 and 2 together the overview frame would be around 13-15 ms on this GPU.
- The sim keeps up at the top speed: tick 10-23 ms of the 150 ms per month, and the main thread no longer stalls on each message.
- Memory is stable over 360 months (above).

## Synthetic vs real

- Hidden Browser pane: requestAnimationFrame does not run, so frame times come from frames rendered back to back with a GPU sync after
  each (an upper bound, no CPU / GPU overlap) plus GPU timer queries, not from a real 60 Hz loop. The rebuild slices were driven by the
  measuring script the way the frame loop drives them.
- CityView apply timings are also measured headless (three.js geometry building in Node, no GPU upload).
- The machine was shared with another worker's dev server, sim and browser tab throughout: absolute numbers vary 2-3x between runs;
  the before / after figures above come from interleaved A/B runs in the same process or page.

## For the visual pass and HANDOVER (not edited here)

- Drop "shallow depth of field" from the architect's-model look: the blur passes are gone (user decision). The T key is free.
- `tsm.env.linear = false` (dev) renders straight to the canvas: 3 ms cheaper, but transparent layers then blend after tone mapping and read paler.
