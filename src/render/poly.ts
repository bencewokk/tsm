import * as THREE from 'three';

export type Pt = [number, number];
export type Mat = 'wall' | 'glass' | 'plain' | 'ghost' | 'lamp';

/** Quad plot in world metres (x, z): F0-F1 is the street front, B0-B1 the rear. */
export class Quad {
  F0: Pt; F1: Pt; B1: Pt; B0: Pt;
  W: number; D: number;
  constructor(F0: Pt, F1: Pt, B1: Pt, B0: Pt) {
    this.F0 = F0; this.F1 = F1; this.B1 = B1; this.B0 = B0;
    this.W = (Math.hypot(F1[0] - F0[0], F1[1] - F0[1]) + Math.hypot(B1[0] - B0[0], B1[1] - B0[1])) / 2;
    this.D = (Math.hypot(B0[0] - F0[0], B0[1] - F0[1]) + Math.hypot(B1[0] - F1[0], B1[1] - F1[1])) / 2;
  }
  /** Bilinear point: s along the front (0..1), t from the street (0) to the rear (1). */
  at(s: number, t: number): Pt {
    const a = 1 - s, b = 1 - t;
    return [
      this.F0[0] * a * b + this.F1[0] * s * b + this.B1[0] * s * t + this.B0[0] * a * t,
      this.F0[1] * a * b + this.F1[1] * s * b + this.B1[1] * s * t + this.B0[1] * a * t,
    ];
  }
  /** Sub-quad as 4 corners in order (s0,t0) (s1,t0) (s1,t1) (s0,t1). */
  strip(s0: number, s1: number, t0: number, t1: number): Pt[] {
    return [this.at(s0, t0), this.at(s1, t0), this.at(s1, t1), this.at(s0, t1)];
  }
  /** Whole plot, optionally pulled in by `m` metres at every corner. */
  poly(m = 0): Pt[] {
    const ms = m / Math.max(1, this.W), mt = m / Math.max(1, this.D);
    return this.strip(ms, 1 - ms, mt, 1 - mt);
  }
  centre(): Pt { return this.at(0.5, 0.5); }
  /** Direction of the front line (unit). */
  dirS(): Pt { const dx = this.F1[0] - this.F0[0] + this.B1[0] - this.B0[0], dz = this.F1[1] - this.F0[1] + this.B1[1] - this.B0[1]; const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; }
}

export function centroid(p: Pt[]): Pt {
  let x = 0, z = 0;
  for (const q of p) { x += q[0]; z += q[1]; }
  return [x / p.length, z / p.length];
}

export function rotatePoly(p: Pt[], a: number, about?: Pt): Pt[] {
  const c = about ?? centroid(p), co = Math.cos(a), si = Math.sin(a);
  return p.map((q) => [c[0] + (q[0] - c[0]) * co - (q[1] - c[1]) * si, c[1] + (q[0] - c[0]) * si + (q[1] - c[1]) * co] as Pt);
}

export function shiftPoly(p: Pt[], dx: number, dz: number): Pt[] { return p.map((q) => [q[0] + dx, q[1] + dz] as Pt); }

export function lerpP(a: Pt, b: Pt, t: number): Pt { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

/** Shrink / grow a polygon about its centroid. */
export function scalePoly(p: Pt[], k: number): Pt[] {
  const c = centroid(p);
  return p.map((q) => [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k] as Pt);
}

/** Cut the corner at vertex i by `c` metres along both neighbouring edges. */
export function chamfer(p: Pt[], i: number, c: number): Pt[] {
  const n = p.length, v = p[i], a = p[(i + n - 1) % n], b = p[(i + 1) % n];
  const la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
  const ca = Math.min(c, la * 0.45), cb = Math.min(c, lb * 0.45);
  const pa: Pt = [v[0] + (a[0] - v[0]) / la * ca, v[1] + (a[1] - v[1]) / la * ca];
  const pb: Pt = [v[0] + (b[0] - v[0]) / lb * cb, v[1] + (b[1] - v[1]) / lb * cb];
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) { if (k === i) out.push(pa, pb); else out.push(p[k]); }
  return out;
}

export function circle(cx: number, cz: number, r: number, seg = 12, rot = 0): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < seg; k++) { const a = rot + (k / seg) * Math.PI * 2; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return out;
}

export function ellipse(cx: number, cz: number, rx: number, rz: number, ang: number, seg = 18): Pt[] {
  const c = Math.cos(ang), s = Math.sin(ang), out: Pt[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2, u = Math.cos(a) * rx, v = Math.sin(a) * rz;
    out.push([cx + u * c - v * s, cz + u * s + v * c]);
  }
  return out;
}

/** Oriented rectangle about (cx, cz). */
export function rect(cx: number, cz: number, w: number, d: number, ang: number): Pt[] {
  const c = Math.cos(ang), s = Math.sin(ang), hw = w / 2, hd = d / 2;
  const f = (u: number, v: number): Pt => [cx + u * c - v * s, cz + u * s + v * c];
  return [f(-hw, -hd), f(hw, -hd), f(hw, hd), f(-hw, hd)];
}

type V3 = [number, number, number];

class Acc {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; aH: number[] = []; seed: number[] = [];
  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aH', new THREE.Float32BufferAttribute(this.aH, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seed, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const hexCache = new Map<number, THREE.Color>();
/** sRGB hex -> working (linear) colour, converted once per hex value (the conversion is three pow calls); do not mutate the result. */
export function hexColor(hex: number): THREE.Color {
  let c = hexCache.get(hex);
  if (!c) { c = new THREE.Color().setHex(hex); hexCache.set(hex, c); }
  return c;
}

/** Accumulates flat-shaded triangles for the windowed / glass / plain / ghost materials. */
export class MB {
  acc: Record<Mat, Acc> = { wall: new Acc(), glass: new Acc(), plain: new Acc(), ghost: new Acc(), lamp: new Acc() };
  /** origin subtracted from every vertex (so a growing building can scale about its own base) */
  ox = 0; oy = 0; oz = 0;
  /** ground level aH is measured from (world y) */
  baseY = 0;
  seed = 0;

  private tri(m: Mat, a: V3, b: V3, c: V3, hint: V3, color: number) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-7) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    const col = hexColor(color);
    const A = this.acc[m];
    for (const p of [a, b, c]) {
      A.pos.push(p[0] - this.ox, p[1] - this.oy, p[2] - this.oz);
      A.nrm.push(nx, ny, nz);
      A.col.push(col.r, col.g, col.b);
      A.aH.push(p[1] - this.baseY);
      A.seed.push(this.seed);
    }
  }

  /** Planar-ish quad as two triangles; `hint` picks the outward side. */
  quad(m: Mat, a: V3, b: V3, c: V3, d: V3, hint: V3, color: number) {
    this.tri(m, a, b, c, hint, color);
    this.tri(m, a, c, d, hint, color);
  }

  /** Walls (and top cap) between a base polygon and a top polygon with the same vertex count. */
  frustum(m: Mat, base: Pt[], top: Pt[], y0: number, y1: number, color: number, cap = true, capColor = color, inward = false) {
    const n = base.length;
    const cb = centroid(base);
    const sg = inward ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = ((base[i][0] + base[j][0]) / 2 - cb[0]) * sg, mz = ((base[i][1] + base[j][1]) / 2 - cb[1]) * sg;
      this.quad(m, [base[i][0], y0, base[i][1]], [base[j][0], y0, base[j][1]], [top[j][0], y1, top[j][1]], [top[i][0], y1, top[i][1]], [mx, inward ? 0.6 : 0.05, mz], color);
    }
    if (cap) {
      const c: Pt = centroid(top);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(m === 'wall' || m === 'glass' ? 'plain' : m, [top[i][0], y1, top[i][1]], [top[j][0], y1, top[j][1]], [c[0], y1, c[1]], [0, 1, 0], capColor);
      }
    }
  }

  prism(m: Mat, poly: Pt[], y0: number, y1: number, color: number, capColor = color) {
    this.frustum(m, poly, poly, y0, y1, color, true, capColor);
  }

  /** Gable roof over a quad (c00, c10, c11, c01): ridge parallel to the first edge (alongS) or to the second. */
  roofGable(m: Mat, q: Pt[], y: number, rh: number, alongS: boolean, color: number) {
    const [c00, c10, c11, c01] = q;
    let r0: Pt, r1: Pt;
    if (alongS) { r0 = lerpP(c00, c01, 0.5); r1 = lerpP(c10, c11, 0.5); } else { r0 = lerpP(c00, c10, 0.5); r1 = lerpP(c01, c11, 0.5); }
    const R0: V3 = [r0[0], y + rh, r0[1]], R1: V3 = [r1[0], y + rh, r1[1]];
    const P = (p: Pt): V3 => [p[0], y, p[1]];
    const cen = centroid(q);
    const hint = (a: Pt, b: Pt): V3 => [(a[0] + b[0]) / 2 - cen[0], 0.7, (a[1] + b[1]) / 2 - cen[1]];
    if (alongS) {
      this.quad(m, P(c00), P(c10), R1, R0, hint(c00, c10), color);
      this.quad(m, P(c01), P(c11), R1, R0, hint(c01, c11), color);
      this.tri(m, P(c00), P(c01), R0, hint(c00, c01), color);
      this.tri(m, P(c10), P(c11), R1, hint(c10, c11), color);
    } else {
      this.quad(m, P(c00), P(c01), R1, R0, hint(c00, c01), color);
      this.quad(m, P(c10), P(c11), R1, R0, hint(c10, c11), color);
      this.tri(m, P(c00), P(c10), R0, hint(c00, c10), color);
      this.tri(m, P(c01), P(c11), R1, hint(c01, c11), color);
    }
  }

  /** Hipped roof (inset 0..0.5 of the long side from each end; 0.5 gives a pyramid). */
  roofHip(m: Mat, q: Pt[], y: number, rh: number, inset: number, color: number, alongS = true) {
    const [c00, c10, c11, c01] = q;
    const P = (p: Pt): V3 => [p[0], y, p[1]];
    let r0: Pt, r1: Pt;
    if (alongS) { const a = lerpP(c00, c01, 0.5), b = lerpP(c10, c11, 0.5); r0 = lerpP(a, b, inset); r1 = lerpP(a, b, 1 - inset); }
    else { const a = lerpP(c00, c10, 0.5), b = lerpP(c01, c11, 0.5); r0 = lerpP(a, b, inset); r1 = lerpP(a, b, 1 - inset); }
    const R0: V3 = [r0[0], y + rh, r0[1]], R1: V3 = [r1[0], y + rh, r1[1]];
    const cen = centroid(q);
    const hint = (a: Pt, b: Pt): V3 => [(a[0] + b[0]) / 2 - cen[0], 0.7, (a[1] + b[1]) / 2 - cen[1]];
    if (alongS) {
      this.quad(m, P(c00), P(c10), R1, R0, hint(c00, c10), color);
      this.quad(m, P(c01), P(c11), R1, R0, hint(c01, c11), color);
      this.tri(m, P(c00), P(c01), R0, hint(c00, c01), color);
      this.tri(m, P(c10), P(c11), R1, hint(c10, c11), color);
    } else {
      this.quad(m, P(c00), P(c01), R1, R0, hint(c00, c01), color);
      this.quad(m, P(c10), P(c11), R1, R0, hint(c10, c11), color);
      this.tri(m, P(c00), P(c10), R0, hint(c00, c10), color);
      this.tri(m, P(c01), P(c11), R1, hint(c01, c11), color);
    }
  }

  /** Mono-pitch roof: high edge along c01-c11 (t = 1 side) rising `rh`, low edge on c00-c10. */
  roofShed(m: Mat, q: Pt[], y: number, rh: number, color: number, highEdge = 2) {
    const [c00, c10, c11, c01] = q;
    const P = (p: Pt, hh = 0): V3 => [p[0], y + hh, p[1]];
    const cen = centroid(q);
    const hint = (a: Pt, b: Pt): V3 => [(a[0] + b[0]) / 2 - cen[0], 0.1, (a[1] + b[1]) / 2 - cen[1]];
    const v = [c00, c10, c11, c01];
    const hi = [highEdge % 4, (highEdge + 1) % 4];
    const H = (i: number) => (hi.includes(i) ? rh : 0);
    // sloped top
    this.quad(m, P(v[0], H(0)), P(v[1], H(1)), P(v[2], H(2)), P(v[3], H(3)), [0, 1, 0], color);
    // vertical sides
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      if (H(i) === 0 && H(j) === 0) continue;
      this.quad(m, P(v[i]), P(v[j]), P(v[j], H(j)), P(v[i], H(i)), hint(v[i], v[j]), color);
    }
  }

  /** Mansard: steep sloped sides inset by `k` (fraction), then a flat top. */
  mansard(m: Mat, q: Pt[], y: number, h: number, k: number, color: number) {
    this.frustum(m, q, scalePoly(q, 1 - k), y, y + h, color, true, color);
  }

  /** Sawtooth roof over a strip: teeth run along s, glazing faces the light side. */
  roofSaw(m: Mat, Q: Quad, s0: number, s1: number, t0: number, t1: number, y: number, rh: number, teeth: number, color: number, glassColor: number) {
    for (let k = 0; k < teeth; k++) {
      const ta = t0 + (t1 - t0) * (k / teeth), tb = t0 + (t1 - t0) * ((k + 1) / teeth);
      const a0 = Q.at(s0, ta), a1 = Q.at(s1, ta), b0 = Q.at(s0, tb), b1 = Q.at(s1, tb);
      const P = (p: Pt, hh = 0): V3 => [p[0], y + hh, p[1]];
      // slope from the low edge `ta` up to the ridge at `tb`, then a vertical glazed face dropping back down
      this.quad(m, P(a0), P(a1), P(b1, rh), P(b0, rh), [a0[0] - b0[0], 1.4, a0[1] - b0[1]], color);
      this.quad(m, P(b0, rh), P(b1, rh), P(b1), P(b0), [b0[0] - a0[0], 0.05, b0[1] - a0[1]], glassColor);
    }
  }
}
