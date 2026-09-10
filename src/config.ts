import type { ISODate } from "./dates.js";

export type OnTier = "value" | "moderate" | "deluxe";
export type OffTier = "budget" | "mid" | "upscale";
export type Tier = OnTier | OffTier;
export type Band = "infant" | "child" | "junior" | "adult";
export type FoodStyle = "grocery" | "qs" | "mix" | "ts" | "plan";
export type Stay = "on" | "off" | "both" | "none";
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
   *  "no live API, maintain it by hand" pattern as ticket_prices; keep
   *  entries short, cite what's checked vs. not,
   *  and re-check before relying on anything time-sensitive (visa rules
   *  especially — they change). */
  goodToKnow: string[];
  /** How much to trust this resort's COST MODEL — whether the way we break a
   *  trip into lines actually matches how this resort sells one.
   *
   *  Omitted entirely means "no worse than the rest of the app": every
   *  ticket curve is an approximation (see seedTickets) and the Park Tickets
   *  card already says so. This field is for a resort with a gap BEYOND
   *  that — something structural the model does not represent at all, where
   *  a number could be wrong in a way the general disclaimer does not
   *  cover. Three qualify today: Shanghai bands tickets by height rather
   *  than age, Hong Kong's age bands were never checked against a source,
   *  and Disneyland Paris sells hotel and tickets as one bundle while we
   *  price them as two separate lines.
   *
   *  Same "no live API, maintain it by hand" pattern as goodToKnow. Remove
   *  the entry when the underlying gap is actually fixed — a badge that
   *  outlives its reason trains people to ignore badges. */
  dataConfidence?: {
    /** Short label for the badge itself. Keep it to a couple of words. */
    level: string;
    /** One plain sentence a non-technical traveller can act on. Say what is
     *  actually unmodelled, not that we are "still working on it". */
    note: string;
  };
  /** Where to check current attraction closures/refurbishments. Disney's own
   *  page where one exists (WDW, Disneyland Anaheim) — otherwise the best
   *  available fan-maintained tracker, and closuresLabel says which so this
   *  never reads as an official Disney source when it isn't one. No API for
   *  this exists anywhere; these are checked by hand same as everything
   *  else in goodToKnow. */
  closuresUrl: string;
  closuresLabel: string;
  ticketUrl: string;
  /** Other airports that reasonably serve this resort, besides the primary
   *  `iata`. Free to browse (board/compare always price the primary), but
   *  picking one of these is the one place a user can ask for a different
   *  airport's fares — always scoped to this resort's own list, never a
   *  bare IATA string trusted from elsewhere, so a WDW search can never be
   *  accidentally priced against Hong Kong's airport. */
  altArrivalAirports: { iata: string; label: string }[];
  /** Admission age bands differ at every resort. A 12-year-old is an adult in
   *  Orlando, a child in Paris, and a Junior in Tokyo. */
  bands: { freeUnder: number; child: [number, number]; junior?: [number, number]; adult: number };
  ticket: {
    base: number; child: number; junior?: number; slope: number; floor: number;
    /** Park Hopper as a flat per-ticket add-on, not scaled by day count or
     *  season the way base admission is — a simplification of Disney's real
     *  (also date-tiered) hopper pricing. Omitted entirely at Hong Kong and
     *  Shanghai, which each have one park and no hopper product to sell. */
    hopperAdultUsd?: number; hopperChildUsd?: number;
  };
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
    closuresUrl: "https://disneyworld.disney.go.com/calendars/day/#/magic-kingdom/",
    closuresLabel: "Official WDW closure calendar",
    ticketUrl: "https://disneyworld.disney.go.com/admission/tickets/",
    altArrivalAirports: [{ iata: "TPA", label: "Tampa — about 75 min from the resort" }],
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    // base recalibrated against real 2026 published one-day pricing ($119-209,
    // researched — see CLAUDE.md) so the off-peak floor no longer prices below
    // Disneyland's, which a flat 132 vs. 148 base did. Still a coarse two-
    // parameter approximation of a genuinely tiered, date-based system — not
    // a claim of exact per-date accuracy.
    ticket: { base: 140, child: 0.93, slope: 0.058, floor: 0.58, hopperAdultUsd: 90, hopperChildUsd: 84 },
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
    closuresUrl: "https://disneyland.disney.go.com/construction-closures-updates/",
    closuresLabel: "Official Disneyland closure calendar",
    ticketUrl: "https://disneyland.disney.go.com/tickets/",
    altArrivalAirports: [{ iata: "LAX", label: "Los Angeles — about 45 min from the resort, often more fare options" }],
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    // base recalibrated against real 2026 published one-day pricing ($104-224,
    // researched — see CLAUDE.md): the old 148 sat *above* WDW's 132, which
    // inverted the two resorts' off-peak ordering versus reality. Still a
    // coarse approximation, not exact per-date accuracy — see the note on WDW.
    ticket: { base: 128, child: 0.94, slope: 0.05, floor: 0.62, hopperAdultUsd: 75, hopperChildUsd: 70 },
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
    closuresUrl: "https://news.disneylandparis.com/en/",
    closuresLabel: "Official Disneyland Paris news (closure announcements)",
    // Beauvais dropped (2026-09-10): it is a budget-carrier base with no US
    // service, so every real-fare lookup against it returns nothing while
    // still costing a metered search. CDG is the only Paris gateway a US
    // traveller actually arrives at.
    altArrivalAirports: [],
    goodToKnow: [
      "Following on from the pricing note above: if you do want the room-only stay this breakdown assumes, it isn't bookable on Disney's own site — call Disney directly, or book the hotel through a third party such as Booking.com or Expedia and buy park tickets separately. Worth pricing both ways; which comes out cheaper depends on the dates and the package on offer.",
      "Space Mountain (currently Star Wars Hyperspace Mountain) is confirmed to close at the end of 2027 for a months-long refurbishment back to its original 1995 Jules Verne theme — not 2026. No reopening date is confirmed yet. Worth checking the closure calendar below before booking a trip built around this ride.",
    ],
    ticketUrl: "https://www.disneylandparis.com/en-gb/tickets/",
    // Disney sells Paris as a hotel + ticket PACKAGE by default — a room-only
    // stay exists but is not sold online. We price room and tickets as two
    // separate lines, which matches the room-only booking most people will
    // not actually make. Deliberately not "fixed" in the pricing math:
    // package rates are not published, so inventing one would be less honest
    // than a clearly-labelled room-only basis. Labelled here instead.
    dataConfidence: {
      level: "Priced room-only",
      note: "Disney's own site sells Disneyland Paris as a hotel + ticket package, with tickets included for every day of your stay — a room-only stay exists but isn't sold online. We price the room and the tickets as two separate lines, so a real Disney quote may be structured quite differently from the breakdown below. Compare against an actual package quote before you budget on it.",
    },
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    // hopperAdultUsd/hopperChildUsd are an unresearched guess (roughly 20% of
    // base) — weaker confidence than WDW/Disneyland's, which came from an
    // actual 2026 price check. Refine before relying on this one.
    ticket: { base: 78, child: 0.84, slope: 0.07, floor: 0.55, hopperAdultUsd: 45, hopperChildUsd: 38 },
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
      "For U.S. passport holders: no visa is required for tourist stays of 90 days or less — just a valid passport and (usually) proof of an onward/return ticket. This is specifically for U.S. citizens; other nationalities should check their own requirements. Source: U.S. State Department Japan travel page (travel.state.gov) and the U.S. Embassy in Japan — checked at write time, always confirm current requirements before booking.",
    ],
    closuresUrl: "https://touringplans.com/tokyo-disney/closures",
    closuresLabel: "Unofficial refurbishment tracker (TouringPlans, not Disney)",
    ticketUrl: "https://www.tokyodisneyresort.jp/en/ticket/",
    altArrivalAirports: [{ iata: "HND", label: "Haneda — closer to central Tokyo, often cheaper than Narita" }],
    bands: { freeUnder: 4, child: [4, 11], junior: [12, 17], adult: 18 },
    // hopperAdultUsd/hopperChildUsd are an unresearched guess (roughly 20% of
    // base) — weaker confidence than WDW/Disneyland's, which came from an
    // actual 2026 price check. Refine before relying on this one.
    ticket: { base: 63, child: 0.55, junior: 0.83, slope: 0.028, floor: 0.82, hopperAdultUsd: 38, hopperChildUsd: 21 },
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
      "For U.S. passport holders: a visa is required to enter mainland China — you must get it before you travel (most U.S. tourists apply for a 10-year multiple-entry tourist visa). This is a different, separate requirement from Hong Kong's. Limited visa-free transit exemptions exist (up to 240 hours as of 2026) but generally only when continuing on to a third country, not for a simple round trip home. Source: U.S. State Department China travel page (travel.state.gov) — checked at write time, always confirm current requirements and processing time before booking, since a visa can take days to weeks to arrange.",
      "Shanghai Disney's real ticket pricing bands some rides by height, not just age — not modeled here; the age-based child/adult split below is a simplification.",
    ],
    closuresUrl: "https://wdwnt.com/refurbishments-and-closures/",
    closuresLabel: "Unofficial refurbishment tracker (WDWNT, not Disney)",
    ticketUrl: "https://www.shanghaidisneyresort.com/en/tickets/",
    // Hongqiao dropped (2026-09-10): mostly domestic/regional China routes,
    // so a US-origin lookup returns nothing and still costs a metered search.
    // PVG is the real gateway.
    altArrivalAirports: [],
    // Shanghai prices children by HEIGHT (1.0-1.4m), not age — a different
    // system from every other resort here, and one this model does not
    // represent at all. The age bands below are a stand-in taken from model
    // knowledge rather than a source, so a family's ticket total can be off
    // in a way the general ticket disclaimer does not cover.
    dataConfidence: {
      level: "Rough ticket pricing",
      note: "Shanghai charges children by height (1.0–1.4m), not age. We price by age like the other resorts, so if your child is near either cut-off the ticket total could be noticeably off. Check the official ticket page before you budget on it.",
    },
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
      "For U.S. passport holders: no visa is required for tourist stays of 90 days or less — Hong Kong has its own immigration, separate from mainland China, even though mainland China requires a visa for most U.S. visitors. Just need a passport valid 6+ months. If your trip also includes mainland China (e.g. Shanghai Disney), that's a separate, additional visa requirement — see that resort's notes. Source: U.S. Consulate General Hong Kong & Macau — checked at write time, always confirm current requirements before booking.",
    ],
    closuresUrl: "https://wdwnt.com/refurbishments-and-closures/",
    closuresLabel: "Unofficial refurbishment tracker (WDWNT, not Disney)",
    ticketUrl: "https://www.hongkongdisneyland.com/book/tickets/",
    altArrivalAirports: [],
    // Hong Kong's age bands come from model knowledge, not a checked source
    // — unlike Tokyo's and Paris's, which were verified against official
    // pages. Flagged until someone confirms them against Hong Kong
    // Disneyland's own ticket page.
    dataConfidence: {
      level: "Unverified age bands",
      note: "We haven't confirmed Hong Kong's child/adult ticket ages against an official source, so a family's ticket total is our least certain of the six. Worth checking the official ticket page before you budget on it.",
    },
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
  { iata: "IAD", name: "Washington, D.C. (Dulles)", lat: 38.94, lon: -77.46 },
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

/**
 * Driving-cost assumptions. US-only for now — no clean public data source
 * for road distance/fuel economy conventions in Europe or Asia the way EIA
 * and the interstate highway system make this tractable for the US. All
 * three numbers are guesses; refine before relying on them for anything real.
 */
export const DRIVING = {
  /** National-average passenger-vehicle fuel economy. */
  mpg: 25,
  /** Real road-trip miles run longer than a straight line — guess. */
  roadDistanceFactor: 1.25,
  /** A budget motel room for an optional overnight stop, if the user doesn't type their own. */
  overnightHotelGuessUsd: 120,
  /** Used only if the gas-price cache has no row yet (a fresh deploy before its first refresh). */
  fallbackGasPriceUsd: 3.15,
} as const;

/**
 * 2026 IRS standard mileage rate — the real published figure, not a guess,
 * covering wear and tear on the user's own car (depreciation, maintenance,
 * insurance — everything gas doesn't already cover). Two rates a year;
 * month-only lookup so it works the same way regardless of which year a
 * cached trip date falls in, same "ignore the year" convention seasonality.ts
 * already uses. Needs a real annual refresh — the IRS sets a new rate every
 * December for the following year.
 */
export function irsMileageRatePerMile(dateISO: string): number {
  const month = Number(dateISO.slice(5, 7));
  return month <= 6 ? 0.725 : 0.76;
}

/**
 * A flat national-average daily economy-car rental rate — real rates vary a
 * lot by city and season (2026 research: roughly $55-95/day generally,
 * $49-78/day for economy specifically; Miami runs cheap, Chicago runs
 * pricey). One guess, not a per-city table — a rental's daily rate doesn't
 * move date-to-date the way a flight or gas price does, so this doesn't need
 * its own refresh job or provider module, just this one hand-picked number,
 * same footing as DRIVING's other guesses. Refine (ideally into a real
 * per-city rate, ideally from a real provider) before relying on it.
 */
export const CAR_RENTAL = {
  dailyRateUsd: 65,
} as const;

/**
 * RSS feeds checked for a private, owner-only digest email — never surfaced
 * to end users automatically (see src/jobs/newsDigest.ts). Best-guess feed
 * URLs based on each site's standard WordPress /feed/ convention, not
 * fetched and confirmed from this environment — verify these resolve on
 * the first real run (check the GitHub Actions log) before relying on them.
 */
export const NEWS_FEEDS: { url: string; label: string }[] = [
  { url: "https://wdwnt.com/tag/closures-and-refurbishments/feed/", label: "WDWNT — closures & refurbishments" },
  { url: "https://news.disneylandparis.com/en/feed/", label: "Disneyland Paris official news" },
  { url: "https://wdwnt.com/tag/deals/feed/", label: "WDWNT — deals & promotions" },
];

export type { ISODate };
