/**
 * Events are plain data: a trigger, text (with {placeholders}), choices and declarative effects.
 * The sim evaluates triggers each month, fills placeholders from its state, and applies effects.
 */

import { LANDMARKS, type SiteChoice, type LandmarkDef } from './landmarks';

export type Trigger = {
  monthAtLeast?: number;
  popAtLeast?: number;
  /** fire N months after another event was resolved */
  after?: { event: string; months: number };
};

/** Conditions select a text variant (all listed keys must match). */
export type Cond = { deal?: string; late?: boolean; served?: boolean };

/** An event only appears in cities whose profile matches (all listed keys). */
export interface Requires { site?: ('harbour' | 'railyard' | 'mine')[]; origin?: string[]; history?: string[] }

/** Words for the old industrial district that the redevelopment project is about, per site kind. Data, so new site kinds are new rows. */
export const SITE_TEXT: Record<string, Record<string, string>> = {
  harbour: { oldSite: 'old docks', district: 'waterfront', past: 'have stood empty since the container port moved down the coast', dev1: 'Harbourside Partners', dev2: 'Tidewater Housing Trust', dev3: 'Parkway Estates', project: 'Docks project', park: 'waterfront park', parkLabel: 'Waterfront park opened at the docks', done: 'Docks district complete' },
  railyard: { oldSite: 'old rail yards', district: 'rail-yard', past: 'have stood idle since freight moved to the new ring line', dev1: 'Railside Developments', dev2: 'Junction Housing Trust', dev3: 'Parkway Estates', project: 'Rail-yard project', park: 'linear park along the old tracks', parkLabel: 'Park opened on the old rail yards', done: 'Rail-yard district complete' },
  mine: { oldSite: 'old pithead', district: 'pithead', past: 'have stood empty since the last seam was worked out', dev1: 'Deepshaft Regeneration', dev2: 'Miners Housing Trust', dev3: 'Parkway Estates', project: 'Pithead project', park: 'park on the spoil heaps', parkLabel: 'Park opened on the old mine', done: 'Pithead district complete' },
};

export type Effect =
  | { kind: 'money'; amount: number }
  | { kind: 'docksDeal'; deal: DocksDeal }
  | { kind: 'docksExtraPlots'; count: number }
  | { kind: 'docksPark' }
  | { kind: 'docksRoadRelief' }
  | { kind: 'landmark'; id: string; site: SiteChoice; pay: 'city' | 'dev' }
  | { kind: 'lmCarPark'; id: string }
  | { kind: 'log'; text: string }
  /** a choice on a development project instance (projects.ts) */
  | { kind: 'project'; inst: number; choice: number };

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
export interface EventDef { id: string; trigger: Trigger; requires?: Requires; landmark?: string; title: string; text: string; choices: ChoiceDef[]; variants?: Variant[] }

export const EVENTS: EventDef[] = [
  {
    id: 'docks_bought',
    trigger: { monthAtLeast: 14, popAtLeast: 5000 },
    requires: { site: ['harbour', 'railyard', 'mine'] },
    title: 'The city bought the {oldSite}',
    text:
      'The sheds on the {village} {district} {past}. ' +
      'The council has bought all {cells} {district} plots and wants a new district of homes and offices there.<br><br>' +
      '<b>Brief:</b> the district only grows where the metro reaches it. Every planned block needs a station on a line within an <b>8-minute walk</b> (about 600 m) along the streets. ' +
      'Blocks still unserved when the deadline passes get built car-first, and those residents buy cars for good.<br><br>Pick a development partner:',
    choices: [
      {
        label: '{dev1}: fast-track towers',
        detail: '+$35M subsidy now. Dense towers. Service must arrive within 12 months.',
        effects: [
          { kind: 'money', amount: 35e6 },
          { kind: 'docksDeal', deal: { id: 'fast', name: '{dev1}', deadline: 12, density: 'high' } },
        ],
      },
      {
        label: '{dev2}: slow and steady',
        detail: 'Costs the city $15M. Mid-rise blocks. You get 30 months to bring the metro.',
        effects: [
          { kind: 'money', amount: -15e6 },
          { kind: 'docksDeal', deal: { id: 'trust', name: '{dev2}', deadline: 30, density: 'mid' } },
        ],
      },
      {
        label: '{dev3}: build with parking',
        detail: '+$10M. Low-rise with garages, no deadline. The whole district is car-locked from day one.',
        effects: [
          { kind: 'money', amount: 10e6 },
          { kind: 'docksDeal', deal: { id: 'parking', name: '{dev3}', deadline: 0, density: 'low', carLockAll: true } },
        ],
      },
    ],
  },
  {
    id: 'docks_followup',
    trigger: { after: { event: 'docks_bought', months: 26 } },
    title: 'The {oldSite}, two years on',
    text: '',
    choices: [],
    variants: [
      {
        when: { deal: 'fast', late: true },
        title: '{dev1} want their money back',
        text:
          '{dev1} took your fast-track deal on the promise of a metro within 12 months. ' +
          '{locked} of {planned} {district} blocks missed the deadline and were built car-first; their residents drive everywhere. ' +
          'The contract lets the developer claw back part of the $35M subsidy.',
        choices: [
          { label: 'Pay the $20M clawback', detail: 'Settle and move on.', effects: [{ kind: 'money', amount: -20e6 }] },
          { label: 'Offer two extra tower plots instead', detail: 'No cash, but two more planned towers on the waterfront that also need a station.', effects: [{ kind: 'docksExtraPlots', count: 2 }] },
        ],
      },
      {
        when: { deal: 'fast', late: false },
        title: '{dev1} report back',
        text:
          'The fast-track worked: your metro reached the {district} on time. The towers are {built}/{planned} complete and ' +
          '{share}% of {district} trips go by metro (city average {cityShare}%). {dev1} offer a phase two.',
        choices: [
          { label: 'Take phase two (+$25M, two more towers)', detail: 'More plots that need service too.', effects: [{ kind: 'money', amount: 25e6 }, { kind: 'docksExtraPlots', count: 2 }] },
          { label: 'Decline politely', detail: 'Keep the {district} as it is.', effects: [] },
        ],
      },
      {
        when: { deal: 'trust' },
        title: '{dev2} write in',
        text:
          '{dev2} took the slow road with you. {built} of {planned} blocks are finished, ' +
          '{locked} went car-first, and {share}% of {district} trips are by metro (city average {cityShare}%). ' +
          'They ask the city to turn one plot into a {park}.',
        choices: [
          { label: 'Fund the park ($6M)', detail: 'Raises land value around the docks.', effects: [{ kind: 'money', amount: -6e6 }, { kind: 'docksPark' }] },
          { label: 'Not now', detail: 'Keep the money.', effects: [] },
        ],
      },
      {
        when: { deal: 'parking' },
        title: '{dev3} traffic',
        text:
          '{dev3} built the {district} around garages, as agreed. Its {homes} households own cars and the roads are jammed ' +
          '(local congestion {cong}%). Residents now petition for a metro station, but they have two cars each: even with a station, only {share}% of their trips use transit.',
        choices: [
          { label: 'Build bus lanes ($5M)', detail: 'Eases the {district} roads a little.', effects: [{ kind: 'money', amount: -5e6 }, { kind: 'docksRoadRelief' }] },
          { label: 'Ignore it', detail: 'They chose the cars.', effects: [] },
        ],
      },
    ],
  },
  {
    id: 'capital_quarter',
    trigger: { monthAtLeast: 30, popAtLeast: 12000 },
    requires: { origin: ['planned-capital'], history: ['planned'] },
    title: 'The ministries want a government quarter',
    text:
      'A capital needs somewhere to govern from. The ministries have drawn up a government quarter of long, formal blocks on the boulevards of {village}. ' +
      'Civil servants commute in lockstep, so a station nearby would move thousands of people a day. How do you answer?',
    choices: [
      { label: 'Welcome them with a grant (+$30M)', detail: 'The state pays for the buildings; you promise service.', effects: [{ kind: 'money', amount: 30e6 }, { kind: 'log', text: 'Government quarter agreed on the boulevards' }] },
      { label: 'Ask them to pay their way (+$12M)', detail: 'Less money, a smaller quarter.', effects: [{ kind: 'money', amount: 12e6 }, { kind: 'log', text: 'A small government quarter is agreed' }] },
      { label: 'Decline', detail: 'Keep the boulevards for homes and shops.', effects: [] },
    ],
  },
];

export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// ---------------------------------------------------------------- landmark proposals: generated from the catalogue (landmarks.ts)
const SITE_WORD: Record<SiteChoice, string> = { centre: 'in the city centre', station: 'next to a station', water: 'on the waterfront', hill: 'on the highest ground', edge: 'at the edge of town' };
const m = (v: number) => `$${Math.round(v / 1e6)}M`;

function proposal(def: LandmarkDef): EventDef {
  const [a, b] = def.sites;
  return {
    id: 'lm_' + def.id,
    landmark: def.id,
    trigger: { monthAtLeast: def.unlock?.month ?? 24, popAtLeast: def.unlock?.pop ?? 8000 },
    title: def.name + ': a proposal',
    text: (def.pitch ?? '') + '<br><br><b>Brief:</b> a landmark is only a success if people can get to it. If there is no station within an <b>8-minute walk</b> when it opens, it gets a car park and its visitors stay in their cars for good. Where do you want it?',
    choices: [
      { label: `Build it ${SITE_WORD[a]} (the city pays ${m(def.cost)})`, detail: `{pre_a} Then ${def.buildMonths} months of construction.`, effects: [{ kind: 'money', amount: -def.cost }, { kind: 'landmark', id: def.id, site: a, pay: 'city' }] },
      { label: `Developer deal: ${SITE_WORD[b]}`, detail: `The developer pays and adds ${m(def.cost * 0.2)} to the city. {pre_b} Unserved at opening, you owe a ${m(def.cost * 0.25)} penalty and it still gets its car park.`, effects: [{ kind: 'money', amount: def.cost * 0.2 }, { kind: 'landmark', id: def.id, site: b, pay: 'dev' }] },
      { label: 'Decline', detail: 'Nothing is built.', effects: [] },
    ],
  };
}

function followup(def: LandmarkDef): EventDef | null {
  if (!def.followup) return null;
  return {
    id: 'lm_' + def.id + '_after',
    landmark: def.id,
    trigger: { after: { event: 'lm_' + def.id, months: def.buildMonths + 8 } },
    title: def.name + ' one year on',
    text: '',
    choices: [],
    variants: [
      { when: { served: true }, text: def.followup.served, choices: [
        { label: 'Reward the operator (-$5M)', detail: 'Goodwill: nothing changes on the map.', effects: [{ kind: 'money', amount: -5e6 }] },
        { label: 'Carry on', detail: '', effects: [] },
      ] },
      { when: { served: false }, text: def.followup.unserved, choices: [
        { label: 'Extend the car park (-$6M)', detail: 'Keeps the road traffic moving; the trips stay car-locked.', effects: [{ kind: 'money', amount: -6e6 }, { kind: 'lmCarPark', id: def.id }] },
        { label: 'Promise a station', detail: 'You will plan one.', effects: [] },
      ] },
    ],
  };
}

for (const def of LANDMARKS) {
  if (def.start) continue;
  EVENTS.push(proposal(def));
  const f = followup(def);
  if (f) EVENTS.push(f);
}
