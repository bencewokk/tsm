# DESIGN-FUN: making the first ten minutes feel good

Branch `worktree-agent-a884a845a686b0163`. Numbers come from `npm run fun` (`scripts/fun.ts`; output in `docs/metrics/fun-before.txt` and `fun-after.txt`, 8 seeds, a three-station starter line built at month 3, 60 months, same seed with and without the line as a control; the sim is deterministic so the control is exact up to RNG drift). The browser session was seed 4821 at 1500x900.

Time scale: 1x = 1.5 s per month, so a year is 18 s, five years 90 s, the whole 20-year game about 6 minutes at 1x. "+6 months" is nine seconds of watching.

## 1. Diagnosis, ranked by how much it hurt

1. **No goal, no scoreboard, no "what next".** The start card said "Build the metro, grow the city." After that nothing: the left panel is statistics, the only prompts were decision dialogs from the project engine (8-12 in five years, the first at month 5-14, before most players have found the Plan button) and a ticker line. There was no reward for a first line, no sense of progress, no signal for what to build second. (Measured: zero objectives, zero rewards, zero unlocks in the code; `HANDOVER` even lists "no rating milestones" as a known gap.)
2. **The clock ran while the player worked out the controls.** Begin started 1x. Planning a three-station line takes a new player 45-90 s, which is 30-60 months: the city grows from 4.6k to 11k+ people and one or two decision dialogs (-22M, -35M at "pick the first option") arrive before the first station exists. Plan mode did not pause. In the browser the sim was at month 13 after about 20 s of reading the page.
3. **Slow, silent payoff after a line opens.** For eight seeds (starter line at month 3): first extra construction round the stations +1 to +16 months (mean 8.5, = 13 s), catchment homes+jobs 10% above the control city +5 to +20 months (mean 13.6, = 20 s), first 36 m tower +13 to +24 months (mean 17.9). In the first 12-24 months the catchment actually dipped on several seeds (demolition and re-subdivision before the new buildings: 4821 6405 -> 5707 -> 5225 homes+jobs at months 12/18/24). Nothing on screen said "this is working": the only feedback was a ticker line and cranes you had to find.
4. **Money is not a constraint, so decisions have no weight.** Money after the first line sits at 100-190M for five years (mean 105 / 106 / 112 / 126 / 137M at months 6 / 12 / 24 / 36 / 60). The line costs 36-42M (82M on seed 83) and earns 0.05-0.35M a month for the first two years (mean 0.16M at month 12: a 22-year payback), 0.87M a month at year five. Income is not the reward; growth is. A second and third line are affordable from day one.
5. **The empty-plot problem is a demand-pool problem.** 39-48% of plots within an 8-minute walk of the new stations were still vacant at months 12-24 (23% at month 60; seed 421 still 54%). They are not low value (median land value 0.57-0.71): the city-wide demand pool sits at its floor (`resPool` about -3 months of growth) because towers and projects borrow against it, and ordinary starts need a positive pool.
6. **Towers lag by 13-24 months after opening.** Tower assembly is a deliberate visible pipeline (acquire, hoarding, demolish, clear, foundations, structure: 12-16 months for a 60 m tower). The first 60 m tower (goal `tower_60`) came at +34 months on 4821.
7. **Planning friction.** Stations are paid for on click, and Esc / Backspace did not give the money back (a cancelled draft burned 5M a station); the preview did not show what was already spent; a click 2.6-3.0 cells from a station neither snapped nor dug (the sim refuses stations closer than 3 cells), leaving a stuck placeholder; the plan view started where the player stood, with the target village often off screen.
8. **No beats.** No ribbon-cutting, no headline, no sound, no visible fares. The first line opening and the 20th looked the same.
9. **Rating and crowding are invisible stakes.** A crowded line lowers its rating and lengthens trips (that is in the route choice), but nothing says so until the number on the right panel changes. The car is a trip share in a stat box.

"The demo first line cost $181M against $135M" turned out to be a test helper artifact: the browser `tsm.demo()` chain is 129-497M. The route a player would build first (old town to the nearest village, three stations) costs **36-42M on 7 of 8 seeds and 82M on seed 83**, always affordable from the 150M start. The unaffordable demo line is not the player's problem; the lack of a signal that a small line is the right start is.

### What a first ten minutes looked like (before)

| time | what the player sees |
|---|---|
| 0 s | start card, Begin |
| 0-60 s | clock running, nothing to do, first decision dialog at month 9-14 (13-21 s) |
| ~60 s | first line built; ticker: "Line 1 opened" |
| +9 to +24 s | first new construction near the stations, nothing says it is because of the line |
| +20 to +36 s | 10% more people and jobs round the stations |
| +25 to +35 s | first 36 m tower |
| always | no objective, no reward, no sound |

## 2. What was built

Everything gameplay-side is deterministic (no RNG; goals read sim numbers). UI-only effects use `Math.random` freely.

### 2.1 Station boom: cranes in 1-3 months (sim, `sim.ts`)
Stations remember when they opened (`Station.opened`). For 30 months a young station gives its walk catchment: a ranking bonus (new buildings go there first), a lower spawn / upgrade land-value threshold, upgrades after 3 months instead of 8-10, a higher per-zone start cap, and its **own small demand pools** (40 homes + 46 jobs a month, scaled by how busy the station is, saved up to six months) that only plots in that catchment can spend when the city-wide pool is dry. Anchor towers do not use the boom pool and the density field's height cap is untouched (verified: with no metro the tallest building stays 24 m through month 96; `npm run towers`). Tower crews work a quarter faster in a boom catchment and sellers are keener (+0.2 acquisition chance); that shaved only about a month, towers remain the slowest payoff. Switch: `BOOM.on` / `?noboom=1`.

| (8 seeds, line at month 3) | before | after |
|---|---|---|
| first extra construction round the stations | +1..+16 mo, mean 8.5 | **+1..+3 mo, mean 1.75** |
| catchment homes+jobs 10% above control | +5..+20 mo, mean 13.6 | **+4..+7 mo, mean 5.75** |
| first 36 m+ tower | +13..+24, mean 17.9 | +13..+22, mean 17.4 (not fixed) |
| catchment homes+jobs at month 24, line / control | mean 5.7k / 4.7k (the catchment dipped between months 12 and 24 on 4821, 187 and 369) | mean 9.5k / 4.7k |
| vacant share of catchment plots, month 12 / 24 / 36 / 60 | 44 / 48 / 39 / 23 % | **39 / 39 / 30 / 21 %** |
| trips a day, month 24 | mean 1.9k | mean 3.2k |
| long run (4821, one 3-station line, month 240) | pop 99.7k | pop 98.1k (it accelerates, it does not inflate: same ceiling) |

Screenshots: `screenshots/fun-boom-close-m7-4821.jpg`, `-m12-`, `-m24-` (left: before, right: after; same camera, line opened at month 3).

### 2.2 First ten minutes (`main.ts`, `planner.ts`, `worker.ts`, goals)
- The clock now **waits after Begin** until the first line opens (or the player presses 1): "The clock is stopped until your first line opens. Press P to plan it". The worker no longer ticks one or two months while the page loads.
- **Plan mode pauses the clock** and restores the speed on leaving. On the first line the plan camera frames both ends of the first goal, and a gold ring and beam mark the unconnected village (`GoalMarker`). The Plan button pulses until a line exists.
- **Undo and refund:** Backspace and Esc (and leaving plan mode) give the full price back for stations dug in this planning session (`removeStation` with `full`); the preview shows "+$15.0M already paid for new stations; Backspace / Esc refunds them, you have $135.0M". Digging with too little money says so; a click up to 3.05 cells from a station snaps to it.
- Building a line **leaves plan mode, starts a held clock and flies out over the new line**.
- First line is affordable on every seed (36-82M of 150M); the first goal's $20M grant pays about half of it back a month later.

### 2.3 Goals with rewards (`sim/goals.ts`, three tracks, one active goal per track)
Network: connect the old town and its nearest village ($20M), 4 stations ($10M), a second line ($20M), an interchange ($25M + signalling, lines run 20% faster), 12 stations, 3 lines, 25 stations. Ridership: 1.5k / 5k / 12k (+ automatic train control: trains hold 25% more) / 30k / 60k trips a day. City: 12k residents, a 60 m tower by a station, 15% of trips won from the car, 25k, rating above 75 for 6 months, 30%, 50k, 45%, 80k, 120k. 22 goals; grants are $5-60M (network grants are the biggest because they should fund expansion). Goals completed in the first 60 months on the starter line: 5-9 (first at month 4 on every seed). Headline moments (goals included): 11-17 in five years, one every 3.5-5.5 months (5-8 s at 1x), against 8-12 decision dialogs before.

### 2.4 Beats (`sim` moments + presenters)
Newspaper card with a ribbon that gets cut when a line opens (`The Tidewater Times`, "987 homes and 4,111 jobs now lie within an 8-minute walk"), a gold confetti card for a goal, toasts for "Cranes at Chapel", "A 62 m tower tops out by Chapel", "Line 1: first riders", "Line 1 is overcrowded" (with what to do), an opening **ripple** along the new walk catchment (the ring travels at walking speed over the streets that gained access), **coin pops** ("+$89k") over every busy station each month, a "Metro vs car" bar in the top bar, WebAudio blips (dig, undo, open, goal, cranes, tower, warn, coin; mute button, remembered).
**Auto** speed button (key 4): 3x while nothing needs you, 1x for a decision or a headline.

Screenshots (seed 4821, `screenshots/`): `fun-boom-close-m{7,12,24}-4821.jpg` (before | after station boom), `fun-ribbon-cutting-4821.jpg` (newspaper card, ripple wash, goals panel after the first line), `fun-plan-first-goal-4821.jpg` (plan view framing the first goal, gold marker, "time is paused" hint), `fun-goals-hud-m30-4821.jpg` (goals list, Metro vs car bar, toasts; the card/toast overlap seen there was fixed by moving the card lower).

## 3. UI event contract (for the visual-pass branch)

All gameplay feedback goes through `src/ui/gameEvents.ts` (pure data, a tiny bus: `gameEvents.on(kind, fn)`, `onAny`). Producers: `src/ui/feedbackEmitter.ts` (from consecutive sim snapshots, no DOM), `src/ui/planner.ts` (plan events), `main.ts` (`clock`). Consumers (all replaceable): `src/ui/feedback.ts` (placeholder DOM: goals list, toasts, newspaper card, coin pops, plan-button pulse), `src/ui/sound.ts` (`bindSound`), and the small world layer in `main.ts` (ripple, goal marker, camera fly). Sim data behind them: `StateMsg.goals / goalsDone / goalsTotal / moments / unlocks`, `StationInfo.opened`. Every event except the plan ones carries `month`.

| event | payload | when |
|---|---|---|
| `stationOpened` | `stationId, name, x, y, lineId, color, catchmentBefore: Uint8Array \| null, catchmentAfter: Uint8Array` (walk minutes x10, N x N, 255 = out of reach; lower after = access gained) | a station came into service (one per station) |
| `lineOpened` | `lineId, color, moment` (title, text, centre x/y of the line, `ref` = line id) | a line was built (ribbon cutting) |
| `moment` | `moment: { seq, month, kind: 'open'\|'growth'\|'tower'\|'goal'\|'crowd'\|'riders'\|'milestone'\|'news', title, text, color, x, y, big, ref }` | any beat; `big` = headline sized, else toast |
| `objectives` | `goals: GoalInfo[]` (id, track, title, text, cur, target, unit, reward, x?, y?, frame?), `done, total, hasLines` | any objective number moved |
| `objectiveReached` | `moment` (kind `goal`, `ref` = goal id), `unlocks: string[]` ('signals', 'atc') | a goal was reached |
| `fare` | `stationId, x, y, amount` ($ for the month), `riders` (trips a day) | each month, up to 10 busiest stations (every 3rd month at 10x) |
| `crowding` | `lines: { id, color, load, rating }[]` (load = peak load / capacity) | a line's load bucket (10%) or rating bucket changed |
| `planCost` | `draftStations, km, cost, paidForStations, money, affordable, notice, trains` | every plan-mode refresh |
| `stationDug` | `x, y, cost` | a station was dug while planning |
| `undo` | `stationIds, refund` | draft stations given back (Backspace / Esc / leaving plan mode) |
| `clock` | `mode: 'held'\|'planning'\|'paused'\|'running', speed, auto` | the clock mode changed |

Commands added: `removeStation { id, full? }` (full refund). The HUD layout is untouched apart from a goals block at the top of the left panel, a toast / headline / coin-pop layer, Auto and Sound buttons and a bar under "Metro vs car"; all of it lives in `feedback.ts` and the CSS block at the end of `style.css`.

## 4. Proposals not done (cuts and changes for the user to decide)

- **Money still does not bind.** After the first line the player has 100M+ and goals pay more. Proposal: start at 100M and let the first goals pay for line two; or cut event "city pays" options (hospital -38M with the first choice). Not changed because it moves every project's balance.
- **Pick-the-first-option events cost cash** (-22M at month 12, -35M at month 14 on 4821): the "decision" dialogs are mostly a bill. Proposal: make the first docks and land events wait until a line exists.
- **Tower pipeline** is the slowest payoff (+13 to +22 months). Proposal: let the first tower in a boom catchment skip the holdout phase, or show the assembly hoardings and cranes in the goal panel ("Tower rising at Chapel, 7 months").
- **Vacant plots** still 20-50% of the catchment on plain seeds (421, 252). They read as fenced gardens, but a density bonus for fenced plots next to a station ("land bank" sold to developers) would finish the job.
- **Cut candidate:** the `Zones` and `Land value` toggles duplicate what the ripple and desire lines now say; keep for experts, but not on the first-run toolbar.
- Rating could gate the boom (a packed line stops attracting growth); left out to keep this pass free of new failure states.

## 5. Honest take

It is now readable and it pays back quickly: a new player knows what to do (the gold goal), does it in a few clicks without the city running away, and gets a ribbon, a $20M grant, a ripple, cranes within seconds and a second and third goal pointing onward. The loop "build -> visible growth -> reward -> next goal" now closes in about 10 seconds at 1x instead of never.

Where it still drags: (1) money is not a constraint, so the choice of *where* to build second has no cost beyond the goal pointing there; (2) towers, the best visual payoff, still take 20-30 s; (3) years 3-6 are a ladder of numbers (pop, riders) that complete themselves without a decision unless the player extends the network, since riders and population grow on their own; the network track is where the player has to act; (4) goals are text and a bar: there is no authored "district opens" moment yet; (5) I could only measure the feel in a throttled, partly hidden browser pane (timers and animation frames pause), so the animation timings (card 7.5 s, ripple 3.4 s, coins 1.9 s) were set by reading the code, not by watching them at 60 fps.
