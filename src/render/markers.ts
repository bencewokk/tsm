import * as THREE from 'three';
import { CELL } from '../sim/constants';
import type { ProjectInfo } from '../sim/projects';

/**
 * Site markers for live development projects (projects.ts): a slim post with a disc in the project type's colour, standing over the site,
 * so several simultaneous assemblies can be told apart on the map. A proposal still awaiting a decision has a ring round the post's foot;
 * a site whose service promise is open shows a second, smaller disc (the deadline), a car-first site a dark disc.
 */
export class ProjectMarkers {
  group = new THREE.Group();
  private sig = '';
  private postGeo = new THREE.CylinderGeometry(1.6, 1.6, 1, 6);
  private headGeo = new THREE.CylinderGeometry(13, 13, 3, 20);
  private ringGeo = new THREE.TorusGeometry(26, 2.2, 6, 28);
  private mats = new Map<string, THREE.MeshBasicMaterial>();

  constructor(private sample: (x: number, z: number) => number) {
    this.group.name = 'project-markers';
  }

  private mat(c: string) {
    let m = this.mats.get(c);
    if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c) }); this.mats.set(c, m); }
    return m;
  }

  update(list: ProjectInfo[]) {
    const live = list.filter((p) => p.status === 'proposed' || p.status === 'assembling' || p.status === 'building');
    const sig = JSON.stringify(live.map((p) => [p.id, p.status, p.promise, p.carLock]));
    if (sig === this.sig) return;
    this.sig = sig;
    for (const c of this.group.children.slice()) this.group.remove(c);
    for (const p of live) {
      const x = p.x * CELL, z = p.y * CELL, y = this.sample(x, z);
      const H = 95;
      const post = new THREE.Mesh(this.postGeo, this.mat('#4a4a4a'));
      post.scale.y = H; post.position.set(x, y + H / 2, z);
      const head = new THREE.Mesh(this.headGeo, this.mat(p.color));
      head.position.set(x, y + H, z);
      this.group.add(post, head);
      if (p.promise === 'open' || p.carLock) {
        const tag = new THREE.Mesh(this.headGeo, this.mat(p.carLock ? '#3b3b3b' : '#ffffff'));
        tag.scale.set(0.55, 1, 0.55); tag.position.set(x, y + H - 9, z);
        this.group.add(tag);
      }
      if (p.status === 'proposed') {
        const ring = new THREE.Mesh(this.ringGeo, this.mat(p.color));
        ring.rotation.x = Math.PI / 2; ring.position.set(x, y + 3, z);
        this.group.add(ring);
      }
    }
  }
}
