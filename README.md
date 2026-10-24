# tsm

A browser transit tycoon, no ads. Build metro lines, watch accessibility turn into land value, and watch a procedurally generated city (planar road graph, frontage plots, an architect's-model look) grow around your stations over the months. The simulation runs in a Web Worker; rendering is Three.js.

## Run

```
npm install
npm run dev
```

Open http://127.0.0.1:5173/?seed=4821 (IPv4 address; `seed=4821` is the reference port-city seed, any other seed gives a different city).

`npm run build` makes a production build, `npx tsc --noEmit` type-checks.

## Controls

- Space pause; 1/2/3 speed (1x / 3x / 10x).
- P plan mode, V back to view. In plan mode: click stations in order, Enter builds the line, Backspace undoes, Esc cancels.
- WASD or arrow keys pan (Shift faster). Middle-drag orbits, wheel zooms, left-drag orbits, right-drag pans.
- Toggles: H heatmap, X x-ray, Z zones, N night, L desire lines.
- Quality button in the HUD (Auto / High / Performance; also `?quality=auto|high|performance`, `?perf=1` for the overlay).
- The left HUD panel lists running development projects and landmarks (click a row to fly there); project decisions open as City hall dialogs.

## More

- [HANDOVER.md](HANDOVER.md): current state, scripts, dev flags, code map.
- [PROGRESS.md](PROGRESS.md): round-by-round log of what was built.
