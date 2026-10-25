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

### What changed, by commit
| commit | what |
|---|---|
| 277b476 | pass 1: sky dome and studio table, time-of-day palette / fog / graded output, ground colour patches and field pattern, per-building facades and roofs, moonlit night (street lamps and station glow as one Points draw call) |
| 2c98bed | diegetic UI layer (paper tags on pins, flags, cost slip, coin pops, news slips) and the HUD as table objects (ledger strip, desk calendar, brass odometer, desk rail, tracing paper in plan mode) |
| 98a5c12 | the WIP picked up in session 2: lane markings and crosswalks, tree thinning, water night glow, ship wakes, lens easing. It already built; nothing needed fixing |
| ac478a9 | verification of the WIP in the browser, A/B cost of the whole pass |
| 2aca1e0 | `camfeel.ts`: wheel zoom eased and anchored at the cursor, smoothed WASD pan, wind sway on tree crowns |
| aad703f | full fun-pass event mapping, newspaper, goal clipboard, dial plate, hoardings, site briefs, crowds that follow line load |
| 9a4ac9c | roof detail that shows (the plain parapet slab hid the building shader's roof code), plant rooms on offices, district names stand back when tags are on |

Captures (seed 4821, 1500x900): `screenshots/visual-before-4821-{overview,mid,street}-{day,dusk,night}.jpg` against `visual-after-4821-*` (same views), UI captures
`visual-after-ui-overview-{day,night}.jpg`, `visual-ui-events.jpg` (every event kind at once), `visual-ui-hoarding.jpg`, `visual-after-roof.jpg`, `visual-roads-*.jpg`.

## 4. Performance: baseline against final
High, seed 4821, month 120, day, 1500x900, GPU p50 in ms with a GPU sync after each frame. The dev GPU is shared (Intel Iris Xe, other tabs), so the baseline of section 2 was taken in a
quieter moment than the final run: the honest figure is the interleaved A/B in one page (all flags off = the classic look, same code, same frames), 40 frames x 5-6 rounds.

| view | baseline (sec. 2) | final (best of 3) | A/B in one page: median (min of rounds) | draw calls, classic -> pass | k tris, classic -> pass |
|---|---|---|---|---|---|
| overview | 9.84 | 10.61 | +8% (+16%) | 443 -> 447 | 707 -> 713 |
| mid | 9.37 | 9.37 | +10% (+18%) | varies with shadow redraws | 613 -> 646 |
| street | 9.37 | 9.24 | +8% (+3%) | 276 -> 289 | 566 -> 597 |

The call counts of the A/B pairs differ by a handful (the mark mesh, the lamp Points, wakes); counts in the baseline table of section 2 were taken while chunks were still rebuilding and are not comparable.
Per feature (A/B, noise about 5%): ground colour +2-4%, building facades and roofs +1-4%, night lights about 1%, tree sway / lens / camera 0%, road marks 0%, tree thinning 0%, sky and grade about 0,
diegetic canvas 0.05 ms CPU per frame, newspaper and clipboard are DOM touched only on change. Typical cost of the whole pass is about +8% GPU; the "min of rounds" column is the worst case and
is at the 10% line or a little over at overview and mid. There is no new full-screen pass (the grade is folded into the existing output pass; no blur). Auto (default) steps the render scale down
whenever the frame goes over 15.5 ms, so on a slower GPU the pass is paid for by resolution rather than frame time; on this machine Auto stayed at 1.0 in all three views.

Behind High / cut: nothing is High-only so far (Auto absorbs the cost). Candidates if a lower tier is wanted: `?novfx=ground` (-3%), `?novfx=bld` (-3%), `?novfx=night`; every look is one flag in `vfx.ts`.
Cut candidates (not removed, the user decides): the `Zones` and `Land value` toolbar buttons (see DESIGN-FUN.md section 4); `?hud=classic` once the diegetic HUD is accepted.

## 5. Fun-pass events and how the diegetic layer presents them
`ui.notify(e)` accepts the `GameEvent` of `worktree-agent-a884a845a686b0163:src/ui/gameEvents.ts` unchanged (the structural copy is `src/ui/diegetic/events.ts`; extra fields are ignored). When the branches
meet: `gameEvents.onAny((e) => dg?.notify(e))` in main.ts and drop the DOM presenter in `feedback.ts` (else every beat shows twice). Until then `tsm.fun('all')` (or one kind) fires samples.

| event | where it lands | how |
|---|---|---|
| `stationOpened` | on the model | the station's tag pulses (expanding ring) and a paper slip "X station opens"; the fun-pass ripple stays a world effect |
| `lineOpened` | on the table | a front page of "The Tidewater Times" is laid on the table with the line-coloured ribbon hanging from its corner (click to dismiss, 9 s) |
| `moment` | table + model | `big`: the newspaper; else a paper slip. When it has a place (`x`, `y`, and not a goal) a brief is pinned at the site for 9 s (`ui.brief`), so "Cranes at Chapel" is at Chapel |
| `objectives` | table + model | the clipboard (goal title, bar, `cur of target`, reward, ticked count) bottom right; a goal with a place gets a gold flag pinned at the site |
| `objectiveReached` | table | a big gold-edged slip; the newspaper is kept for line openings |
| `fare` | model | a coin pop rising above the station (it was in the wrong units before: cells used as metres) |
| `crowding` | model | `lineLoad` turns the station tag red ("packed"); the crowds at the entrances grow and pack (also derived from the state's peak load, so they work without the event) |
| `planCost` | hybrid | the cost slip (tracing paper) that follows the cursor in plan mode: always screen-space, always legible; the event refreshes its text |
| `stationDug` | model | "-$5.0M" pops at the dug site |
| `undo` | model + table | "+$5.0M" pops at the site and a slip "Plan taken back" |
| `clock` | table | the brass dial plate on the desk rail: needle at the speed, label WAITING / PLANNING / PAUSED / RUNNING / AUTO (the state's speed drives it until the first event) |

Hybrid rule kept: money (brass odometer), date (desk calendar), pause / speed (brass buttons + dial), quality (rail) and the cost slip are DOM / screen-space and stay legible at every zoom;
station names, ridership, project hoardings, flags, briefs and goal pins are in the world with distance LOD (full tag, mini badge, hidden) and overlap rejection, all on one canvas.

## 6. Ranked issues: solved and left
1. Flat light, no depth: solved (palette, fog, sky, grade; golden hour at dusk).
2. No sky or horizon: solved (dome, studio table).
3. Empty ground: mostly solved (colour patches, fields); far hills still low contrast at noon.
4. Weak night: solved (lamps, station glow, window mix, water glow); no bloom on lit tower crowns beyond the sprites.
5. Samey buildings: improved (facades, floors, shopfronts, roof patches and plant rooms); the tower styles' own roofs are still bare.
6. Plain streets: solved on arterials and collectors (dashes, edge lines, zebra crossings); cobbled cores and local streets have none on purpose.
7. Noisy far view: improved (tree thinning, marks fade).
8. Dead water: improved (wakes, night lights in the water); no sun glint or reflections.
9. Generic HUD: solved for the table objects; the left panel is still a long list; goals have a clipboard.
10. Camera: solved (wheel eased about the cursor, lens widens close in, pan glides).

## 7. What I would do next
- Merge the fun branch and wire `gameEvents.onAny` (one line), then retire the placeholder DOM presenter.
- Roof detail for the tower styles (`towers.ts`), a halo around lit tower crowns, a cheap sun glint on the water.
- Replace the long left list with pins: a project row becomes the hoarding on the map; keep only the totals on the table.
- Hoardings that follow the camera azimuth (screen-aligned cards now) and open into the decision card on click.
- A real tree LOD (an imposter quad past 3 km): the current thinning hides vertices but does not reduce vertex work, and trees are still the largest GPU line at overview.

## 8. Honest take
The model now reads as a model: it has a light, a horizon, a bright side and a shaded side, storeys and roofs, and at dusk and night it is the best looking thing in the game. The paper tags,
hoardings, newspaper and clipboard give the table a voice and I would keep them. What is not there: it is still low-poly boxes and cones, trees and far hills are plain, the left panel is still a panel,
and the performance headroom is spent (about +8% typical, at the edge of the 10% budget in the worst samples), so the next visual item has to be paid for. Measurements are from a shared integrated GPU and swing by 5-10% between runs.
