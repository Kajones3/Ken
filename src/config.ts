import type { ISODate } from "./dates.js";

export type OnTier = "value" | "moderate" | "deluxe";
export type OffTier = "budget" | "mid" | "upscale";
export type Tier = OnTier | OffTier;
export type Band = "infant" | "child" | "junior" | "adult";
export type FoodStyle = "grocery" | "qs" | "mix" | "ts" | "plan";
export type Stay = "on" | "off" | "both";
export type TierIndex = 0 | 1 | 2;

export const ON_TIERS: readonly OnTier[] = ["value", "moderate", "deluxe"];
export const OFF_TIERS: readonly OffTier[] = ["budget", "mid", "upscale"];

/** Round trips are cached in three length buckets rather than one row per exact length. */
export const TRIP_BUCKETS = [4, 7, 11] as const;
export function bucketFor(nights: number): number {
  let best: number = TRIP_BUCKETS[0]!;
  for (const b of TRIP_BUCKETS) if (Math.abs(b - nights) < Math.abs(best - nights)) best = b;
  return best;
}

export interface HotelDef {
  id: string; name: string; descriptor: string; base: number; tier: Tier; onProperty: boolean;
}

export interface Resort {
  id: string; name: string; city: string; iata: string;
  lat: number; lon: number; currency: string; parks: number;
  region: "dom" | "atl" | "pac";
  note: string;
  /** Short, hand-maintained facts that don't fit the price breakdown but
   *  change how someone should actually plan the trip — entry/visa notes,
   *  ticket-bundling quirks, anything that trips people up. Same
   *  "no live API, maintain it by hand" pattern as ticket_prices and
   *  airport_transport; keep entries short, cite what's checked vs. not,
   *  and re-check before relying on anything time-sensitive (visa rules
   *  especially — they change). */
  goodToKnow: string[];
  ticketUrl: string;
  /** Admission age bands differ at every resort. A 12-year-old is an adult in
   *  Orlando, a child in Paris, and a Junior in Tokyo. */
  bands: { freeUnder: number; child: [number, number]; junior?: [number, number]; adult: number };
  ticket: { base: number; child: number; junior?: number; slope: number; floor: number };
  food: { grocery: number; qs: number; mix: number; ts: number };
  /** Only Walt Disney World and Disneyland Paris sell dining plans. */
  plans: { label: string; adult: number; child: number }[];
  /** Per day. Off-property means paying to park at the parks. */
  transport: { on: number; off: number };
  hotels: HotelDef[];
}

const h = (id: string, name: string, descriptor: string, base: number, tier: Tier, onProperty: boolean): HotelDef =>
  ({ id, name, descriptor, base, tier, onProperty });

export const RESORTS: Resort[] = [
  {
    id: "wdw", name: "Walt Disney World", city: "Orlando, Florida", iata: "MCO",
    lat: 28.43, lon: -81.31, currency: "USD", parks: 4, region: "dom",
    note: "4 parks · park-hopper priced separately",
    goodToKnow: [
      "Park Hopper (same-day access to more than one park) and Genie+/Lightning Lane (paid line-skipping) are both sold separately from base admission and aren't priced here.",
    ],
    ticketUrl: "https://disneyworld.disney.go.com/admission/tickets/",
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    ticket: { base: 132, child: 0.93, slope: 0.058, floor: 0.58 },
    food: { grocery: 38, qs: 62, mix: 96, ts: 158 },
    plans: [
      { label: "Disney Dining Plan · Quick Service", adult: 62.78, child: 25.82 },
      { label: "Disney Dining Plan · Table Service", adult: 99.87, child: 31.94 },
      { label: "Disney Dining Plan · Deluxe", adult: 163.01, child: 46.85 },
    ],
    transport: { on: 0, off: 35 },
    hotels: [
      h("wdw-asm", "Disney's All-Star Movies", "Value resort", 178, "value", true),
      h("wdw-pop", "Disney's Pop Century", "Value resort", 265, "value", true),
      h("wdw-cbr", "Disney's Caribbean Beach", "Moderate resort", 271, "moderate", true),
      h("wdw-por", "Port Orleans Riverside", "Moderate resort", 268, "moderate", true),
      h("wdw-gdt", "Coronado Springs · Gran Destino", "Moderate resort", 328, "moderate", true),
      h("wdw-akl", "Animal Kingdom Lodge", "Deluxe resort", 509, "deluxe", true),
      h("wdw-wl", "Wilderness Lodge", "Deluxe resort", 533, "deluxe", true),
      h("wdw-cr", "Contemporary Resort", "Deluxe resort", 608, "deluxe", true),
      h("wdw-gf", "Grand Floridian", "Deluxe resort", 729, "deluxe", true),
      h("wdw-kis", "Kissimmee value chain", "Off property · 20 min", 195, "budget", false),
      h("wdw-lbv", "Lake Buena Vista 3-star", "Off property · 15 min", 215, "budget", false),
      h("wdw-bc", "Bonnet Creek area", "Off property · 10 min", 265, "mid", false),
      h("wdw-ds", "Disney Springs area hotel", "Off property · 5 min", 310, "mid", false),
      h("wdw-wa", "Waldorf Astoria Orlando", "Off property · 10 min", 465, "upscale", false),
      h("wdw-fs", "Four Seasons Orlando", "Off property · on WDW land", 820, "upscale", false),
    ],
  },
  {
    id: "dlr", name: "Disneyland Resort", city: "Anaheim, California", iata: "SNA",
    lat: 33.68, lon: -117.87, currency: "USD", parks: 2, region: "dom",
    note: "2 parks · walkable resort",
    goodToKnow: [
      "Park Hopper and paid Lightning Lane line-skipping are sold separately from base admission and aren't priced here.",
    ],
    ticketUrl: "https://disneyland.disney.go.com/tickets/",
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    ticket: { base: 148, child: 0.94, slope: 0.05, floor: 0.62 },
    food: { grocery: 40, qs: 66, mix: 100, ts: 162 },
    plans: [],
    transport: { on: 0, off: 40 },
    hotels: [
      h("dlr-pph", "Pixar Place Hotel", "On property · walkable", 410, "moderate", true),
      h("dlr-dlh", "Disneyland Hotel", "On property · walkable", 548, "deluxe", true),
      h("dlr-gch", "Grand Californian", "On property · park entrance", 675, "deluxe", true),
      h("dlr-hb", "Harbor Blvd 3-star", "Off property · walkable", 185, "budget", false),
      h("dlr-gn", "Good Neighbor mid-tier", "Off property · shuttle", 265, "mid", false),
      h("dlr-cc", "Convention Center hotel", "Off property · 15 min walk", 320, "mid", false),
      h("dlr-jw", "JW Marriott Anaheim", "Off property · 10 min", 425, "upscale", false),
    ],
  },
  {
    id: "dlp", name: "Disneyland Paris", city: "Marne-la-Vallée, France", iata: "CDG",
    lat: 49.01, lon: 2.55, currency: "EUR", parks: 2, region: "atl",
    note: "2 parks · already on dynamic pricing",
    goodToKnow: [
      "Booking directly through Disney's own website, on-property hotel stays are only sold bundled with park tickets — one combined price, tickets included for every day of your stay. A room-only stay (no tickets) does exist but isn't sold online; you'd need to call Disney directly or book through a third-party site. The hotel and ticket prices below are priced separately, matching a room-only stay — if you book Disney's own package instead, expect one combined price rather than these two added together.",
    ],
    ticketUrl: "https://www.disneylandparis.com/en-gb/tickets/",
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    ticket: { base: 78, child: 0.84, slope: 0.07, floor: 0.55 },
    food: { grocery: 30, qs: 49, mix: 80, ts: 128 },
    plans: [
      { label: "Half Board Plus meal plan", adult: 46, child: 26 },
      { label: "Full Board Plus meal plan", adult: 70, child: 39 },
    ],
    transport: { on: 0, off: 12 },
    hotels: [
      h("dlp-sf", "Disney Hotel Santa Fe", "Value · shuttle", 165, "value", true),
      h("dlp-ch", "Disney Hotel Cheyenne", "Value · shuttle", 198, "value", true),
      h("dlp-sl", "Disney Sequoia Lodge", "Moderate · walkable", 252, "moderate", true),
      h("dlp-nb", "Disney Newport Bay Club", "Moderate · walkable", 285, "moderate", true),
      h("dlp-dlh", "Disneyland Hotel", "Deluxe · park gates", 820, "deluxe", true),
      h("dlp-bsg", "Bussy-Saint-Georges hotel", "Off property · 12 min", 135, "budget", false),
      h("dlp-vde", "Val d'Europe hotel", "Off property · 8 min", 178, "mid", false),
      h("dlp-par", "Paris centre (RER A)", "Off property · 45 min", 245, "upscale", false),
    ],
  },
  {
    id: "tdr", name: "Tokyo Disney Resort", city: "Urayasu, Japan", iata: "NRT",
    lat: 35.76, lon: 140.39, currency: "JPY", parks: 2, region: "pac",
    note: "2 parks · run by Oriental Land Co. under licence",
    goodToKnow: [
      "Many nationalities (including US passport holders) can enter Japan visa-free for short tourist stays, but requirements depend on your passport — check current requirements before booking.",
    ],
    ticketUrl: "https://www.tokyodisneyresort.jp/en/ticket/",
    bands: { freeUnder: 4, child: [4, 11], junior: [12, 17], adult: 18 },
    ticket: { base: 63, child: 0.55, junior: 0.83, slope: 0.028, floor: 0.82 },
    food: { grocery: 22, qs: 35, mix: 56, ts: 94 },
    plans: [],
    transport: { on: 0, off: 14 },
    hotels: [
      h("tdr-ch", "Tokyo Disney Celebration Hotel", "Value · shuttle", 172, "value", true),
      h("tdr-ts", "Toy Story Hotel", "Value · monorail", 285, "value", true),
      h("tdr-tdh", "Tokyo Disneyland Hotel", "Deluxe · park gates", 495, "deluxe", true),
      h("tdr-mc", "Hotel MiraCosta", "Deluxe · inside DisneySea", 640, "deluxe", true),
      h("tdr-fs", "Fantasy Springs Hotel", "Deluxe · inside DisneySea", 720, "deluxe", true),
      h("tdr-su", "Shin-Urayasu business hotel", "Off property · 10 min", 138, "budget", false),
      h("tdr-ar", "Tokyo Bay Ariake", "Off property · 30 min", 178, "mid", false),
      h("tdr-mh", "Maihama partner hotel", "Off property · monorail", 215, "mid", false),
      h("tdr-cty", "Tokyo city 4-star", "Off property · 40 min", 285, "upscale", false),
    ],
  },
  {
    id: "shdr", name: "Shanghai Disney Resort", city: "Pudong, Shanghai", iata: "PVG",
    lat: 31.14, lon: 121.81, currency: "CNY", parks: 1, region: "pac",
    note: "1 park · tiered date pricing",
    goodToKnow: [
      "Most nationalities need a visa for mainland China — this is a different, separate requirement from Hong Kong's. Limited visa-free transit exemptions exist (up to 240 hours as of 2026) but generally only when continuing on to a third country, not for a simple round trip home. Check current requirements for your passport well before booking.",
      "Shanghai Disney's real ticket pricing bands some rides by height, not just age — not modeled here; the age-based child/adult split below is a simplification.",
    ],
    ticketUrl: "https://www.shanghaidisneyresort.com/en/tickets/",
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    ticket: { base: 82, child: 0.75, slope: 0.04, floor: 0.7 },
    food: { grocery: 18, qs: 31, mix: 49, ts: 82 },
    plans: [],
    transport: { on: 0, off: 10 },
    hotels: [
      h("shdr-ts", "Toy Story Hotel", "Value · shuttle", 165, "value", true),
      h("shdr-sdh", "Shanghai Disneyland Hotel", "Deluxe · lakeside", 305, "deluxe", true),
      h("shdr-pd", "Pudong business hotel", "Off property · 20 min", 98, "budget", false),
      h("shdr-adj", "Resort-adjacent hotel", "Off property · 10 min", 148, "mid", false),
      h("shdr-cty", "Shanghai city 5-star", "Off property · 45 min", 225, "upscale", false),
    ],
  },
  {
    id: "hkdl", name: "Hong Kong Disneyland", city: "Lantau Island, Hong Kong", iata: "HKG",
    lat: 22.31, lon: 113.91, currency: "HKD", parks: 1, region: "pac",
    note: "1 park · smallest of the six",
    goodToKnow: [
      "Hong Kong has its own immigration, separate from mainland China — many nationalities (including US passport holders, for roughly 90 days) can enter visa-free even though mainland China requires a visa for most visitors. If your trip also includes mainland China (e.g. Shanghai Disney), that needs its own separate check.",
    ],
    ticketUrl: "https://www.hongkongdisneyland.com/book/tickets/",
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    ticket: { base: 88, child: 0.72, slope: 0.045, floor: 0.68 },
    food: { grocery: 20, qs: 34, mix: 53, ts: 87 },
    plans: [],
    transport: { on: 0, off: 12 },
    hotels: [
      h("hkdl-hh", "Disney Hollywood Hotel", "Value · shuttle", 178, "value", true),
      h("hkdl-el", "Disney Explorers Lodge", "Moderate · shuttle", 232, "moderate", true),
      h("hkdl-hkd", "Hong Kong Disneyland Hotel", "Deluxe · walkable", 348, "deluxe", true),
      h("hkdl-kln", "Kowloon hotel", "Off property · 30 min MTR", 148, "budget", false),
      h("hkdl-tc", "Tung Chung hotel", "Off property · 10 min", 188, "mid", false),
      h("hkdl-hki", "Hong Kong Island 4-star", "Off property · 40 min", 275, "upscale", false),
    ],
  },
];

export const RESORT_BY_ID = new Map(RESORTS.map((r) => [r.id, r]));

export interface Origin { iata: string; name: string; lat: number; lon: number }
export const ORIGINS: Origin[] = [
  { iata: "ATL", name: "Atlanta", lat: 33.64, lon: -84.43 },
  { iata: "BOS", name: "Boston", lat: 42.36, lon: -71.01 },
  { iata: "BWI", name: "Baltimore", lat: 39.18, lon: -76.67 },
  { iata: "CLT", name: "Charlotte", lat: 35.21, lon: -80.94 },
  { iata: "DEN", name: "Denver", lat: 39.86, lon: -104.67 },
  { iata: "DFW", name: "Dallas–Fort Worth", lat: 32.9, lon: -97.04 },
  { iata: "DTW", name: "Detroit", lat: 42.21, lon: -83.35 },
  { iata: "IAH", name: "Houston", lat: 29.98, lon: -95.34 },
  { iata: "JFK", name: "New York JFK", lat: 40.64, lon: -73.78 },
  { iata: "LAS", name: "Las Vegas", lat: 36.08, lon: -115.15 },
  { iata: "LAX", name: "Los Angeles", lat: 33.94, lon: -118.41 },
  { iata: "MIA", name: "Miami", lat: 25.79, lon: -80.29 },
  { iata: "MSP", name: "Minneapolis", lat: 44.88, lon: -93.22 },
  { iata: "ORD", name: "Chicago O'Hare", lat: 41.98, lon: -87.9 },
  { iata: "PHL", name: "Philadelphia", lat: 39.87, lon: -75.24 },
  { iata: "PHX", name: "Phoenix", lat: 33.43, lon: -112.01 },
  { iata: "SEA", name: "Seattle", lat: 47.45, lon: -122.31 },
  { iata: "SFO", name: "San Francisco", lat: 37.62, lon: -122.38 },
];
export const ORIGIN_BY_IATA = new Map(ORIGINS.map((o) => [o.iata, o]));

/**
 * Getting to your home airport: parking there vs. Uber/Lyft/taxi vs.
 * transit where it exists. No live API for any of this either — same
 * situation as ticket prices. These are rough placeholder guesses for a
 * friends demo, not verified against current rates. Refine per-airport
 * before relying on them for anything real.
 */
export interface AirportTransportGuess {
  parkingPerDayUsd: number; rideshareRoundTripUsd: number;
  transitAvailable: boolean; transitRoundTripUsd?: number; note: string;
}
export const AIRPORT_TRANSPORT_GUESSES: Record<string, AirportTransportGuess> = {
  ATL: { parkingPerDayUsd: 12, rideshareRoundTripUsd: 60, transitAvailable: true, transitRoundTripUsd: 6, note: "MARTA runs straight to the terminal — guess" },
  BOS: { parkingPerDayUsd: 25, rideshareRoundTripUsd: 80, transitAvailable: true, transitRoundTripUsd: 5, note: "Blue Line + free Silver Line bus — guess" },
  BWI: { parkingPerDayUsd: 14, rideshareRoundTripUsd: 60, transitAvailable: true, transitRoundTripUsd: 12, note: "MARC/Amtrak from BWI station — guess" },
  CLT: { parkingPerDayUsd: 12, rideshareRoundTripUsd: 45, transitAvailable: false, note: "no useful rail transit — guess" },
  DEN: { parkingPerDayUsd: 10, rideshareRoundTripUsd: 70, transitAvailable: true, transitRoundTripUsd: 20, note: "A-Line commuter rail to Union Station — guess" },
  DFW: { parkingPerDayUsd: 11, rideshareRoundTripUsd: 65, transitAvailable: false, note: "TEXRail only reaches part of the metro — guess" },
  DTW: { parkingPerDayUsd: 9, rideshareRoundTripUsd: 55, transitAvailable: false, note: "no rail transit — guess" },
  IAH: { parkingPerDayUsd: 10, rideshareRoundTripUsd: 65, transitAvailable: false, note: "no rail transit — guess" },
  JFK: { parkingPerDayUsd: 20, rideshareRoundTripUsd: 145, transitAvailable: true, transitRoundTripUsd: 17, note: "AirTrain + subway/LIRR — guess" },
  LAS: { parkingPerDayUsd: 10, rideshareRoundTripUsd: 45, transitAvailable: false, note: "no direct rail to the strip — guess" },
  LAX: { parkingPerDayUsd: 15, rideshareRoundTripUsd: 100, transitAvailable: true, transitRoundTripUsd: 8, note: "LAX FlyAway bus / Metro C Line via shuttle — guess" },
  MIA: { parkingPerDayUsd: 15, rideshareRoundTripUsd: 70, transitAvailable: true, transitRoundTripUsd: 5, note: "MIA Mover to Metrorail — guess" },
  MSP: { parkingPerDayUsd: 10, rideshareRoundTripUsd: 55, transitAvailable: true, transitRoundTripUsd: 5, note: "Blue Line light rail straight to the terminal — guess" },
  ORD: { parkingPerDayUsd: 14, rideshareRoundTripUsd: 80, transitAvailable: true, transitRoundTripUsd: 10, note: "CTA Blue Line direct — guess" },
  PHL: { parkingPerDayUsd: 14, rideshareRoundTripUsd: 55, transitAvailable: true, transitRoundTripUsd: 14, note: "SEPTA Airport Line direct — guess" },
  PHX: { parkingPerDayUsd: 10, rideshareRoundTripUsd: 45, transitAvailable: true, transitRoundTripUsd: 4, note: "PHX Sky Train to Valley Metro light rail — guess" },
  SEA: { parkingPerDayUsd: 18, rideshareRoundTripUsd: 80, transitAvailable: true, transitRoundTripUsd: 6, note: "Link light rail direct — guess" },
  SFO: { parkingPerDayUsd: 22, rideshareRoundTripUsd: 100, transitAvailable: true, transitRoundTripUsd: 20, note: "BART direct — guess" },
};

/** Tiered freshness: near dates move, far dates don't. */
export const REFRESH_TIERS = [
  { name: "near", fromDay: 0, toDay: 60, everyDays: 1 },
  { name: "mid", fromDay: 61, toDay: 180, everyDays: 3 },
  { name: "far", fromDay: 181, toDay: 365, everyDays: 7 },
] as const;

export function shouldRefresh(tierName: string, dayOfYear: number): boolean {
  const t = REFRESH_TIERS.find((x) => x.name === tierName);
  if (!t) return false;
  return dayOfYear % t.everyDays === 0;
}

export type { ISODate };
