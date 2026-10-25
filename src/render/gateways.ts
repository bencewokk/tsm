import * as THREE from 'three';
import { CELL } from '../sim/constants';

type GW = { id: string; x: number; y: number; ang: number };

/**
 * Gateways (round 7, step 9), drawn as abstract architect's-model pieces in the same card and paint as the city (no aircraft or ships
 * moving): an intercity hall along the railway, a motorway junction ring, a ferry pier with a moored boat, an airport runway and terminal.
 */
export class GatewayView {
  group = new THREE.Group();
  private sig = '';
  constructor(private ground: (x: number, z: number) => number) {}

  private box(w: number, h: number, d: number, color: number, x: number, z: number, ang: number, lift = 0, along = 0, side = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const px = x + ca * along - sa * side, pz = z + sa * along + ca * side;
    m.position.set(px, Math.max(0.4, this.ground(px, pz)) + h / 2 + lift, pz);
    m.rotation.y = -ang;
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  update(list: GW[]) {
    const sig = JSON.stringify(list.map((g) => [g.id, Math.round(g.x * 10), Math.round(g.y * 10)]));
    if (sig === this.sig) return;
    this.sig = sig;
    this.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    this.group.clear();
    for (const g of list) {
      const x = g.x * CELL, z = g.y * CELL, a = g.ang;
      if (g.id === 'intercity') {
        // a long train hall over the tracks, a glass roof, a forecourt
        this.group.add(this.box(170, 16, 42, 0xd8d2c4, x, z, a));
        this.group.add(this.box(176, 3, 46, 0x9fb7c4, x, z, a, 16));
        this.group.add(this.box(60, 1, 30, 0xcfc8b8, x, z, a, 0, 0, 40));
      } else if (g.id === 'airport') {
        // runway (550 m), its centre line, a terminal and an apron beside it, a control tower
        this.group.add(this.box(550, 0.6, 45, 0x5d6166, x, z, a));
        for (let s = -240; s <= 240; s += 40) this.group.add(this.box(18, 0.2, 1.6, 0xf2f2ee, x, z, a, 0.6, s));
        this.group.add(this.box(160, 18, 46, 0xe3ddd0, x, z, a, 0, 0, 95));
        this.group.add(this.box(220, 0.5, 60, 0x8a8e93, x, z, a, 0, 0, 52));
        this.group.add(this.box(10, 40, 10, 0xd7d0c0, x, z, a, 0, 110, 95));
      } else if (g.id === 'ferry') {
        // a pier out into the water and a moored ferry
        this.group.add(this.box(130, 3, 14, 0xb9a98c, x, z, a, 0, 65));
        this.group.add(this.box(62, 9, 16, 0xf4f1ea, x, z, a, 3, 110, 16));
        this.group.add(this.box(30, 8, 22, 0xd9d2c2, x, z, a));
      } else if (g.id === 'motorway') {
        // a junction: a ring of carriageway and the motorway running out to the map edge
        const ring = new THREE.Mesh(new THREE.TorusGeometry(70, 7, 6, 32), new THREE.MeshStandardMaterial({ color: 0x6b6f74, roughness: 0.9 }));
        ring.rotation.x = Math.PI / 2;
        ring.scale.z = 0.12;
        ring.position.set(x, Math.max(0.4, this.ground(x, z)) + 1.2, z);
        this.group.add(ring);
        this.group.add(this.box(260, 1, 26, 0x6b6f74, x, z, a + Math.PI, 0.4, 130));
      }
    }
  }
}
