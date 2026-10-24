# Visual pass

Branch `worktree-agent-aa7573285fba2d85f` (from master d4e7d41). Scope: rendering (lighting, materials, shaders, environment, night, camera) and, added mid-way, the
presentation of the UI (diegetic layer). Sim and gameplay code untouched.

Captured on the dev machine (Intel Iris Xe, Chrome-based Browser pane, canvas 1500x900, DPR 1, GPU shared with other workers' tabs, so absolute numbers
drift up to 2x; every A/B below is interleaved in one page). Reference city: seed 4821 (coast / port) at month 120 with the demo line; hills seed 187 and
river seed 57 at month 60 without a line. Captures: `screenshots/visual-before-*` (seed, view, time of day).

## 1. Diagnosis, ranked by impact on feel

1. **Flat, washed-out light at every distance (biggest).** Day is one hemisphere light at 1.5 plus a white sun, ACES at exposure 1.05, and the background and fog are the same
   pale grey (`#e9eef0`, fog 9000..26000 m). Nothing has a bright side and a shaded side of a different hue, nothing recedes: a hill 10 km away has the same value and
   saturation as a street 300 m away. The paper sheet (opacity up to 0.55 in view mode from 3200 m) then whitens the ground at overview, so on the hills seed 187 the
   ridges read as white blobs and on 4821 the land is a cream tablecloth. The sun position barely changes the grade: no golden hour, no blue shadow.
2. **No sky, no horizon, no depth.** The model floats on a flat grey void: no gradient, no horizon haze, no sun glow. The grey slab of the board edge is the most
   prominent object on the left of the overview. Dusk and night are a flat navy.
3. **Empty, uniform ground.** Outside the built area the terrain is one low-contrast green-cream with a thin cork line; at overview more than half the frame is this.
   No field patches, no variation of grass, no valley shading, no AO in folds.
4. **Weak night.** Lit windows are the only light. Roads glow a uniform brown, there are no streetlights or light pools, no halos on lit towers and stations, windows are
   static (never change), water is a flat black, the ground goes to murky olive.
5. **Samey buildings up close.** Facades are a single window grid per building class, same grey-beige plinth to roof, flat roofs without any equipment, no cornice or
   floor lines on most mid-rises, no tint variation inside a district (every terrace is the same orange). Tall blank grey slabs dominate the street view of towers.
6. **Streets are plain strips.** Asphalt strips with a pale kerb, no lane markings, no crosswalks, no stop lines; arterials read as dark ribbons.
7. **Noisy far view.** At overview thousands of tiny buildings and about 30k tree instances produce speckle (trees are the biggest single GPU cost at overview, see
   PERF.md), while the big shapes (hills, river, centres) do not read.
8. **Water is nice but dead.** Good shore foam and depth tint, but no sun glint, no night reflection of the city, ships leave no wake.
9. **UI is a generic web HUD over a model: a top bar of seven stats, a long left panel of lists, a right panel, a bottom toolbar of ten buttons.** At 1500x900 the panels
   cover about 30% of the view, the modal dialogs stack (see `visual-before-57-mid-ui.png`: the start card sits on a City hall proposal), and nothing is attached to the
   world: stations have no names or ridership on the map, projects and landmarks are only list rows, the "docks brief" is a card in a corner. This breaks the
   architect's-model metaphor that the 3D view builds.
10. **Camera feel.** Zoom is the stock OrbitControls dolly (damped but linear), FOV is a fixed 32 degrees: close street views have no perspective drama and overview
    has no compression.

## 2. Baseline numbers (before any change)

Seed 4821, month 120 with the demo line, 1500x900, DPR 1, day, best of 3 rounds of 50 frames (GPU timer query + a sync after each frame, `scripts/visual-bench.js`
`__bench`), view = scripts' overview (5200 m, polar 1.0), mid (1700 m) and street (420 m, polar 1.28) around the first village.

| view | quality | scale | GPU p50 ms | wall p50 ms | draw calls | k tris |
|---|---|---|---|---|---|---|
| overview | High | 1.0 | 9.84 | 21.8 | 784 | 710 |
| overview | Auto | 0.9 | 8.36 | 17.6 | 784 | 710 |
| mid | High | 1.0 | 9.37 | 17.3 | 366 | 616 |
| mid | Auto | 0.9 | 8.07 | 14.0 | 366 | 616 |
| street | High | 1.0 | 9.37 | 18.4 | 473 | 568 |
| street | Auto | 1.0 | 9.87 | 19.6 | 473 | 568 |

Wall = CPU + GPU with no pipelining (an upper bound), so it is about twice the GPU figure. The budget below is "no more than about 10% over these".

## 3. Work log

Interleaved A/B (all flags on vs `vfx.setAll(false)` = classic look, High, one page, 40 frames x 3 rounds, GPU p50 ms), measured after the roads / far-view /
water / camera work of session 1 was picked up:

| view | classic | visual pass | delta |
|---|---|---|---|
| overview day | 12.05 | 12.78 | +6% |
| mid day | 10.95 | 11.81 | +8% |
| street day | 11.12 | 12.19 | +10% |

Per flag (same method): ground +3-4%, buildings 1-8% (noisy), night about 1%, road markings 0%, tree thinning 0% (it hides vertices but the triangle count does
not drop), sky and grade about 0. The budget is therefore used up: anything added below has to be about free or pay for itself.

### Pick-up (session 2)
- The WIP tip already passed `tsc --noEmit` and `npm run build`: the "half-written" night-lights module was in fact complete (`NightLights`, `shoreGlow`, the water
  emissive hook). Checked in the browser: lane dashes, edge lines and zebra crossings at junction plates (`visual-roads-c`), tree thinning at overview, ship wakes,
  water glow at night, lens easing (`visual-wip-*`).
