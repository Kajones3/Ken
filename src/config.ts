import type { ISODate } from "./dates.js";
import { haversineMiles } from "./geo.js";

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
    // Value/moderate bases recalibrated 2026-09-15 against real 2026 nightly
    // rates researched in EUR/USD across booking sites — the old bases sat
    // below researched "from" prices for all four. Disneyland Hotel (the
    // flagship, castle-adjacent property) had no comparably reliable
    // research figure to check against — left unchanged, still a guess.
    hotels: [
      h("dlp-sf", "Disney Hotel Santa Fe", "Value · shuttle", 190, "value", true),
      h("dlp-ch", "Disney Hotel Cheyenne", "Value · shuttle", 205, "value", true),
      h("dlp-sl", "Disney Sequoia Lodge", "Moderate · walkable", 270, "moderate", true),
      h("dlp-nb", "Disney Newport Bay Club", "Moderate · walkable", 320, "moderate", true),
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
    // On-property bases recalibrated 2026-09-15 against real 2026 nightly
    // rates researched in JPY and converted (Celebration ~JPY22,000, Toy
    // Story ~JPY38,000, Tokyo Disneyland Hotel ~JPY54,000, MiraCosta
    // ~JPY62,000, Fantasy Springs ~JPY90,000, at roughly JPY150/USD) — the
    // old bases undershot the value tier and overshot Tokyo Disneyland
    // Hotel/MiraCosta. Sources disagreed by a wide margin on MiraCosta and
    // Fantasy Springs specifically (themed suites vs. standard rooms), so
    // those two remain a rougher approximation than the other three.
    hotels: [
      h("tdr-ch", "Tokyo Disney Celebration Hotel", "Value · shuttle", 195, "value", true),
      h("tdr-ts", "Toy Story Hotel", "Value · monorail", 300, "value", true),
      h("tdr-tdh", "Tokyo Disneyland Hotel", "Deluxe · park gates", 420, "deluxe", true),
      h("tdr-mc", "Hotel MiraCosta", "Deluxe · inside DisneySea", 560, "deluxe", true),
      h("tdr-fs", "Fantasy Springs Hotel", "Deluxe · inside DisneySea", 680, "deluxe", true),
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
    // On-property bases recalibrated 2026-09-15 against real 2026 nightly
    // rates researched in CNY and converted (Toy Story ~CNY1,200-3,000,
    // Shanghai Disneyland Hotel ~CNY1,800-3,500, at roughly CNY7/USD) — the
    // old bases sat below even the low end of the researched range.
    hotels: [
      h("shdr-ts", "Toy Story Hotel", "Value · shuttle", 215, "value", true),
      h("shdr-sdh", "Shanghai Disneyland Hotel", "Deluxe · lakeside", 370, "deluxe", true),
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
/**
 * Extra departure airports a Plus subscriber can pick, beyond the 19 free
 * metros above.
 *
 * Why the split exists: every origin multiplies the nightly and monthly
 * pre-caching bill, so the free list stays at the big metros most people can
 * reach. But "nearest big airport" is a real compromise — someone in Raleigh
 * is offered Charlotte, three hours away, and the fare they'd actually pay is
 * a different number. Plus removes that compromise, and it pays for itself:
 * a Plus user can buy the exact fare on their own airport.
 *
 * These are NOT pre-cached the way the free 19 are. They are covered by BTS
 * (the survey includes every US airport — see btsBaseline's origin filter,
 * which now spans both lists), so a Plus user gets a real estimate on them
 * immediately, and can pay to check any specific date exactly.
 */
export const PLUS_ORIGINS: Origin[] = [
  { iata: "RDU", name: "Raleigh–Durham", lat: 35.88, lon: -78.79 },
  { iata: "AUS", name: "Austin", lat: 30.19, lon: -97.67 },
  { iata: "BNA", name: "Nashville", lat: 36.13, lon: -86.68 },
  { iata: "CLE", name: "Cleveland", lat: 41.41, lon: -81.85 },
  { iata: "CMH", name: "Columbus", lat: 39.998, lon: -82.89 },
  { iata: "CVG", name: "Cincinnati", lat: 39.05, lon: -84.67 },
  { iata: "IND", name: "Indianapolis", lat: 39.72, lon: -86.29 },
  { iata: "JAX", name: "Jacksonville", lat: 30.49, lon: -81.69 },
  { iata: "MCI", name: "Kansas City", lat: 39.3, lon: -94.71 },
  { iata: "MKE", name: "Milwaukee", lat: 42.95, lon: -87.9 },
  { iata: "MSY", name: "New Orleans", lat: 29.99, lon: -90.26 },
  { iata: "OAK", name: "Oakland", lat: 37.71, lon: -122.22 },
  { iata: "PDX", name: "Portland", lat: 45.59, lon: -122.6 },
  { iata: "PIT", name: "Pittsburgh", lat: 40.49, lon: -80.23 },
  { iata: "RSW", name: "Fort Myers", lat: 26.54, lon: -81.76 },
  { iata: "SAN", name: "San Diego", lat: 32.73, lon: -117.19 },
  { iata: "SAT", name: "San Antonio", lat: 29.53, lon: -98.47 },
  { iata: "SJC", name: "San Jose", lat: 37.36, lon: -121.93 },
  { iata: "SLC", name: "Salt Lake City", lat: 40.79, lon: -111.98 },
  { iata: "SMF", name: "Sacramento", lat: 38.7, lon: -121.59 },
  { iata: "STL", name: "St. Louis", lat: 38.75, lon: -90.37 },
  { iata: "TPA", name: "Tampa", lat: 27.98, lon: -82.53 },
];

/** Every departure airport the app knows, free and Plus together. */
export const ALL_ORIGINS: Origin[] = [...ORIGINS, ...PLUS_ORIGINS];

/** Resolves any known origin. Callers that must enforce the free/Plus split
 *  check membership of ORIGINS separately — this map deliberately does not,
 *  so pricing and distance maths work the same for either list. */
export const ORIGIN_BY_IATA = new Map(ALL_ORIGINS.map((o) => [o.iata, o]));

/** Is this airport free for everyone, or does picking it need Plus? */
export function originNeedsPlus(iata: string): boolean {
  return PLUS_ORIGINS.some((o) => o.iata === iata);
}

/** Every arrival airport the app prices, mapped back to the resort it serves.
 *  Primaries and alternates both, so a lookup can start from a bare IATA code
 *  that came out of a route table rather than a resort object. */
export const RESORT_BY_ARRIVAL_AIRPORT = new Map(
  RESORTS.flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)].map((iata) => [iata, r] as const)),
);

/**
 * Below this, flying is not a thing anyone does — you drive.
 *
 * Picked against the real distances rather than by feel. Every origin the app
 * knows, measured to the two domestic resorts: LAX→Disneyland 36 miles,
 * SAN→Disneyland 77, TPA→WDW 81, then a clear gap to RSW→WDW 133, JAX→WDW
 * 144, MIA→WDW 193 and LAS→Disneyland 226. The first three are drives nobody
 * would fly; the last four are genuine, scheduled, regularly-flown routes.
 * 100 sits in the gap, so the rule catches the nonsense without ever
 * withholding a fare someone might really book.
 */
export const NO_FLY_RADIUS_MILES = 100;

/**
 * True when pricing this route is pointless because the traveller is already
 * there. Two cases, and both were really happening every night:
 *
 *   1. The same airport at both ends. LAX is a departure airport AND one of
 *      Disneyland's arrival airports, so the refresh asked for LAX→LAX six
 *      times a night and Travelpayouts rejected every one of them.
 *   2. Different airports, same metro. LAX→SNA failed the same way, because
 *      Travelpayouts resolves SNA to the Los Angeles city code and then sees
 *      an origin and destination that are equal.
 *
 * Worth catching in one shared place rather than at each call site: the
 * nightly rotation would otherwise spend real SerpApi money on these (they
 * are in its 171-route pool and have never been bought, so they sort to the
 * FRONT of the stalest-first queue), and an exact-fare click would spend a
 * metered lookup to be told what we already know.
 *
 * Deliberately NOT a claim about whether the trip is worth taking — someone
 * in Los Angeles absolutely may visit Disneyland. It is a claim about the
 * flight only. Driving is priced separately and is unaffected.
 */
export function isLocalRoute(originIata: string, destinationIata: string): boolean {
  if (!originIata || !destinationIata) return false;
  if (originIata === destinationIata) return true;
  const resort = RESORT_BY_ARRIVAL_AIRPORT.get(destinationIata);
  return Boolean(resort && isLocalToResort(originIata, resort));
}

/** Shared by both directions of the rule, so "too close to fly" and "close
 *  enough to drive" can never disagree about the same pair of points. */
function isLocalToResort(originIata: string, resort: Resort): boolean {
  const origin = ORIGIN_BY_IATA.get(originIata);
  if (!origin) return false;
  return haversineMiles(origin.lat, origin.lon, resort.lat, resort.lon) < NO_FLY_RADIUS_MILES;
}

/**
 * The resort this departure airport is close enough to drive to, if any.
 *
 * The other half of `isLocalRoute`, and the useful half for a traveller:
 * having established that someone departing LAX will not be flying to
 * Disneyland, the board should say what they WILL do — drive to Disneyland,
 * fly to the other five — rather than show a gap where the nearest resort's
 * price ought to be.
 *
 * Domestic only, and that is a real limit rather than an oversight:
 * `priceTrip` refuses to price a drive to any resort outside the US, so
 * "local to Paris" has nowhere to go even if someone departed from CDG.
 * Nearest wins if two ever qualify (none do today — Orlando and Anaheim are
 * 2,000 miles apart).
 */
export function localResortFor(originIata: string): Resort | null {
  if (!originIata) return null;
  const origin = ORIGIN_BY_IATA.get(originIata);
  if (!origin) return null;
  return RESORTS
    .filter((r) => r.region === "dom" && isLocalToResort(originIata, r))
    .sort((a, b) =>
      haversineMiles(origin.lat, origin.lon, a.lat, a.lon)
      - haversineMiles(origin.lat, origin.lon, b.lat, b.lon))[0] ?? null;
}

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
 * The IRS standard mileage rates we actually have on file, newest last, each
 * tagged with the year it was published FOR. This covers wear and tear on the
 * user's own car (depreciation, maintenance, insurance — everything gas
 * doesn't already cover). The IRS can change the rate mid-year, so each year
 * carries both halves.
 *
 * These are real published figures, not guesses. ADDING A YEAR IS A MANUAL
 * JOB: the IRS publishes the next year's rate around the middle of December.
 * Look it up at irs.gov ("standard mileage rates"), then add one row here.
 * Never invent a future year's number — an unpublished rate is exactly what
 * the carry-forward warning below exists to tell you about.
 */
export const IRS_MILEAGE_RATES: readonly {
  year: number; janToJunPerMile: number; julToDecPerMile: number;
}[] = [
  { year: 2026, janToJunPerMile: 0.725, julToDecPerMile: 0.76 },
];

/**
 * How far past the newest year on file a trip may still be priced, by carrying
 * that year's rate forward with a label on it.
 *
 * One year, deliberately. The app prices 365 days ahead, so at any moment the
 * furthest-out bookable trip is at most one calendar year past the current
 * one — which means a one-year allowance covers the whole booking window and
 * the app never breaks just because it's January and the IRS hasn't published
 * yet. Past that, the rate on file is old enough that quietly reusing it would
 * be a real misstatement of cost, so priceTrip refuses instead. In practice
 * that only happens if the warnings get ignored for more than a full year.
 */
export const MILEAGE_RATE_CARRY_FORWARD_YEARS = 1;

export type MileageRateLookup =
  | {
      ok: true;
      ratePerMile: number;
      /** The year the IRS published this rate for. */
      rateYear: number;
      /** The year the trip itself falls in. */
      tripYear: number;
      /** True when tripYear has no published rate and rateYear's was reused. */
      carriedForward: boolean;
    }
  | { ok: false; tripYear: number; newestYearOnFile: number; reason: string };

/** The most recent year IRS_MILEAGE_RATES has a published rate for. */
export function newestMileageRateYear(): number {
  return Math.max(...IRS_MILEAGE_RATES.map((r) => r.year));
}

/**
 * The IRS rate to use for a trip starting on `dateISO`, and whether it's the
 * real rate for that year or an older one carried forward.
 *
 * Year-aware on purpose. This used to read only the month and hand back the
 * 2026 figure for any date in any year, which meant a 2028 trip was silently
 * priced on a two-year-old rate with nothing anywhere saying so. Now a trip in
 * a year with no rate on file still prices — the alternative is breaking every
 * driving comparison each January — but it comes back flagged, and the owner
 * gets told (news-digest email) that a new figure is due. Deliberately NOT
 * shown to end users; see mileageRateStatus below and MileageRateUsed in
 * pricing.ts.
 */
export function irsMileageRate(dateISO: string): MileageRateLookup {
  const tripYear = Number(dateISO.slice(0, 4));
  const month = Number(dateISO.slice(5, 7));
  const newestYearOnFile = newestMileageRateYear();
  if (!Number.isFinite(tripYear) || !Number.isFinite(month)) {
    return { ok: false, tripYear, newestYearOnFile, reason: `not a real date: ${dateISO}` };
  }
  const exact = IRS_MILEAGE_RATES.find((r) => r.year === tripYear);
  const half = (r: { janToJunPerMile: number; julToDecPerMile: number }) =>
    (month <= 6 ? r.janToJunPerMile : r.julToDecPerMile);
  if (exact) {
    return { ok: true, ratePerMile: half(exact), rateYear: tripYear, tripYear, carriedForward: false };
  }
  // A trip in a year we have no figure for yet. Carry the newest one forward
  // if it's recent enough to still be defensible, otherwise refuse — pricing
  // must never quietly guess (see the {ok:false} contract in pricing.ts).
  const newest = IRS_MILEAGE_RATES.find((r) => r.year === newestYearOnFile)!;
  const gap = tripYear - newestYearOnFile;
  if (gap > 0 && gap <= MILEAGE_RATE_CARRY_FORWARD_YEARS) {
    return { ok: true, ratePerMile: half(newest), rateYear: newestYearOnFile, tripYear, carriedForward: true };
  }
  return {
    ok: false, tripYear, newestYearOnFile,
    reason: gap > 0
      ? `no IRS mileage rate on file for ${tripYear} — the newest one we have is ${newestYearOnFile}`
      : `no IRS mileage rate on file for ${tripYear} — rates only go back to ${Math.min(...IRS_MILEAGE_RATES.map((r) => r.year))}`,
  };
}

/**
 * Whether the rates on file still cover everything the app can price, for the
 * owner-facing warning. `horizonDays` is the booking window the app actually
 * offers (365 days — see calendar() in server.ts).
 */
export function mileageRateStatus(todayISO: string, horizonDays = 365): {
  newestYearOnFile: number;
  /** Years inside the booking window with no published rate. Empty when covered. */
  uncoveredYears: number[];
  /** True when some bookable date is beyond the carry-forward window, so driving trips there won't price at all. */
  pricingBroken: boolean;
} {
  const newestYearOnFile = newestMileageRateYear();
  const start = new Date(`${todayISO}T00:00:00Z`);
  const end = new Date(start.getTime() + horizonDays * 86_400_000);
  const uncoveredYears: number[] = [];
  let pricingBroken = false;
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
    if (IRS_MILEAGE_RATES.some((r) => r.year === y)) continue;
    uncoveredYears.push(y);
    if (y - newestYearOnFile > MILEAGE_RATE_CARRY_FORWARD_YEARS || y < newestYearOnFile) pricingBroken = true;
  }
  return { newestYearOnFile, uncoveredYears, pricingBroken };
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
