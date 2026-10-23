/**
 * Signature landmarks: a catalogue of unique buildings, as data. Adding a landmark is adding a row here (plus a form in render/landmarks.ts).
 * - `start` ones exist from day one in the old towns (the core gets an identity at once);
 * - the others arrive as proposals through the event system (events are generated from this table), filtered by the city profile.
 */
export type LandmarkCategory = 'civic' | 'culture' | 'sport' | 'heritage' | 'commercial' | 'leisure' | 'health' | 'education';
export type SiteChoice = 'centre' | 'station' | 'water' | 'hill' | 'edge';

export interface LandmarkRequires {
  origin?: string[]; terrain?: string[]; site?: string[]; history?: string[]; tradition?: string[]; wealthAtLeast?: number;
}

export interface LandmarkDef {
  id: string;
  name: string;
  category: LandmarkCategory;
  /** form id in render/landmarks.ts */
  form: string;
  /** plot size in cells: frontage x depth (50 m each) */
  size: [number, number];
  /** which sites the proposal offers (first = the city-pays option, second = the developer option) */
  sites: [SiteChoice, SiteChoice];
  /** the site must have this to be built at all (the feature moves inland / to the highest ground otherwise) */
  needs?: { water?: boolean; hill?: boolean };
  buildMonths: number;
  /** $ the city pays on the city-pays deal */
  cost: number;
  // ---- gameplay
  /** steady destination weight in the trip model (jobs-equivalent) */
  attr: number;
  /** extra visitor trips per day on an ordinary day */
  visitors: number;
  /** when the visitors come: shapes the extra load (weekday = commuting peaks, weekend, events = rare spikes) */
  pattern: 'allday' | 'weekday' | 'weekend' | 'events';
  /** extra trips per day on an event day (match, concert, festival, expo) */
  eventTrips: number;
  /** average months between event days (0 = none) */
  eventEvery: number;
  /** land value amenity weight within ~4 cells */
  value: number;
  night: 'floodlit' | 'crown' | 'windows' | 'beacon' | 'glow';
  // ---- proposals
  start?: boolean;
  unlock?: { month?: number; pop?: number };
  requires?: LandmarkRequires;
  pitch?: string;
  followup?: { served: string; unserved: string };
}

export const LANDMARKS: LandmarkDef[] = [
  // ---------------------------------------------------------------- day one: the old town's identity
  { id: 'cathedral', name: 'Cathedral', category: 'heritage', form: 'cathedral', size: [1.2, 1.1], sites: ['centre', 'centre'], buildMonths: 8, cost: 0, attr: 120, visitors: 400, pattern: 'weekend', eventTrips: 1500, eventEvery: 6, value: 1.2, night: 'floodlit', start: true },
  { id: 'cityhall', name: 'City hall', category: 'civic', form: 'cityhall', size: [1.4, 0.9], sites: ['centre', 'centre'], buildMonths: 6, cost: 0, attr: 380, visitors: 900, pattern: 'weekday', eventTrips: 0, eventEvery: 0, value: 1.0, night: 'floodlit', start: true },
  { id: 'markethall', name: 'Market hall', category: 'commercial', form: 'markethall', size: [1.6, 0.9], sites: ['centre', 'centre'], buildMonths: 5, cost: 0, attr: 260, visitors: 1600, pattern: 'allday', eventTrips: 0, eventEvery: 0, value: 0.9, night: 'windows', start: true },

  // ---------------------------------------------------------------- proposals
  {
    id: 'hospital', name: 'General hospital', category: 'health', form: 'hospital', size: [2.2, 1.6], sites: ['edge', 'centre'], buildMonths: 12, cost: 38e6,
    attr: 900, visitors: 2400, pattern: 'allday', eventTrips: 0, eventEvery: 0, value: 0.6, night: 'beacon', unlock: { month: 20, pop: 8000 },
    pitch: 'The health board wants a general hospital for {village}. Staff come in around the clock and patients and visitors arrive all day; it is a steady, all-day source of trips rather than a peak.',
    followup: { served: 'Doctors and nurses say the metro is how half the staff get in. The board asks for a second entrance.', unserved: 'The hospital car park is full by eight and the neighbours complain about parked cars. Staff ask why there is no station.' },
  },
  {
    id: 'university', name: 'University campus', category: 'education', form: 'university', size: [3.0, 2.2], sites: ['edge', 'station'], buildMonths: 18, cost: 55e6,
    attr: 1400, visitors: 5200, pattern: 'weekday', eventTrips: 0, eventEvery: 0, value: 0.9, night: 'windows', unlock: { month: 36, pop: 15000 },
    pitch: 'A university wants to open a campus. Thousands of students and staff will travel in on weekdays, in sharp morning and evening peaks, and rent rooms nearby.',
    followup: { served: 'Term starts and the metro fills with students. The union asks for more trains in the peaks.', unserved: 'Students are parking in every side street. The university asks the council for a station.' },
  },
  {
    id: 'stadium', name: 'Football stadium', category: 'sport', form: 'stadium', size: [3.2, 2.6], sites: ['edge', 'station'], buildMonths: 16, cost: 62e6,
    attr: 160, visitors: 700, pattern: 'events', eventTrips: 26000, eventEvery: 1, value: 0.4, night: 'floodlit', unlock: { month: 40, pop: 20000 },
    pitch: 'The city club needs a proper stadium. On ordinary days it is nearly empty, but a match day brings tens of thousands within a couple of hours, almost all of them at the same time.',
    followup: { served: 'Match days work: the crowd leaves on the metro. The club wants a bigger ground.', unserved: 'Match-day traffic gridlocks half the town. Fans march on city hall demanding a station at the ground.' },
    requires: { wealthAtLeast: 0.15 },
  },
  {
    id: 'arena', name: 'Concert arena', category: 'leisure', form: 'arena', size: [2.2, 2.0], sites: ['station', 'edge'], buildMonths: 14, cost: 44e6,
    attr: 120, visitors: 500, pattern: 'events', eventTrips: 14000, eventEvery: 1, value: 0.4, night: 'glow', unlock: { month: 48, pop: 25000 },
    pitch: 'An arena operator offers a covered arena for concerts and shows. Evenings and weekends get sharp spikes of visitors, then nothing for days.',
    followup: { served: 'Sold-out nights and the last trains are packed. The operator offers to pay for late service.', unserved: 'Concert crowds spill across the bridges at midnight with no way home but taxis.' },
  },
  {
    id: 'library', name: 'Central library', category: 'culture', form: 'library', size: [1.7, 1.3], sites: ['centre', 'station'], buildMonths: 10, cost: 26e6,
    attr: 420, visitors: 2200, pattern: 'allday', eventTrips: 0, eventEvery: 0, value: 0.9, night: 'windows', unlock: { month: 24, pop: 10000 },
    pitch: 'The city could build a great central library: a glass reading room, a stack of terraces, free for everyone. It draws a steady, all-day crowd and lifts the streets around it.',
    followup: { served: 'The reading room is full by nine. A cafe opens in every doorway nearby.', unserved: 'Few people can reach the library without a car; the council asks whether a stop is planned.' },
  },
  {
    id: 'museum', name: 'City museum', category: 'culture', form: 'museum', size: [1.9, 1.3], sites: ['centre', 'water'], buildMonths: 12, cost: 30e6,
    attr: 240, visitors: 2600, pattern: 'weekend', eventTrips: 6000, eventEvery: 4, value: 1.1, night: 'floodlit', unlock: { month: 30, pop: 12000 }, requires: { wealthAtLeast: 0.25 },
    pitch: 'A foundation will fund a museum of the city if you provide the plot. Weekends and school holidays are busiest, and a blockbuster exhibition brings queues round the block.',
    followup: { served: 'The big exhibition opens and visitors arrive by metro. Attendance doubles.', unserved: 'The exhibition is a hit but the queue of cars is longer than the queue of visitors.' },
  },
  {
    id: 'opera', name: 'Opera house', category: 'culture', form: 'opera', size: [1.8, 1.5], sites: ['centre', 'water'], buildMonths: 16, cost: 48e6,
    attr: 180, visitors: 900, pattern: 'events', eventTrips: 4500, eventEvery: 1, value: 1.3, night: 'glow', unlock: { month: 42, pop: 18000 }, requires: { wealthAtLeast: 0.45 },
    pitch: 'A patron offers an opera house for the heart of the city, sweeping glass foyer and a copper-roofed auditorium. Evenings are busy, daytime nearly empty; surrounding land becomes very desirable.',
    followup: { served: 'Opening night: the foyer glows and the last metro is held for the audience.', unserved: 'Audiences grumble about parking. Take-up of the subscription is lower than hoped.' },
  },
  {
    id: 'expo', name: 'Exhibition hall', category: 'commercial', form: 'expo', size: [2.8, 1.8], sites: ['station', 'edge'], buildMonths: 14, cost: 40e6,
    attr: 300, visitors: 1500, pattern: 'events', eventTrips: 9000, eventEvery: 2, value: 0.5, night: 'glow', unlock: { month: 54, pop: 22000 }, requires: { wealthAtLeast: 0.3 },
    pitch: 'A trade body proposes a big exhibition hall with a long glazed nave. A trade fair every couple of months sends crowds in for a few days.',
    followup: { served: 'The first trade fair fills the hotels; delegates all use the metro.', unserved: 'Exhibitors complain: a hall that cannot be reached without a car is a hall that stays half empty.' },
  },
  {
    id: 'tvtower', name: 'Broadcast tower', category: 'commercial', form: 'tvtower', size: [1.0, 1.0], sites: ['hill', 'edge'], buildMonths: 12, cost: 30e6,
    attr: 160, visitors: 700, pattern: 'allday', eventTrips: 0, eventEvery: 0, value: 0.3, night: 'beacon', unlock: { month: 60, pop: 24000 }, needs: { hill: true },
    pitch: 'The broadcasters want a tall concrete tower with an observation deck, on the highest ground you can give them. Tourists come for the view all day long.',
    followup: { served: 'The observation deck queue runs out the door; tourists arrive on the metro.', unserved: 'The tower is a landmark from every street, but only coaches go up the hill.' },
  },
  {
    id: 'skyscraper', name: 'Signature skyscraper', category: 'commercial', form: 'skyscraper', size: [1.0, 1.0], sites: ['centre', 'station'], buildMonths: 24, cost: 70e6,
    attr: 2600, visitors: 4200, pattern: 'weekday', eventTrips: 0, eventEvery: 0, value: 1.2, night: 'crown', unlock: { month: 66, pop: 30000 }, requires: { wealthAtLeast: 0.4 },
    pitch: 'A developer wants to build the tallest tower the city has seen, a slender needle with a lit crown. Thousands of office workers, all arriving at the same hours.',
    followup: { served: 'The crown is lit and the lobbies fill at nine. Half the tenants say they signed because of the metro.', unserved: 'Floors stand half let: tenants ask where the station is.' },
  },
  {
    id: 'ferris', name: 'Giant wheel', category: 'leisure', form: 'ferris', size: [1.4, 1.2], sites: ['water', 'centre'], buildMonths: 8, cost: 18e6,
    attr: 90, visitors: 1800, pattern: 'weekend', eventTrips: 3500, eventEvery: 3, value: 0.6, night: 'glow', unlock: { month: 36, pop: 12000 }, needs: { water: true },
    pitch: 'An amusement operator wants a giant observation wheel by the water. It is crowded on sunny weekends and festivals, quiet in winter.',
    followup: { served: 'Weekend queues for the wheel reach the metro entrance.', unserved: 'The wheel is lovely and the road to it is a car park.' },
  },
  {
    id: 'lighthouse', name: 'Lighthouse', category: 'heritage', form: 'lighthouse', size: [0.9, 0.9], sites: ['water', 'edge'], buildMonths: 6, cost: 8e6,
    attr: 40, visitors: 300, pattern: 'weekend', eventTrips: 900, eventEvery: 6, value: 0.4, night: 'beacon', unlock: { month: 24, pop: 6000 }, needs: { water: true },
    pitch: 'The harbour board wants a lighthouse on the point. It is a postcard, not a trip generator; tourists walk out to it on fine weekends.',
    followup: { served: 'The point is a favourite for weekend walks.', unserved: 'Few people make it out to the point without a car.' },
  },
  {
    id: 'fort', name: 'Hill fort', category: 'heritage', form: 'fort', size: [1.7, 1.7], sites: ['hill', 'edge'], buildMonths: 14, cost: 22e6,
    attr: 80, visitors: 800, pattern: 'weekend', eventTrips: 2500, eventEvery: 4, value: 0.8, night: 'floodlit', unlock: { month: 30, pop: 10000 }, needs: { hill: true },
    pitch: 'An old castle on the highest hill could be rebuilt as a museum fort with ramparts and a keep. A fine landmark, busy on weekends and open-air festival days.',
    followup: { served: 'The festival on the ramparts sells out; visitors come up by metro and shuttle bus.', unserved: 'Festival traffic on the hill road is a nightmare.' },
  },
  {
    id: 'brewery', name: 'Old brewery arts venue', category: 'heritage', form: 'brewery', size: [1.8, 1.4], sites: ['edge', 'water'], buildMonths: 10, cost: 20e6,
    attr: 160, visitors: 1100, pattern: 'events', eventTrips: 3200, eventEvery: 2, value: 0.7, night: 'glow', unlock: { month: 36, pop: 12000 },
    requires: { history: ['industrial'], origin: ['port', 'mining', 'rail-junction'] },
    pitch: 'An old brewery with a tall brick chimney could become a venue for markets, gigs and studios. Evenings and weekends are busy, and the chimney gets a lit crown.',
    followup: { served: 'The first night market draws crowds from every line.', unserved: 'The venue is a hit with the people who can drive there.' },
  },
];

export const LANDMARK_INDEX: Record<string, number> = Object.fromEntries(LANDMARKS.map((l, i) => [l.id, i + 1]));
export const landmarkAt = (lm: number): LandmarkDef | undefined => (lm > 0 ? LANDMARKS[lm - 1] : undefined);
