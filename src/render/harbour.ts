import * as THREE from 'three';
import { N, CELL, Flag, Water } from '../sim/constants';
import { Layer, unitGeos } from './layers';
import { vhash } from './common';

const CONCRETE = 0xc6c3bb;

/**
 * Static harbour dressing around the old docks: quay walls along the water, piers, gantry cranes, moored ships,
 * and a couple of barges on the river. Built once from the terrain.
 */
export class Harbour {
  group = new THREE.Group();
  boxes: Layer;
  cyls: Layer;

  constructor(water: Uint8Array, flags: Uint8Array, sample: (x: number, z: number) => number, mat: THREE.Material) {
    const g = unitGeos();
    this.boxes = new Layer(g.box, mat, 2000);
    this.cyls = new Layer(g.cyl, mat, 100);
    this.group.add(this.boxes.mesh, this.cyls.mesh);
    const isSea = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && water[y * N + x] === Water.Sea;
    const docks = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && !water[y * N + x] && (flags[y * N + x] & Flag.Docks) !== 0;
    // quay edge: sea cells touching the docks become concrete wharf with a straight wall into the water
    const quay: { x: number; y: number; dx: number; dy: number }[] = [];
    let qh = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (!isSea(x, y)) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!docks(x + dx, y + dy)) continue;
          quay.push({ x, y, dx: -dx, dy: -dy });
          qh += sample((x + dx + 0.5) * CELL, (y + dy + 0.5) * CELL);
          break;
        }
      }
    if (!quay.length) { this.finish(); return; }
    qh = Math.max(3, qh / quay.length - 1);
    for (const q of quay) this.boxes.add((q.x + 0.5) * CELL, -10, (q.y + 0.5) * CELL, CELL + 0.5, qh + 10, CELL + 0.5, 0, CONCRETE);
    // bollard strip / quay edge line
    for (const q of quay) {
      const ex = (q.x + 0.5 + q.dx * 0.5) * CELL, ez = (q.y + 0.5 + q.dy * 0.5) * CELL;
      this.boxes.add(ex, qh, ez, q.dx ? 1.2 : CELL, 0.8, q.dx ? CELL : 1.2, 0, 0x8d8a84);
    }
    // piers: up to three, spaced apart, running straight out to sea
    const piers: typeof quay = [];
    const order = quay.slice().sort((a, b) => vhash(a.y * N + a.x, 5) - vhash(b.y * N + b.x, 5));
    for (const q of order) {
      if (piers.length >= 3) break;
      if (piers.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < 5)) continue;
      let len = 0;
      while (len < 3 && isSea(q.x + q.dx * (len + 1), q.y + q.dy * (len + 1)) && isSea(q.x + q.dx * (len + 1) + q.dy, q.y + q.dy * (len + 1) + q.dx)) len++;
      if (len < 2) continue;
      piers.push(q);
      const L = len * CELL - 10, ux = q.dx, uz = q.dy;
      const cx = (q.x + 0.5) * CELL + ux * (CELL / 2 + L / 2), cz = (q.y + 0.5) * CELL + uz * (CELL / 2 + L / 2);
      const rot = Math.atan2(-uz, ux);
      this.boxes.add(cx, -10, cz, L, qh + 10, 18, rot, CONCRETE);
      // containers stacked on the pier root
      for (let k = 0; k < 6; k++) {
        const t = -L / 2 + 10 + k * 13;
        if (t > L / 2 - 30) break;
        const st = 1 + Math.floor(vhash(q.x * 7 + k, q.y) * 3);
        for (let s = 0; s < st; s++) this.boxes.add(cx + ux * t + uz * -4, qh + s * 2.6, cz + uz * t + ux * -4, 12, 2.55, 2.4, rot, [0xb5533c, 0x3d6e9e, 0x4f8a5b, 0xd6a23a, 0x8a8f96][Math.floor(vhash(k * 13 + s, q.x + q.y) * 5)]);
      }
      // ship-to-shore gantry crane straddling the pier, boom out over the water
      const col = piers.length % 2 ? 0xd0643f : 0x3f6f9a;
      const gx = cx + ux * (L / 2 - 30), gz = cz + uz * (L / 2 - 30);
      for (const a of [-1, 1]) for (const b of [-1, 1]) {
        const px = gx + ux * a * 8 + uz * b * 8, pz = gz + uz * a * 8 + ux * b * 8;
        this.boxes.add(px, qh, pz, 2, 30, 2, 0, col);
      }
      this.boxes.add(gx, qh + 30, gz, 20, 3, 20, rot, col);
      this.boxes.add(gx + uz * 24, qh + 34, gz + ux * 24, 3, 2.4, 80, rot, col); // boom across the berth
      this.boxes.add(gx, qh + 33, gz, 8, 5, 8, rot, 0xe5e2dc);
      // a ship moored alongside
      const side = 9 + 4 + 10;
      const sx = cx + uz * side + ux * 6, sz = cz + ux * side + uz * 6;
      if (isSea(Math.floor(sx / CELL), Math.floor(sz / CELL))) {
        const hull = [0x34495e, 0x7a3b2e, 0x2f5a52][piers.length % 3];
        const SL = Math.min(110, L + 10);
        this.boxes.add(sx, -4, sz, SL, 9, 20, rot, hull);
        this.boxes.add(sx, 5, sz, SL - 4, 0.6, 19, rot, 0xcfc9bd);
        for (let k = 0; k < 4; k++) {
          const t = -SL / 2 + 14 + k * 17;
          this.boxes.add(sx + ux * t, 5.6, sz + uz * t, 15, 2.6 + (k % 2) * 2.6, 16, rot, [0xb5533c, 0x3d6e9e, 0x4f8a5b, 0xd6a23a][(k + piers.length) % 4]);
        }
        const bt = SL / 2 - 9;
        this.boxes.add(sx + ux * bt, 5.6, sz + uz * bt, 11, 12, 16, rot, 0xf1efea);
        this.cyls.add(sx + ux * (bt - 2), 17.6, sz + uz * (bt - 2), 3.5, 6, 3.5, 0, hull);
      }
    }
    // barges on the river
    const river: number[] = [];
    for (let i = 0; i < N * N; i++) if (water[i] === Water.River) river.push(i);
    river.sort((a, b) => a - b);
    for (const f of [0.35, 0.62]) {
      const i = river[Math.floor(river.length * f)];
      if (i === undefined) continue;
      const x = i % N, y = (i / N) | 0;
      const row = (yy: number) => { let s = 0, c = 0; for (let xx = 0; xx < N; xx++) if (water[yy * N + xx] === Water.River) { s += xx; c++; } return c ? s / c : x; };
      const cxr = row(y), dxr = row(Math.min(N - 1, y + 3)) - row(Math.max(0, y - 3));
      const rot = Math.atan2(-6, dxr);
      const bx = (cxr + 0.5) * CELL, bz = (y + 0.5) * CELL;
      this.boxes.add(bx, -1.5, bz, 60, 3.5, 10, rot, 0x4a4f55);
      this.boxes.add(bx, 2, bz, 40, 1.8, 7, rot, 0x9a8c74);
      this.boxes.add(bx + Math.cos(rot) * 24, 2, bz - Math.sin(rot) * 24, 6, 4, 8, rot, 0xefece6);
    }
    this.finish();
  }

  private finish() { this.boxes.finish(); this.cyls.finish(); }
}
