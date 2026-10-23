import { Rng } from './rng';

/**
 * CityProfile: what kind of place this seed is. Drawn from the seed at world generation; combinations are never filtered for plausibility.
 * Coherence comes from history layers: the origin forms the first core and each later era adds a layer of quarters on top.
 */
export type TerrainKind = 'coast' | 'river' | 'hills' | 'plain';
export type Origin = 'port' | 'rail-junction' | 'market-town' | 'mining' | 'planned-capital';
export type LayerKind = 'industrial' | 'planned' | 'garden' | 'transit';
/** The "obsolete industrial district" the redevelopment project is about: waterfront docks, rail yards or a pithead. */
export type SiteKind = 'harbour' | 'railyard' | 'mine';

export interface EraLayer { kind: LayerKind; label: string }

export interface CityProfile {
  seed: number;
  terrain: TerrainKind;
  origin: Origin;
  history: EraLayer[];
  /** 0 organic .. 1 strictly planned: scales road regularity everywhere */
  planningStrength: number;
  /** 0 poor .. 1 rich: taller towers, greener, calmer palettes */
  wealth: number;
  /** relative weights (0.5 = neutral) of what the city builds */
  dominant: { res: number; com: number; ind: number; civic: number };
  /** the old industrial site that gets redeveloped */
  site: SiteKind;
  /** regional building tradition (palette family of the old fabric) */
  tradition: 'south' | 'north' | 'brick' | 'whitewash' | 'sand';
  story: string;
}

const TERRAINS: TerrainKind[] = ['coast', 'coast', 'river', 'hills', 'plain'];
const ORIGINS: Origin[] = ['port', 'rail-junction', 'market-town', 'mining', 'planned-capital'];
const LAYERS: EraLayer[] = [
  { kind: 'industrial', label: 'industrialised' },
  { kind: 'planned', label: 'given a grand planned quarter of boulevards' },
  { kind: 'garden', label: 'ringed with garden suburbs' },
  { kind: 'transit', label: 'rebuilt around transit' },
];

const ORIGIN_NOUN: Record<Origin, string> = {
  port: 'port town', 'rail-junction': 'railway junction', 'market-town': 'market town', mining: 'mining town', 'planned-capital': 'planned capital',
};
const TERRAIN_ADJ: Record<TerrainKind, string> = { coast: 'coastal', river: 'riverside', hills: 'hill-country', plain: 'lowland' };

export function siteFor(origin: Origin, terrain: TerrainKind, rng: Rng): SiteKind {
  if (origin === 'mining') return 'mine';
  if (origin === 'rail-junction') return 'railyard';
  if (origin === 'port') return 'harbour';
  // every terrain has a river big enough for wharves; hills and plains just favour rail yards
  return (terrain === 'coast' || terrain === 'river') && rng.next() < 0.7 ? 'harbour' : 'railyard';
}

function story(cp: Omit<CityProfile, 'story'>): string {
  const rich = cp.wealth > 0.7 ? 'prosperous ' : cp.wealth < 0.3 ? 'modest ' : '';
  const first = `A ${rich}${TERRAIN_ADJ[cp.terrain]} ${ORIGIN_NOUN[cp.origin]}`;
  const phrases = cp.history.map((h) => h.label);
  let tail = '';
  if (phrases.length === 1) tail = `, ${phrases[0]}`;
  else if (phrases.length > 1) tail = `, ${phrases.slice(0, -1).join(', ')}, then ${phrases[phrases.length - 1]}`;
  const plan = cp.planningStrength > 0.7 ? 'Its streets are strictly laid out.' : cp.planningStrength < 0.3 ? 'Its streets wander wherever the land let them.' : 'Planned axes cut through an older, organic fabric.';
  const dom = cp.dominant.ind > 0.65 ? ' Heavy industry shapes the skyline.' : cp.dominant.com > 0.65 ? ' Commerce drives the centre.' : cp.dominant.res > 0.65 ? ' Homes outnumber everything else.' : '';
  return `${first}${tail}. ${plan}${dom}`;
}

/** The default city (seed 4821): the original port town. */
function portCity(seed: number): CityProfile {
  const base = {
    seed, terrain: 'coast' as const, origin: 'port' as const,
    history: [LAYERS[0], LAYERS[3]],
    planningStrength: 0.5, wealth: 0.5, dominant: { res: 0.5, com: 0.5, ind: 0.5, civic: 0.5 }, site: 'harbour' as const, tradition: 'south' as const,
  };
  return { ...base, story: story(base) };
}

export function makeCityProfile(seed: number, force?: Partial<Pick<CityProfile, 'terrain' | 'origin'>>): CityProfile {
  const forced = !!(force && (force.terrain || force.origin));
  if (seed === 4821 && !forced) return portCity(seed);
  const rng = new Rng((seed ^ 0x9e3779b1) >>> 0);
  rng.next(); rng.next();
  const terrain = force?.terrain ?? rng.pick(TERRAINS);
  const origin = force?.origin ?? rng.pick(ORIGINS);
  // 1-3 later eras, in historical order, each at most once
  const pool = LAYERS.filter((l) => !(origin === 'planned-capital' && l.kind === 'planned'));
  const n = 1 + Math.floor(rng.next() * 3);
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const picked = shuffled.slice(0, n);
  picked.sort((a, b) => LAYERS.indexOf(a) - LAYERS.indexOf(b));
  const planning = Math.max(0.05, Math.min(0.97, (origin === 'planned-capital' ? 0.6 : 0.1) + rng.next() * (origin === 'planned-capital' ? 0.4 : 0.8) + (picked.some((l) => l.kind === 'planned') ? 0.12 : 0)));
  const mix = () => Math.max(0.2, Math.min(0.85, 0.5 + (rng.next() - 0.5) * 0.7));
  const dominant = { res: mix(), com: mix(), ind: mix(), civic: mix() };
  if (origin === 'mining' || picked.some((l) => l.kind === 'industrial')) dominant.ind = Math.max(dominant.ind, 0.55);
  if (origin === 'planned-capital') dominant.civic = Math.max(dominant.civic, 0.65);
  const base = { seed, terrain, origin, history: picked, planningStrength: planning, wealth: rng.next(), dominant, site: siteFor(origin, terrain, rng), tradition: rng.pick(['south', 'north', 'brick', 'whitewash', 'sand'] as const) };
  return { ...base, story: story(base) };
}
