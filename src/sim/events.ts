/**
 * Events are plain data: a trigger, text (with {placeholders}), choices and declarative effects.
 * The sim evaluates triggers each month, fills placeholders from its state, and applies effects.
 */

export type Trigger = {
  monthAtLeast?: number;
  popAtLeast?: number;
  /** fire N months after another event was resolved */
  after?: { event: string; months: number };
};

/** Conditions select a text variant (all listed keys must match). */
export type Cond = { deal?: string; late?: boolean };

export type Effect =
  | { kind: 'money'; amount: number }
  | { kind: 'docksDeal'; deal: DocksDeal }
  | { kind: 'docksExtraPlots'; count: number }
  | { kind: 'docksPark' }
  | { kind: 'docksRoadRelief' }
  | { kind: 'log'; text: string };

export interface DocksDeal {
  id: string;
  name: string;
  /** months to get service in; 0 = no deadline */
  deadline: number;
  density: 'high' | 'mid' | 'low';
  /** whole district car-locked from day one */
  carLockAll?: boolean;
}

export interface ChoiceDef { label: string; detail: string; effects: Effect[] }
export interface Variant { when: Cond; title?: string; text: string; choices: ChoiceDef[] }
export interface EventDef { id: string; trigger: Trigger; title: string; text: string; choices: ChoiceDef[]; variants?: Variant[] }

export const EVENTS: EventDef[] = [
  {
    id: 'docks_bought',
    trigger: { monthAtLeast: 14, popAtLeast: 5000 },
    title: 'The city bought the old docks',
    text:
      'The warehouses on the {village} waterfront have stood empty since the container port moved down the coast. ' +
      'The council has bought all {cells} waterfront plots and wants a new district of homes and offices there.<br><br>' +
      '<b>Brief:</b> the district only grows where the metro reaches it. Every planned block needs a station on a line within <b>600 m</b>. ' +
      'Blocks still unserved when the deadline passes get built car-first, and those residents buy cars for good.<br><br>Pick a development partner:',
    choices: [
      {
        label: 'Harbourside Partners: fast-track towers',
        detail: '+$35M subsidy now. Dense towers. Service must arrive within 12 months.',
        effects: [
          { kind: 'money', amount: 35e6 },
          { kind: 'docksDeal', deal: { id: 'fast', name: 'Harbourside Partners', deadline: 12, density: 'high' } },
        ],
      },
      {
        label: 'Tidewater Housing Trust: slow and steady',
        detail: 'Costs the city $15M. Mid-rise blocks. You get 30 months to bring the metro.',
        effects: [
          { kind: 'money', amount: -15e6 },
          { kind: 'docksDeal', deal: { id: 'trust', name: 'Tidewater Housing Trust', deadline: 30, density: 'mid' } },
        ],
      },
      {
        label: 'Parkway Estates: build with parking',
        detail: '+$10M. Low-rise with garages, no deadline. The whole district is car-locked from day one.',
        effects: [
          { kind: 'money', amount: 10e6 },
          { kind: 'docksDeal', deal: { id: 'parking', name: 'Parkway Estates', deadline: 0, density: 'low', carLockAll: true } },
        ],
      },
    ],
  },
  {
    id: 'docks_followup',
    trigger: { after: { event: 'docks_bought', months: 26 } },
    title: 'The docks, two years on',
    text: '',
    choices: [],
    variants: [
      {
        when: { deal: 'fast', late: true },
        title: 'Harbourside Partners want their money back',
        text:
          'Harbourside Partners took your fast-track deal on the promise of a metro within 12 months. ' +
          '{locked} of {planned} docks blocks missed the deadline and were built car-first; their residents drive everywhere. ' +
          'The contract lets the developer claw back part of the $35M subsidy.',
        choices: [
          { label: 'Pay the $20M clawback', detail: 'Settle and move on.', effects: [{ kind: 'money', amount: -20e6 }] },
          { label: 'Offer two extra tower plots instead', detail: 'No cash, but two more planned towers on the waterfront that also need a station.', effects: [{ kind: 'docksExtraPlots', count: 2 }] },
        ],
      },
      {
        when: { deal: 'fast', late: false },
        title: 'Harbourside Partners report back',
        text:
          'The fast-track worked: your metro reached the docks on time. The towers are {built}/{planned} complete and ' +
          '{share}% of docks trips go by metro (city average {cityShare}%). Harbourside offers a phase two.',
        choices: [
          { label: 'Take phase two (+$25M, two more towers)', detail: 'More plots that need service too.', effects: [{ kind: 'money', amount: 25e6 }, { kind: 'docksExtraPlots', count: 2 }] },
          { label: 'Decline politely', detail: 'Keep the waterfront as it is.', effects: [] },
        ],
      },
      {
        when: { deal: 'trust' },
        title: 'The Housing Trust writes in',
        text:
          'The Tidewater Housing Trust took the slow road with you. {built} of {planned} blocks are finished, ' +
          '{locked} went car-first, and {share}% of docks trips are by metro (city average {cityShare}%). ' +
          'The Trust asks the city to turn one plot into a waterfront park.',
        choices: [
          { label: 'Fund the park ($6M)', detail: 'Raises land value around the docks.', effects: [{ kind: 'money', amount: -6e6 }, { kind: 'docksPark' }] },
          { label: 'Not now', detail: 'Keep the money.', effects: [] },
        ],
      },
      {
        when: { deal: 'parking' },
        title: 'Parkway Estates traffic',
        text:
          'Parkway Estates built the docks around garages, as agreed. Its {homes} households own cars and the harbour roads are jammed ' +
          '(local congestion {cong}%). Residents now petition for a metro station, but they have two cars each: even with a station, only {share}% of their trips use transit.',
        choices: [
          { label: 'Build bus lanes ($5M)', detail: 'Eases the waterfront roads a little.', effects: [{ kind: 'money', amount: -5e6 }, { kind: 'docksRoadRelief' }] },
          { label: 'Ignore it', detail: 'They chose the cars.', effects: [] },
        ],
      },
    ],
  },
];

export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}
