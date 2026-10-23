# HANDOVER (read this first, then PROGRESS.md)

State: `master` is clean, `npx tsc --noEmit` and `npm run build` both pass. Round 3 steps 1, 2 (plot assembly, merged fe4db48) and 3 (landscape, partial) are done and measured; see PROGRESS.md. `wip/plot-assembly` is merged and kept only as history. Next is QUEUE item 4 (road hierarchy and pruning).

## Game
Browser transit tycoon, no ads. Core loop: build metro lines -> accessibility -> land value -> buildings grow over months -> riders and money -> more lines.
Key decisions:
- No global grid: a planar road graph (arterial/collector/local) with frontage plots (convex quads flush along each street edge).
- Station catchments follow walkable streets (network walk time), not circles.
- The sim runs on a hidden coarse grid (N x N cells, `src/sim/constants.ts`), in a Web Worker.
- Look: architect's-model, muted district palettes.
- Riders: gravity trips with logistic mode choice (transit vs car).
- Data-driven events (`events.ts`): the docks project with deals, service brief, car-lock and follow-ups.
- Landmark catalogue (`landmarks.ts`, data) with proposals as events.
- `CityProfile` / `DistrictProfile` with history layers: every seed is a different city (4821 = original port-city preset).

## How to run (verified against package.json)
- `npm run dev` serves http://127.0.0.1:5173. IPv4 only: use 127.0.0.1, not localhost.
- URL params: `?seed=N&terrain=coast|river|hills|plain&origin=port|rail-junction|market-town|mining|planned-capital`.
- `npm run build` (= `tsc --noEmit && vite build`); `npx tsc --noEmit` for a type check only.
- `npm run headless -- <seed> <months> <deal 1> [--line] [--map]`, e.g. `npm run headless -- 4821 36 1 --line`.
- `npm run seeds -- <months> <seeds...>` is the seed survey; `npm run terrain -- [seed ...] [--map]` and `npm run impact -- [seed]` are the terrain tools. `npm run metrics -- [months] [--line] [--baseline] [seed ...]` prints the height/density gradient (by distance from the centre and by station walk time) and road stats. Baseline output is in `docs/metrics/before-*.txt`.
- `scripts/make_grid.py` composes `screenshots/grid-<seed>.png` into the labelled contact sheet `seeds-grid.jpg` (needs PIL).
- Dev Vite middleware: `window.tsm.shot(name)` saves a full-resolution canvas PNG to `screenshots/` (png is git-ignored; showcase captures are committed as jpg).
- Dev helpers on `window.tsm`: `ff(month, deal)`, `demo(deal, lineMonth)`, `view(x,y,dist,az,pol)`, `shot(name)`, `phase(p)` (0.86 = night), `city.gallery(x,z,styles)`.
- Hidden Browser pane throttles timers: keep one JS call under about 40 s and use `tsm.ff` in small steps.

## Controls (from src/main.ts)
Space pause; 1/2/3 speed (1x/3x/10x); P toggles plan mode (V back to view). WASD or arrow keys pan (Shift faster); middle-drag orbits (yaw + pitch; yaw only in plan mode); wheel zooms; left-drag orbits, right-drag pans. In plan mode: click stations in order, Enter builds, Backspace undoes, Esc cancels. H heatmap, X x-ray, Z zones, N night, L desire lines (moved from D), T tilt-shift. Left HUD panel lists landmarks (click to fly there).

## Code map
- `src/sim/` (runs in `worker.ts`; messages typed in `protocol.ts`)
  - `relief.ts` (ground height / slope / view fields, Tobler, metro vertical profile `quoteLine`, car effort field `zoneEffort`; shared with the planner on the main thread).
  - `sim.ts` monthly tick, growth, demand, trips, money, redevelopment (demolish -> construct -> merge).
  - `terrain.ts` seeded heightmap/river/bay per terrain type. `cityprofile.ts` CityProfile from the seed. `profiles.ts` DistrictProfile data, `hash01`.
  - `town.ts` quarter street skeletons, `profileAt`. `roads.ts` road graph (RC classes, ROAD_HALF), growth. `lots.ts` plot generation (corner cuts, tiers, back rows, carve). `geom.ts` polygon helpers.
  - `field.ts` density-and-height field (centrality x jobs x station access). `metrics.ts` measurement helpers.
  - `metro.ts` lines/stations/trains/accessibility. `events.ts` event engine and docks project. `landmarks.ts` catalogue; `landmarkSys.ts` siting/construction/opening/visitor trips.
  - `assembly.ts` large plot assembly (tower / landmark / docks).
- `src/render/` Three.js: `city.ts` (chunks, rebuild on plot change), `buildings.ts`, `towers.ts`, `poly.ts` mesh builder, `forms.ts`, `harbour.ts`, `landmarks.ts`, `terrain.ts`, `metro.ts`, `env.ts` (day/night, sky), `look.ts` (post effects, tilt-shift), `layers.ts` (heatmap/overlays), `desire.ts`; `sites.ts` (assembly hoardings, cabins, cranes).
- `src/ui/` `hud.ts` (HUD, event dialog, landmark list), `planner.ts` (plan mode). `src/main.ts` boot, input, camera, `tsm` dev helpers.
- `scripts/` headless, seeds, metrics, terrain (landform survey), impact (terrain gameplay numbers), lib (`testLine`), asmdebug, fieldprobe, dbg_render, make_grid.py.

## DONE (master)
- M1..M6 (0c1d090 .. 7006840): terrain, growth sim, metro, riders/money, docks events, window-light/day-night look.
- Non-grid refactor 8e264c5; plan-mode street catchment ccf664a.
- District looks 02ba70a, 420675c; wall-to-wall plots and dynamic construction f695f57.
- Stage A district profiles 05f50c3; Stage B CityProfile ee94df6.
- Landmark catalogue 869a082; landmark gameplay 04aac68; verification 439226b.
- Round 3 step 1 (QUEUE item 1 below): b19afe0 density-and-height field, field-driven fabric classes, re-subdivision of streets when their class rises, per-plot heights through the protocol, `npm run metrics`. The code is in master, but the before/after numbers were only partly recorded (docs/metrics has the baseline only). Re-run `npm run metrics` to check the acceptance criteria below before calling it fully closed, and confirm re-subdivision visibly fills mid-ring back rows.
- PROGRESS.md round plan: e9e8e00, abf0e8a (road hierarchy by age), 48f02fc (landscape step).
- Round 4 (this worker): step 3b playability (route guarantee, rack / funicular segments, `npm run routes`), tower retune (`npm run towers`), x-ray fix, then queue steps 4 (road hierarchy), 5 (territories, `?noterr=1`), 6 (empty structure and squares, `?nores=1`), 7 (satellites with a cause, `?nosat=1`, `npm run satellites`), 8 (visual pass: cork, strata, acrylic water, paper map blend, labels, traffic and crowds). See the matching PROGRESS sections; dev switches `HIER.on` (`?nohier=1`), `TERR.on`, `RES.on`, `SQ.on`, `SAT.on`; scripts `routes`, `towers`, `zones`, `structure`, `satellites`.

## IN PROGRESS / WIP
Nothing in progress. Queue steps 1-8 are done (some partial, see PROGRESS). Leftovers: ravines, terraces / vineyards, retaining walls, flood / landslide events, a real funicular line type, moving trains and ships, label collision avoidance, growth rules specific to satellites, campus lawn linked to the university landmark. Open tuning issue: with the density field plus plot assembly, 60 m towers arrive late (first around month 87 on 4821 with the test line); see PROGRESS "Step 1 numbers".
Fixed in step 2: docks `built` count (see PROGRESS).

## QUEUE (in order, with acceptance criteria)
1. [DONE b19afe0, numbers in docs/metrics] Density-and-height field before placing buildings. One main centre, a few smaller centres, transit corridors; sequence CBD -> dense mixed-use inner -> medium-density transit districts -> suburbs/industry -> fringe; compact CBD; towers only where land value, jobs and station access overlap. The starting city is modest; big tower clusters mostly come from the player's transit. Plots re-subdivide/merge as land value changes so empty mid-ring back rows fill in. Acceptance: `npm run metrics` shows height and density versus distance from the centre and versus station access, before/after (baseline in docs/metrics), for seed 4821 and two other origins. (Code landed in b19afe0; verify and record the numbers.)
2. [DONE, merged fe4db48] Large plot assembly (required rule). Every tower, stadium, arena, factory, campus or major redevelopment consumes several contiguous plots (acquired over time, holdouts possible). Visible stages: hoardings -> demolition building by building -> cleared site with cabins -> foundations -> structure with cranes -> facade -> opening. Streets through the site close or reroute; pathfinding and catchments update. New plaza or cut-through; drop-off loops for venues; yard and freight access for factories. Landmark event proposals use the same pipeline and show which plots get cleared. Acceptance: no large building appears on a single original plot; capture sequence of a tower and a stadium/factory build; a street closure with catchment before/after. (WIP branch.)
3. [DONE, partial: see PROGRESS "Step 3 results"] Dramatic terrain with gameplay impact (before road pruning). Ridges and mountains with passes, carved valleys, cliffs and bays, a castle hill, floodplains and wetlands, ravines; slope materials, forests, vineyards, retaining walls. Gameplay: metro cost by terrain (cut-and-cover cheap, bored tunnel under hills expensive, viaduct across valleys, river crossings) shown per segment in plan mode with gradient limits; deep stations add access time; slope-aware walking (Tobler) shrinks hilltop catchments; arterials follow valleys and passes; switchbacks; car times include grade. Slopes limit density; views raise value; floodplain unbuildable or flood risk; ridges split basins so a tunnel opens a basin. Optional funicular/cable car. Events: flood, landslide, tunnel milestone. Acceptance: one dramatic oblique per terrain type, plan mode with segment types/costs, hilltop vs flat catchment area, cost per km per segment type, ridership change when a tunnel opens a basin.
4. [DONE, see PROGRESS "Step 4"] Road hierarchy and pruning. Old core and old villages stay organic (remove only junk fragments and slivers), 1-2 historic main streets slightly wider. Arterials stop at or ring the core (ring road on the old walls; deliberate cut-through only if history suggests it). Outside the core a strict hierarchy: continuous arterial spines, clearly secondary collectors, locals only fill blocks, few diagonals, no triangle leftovers; planned quarters regular. Rendering by class: wide arterials with tree lines or medians, medium collectors, thin locals, cobbled old-town lanes; the organic-core vs ordered-outer contrast reads as history. Road classes affect speed and capacity in the sim. Acceptance: `npm run metrics` road stats (diagonals, dead ends, triangles) for core vs outside, before/after.
5. [DONE, see PROGRESS "Step 5"] Land-use territories with real borders: port/logistics, heavy industry, old core, inner mixed-use, transit suburb, detached suburb, parks/waterfront. Working port with freight corridors, warehouse belts, rail yards, workers' districts; the docks redevelopment is a bounded zone; no towers on working quays.
6. [DONE, see PROGRESS "Step 6"] Deliberate empty structure: large parks, a rail corridor, floodplain, campus, industrial yards, green wedges, visibly intentional (edged, planted, fenced, paved).
   NEW SQUARES (added by the coordinator, build with step 6, not before): new squares form where `squarePressure` is high. squarePressure = pedestrianCentrality + nearbyRetailAndJobs + landmarkDemand + transitBoardings + crossingOrWaterfrontBonus - existingPublicSpaceNearby. Normalise each term to 0..1 and weight them; never add raw units. pedestrianCentrality: no exact betweenness; approximate it with the walking legs of the existing trip assignment (walk flow per road node), failing that junction degree x road importance. Evaluate rarely (about once a year); a square forms only above a high threshold, with a minimum spacing between squares and hysteresis; squares persist once built, never removed. Carve squares at junctions: buy the adjacent plots (reuse the plot-assembly code in assembly.ts), pave the space, add trees or a fountain, size by pressure. Feed back into the sim: a square raises land value and the retail share on its edges, and counts toward existingPublicSpaceNearby.
7. [DONE, see PROGRESS "Step 7"] Satellites with a cause: historical village (organic), rail town (around its station), factory town (terraces by the works), planned/commuter suburb (curvilinear); each with 1-2 strong links (arterial or rail) tied to the CityProfile history layers.
8. [DONE, see PROGRESS "Step 8"] VISUAL PASS after the structure work (user chose a MIX). 3D city view: "refined architect's model" (card/wood buildings, layered cork terrain, acrylic water, studio light, shallow depth of field). Plan mode and data overlays: "map/diagram" (paper texture, hatching, contour lines, district and arterial labels, metro as a bold transit diagram). Ideally a smooth blend when zooming out or entering plan mode. Plus life (traffic dots on arterials, moving trains, ships, station crowds), haze, labels, better water (shore foam, reflections).

## User's standing principles
Stronger macro structure and density discipline, NOT more variation (no new building styles/props/landmarks this round). Measure with numbers and before/after captures of the same seed (4821 plus two other origins). Commit per step. Keep PROGRESS.md current.

## Known bugs and limits
- Plots re-subdivide only when a street's field class rises (b19afe0); the older PROGRESS note "no re-subdivision" was stale, and quality is unverified.
- The headless survey has no metro and its money figures are meaningless (inc/exp 0.00).
- A weak curved-street capture; hills only read at the horizon; modest night floodlights.
- Bridge landmark missing; landmark proposals ignore `dominantBuildingTypes`; no rating milestones (unlocks are month/population only).
- (fixed) Docks `built` count: see PROGRESS.
- Git on Windows prints LF->CRLF warnings; harmless. `screenshots/*.png` is git-ignored.
