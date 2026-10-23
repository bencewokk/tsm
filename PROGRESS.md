# Progress

## Done
- M1 Terrain + town: seeded heightmap, river into a bay, 2-3 villages with roads, Three.js render with orbit camera.
- M2 Growth sim: monthly tick in a worker, land value (car access + amenities - industry - centre distance), spawn/upgrade/decline, R/C/I demand pools, road growth, congestion.
- M3 Metro: plan mode (P): dig stations, click them in order, Enter builds; coloured lines, animated trains.
- M4 Riders + money: gravity trips between 8x8 zones, logistic mode choice, fares vs costs.
- M5 Docks project: data-driven events (src/sim/events.ts), three deals, ghost plan buildings, car-lock and follow-up.
- Refactor (non-grid): planar road graph (arterial/collector/local), exploration + densification growth with per-district orientation, walk catchments over the street network, curved metro.
- M6 Look: window-light shader, day/night, x-ray, heatmap, desire lines, tilt-shift.
- District looks (commits 02ba70a, then "Stations as buildings ..."): district palettes, old-town cores with squares and a church, hub squares at busy stations, river parks, stations as small entrance buildings that grow into glass halls, quay aprons, street trees, richer industry.
- Wall-to-wall + street-shaped buildings + dynamic construction (commit f695f57):
  - lots.ts: plots are convex quads generated flush along each street edge. Corners are cut by the cross street's kerb line (owner = stronger street), bends use a shared mitre line, so rows trace curves and wedge / trapezoid plots fall out of the street geometry. Density tiers 0/1/2 (detached edge / terraced mid / dense core) pick plot width, depth, setback and gap; dense tiers also get one or two back rows (courtyards). Capacity follows frontage width and tier.
  - render: polygon building forms (poly.ts MB mesh builder, buildings.ts per-kind designs, towers.ts tower styles), merged per 16x16-cell chunk and rebuilt only when a plot in the chunk changes. Trees / cranes stay instanced.
  - tower styles from parts (podium + shaft + crown) chosen by plot seed and the era the tower was built in: art deco, international, brutalist, postmodern, contemporary (tapered/twisted, sheared crown), supertall (needle, mechanical bands), residential (balconies, staggered), twin towers with a skybridge on merged plots; lit crowns via an unlit "lamp" material.
  - redevelopment in the sim: an existing building is demolished first (1 month of rubble, old building shrinks), then the new one rises floor by floor inside a scaffold cage with a crane; a bigger building can absorb its row neighbour (plot merge). Lot fields demo / ntype / built / dens / sides / back are sent through the protocol.

## Stage A + B: profiles and city identity (done)
- Stage A: `src/sim/profiles.ts` holds `DistrictProfile` data (density, landUseMix, lotWidthRange, lotDepthRange, setbackRange, buildingHeightRange, frontageContinuity, roadRegularity, palette, era, yardChance, courtyardChance, growthRate, backRows). Plot generation, forms, palettes, yards, courtyards, street regularity, growth weights all read it. Each street varies its profile inside the ranges (per edge hash), each construction wave varies tower height.
- Stage B: `src/sim/cityprofile.ts` `CityProfile { terrain, origin, history layers, planningStrength, wealth, dominant, site, tradition, story }` drawn from the seed (seed 4821 is the original port city preset). Odd combinations are kept; coherence comes from layers:
  - terrain.ts: coast (sea + bay + river) / river (wide river, wharves) / hills (relief, steep woodland) / plain; every terrain has a river so a port can always have wharves. Origin sites: port (shore/wharf), market-town (radial town by the river), rail-junction (grid town beside a railway + yards), mining (miners' terraces on a hillside, pithead uphill, a mound is raised on flat land), planned-capital (open level site). Older villages follow the origin's character; history layers add a planned quarter (axis boulevard, rond-points, regular grid, civic hall + squares) and garden suburbs; the industrial layer is the redevelopment site (docks / rail yards / mine yard) flagged Flag.Docks.
  - town.ts: street skeletons per quarter style (organic, planned, terraces along contours, radial with ring street, rail grid); planningStrength shifts every profile's roadRegularity. profileAt picks the nearest quarter's core / mid / outer profile, downtown near stations / high value, site profile on the old industrial strip.
  - tradition (south terracotta / north slate / brick / whitewash / sand with flat roofs) swaps the old-fabric palettes; wealth scales heights and greenery; dominant types weight what gets built.
  - render: rail ribbons with sleepers, rond-point islands, rail yards (sheds, sidings with wagons, water tower), mine (headframe, engine house, ore bunkers, spoil heaps), civic hall with dome, grand boulevard fronts (mansards, plinth, cornice), river wharves.
  - events: the docks project is a site project (`requires.site`), its words come from `SITE_TEXT` (docks / rail yards / pithead); capital_quarter event for planned capitals. Start card shows the story and chips.
- Seed survey (`npm run seeds -- 84 <seeds>`, month 84, no metro): contact sheet `screenshots/seeds-grid.jpg` (captures grid-<seed>.png via `tsm.shot`).

| seed | terrain / origin / site | plan | wealth | pop | bld | continuous frontage | density core / mid / edge (plots per cell) |
|---|---|---|---|---|---|---|---|
| 4821 | coast / port / docks | .50 | .50 | 32.8k | 840 | 92% | 1.80 / .34 / .04 |
| 83 | coast / mining / mine | .75 | .33 | 33.9k | 1524 | 89% | 2.04 / .50 / .17 |
| 57 | river / market town / docks | .49 | .68 | 34.2k | 1197 | 89% | 1.87 / .52 / .04 |
| 187 | hills / rail junction / yards | .97 | .70 | 39.8k | 1686 | 84% | 1.60 / .82 / .14 |
| 304 | coast / planned capital / yards | .91 | .97 | 35.0k | 907 | 86% | 1.34 / .38 / .06 |
| 421 | plain / mining / mine | .92 | .45 | 31.6k | 1187 | 92% | 1.21 / .08 / .11 |
| 369 | hills / port / docks | .22 | .10 | 32.4k | 1031 | 92% | 1.81 / .39 / .03 |
| 252 | plain / market town / yards | .42 | .12 | 37.3k | 1262 | 93% | 1.41 / .36 / .13 |

## Plan: queued work (in order)
3. Signature landmarks tied to events (NEXT, not started): catalogue of unique hand-shaped landmarks (cathedral, city hall with clock tower, market hall, opera/concert hall, museum, university campus, hospital, stadium, arena, main library, TV/radio tower, signature skyscraper, expo hall, big covered terminal, ferris wheel, lighthouse, fort/castle on a hill, brewery/power-station chimney turned venue, big bridge). Civic, cultural, sport, industrial-heritage, commercial. Some exist from the start in the old town (cathedral, city hall, market hall). Footprints fit the street network, plaza/forecourt where it fits, night lighting (floodlights, lit crown). Gameplay: strong trip generator with its own pattern (stadium/arena event-day spikes, university weekday peaks, hospital steady all-day, museum weekends), raises nearby land value and pulls growth. Events (data-driven like the docks project): proposal with 2-3 site options or deals (city pays if service guaranteed within N months), served-by-transit-at-opening decides modal split else car park + car-locked trips, follow-ups (match-day crowd, festival, expo, protest if stop skipped), milestone unlocks. Landmark definitions, trip profiles and event JSON are data. Verify with day/night captures, an event dialog, and match-day ridership effect. All filtered by CityProfile.
4. Known follow-ups: steep-land parks need a seed with hills; plots keep the density tier they had when their street was created (no re-subdivision as value rises, only merging).

## Dev notes
- Run: `npm run dev` (http://127.0.0.1:5173), `npm run build`, `npm run headless -- <seed> <months> <deal> [--line] [--map]`.
- Dev-only page helpers on `window.tsm`: `ff(month, deal)` fast-forward, `demo(deal, lineMonth)` takes a docks deal and builds a test line, `view(x,y,dist,az,pol)`, `shot(name)` writes screenshots/<name>.png at canvas resolution through a Vite middleware, `phase(p)` time of day (0.86 = night), `city.gallery(x,z,styles)` tower style row.
- Keep a single JS call under ~40 s in the Browser pane (hidden pane throttles timers).
