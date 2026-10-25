/**
 * Paper objects drawn to small offscreen canvases (once per content change, never per frame): the station tag, the pinned project flag,
 * the cost slip. The layer blits them every frame. Day and night variants (night: the paper is a warm, dimmer cream, as if lit by the lamps).
 */
export interface TagSpec {
  /** big text (station, project, landmark name) */
  title: string;
  /** small line under the title */
  sub?: string;
  /** coloured badge on the right (ridership), '' for none */
  badge?: string;
  /** line / type colour (pin head, badge, left edge) */
  color: string;
  /** 0 = tag, 1 = flag (project: tilted card, folded corner, progress bar), 2 = cost slip (tracing paper), 3 = site hoarding (painted board) */
  look: 0 | 1 | 2 | 3;
  /** progress 0..1 for flags */
  pct?: number;
  /** red / green accent on a cost slip */
  ok?: boolean;
  /** small mode: only the badge (far zoom) */
  mini?: boolean;
}

export interface Bitmap { c: HTMLCanvasElement; w: number; h: number }

export const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", serif';
export const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace';

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** A hoarding: the painted plywood board that stands on a building site, with a hazard stripe, the project's name and its phase. */
function renderHoarding(t: TagSpec, s: number, night: boolean): Bitmap {
  const m = document.createElement('canvas');
  const g0 = m.getContext('2d')!;
  g0.font = `800 13px ${SANS}`;
  const tw = g0.measureText(t.title.toUpperCase()).width;
  g0.font = `600 9.5px ${SANS}`;
  const sw = t.sub ? g0.measureText(t.sub.toUpperCase()).width : 0;
  const w = Math.ceil(Math.max(tw, sw) + 26), h = t.pct !== undefined ? 46 : 40, M = 3;
  m.width = Math.ceil((w + M * 2) * s); m.height = Math.ceil((h + M * 2) * s);
  const g = m.getContext('2d')!;
  g.scale(s, s); g.translate(M, M);
  g.fillStyle = 'rgba(30,22,10,0.25)'; g.fillRect(1.5, 2, w, h);
  // painted board with a grain
  g.fillStyle = night ? '#a9a089' : '#e6dab5'; g.fillRect(0, 0, w, h);
  g.strokeStyle = night ? 'rgba(80,66,40,0.25)' : 'rgba(120,96,56,0.2)'; g.lineWidth = 0.6;
  for (let y = 7; y < h; y += 7) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  // hazard stripe along the top
  g.save(); g.beginPath(); g.rect(0, 0, w, 6); g.clip();
  g.fillStyle = '#e2b43a'; g.fillRect(0, 0, w, 6);
  g.fillStyle = '#2b2722';
  for (let x = -6; x < w + 6; x += 10) { g.beginPath(); g.moveTo(x, 6); g.lineTo(x + 5, 6); g.lineTo(x + 11, 0); g.lineTo(x + 6, 0); g.closePath(); g.fill(); }
  g.restore();
  g.strokeStyle = 'rgba(40,30,15,0.7)'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
  // the project colour as a painted band on the left
  g.fillStyle = t.color; g.fillRect(0, 6, 4, h - 6);
  g.textBaseline = 'alphabetic'; g.fillStyle = '#2b2722';
  g.font = `800 13px ${SANS}`; g.fillText(t.title.toUpperCase(), 13, 21);
  if (t.sub) { g.fillStyle = '#5d5240'; g.font = `600 9.5px ${SANS}`; g.fillText(t.sub.toUpperCase(), 13, 33); }
  if (t.pct !== undefined) {
    g.fillStyle = 'rgba(60,45,25,0.2)'; g.fillRect(13, h - 7, w - 24, 3);
    g.fillStyle = t.color; g.fillRect(13, h - 7, (w - 24) * Math.max(0, Math.min(1, t.pct)), 3);
  }
  // two screws
  g.fillStyle = '#6b6254'; for (const x of [w - 6, 8]) { g.beginPath(); g.arc(x, h - 4, 1.2, 0, Math.PI * 2); g.fill(); }
  return { c: m, w: w + M * 2, h: h + M * 2 };
}

/** Render a tag at `s` device pixels per CSS pixel. The bitmap includes a 3 px margin for the paper's shadow. */
export function renderTag(t: TagSpec, s: number, night: boolean): Bitmap {
  if (t.look === 3 && !t.mini) return renderHoarding(t, s, night);
  const m = document.createElement('canvas');
  const g0 = m.getContext('2d')!;
  const tf = t.mini ? 10.5 : t.look === 2 ? 16 : 12.5, sf = 9.5, bf = 10.5;
  g0.font = `bold ${tf}px ${SERIF}`;
  const tw = t.mini ? 0 : g0.measureText(t.title).width;
  g0.font = `${sf}px ${SERIF}`;
  const sw = t.sub && !t.mini ? g0.measureText(t.sub).width : 0;
  g0.font = `bold ${bf}px ${MONO}`;
  const bw = t.badge ? g0.measureText(t.badge).width + 9 : 0;
  const padX = 7, padY = t.mini ? 3 : 4;
  const inner = t.mini ? bw : Math.max(tw + (bw ? bw + 6 : 0), sw);
  const w = Math.ceil(inner + padX * 2 + (t.look === 1 ? 6 : 0)), h = Math.ceil(t.mini ? 17 : t.look === 2 ? 40 : t.sub ? 34 : 24) + (t.look === 1 && t.pct !== undefined ? 6 : 0);
  const M = 3;
  m.width = Math.ceil((w + M * 2) * s); m.height = Math.ceil((h + M * 2) * s);
  const g = m.getContext('2d')!;
  g.scale(s, s);
  g.translate(M, M);
  // paper shadow
  g.fillStyle = 'rgba(30,22,10,0.22)';
  rr(g, 1.2, 2, w, h, 3); g.fill();
  // sheet
  const paper = t.look === 2 ? (night ? '#b9c3c2' : '#edf3f1') : night ? '#d8cfb6' : '#f7f2e4';
  g.fillStyle = paper;
  rr(g, 0, 0, w, h, 3); g.fill();
  if (t.look === 2) { g.setLineDash([3, 2]); g.strokeStyle = t.ok === false ? 'rgba(180,60,40,0.8)' : 'rgba(40,110,80,0.8)'; g.lineWidth = 1; rr(g, 0.5, 0.5, w - 1, h - 1, 3); g.stroke(); g.setLineDash([]); }
  else { g.strokeStyle = 'rgba(70,52,30,0.5)'; g.lineWidth = 0.8; rr(g, 0.4, 0.4, w - 0.8, h - 0.8, 3); g.stroke(); }
  // colour edge (line colour / project colour)
  g.fillStyle = t.color;
  if (t.look === 1) { g.fillRect(0, 0, 4, h); } else if (!t.mini) { g.fillRect(0, 3, 3, h - 6); }
  // folded corner on flags
  if (t.look === 1) {
    g.fillStyle = night ? '#bdb398' : '#e4dcc4';
    g.beginPath(); g.moveTo(w - 7, 0); g.lineTo(w, 7); g.lineTo(w - 7, 7); g.closePath(); g.fill();
  }
  const x0 = padX + (t.look === 1 ? 4 : 0);
  if (t.mini) {
    if (t.badge) { g.fillStyle = t.color; rr(g, 3, 3, w - 6, h - 6, 3); g.fill(); g.fillStyle = '#fff'; g.font = `bold ${bf}px ${MONO}`; g.textBaseline = 'middle'; g.fillText(t.badge, 3 + 4.5, h / 2 + 0.5); }
  } else {
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#2b2722';
    g.font = `bold ${tf}px ${SERIF}`;
    g.fillText(t.title, x0, padY + (t.look === 2 ? 15 : 12));
    if (t.sub) { g.fillStyle = '#6b6254'; g.font = `${sf}px ${SERIF}`; g.fillText(t.sub, x0, padY + (t.look === 2 ? 29 : 24)); }
    if (t.badge) {
      const bx = w - padX - bw + 3, by = padY - 0.5;
      g.fillStyle = t.color; rr(g, bx, by, bw, 15, 3); g.fill();
      g.fillStyle = '#fff'; g.font = `bold ${bf}px ${MONO}`; g.textBaseline = 'middle'; g.fillText(t.badge, bx + 4.5, by + 8);
    }
    if (t.look === 1 && t.pct !== undefined) {
      g.fillStyle = 'rgba(60,45,25,0.15)'; g.fillRect(x0, h - 8, w - x0 - padX, 3);
      g.fillStyle = t.color; g.fillRect(x0, h - 8, (w - x0 - padX) * Math.max(0, Math.min(1, t.pct)), 3);
    }
  }
  return { c: m, w: w + M * 2, h: h + M * 2 };
}
