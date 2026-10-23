/** 2D geometry helpers. All coordinates are in cell units (1 = 50 m), floats. */

export function segIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): { t: number; u: number } | null {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

export function pointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number; x: number; y: number } {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + vx * t, y = ay + vy * t;
  return { d: Math.hypot(px - x, py - y), t, x, y };
}

/** Smallest absolute difference between two angles, in [0, PI]. */
export function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Undirected line angle difference in [0, PI/2]. */
export function lineDiff(a: number, b: number): number {
  const d = angDiff(a, b);
  return Math.min(d, Math.PI - d);
}

/** Oriented rectangle corners: centre, angle, half-width along `ang`, half-depth across. */
export function rectCorners(x: number, y: number, ang: number, hw: number, hd: number): number[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  const ux = c * hw, uy = s * hw, vx = -s * hd, vy = c * hd;
  return [x + ux + vx, y + uy + vy, x - ux + vx, y - uy + vy, x - ux - vx, y - uy - vy, x + ux - vx, y + uy - vy];
}

/** Separating-axis test between two convex quads (8-number corner arrays). */
export function quadsOverlap(a: number[], b: number[]): boolean {
  for (const poly of [a, b]) {
    for (let k = 0; k < 4; k++) {
      const x1 = poly[k * 2], y1 = poly[k * 2 + 1];
      const x2 = poly[((k + 1) % 4) * 2], y2 = poly[((k + 1) % 4) * 2 + 1];
      const nx = y1 - y2, ny = x2 - x1;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let j = 0; j < 4; j++) {
        const pa = a[j * 2] * nx + a[j * 2 + 1] * ny; amin = Math.min(amin, pa); amax = Math.max(amax, pa);
        const pb = b[j * 2] * nx + b[j * 2 + 1] * ny; bmin = Math.min(bmin, pb); bmax = Math.max(bmax, pb);
      }
      if (amax <= bmin + 1e-6 || bmax <= amin + 1e-6) return false;
    }
  }
  return true;
}

/** Ramer-Douglas-Peucker polyline simplification. */
export function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = pointSeg(pts[k][0], pts[k][1], pts[i][0], pts[i][1], pts[j][0], pts[j][1]).d;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Chaikin corner cutting (keeps the endpoints). */
export function chaikin(pts: [number, number][], iters = 2): [number, number][] {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) return p;
    const out: [number, number][] = [p[0]];
    for (let k = 0; k < p.length - 1; k++) {
      const [ax, ay] = p[k], [bx, by] = p[k + 1];
      if (k > 0) out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      if (k < p.length - 2) out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}
