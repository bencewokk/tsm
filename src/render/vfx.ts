/**
 * Visual pass switches. Every look change of the visual pass sits behind a flag so it can be compared with the classic look in one page:
 * `?vfx=0` turns all of them off (the pre-pass look), `?vfx=sky,grade` turns on only those named, `?novfx=roads,night` turns the named
 * ones off. At runtime `tsm.vfx.set('sky', false)` flips one and rebuilds whatever depends on it (materials recompile, geometry that was
 * baked in is rebuilt by its owner through `onChange`).
 */
export type VfxName = 'sky' | 'grade' | 'ground' | 'bld' | 'night' | 'roads' | 'thin' | 'water' | 'cam' | 'diegetic';
const ALL: VfxName[] = ['sky', 'grade', 'ground', 'bld', 'night', 'roads', 'thin', 'water', 'cam', 'diegetic'];

class Vfx {
  private on = new Map<VfxName, boolean>();
  private listeners: ((n: VfxName, v: boolean) => void)[] = [];
  constructor() {
    const p = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const only = p.get('vfx');
    const off = (p.get('novfx') ?? '').split(',').filter(Boolean);
    const list = only && only !== '0' && only !== '1' ? only.split(',') : null;
    for (const n of ALL) this.on.set(n, only === '0' ? false : list ? list.includes(n) : !off.includes(n));
  }
  is(n: VfxName) { return this.on.get(n) !== false; }
  set(n: VfxName, v: boolean) { if (this.is(n) === v) return; this.on.set(n, v); for (const f of this.listeners) f(n, v); }
  setAll(v: boolean) { for (const n of ALL) this.set(n, v); }
  onChange(f: (n: VfxName, v: boolean) => void) { this.listeners.push(f); }
  /** state string for shader program cache keys */
  key(...names: VfxName[]) { return names.map((n) => (this.is(n) ? '1' : '0')).join(''); }
}

export const VFX = new Vfx();
if (typeof window !== 'undefined') (window as unknown as { vfx: Vfx }).vfx = VFX;   // dev handle: vfx.set('sky', false)
