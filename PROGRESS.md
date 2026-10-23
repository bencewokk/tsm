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

## Plan: queued work (in order)
1. Stage A (profiles, folded into the building work): every district parameter goes through a `DistrictProfile`
   `{ density, landUseMix, lotWidthRange, lotDepthRange, setbackRange, buildingHeightRange, frontageContinuity, roadRegularity, palette, era, yardChance, courtyardChance, growthRate }`.
   Current port city = one set of profiles (old town, docks, suburbs, downtown, industry, ...) and must look the same as before; each district picks a profile and varies it slightly per street and per construction wave.
2. Stage B (own commits, BEFORE landmarks): `CityProfile` from the seed
   `{ terrain: coast|river|hills|plain, origin: port|rail-junction|market-town|mining|planned-capital, history: [era layers], planningStrength, wealth, dominantBuildingTypes }`.
   - Odd combinations are allowed ("coastal mining town that is a planned capital"); coherence comes from history layers: the origin forms the first core, each later era adds a layer on top with its own district profiles, location and street pattern. Hard limits are only physical (port needs water, mine needs hills/ore): move the feature (mine inland, port ships its ore) instead of dropping it.
   - planningStrength -> per-district roadRegularity: planned quarters get straight regular streets, boulevards, axes, rond-points through the existing per-neighbourhood street direction; organic quarters stay irregular. No global grid.
   - generic fabric rules: clusters along connected frontage; density follows accessibility; type follows district land use; height follows land value / centrality / stations; neighbours share era + palette but vary width/depth/height/setback; growth favours existing fabric and reachable stations, infill before edge sprawl; barriers create edges (waterfront industry, warehouses along rail, terraces on hillsides, green wedges, commercial at bridgeheads).
   - anchors: original settlement, a market/centre, an industrial/logistics area, transit-led centres (per history layer for odd combinations).
   - events + landmarks filtered by profile (docks project needs water; equivalents: pithead/mine redevelopment, rail-yard redevelopment, planned-capital government quarter), data-driven.
   - start screen shows the story in a line or two ("A coastal mining town, remade as a planned capital in the early transit age.").
   - check: ~8 seeds headless + side-by-side grid of full-resolution overview captures; cities must look clearly different, strengthen or cut axes that change nothing; record per-seed stats (population, density gradient, share of continuous frontage) in this file.
3. Signature landmarks tied to events (after Stage B): catalogue of unique hand-shaped landmarks (cathedral, city hall with clock tower, market hall, opera/concert hall, museum, university campus, hospital, stadium, arena, main library, TV/radio tower, signature skyscraper, expo hall, big covered terminal, ferris wheel, lighthouse, fort/castle on a hill, brewery/power-station chimney turned venue, big bridge). Civic, cultural, sport, industrial-heritage, commercial. Some exist from the start in the old town (cathedral, city hall, market hall). Footprints fit the street network, plaza/forecourt where it fits, night lighting (floodlights, lit crown). Gameplay: strong trip generator with its own pattern (stadium/arena event-day spikes, university weekday peaks, hospital steady all-day, museum weekends), raises nearby land value and pulls growth. Events (data-driven like the docks project): proposal with 2-3 site options or deals (city pays if service guaranteed within N months), served-by-transit-at-opening decides modal split else car park + car-locked trips, follow-ups (match-day crowd, festival, expo, protest if stop skipped), milestone unlocks. Landmark definitions, trip profiles and event JSON are data. Verify with day/night captures, an event dialog, and match-day ridership effect. All filtered by CityProfile.
4. Known follow-ups: steep-land parks need a seed with hills; plots keep the density tier they had when their street was created (no re-subdivision as value rises, only merging).

## Dev notes
- Run: `npm run dev` (http://127.0.0.1:5173), `npm run build`, `npm run headless -- <seed> <months> <deal> [--line] [--map]`.
- Dev-only page helpers on `window.tsm`: `ff(month, deal)` fast-forward, `demo(deal, lineMonth)` takes a docks deal and builds a test line, `view(x,y,dist,az,pol)`, `shot(name)` writes screenshots/<name>.png at canvas resolution through a Vite middleware, `phase(p)` time of day (0.86 = night), `city.gallery(x,z,styles)` tower style row.
- Keep a single JS call under ~40 s in the Browser pane (hidden pane throttles timers).
