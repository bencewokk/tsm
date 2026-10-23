# Progress

- M1 Terrain + town: done. Seeded heightmap, river into a bay, 2-3 villages with roads, Three.js render with orbit camera.
- M2 Growth sim: done. Monthly tick in a worker, land value (car access + amenities - industry - centre distance), spawn/upgrade/decline, R/C/I demand pools with pressure, road growth, congestion.
- M3 Metro: done. Plan mode (P): click to dig stations, click stations in order, Enter builds; coloured lines, animated trains; station access + walkable premium make towers rise near stations.
- M4 Riders + money: done. Gravity trips between 8x8 zones, logistic car/transit choice, line loads, crowding rating, fares vs running/upkeep/build costs (3x under water).
- M5 Docks project: done. Events as data (src/sim/events.ts); docks bought at month 14 with three deals; ghost plan buildings tinted by service; district builds only within 600 m of a station; late blocks car-locked for good; follow-up event 26 months later refers to the deal. Next: look (night, x-ray, heatmap, desire lines, tilt-shift).
