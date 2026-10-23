import * as THREE from 'three';
import { CELL } from '../sim/constants';
import type { Village } from '../sim/terrain';

const CAUSE_TEXT: Record<string, string> = { hist: 'old village', rail: 'railway town', factory: 'factory town', commuter: 'garden suburb' };

/**
 * Map labels: the names of the old town and the other settlements (with what they are), drawn as paper tags that stand on the model.
 * They fade in as the camera pulls back and are always on in plan mode.
 */
export class Labels {
  group = new THREE.Group();
  private sprites: { s: THREE.Sprite; big: boolean }[] = [];

  constructor(villages: Village[], site: string, docks: { x: number; y: number } | null, sample: (x: number, z: number) => number) {
    const add = (title: string, sub: string, x: number, y: number, big: boolean, lift: number) => {
      const s = this.make(title, sub, big);
      s.position.set((x + 0.5) * CELL, sample((x + 0.5) * CELL, (y + 0.5) * CELL) + lift, (y + 0.5) * CELL);
      this.group.add(s);
      this.sprites.push({ s, big });
    };
    for (const v of villages) {
      const sub = v.kind === 'origin' ? 'old town' : v.kind === 'planned' ? 'planned quarter' : v.kind === 'garden' ? 'garden suburb' : v.cause ? CAUSE_TEXT[v.cause] ?? '' : '';
      add(v.name, sub, v.x, v.y, v.kind === 'origin', v.kind === 'origin' ? 420 : 260);
    }
    if (docks) add(site === 'harbour' ? 'The Docks' : site === 'railyard' ? 'The Rail Yards' : 'The Pit', 'old industry', docks.x - 2, docks.y + 3, false, 130);
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

  /** Fade with the camera distance; plan mode keeps them fully visible. */
  update(dist: number, plan: boolean, night = 0) {
    const t = plan ? 1 : THREE.MathUtils.smoothstep(dist, 2600, 4200);
    for (const { s, big } of this.sprites) { (s.material as THREE.SpriteMaterial).color.setScalar(1 - 0.72 * night); (s.material as THREE.SpriteMaterial).opacity = big ? Math.max(t, THREE.MathUtils.smoothstep(dist, 1800, 3000) * 0.9) : t; s.visible = t > 0.02 || big; }
  }
}
