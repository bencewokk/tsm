import * as THREE from 'three';
import { CELL, N } from '../sim/constants';
import type { Village } from '../sim/terrain';
import type { LotsMsg } from '../sim/protocol';

const CAUSE_TEXT: Record<string, string> = { hist: 'old village', rail: 'railway town', factory: 'factory town', commuter: 'garden suburb' };

/**
 * Map labels: the names of the old town and the other settlements (with what they are), drawn as paper tags that stand on the model.
 * They fade in as the camera pulls back and are always on in plan mode.
 */
export class Labels {
  group = new THREE.Group();
  private sprites: { s: THREE.Sprite; big: boolean; base: THREE.Vector3; cx: number; cy: number; lift: number }[] = [];
  private water: Uint8Array | null = null;
  private sample: (x: number, z: number) => number;
  /** dev switch (`tsm.labels.avoid = false`) for before / after captures */
  avoid = true;
  private v = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor(villages: Village[], site: string, docks: { x: number; y: number } | null, sample: (x: number, z: number) => number, water?: Uint8Array) {
    this.sample = sample;
    this.water = water ?? null;
    // round 7: the tags stand lower (they were lifted 260-420 m, so in an oblique view they floated over whatever lay behind the
    // settlement, often the water) and are anchored on the settlement's built land, see anchor()
    const add = (title: string, sub: string, x: number, y: number, big: boolean, lift: number) => {
      const s = this.make(title, sub, big);
      this.group.add(s);
      const e = { s, big, base: new THREE.Vector3(), cx: x, cy: y, lift };
      this.sprites.push(e);
      this.place(e, x, y);
    };
    for (const v of villages) {
      const sub = v.kind === 'origin' ? 'old town' : v.kind === 'planned' ? 'planned quarter' : v.kind === 'garden' ? 'garden suburb' : v.cause ? CAUSE_TEXT[v.cause] ?? '' : '';
      add(v.name, sub, v.x, v.y, v.kind === 'origin', v.kind === 'origin' ? 150 : 110);
    }
    if (docks) add(site === 'harbour' ? 'The Docks' : site === 'railyard' ? 'The Rail Yards' : 'The Pit', 'old industry', docks.x, docks.y, false, 80);
  }

  /** water cells under a label's footprint (its width and depth on the ground, cell units) centred at x, y */
  private wetUnder(x: number, y: number, big: boolean) {
    const W = this.water;
    if (!W) return 0;
    const hw = (big ? 600 : 470) / CELL / 2, hd = 2.2;
    let n = 0;
    for (let dy = -hd; dy <= hd; dy += 1) for (let dx = -hw; dx <= hw; dx += 1) {
      const cx = Math.floor(x + dx), cy = Math.floor(y + dy);
      if (cx < 0 || cy < 0 || cx >= N || cy >= N || W[cy * N + cx]) n++;
    }
    return n;
  }

  /** put a label at the dry spot nearest (x, y) whose footprint has the least water (none if there is such a spot within 8 cells) */
  private place(e: Labels['sprites'][number], x: number, y: number) {
    let bx = x, by = y, best = this.wetUnder(x, y, e.big) * 100;
    if (best > 0) for (let r = 1; r <= 8; r++) for (let k = 0; k < 8 * r; k++) {
      const a = (k / (8 * r)) * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      const score = this.wetUnder(px, py, e.big) * 100 + r;
      if (score < best) { best = score; bx = px; by = py; }
    }
    e.base.set((bx + 0.5) * CELL, this.sample((bx + 0.5) * CELL, (by + 0.5) * CELL) + e.lift, (by + 0.5) * CELL);
    e.s.position.copy(e.base);
  }

  /**
   * Anchor each label to the centroid of its settlement's built plots (within 9 cells of the original centre, the docks label within 6),
   * then move it to the nearest spot with no water under it. Called when the city changes (main.ts, once a year).
   */
  anchor(L: LotsMsg) {
    for (const e of this.sprites) {
      const R = e.lift === 80 ? 6 : 9;
      let sx = 0, sy = 0, n = 0;
      for (let k = 0; k < L.n; k++) {
        if (!L.type[k] || L.level[k] <= 0) continue;
        const dx = L.x[k] - e.cx, dy = L.y[k] - e.cy;
        if (dx * dx + dy * dy > R * R) continue;
        sx += L.x[k]; sy += L.y[k]; n++;
      }
      if (n >= 4) this.place(e, sx / n - 0.5, sy / n - 0.5); else this.place(e, e.cx, e.cy);
    }
  }

  private make(title: string, sub: string, big: boolean): THREE.Sprite {
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 150;
    const g = cv.getContext('2d')!;
    g.fillStyle = 'rgba(248,244,232,0.94)';
    g.beginPath(); g.roundRect(4, 8, 632, 132, 18); g.fill();
    g.strokeStyle = 'rgba(70,60,48,0.8)'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#2f2a24'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${big ? 58 : 50}px Georgia, 'Times New Roman', serif`;
    g.fillText(title, 320, sub ? 58 : 76);
    if (sub) { g.font = `italic 600 30px Georgia, serif`; g.fillStyle = '#6b6254'; g.fillText(sub, 320, 108); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0 }));
    sp.scale.set(big ? 600 : 470, big ? 140 : 110, 1);
    sp.renderOrder = 25;
    return sp;
  }

  /**
   * Fade with the camera distance; plan mode keeps them fully visible. With the camera given, tags do not overlap on screen:
   * they are placed in order (old town first, then the others as listed), a tag that would overlap one already placed is lifted
   * along the screen's up direction in steps, and if it still overlaps after three steps it is faded out for this frame.
   */
  update(dist: number, plan: boolean, night = 0, cam?: THREE.PerspectiveCamera, viewH = 900, tagsOn = false) {
    const t = plan ? 1 : THREE.MathUtils.smoothstep(dist, 2600, 4200);
    const placed: [number, number, number, number][] = [];
    if (cam && this.avoid) { cam.updateMatrixWorld(); this.up.setFromMatrixColumn(cam.matrixWorld, 1).normalize(); }
    const order = this.sprites.slice().sort((a, b) => Number(b.big) - Number(a.big));
    for (const { s, big, base } of order) {
      const m = s.material as THREE.SpriteMaterial;
      m.color.setScalar(1 - 0.72 * night);
      // with the paper tags pinned on the stations (diegetic layer) the district names stand back earlier, so the two never pile up
      let op = big ? Math.max(t, THREE.MathUtils.smoothstep(dist, tagsOn ? 2300 : 1800, tagsOn ? 3400 : 3000) * 0.9) : t;
      s.position.copy(base);
      if (cam && this.avoid && op > 0.02) {
        let ok = false;
        for (let step = 0; step < 4 && !ok; step++) {
          s.position.copy(base).addScaledVector(this.up, step * s.scale.y * 1.05);
          this.v.copy(s.position).project(cam);
          if (this.v.z > 1) { ok = true; break; }
          const depth = s.position.distanceTo(cam.position);
          const px = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * depth);
          const hw = (s.scale.x * px) / viewH, hh = (s.scale.y * px) / viewH;   // half extents in NDC units (y spans 2 = viewH)
          const r: [number, number, number, number] = [this.v.x - hw / cam.aspect, this.v.y - hh, this.v.x + hw / cam.aspect, this.v.y + hh];
          if (placed.every((q) => r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3])) { placed.push(r); ok = true; }
        }
        if (!ok) { s.position.copy(base); op = 0; }
      }
      m.opacity = op;
      s.visible = op > 0.02 || (big && !cam);
    }
  }
}
