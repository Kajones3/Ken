import { CLIMATE_ROWS, CLIMATE_SOURCE, type ClimateRow } from "./climateData.js";
import type { ISODate } from "./dates.js";
import { haversineMiles } from "./geo.js";

export type OnTier = "value" | "moderate" | "deluxe";
export type OffTier = "budget" | "mid" | "upscale";
export type Tier = OnTier | OffTier;
export type Band = "infant" | "child" | "junior" | "adult";
export type FoodStyle = "grocery" | "qs" | "mix" | "ts" | "plan";
export type Stay = "on" | "off" | "none";
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
  /** Each park and the lands inside it, for the "what does this resort
   *  actually have" half of the shared PDF. `parks` above stays the count
   *  the board shows; config.test.ts pins the two against each other so a
   *  park added here and not there (or the reverse) fails a test rather
   *  than producing a page that contradicts its own summary line.
   *
   *  HAND-MAINTAINED, and the shipped rows are a CLAUDE DRAFT the owner
   *  corrects — same standing as the four international hotel baselines and
   *  the visa notes. Lands are renamed and rebuilt (Shanghai gained Zootopia,
   *  Hong Kong gained World of Frozen, Walt Disney World is rebuilding
   *  DinoLand), so treat an unchecked row as plausible, not confirmed. */
  parkList: { name: string; lands: string[] }[];
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
  /** Where to send somebody who wants to book a Disney-owned hotel. Disney's
   *  own site, never Booking.com: an on-property room is Disney's product and
   *  a Booking.com search for "Disney's Pop Century" is a worse answer than
   *  Disney's own page, whatever it does for commission.
   *
   *  `byTier` exists because Walt Disney World publishes a page per category
   *  and the owner asked for the category page, not the index — somebody who
   *  picked Moderate should land on the Moderate list. Every other resort has
   *  one hotel page, so they set `url` alone and every tier resolves to it.
   *
   *  Resolve with onPropertyHotelUrl(), never by reading these directly, so
   *  the "category page if there is one, index otherwise" rule has one home. */
  onPropertyHotels: { url: string; byTier?: Partial<Record<OnTier, string>> };
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
    /** PUBLISHED MULTI-DAY TOTALS for an adult, index 0 = one day.
     *
     *  The `slope`/`floor` pair below is a straight line, and Disney's real
     *  multi-day curve is not one: at Walt Disney World days two to four
     *  barely discount at all and then day five falls off a cliff (the
     *  marginal cost of day five is $35 against day three's $140). No single
     *  slope fits both halves, so where real totals exist they are stored
     *  here AS PUBLISHED and the discount is derived from them —
     *  ticketMultiDay() turns them into the same kind of factor the curve
     *  produced, so nothing downstream changes and seasonality still comes
     *  from the nightly ticket_prices table.
     *
     *  The curve stays for every resort without a real table, and for trips
     *  longer than one covers. Store the totals, never the factors: a total
     *  is a number somebody can check against Disney's own page. */
    multiDayAdultUsd?: number[];
    /** Park Hopper add-on per ticket BY DAY COUNT, index 0 = one day. A flat
     *  figure was always a simplification; at Disneyland the real add-on
     *  nearly doubles between a one-day and a five-day ticket ($70 to $135),
     *  which a single number cannot say. hopperAdultUsd stays as the
     *  fallback for resorts with no table. */
    hopperByDaysUsd?: number[];
    /** Park Hopper as a flat per-ticket add-on, not scaled by day count or
     *  season the way base admission is — a simplification of Disney's real
     *  (also date-tiered) hopper pricing. Omitted entirely at Hong Kong and
     *  Shanghai, which each have one park and no hopper product to sell. */
    hopperAdultUsd?: number; hopperChildUsd?: number;
  };
  food: { grocery: number; qs: number; mix: number; ts: number };
  /**
   * A few named restaurants per dining style, so "table service" is not just
   * a number — the owner's ask (2026-09-25): "if I want to do table service,
   * I need to know that Sanaa is $XX per person." Priced the way Disney
   * prices its own dining guide, by $ tier rather than a claimed dollar
   * figure ($ under ~$15/person, $$ ~$15-35, $$$ ~$35-60, $$$$ over ~$60) —
   * a real menu varies by what you order far more than this model can, so a
   * tier is the honest amount of precision to claim.
   *
   * CLAUDE'S OWN LIST, same standing as the starter attraction rows and the
   * illustrative promo rows: real, well-known restaurant names, not
   * hand-verified against a current menu or a resort's current lineup
   * (restaurants close and reopen more often than attractions do). Replace
   * or correct before relying on a specific name being open.
   */
  foodExamples?: { qs?: { name: string; tier: string }[]; ts?: { name: string; tier: string }[] };
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
    parkList: [
      { name: "Magic Kingdom", lands: ["Main Street, U.S.A.", "Adventureland", "Frontierland", "Liberty Square", "Fantasyland", "Tomorrowland"] },
      { name: "EPCOT", lands: ["World Celebration", "World Discovery", "World Nature", "World Showcase"] },
      { name: "Disney's Hollywood Studios", lands: ["Hollywood Boulevard", "Echo Lake", "Grand Avenue", "Star Wars: Galaxy's Edge", "Toy Story Land", "Animation Courtyard", "Sunset Boulevard"] },
      { name: "Disney's Animal Kingdom", lands: ["Discovery Island", "Pandora \u2013 The World of Avatar", "Africa", "Asia", "DinoLand U.S.A."] },
    ],
    goodToKnow: [
      "Park Hopper (same-day access to more than one park) and Genie+/Lightning Lane (paid line-skipping) are both sold separately from base admission and aren't priced here.",
    ],
    closuresUrl: "https://disneyworld.disney.go.com/calendars/day/#/magic-kingdom/",
    closuresLabel: "Official WDW closure calendar",
    ticketUrl: "https://disneyworld.disney.go.com/admission/tickets/",
    onPropertyHotels: {
      url: "https://disneyworld.disney.go.com/resorts/",
      byTier: {
        value: "https://disneyworld.disney.go.com/resorts/#/value/",
        moderate: "https://disneyworld.disney.go.com/resorts/#/moderate/",
        deluxe: "https://disneyworld.disney.go.com/resorts/#/deluxe/",
      },
    },
    altArrivalAirports: [{ iata: "TPA", label: "Tampa — about 75 min from the resort" }],
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    // base recalibrated against real 2026 published one-day pricing ($119-209,
    // researched — see CLAUDE.md) so the off-peak floor no longer prices below
    // Disneyland's, which a flat 132 vs. 148 base did. Still a coarse two-
    // parameter approximation of a genuinely tiered, date-based system — not
    // a claim of exact per-date accuracy.
    /* OWNER DATA, 2026-09-23. Published multi-day totals, standard mid-season,
       tax excluded. Adult 1-7 days: 149/275/415/530/565/590/620. Child (3-9)
       runs $5-20 under adult, which is 0.966 at one day — the old 0.93 made a
       child $10 cheaper than Disney does. Hopper adds $70 at one day rising to
       $95 at seven; the old flat $90 overcharged every short trip. */
    ticket: {
      base: 149, child: 0.966, slope: 0.058, floor: 0.58,
      multiDayAdultUsd: [149, 275, 415, 530, 565, 590, 620],
      hopperByDaysUsd: [70, 80, 80, 85, 90, 95, 95],
      hopperAdultUsd: 85, hopperChildUsd: 85,
    },
    food: { grocery: 38, qs: 62, mix: 96, ts: 158 },
    foodExamples: {
      qs: [{ name: "Satu'li Canteen", tier: "$$" }, { name: "Docking Bay 7", tier: "$$" }],
      ts: [{ name: "'Ohana", tier: "$$$" }, { name: "Topolino's Terrace", tier: "$$$$" }, { name: "Sanaa", tier: "$$$" }],
    },
    plans: [
      { label: "Disney Dining Plan · Quick Service", adult: 62.78, child: 25.82 },
      { label: "Disney Dining Plan · Table Service", adult: 99.87, child: 31.94 },
      { label: "Disney Dining Plan · Deluxe", adult: 163.01, child: 46.85 },
    ],
    transport: { on: 0, off: 35 },
    // RESOLVED 2026-09-23 — the WDW-medians open question in CLAUDE.md.
    // Moderate/Deluxe re-baselined from the owner's own 450/1090 to 305/700,
    // the owner's call after a web-search cross-check (third-party rate
    // write-ups, not Disney's own booking flow, which has no static price in
    // its page source — only an interactive, date-driven search) landed
    // closer to a Gemini-drafted estimate than to the owner's original
    // figures. Value (270) was not in dispute and is unchanged.
    //
    // The real per-hotel BANDS this was checked against, kept here as
    // information the single median can't carry on its own:
    //   Moderate: Caribbean Beach $200-350, Coronado Springs $250-400 (Gran
    //   Destino Tower specifically "from $380"), Port Orleans Riverside
    //   $350-400.
    //   Deluxe: overall $450-1200; Contemporary $500-900; Grand Floridian
    //   theme-park-view rooms $1300+ (that figure is one premium room
    //   category, not the hotel's typical rate, so it is not used as GF's
    //   base below).
    hotels: [
      h("wdw-asm", "Disney's All-Star Movies", "Value resort", 217, "value", true),
      h("wdw-pop", "Disney's Pop Century", "Value resort", 323, "value", true),
      h("wdw-cbr", "Disney's Caribbean Beach", "Moderate resort", 275, "moderate", true),
      h("wdw-por", "Port Orleans Riverside", "Moderate resort", 305, "moderate", true),
      h("wdw-gdt", "Coronado Springs · Gran Destino", "Moderate resort", 345, "moderate", true),
      h("wdw-akl", "Animal Kingdom Lodge", "Deluxe resort", 620, "deluxe", true),
      h("wdw-wl", "Wilderness Lodge", "Deluxe resort", 680, "deluxe", true),
      h("wdw-cr", "Contemporary Resort", "Deluxe resort", 720, "deluxe", true),
      h("wdw-gf", "Grand Floridian", "Deluxe resort", 950, "deluxe", true),
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
    parkList: [
      { name: "Disneyland Park", lands: ["Main Street, U.S.A.", "Adventureland", "New Orleans Square", "Frontierland", "Critter Country", "Star Wars: Galaxy's Edge", "Fantasyland", "Mickey's Toontown", "Tomorrowland"] },
      { name: "Disney California Adventure", lands: ["Buena Vista Street", "Hollywood Land", "Avengers Campus", "Cars Land", "San Fransokyo Square", "Pacific Wharf", "Paradise Gardens Park", "Pixar Pier", "Grizzly Peak"] },
    ],
    goodToKnow: [
      "Park Hopper and paid Lightning Lane line-skipping are sold separately from base admission and aren't priced here.",
    ],
    closuresUrl: "https://disneyland.disney.go.com/construction-closures-updates/",
    closuresLabel: "Official Disneyland closure calendar",
    ticketUrl: "https://disneyland.disney.go.com/tickets/",
    // Disneyland doesn't publish Walt Disney World's Value/Moderate/Deluxe
    // split, so there is one page and every tier lands on it. Our own three
    // on-property rows here are a convenience for the category picker, not a
    // claim that Disney markets them that way.
    onPropertyHotels: { url: "https://disneyland.disney.go.com/hotels/" },
    altArrivalAirports: [{ iata: "LAX", label: "Los Angeles — about 45 min from the resort, often more fare options" }],
    bands: { freeUnder: 3, child: [3, 9], adult: 10 },
    // base recalibrated against real 2026 published one-day pricing ($104-224,
    // researched — see CLAUDE.md): the old 148 sat *above* WDW's 132, which
    // inverted the two resorts' off-peak ordering versus reality. Still a
    // coarse approximation, not exact per-date accuracy — see the note on WDW.
    /* OWNER DATA, 2026-09-23, same source and basis as Walt Disney World's.
       Adult 1-5 days: 149/335/425/480/520 — note the TWO-day ticket costs
       MORE per day than a one-day ($167.50 against $149), which is real at
       Disneyland and which a declining curve could never produce. Hopper runs
       $70 to $135 by length; the old flat $75 was under by nearly half on a
       five-day trip. */
    ticket: {
      base: 149, child: 0.933, slope: 0.05, floor: 0.62,
      multiDayAdultUsd: [149, 335, 425, 480, 520],
      hopperByDaysUsd: [70, 100, 110, 120, 135],
      hopperAdultUsd: 110, hopperChildUsd: 110,
    },
    food: { grocery: 40, qs: 66, mix: 100, ts: 162 },
    foodExamples: {
      qs: [{ name: "Galactic Grill", tier: "$" }, { name: "Alien Pizza Planet", tier: "$" }],
      ts: [{ name: "Blue Bayou", tier: "$$$" }, { name: "Carthay Circle", tier: "$$$$" }],
    },
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
    parkList: [
      { name: "Disneyland Park", lands: ["Main Street, U.S.A.", "Frontierland", "Adventureland", "Fantasyland", "Discoveryland"] },
      { name: "Walt Disney Studios Park", lands: ["Front Lot", "Production Courtyard", "Toon Studio", "Worlds of Pixar", "Avengers Campus"] },
    ],
    closuresUrl: "https://news.disneylandparis.com/en/",
    closuresLabel: "Official Disneyland Paris news (closure announcements)",
    // Beauvais dropped (2026-09-10): it is a budget-carrier base with no US
    // service, so every real-fare lookup against it returns nothing while
    // still costing a metered search. CDG is the only Paris gateway a US
    // traveller actually arrives at.
    altArrivalAirports: [],
    goodToKnow: [
      "To be clear about which half is the awkward one: park tickets on their own ARE sold online, at tickets.disneylandparis.com, dated or undated, with no hotel attached. It is the ROOM WITHOUT TICKETS that Disney will not sell you online — call Disney directly for a room-only rate, or book the hotel through a third party such as Booking.com or Expedia and buy the park tickets separately. Worth pricing both ways; which comes out cheaper depends on the dates and the package on offer.",
      "Space Mountain (currently Star Wars Hyperspace Mountain) is confirmed to close at the end of 2027 for a months-long refurbishment back to its original 1995 Jules Verne theme — not 2026. No reopening date is confirmed yet. Worth checking the closure calendar below before booking a trip built around this ride.",
    ],
    ticketUrl: "https://www.disneylandparis.com/en-gb/tickets/",
    // UNVERIFIED from this environment — every Disney domain is blocked by
    // the egress proxy here, so this path could not be fetched. Same caveat
    // as goodToKnow's visa notes: plausible and conventional, not checked.
    // The owner click-tests these; fix here if one 404s.
    onPropertyHotels: { url: "https://www.disneylandparis.com/en-gb/hotels/" },
    // Disney sells Paris ACCOMMODATION as a hotel + ticket PACKAGE by
    // default — a room-only stay exists but is not sold online. Note the
    // scope, re-checked 2026-09-21 after the owner asked: buying park
    // tickets alone online is ordinary and always has been, so the bundling
    // constraint runs one way only. We price room and tickets as two
    // separate lines, which matches the room-only booking most people will
    // not actually make. Deliberately not "fixed" in the pricing math:
    // package rates are not published, so inventing one would be less honest
    // than a clearly-labelled room-only basis. Labelled here instead.
    dataConfidence: {
      level: "Priced room-only",
      note: "Park tickets on their own are sold online normally — that part is fine. What Disney's own site will not sell you online is a ROOM WITHOUT TICKETS: book a Disney hotel there and it comes as a hotel + ticket package, with admission included for every day of your stay. A room-only stay does exist, but only by phone or through a third party. We price the room and the tickets as two separate lines, so a real Disney quote may be structured quite differently from the breakdown below. Compare against an actual package quote before you budget on it.",
    },
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    // hopperAdultUsd/hopperChildUsd are an unresearched guess (roughly 20% of
    // base) — weaker confidence than WDW/Disneyland's, which came from an
    // actual 2026 price check. Refine before relying on this one.
    ticket: { base: 78, child: 0.84, slope: 0.07, floor: 0.55, hopperAdultUsd: 45, hopperChildUsd: 38 },
    food: { grocery: 30, qs: 49, mix: 80, ts: 128 },
    foodExamples: {
      qs: [{ name: "Cowboy Cookout Barbecue", tier: "$" }, { name: "Colonel Hathi's Pizza Outpost", tier: "$" }],
      ts: [{ name: "Auberge de Cendrillon", tier: "$$$$" }, { name: "Walt's — an American Restaurant", tier: "$$$" }],
    },
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
      h("dlp-sf", "Disney Hotel Santa Fe", "Value · shuttle", 250, "value", true),
      h("dlp-ch", "Disney Hotel Cheyenne", "Value · shuttle", 278, "value", true),
      h("dlp-sl", "Disney Sequoia Lodge", "Moderate · walkable", 298, "moderate", true),
      h("dlp-nb", "Disney Newport Bay Club", "Moderate · walkable", 355, "moderate", true),
      h("dlp-dlh", "Disneyland Hotel", "Deluxe · park gates", 826, "deluxe", true),
      h("dlp-bsg", "Bussy-Saint-Georges hotel", "Off property · 12 min", 135, "budget", false),
      h("dlp-vde", "Val d'Europe hotel", "Off property · 8 min", 178, "mid", false),
      h("dlp-par", "Paris centre (RER A)", "Off property · 45 min", 245, "upscale", false),
    ],
  },
  {
    id: "tdr", name: "Tokyo Disney Resort", city: "Urayasu, Japan", iata: "NRT",
    lat: 35.76, lon: 140.39, currency: "JPY", parks: 2, region: "pac",
    note: "2 parks · run by Oriental Land Co. under licence",
    parkList: [
      { name: "Tokyo Disneyland", lands: ["World Bazaar", "Adventureland", "Westernland", "Critter Country", "Fantasyland", "Toontown", "Tomorrowland"] },
      { name: "Tokyo DisneySea", lands: ["Mediterranean Harbor", "American Waterfront", "Port Discovery", "Lost River Delta", "Arabian Coast", "Mermaid Lagoon", "Mysterious Island", "Fantasy Springs"] },
    ],
    goodToKnow: [
      "For U.S. passport holders: no visa is required for tourist stays of 90 days or less — just a valid passport and (usually) proof of an onward/return ticket. This is specifically for U.S. citizens; other nationalities should check their own requirements. Source: U.S. State Department Japan travel page (travel.state.gov) and the U.S. Embassy in Japan — checked at write time, always confirm current requirements before booking.",
    ],
    closuresUrl: "https://touringplans.com/tokyo-disney/closures",
    closuresLabel: "Unofficial refurbishment tracker (TouringPlans, not Disney)",
    // The owner's own click-tested link (2026-09-21): Tokyo's real purchase
    // flow, not the informational ticket page the previous URL landed on.
    // The `_gl=...` cross-domain analytics token they pasted with it is
    // stripped deliberately — it is a short-lived per-session linker value,
    // so shipping it would hard-code one expired browsing session into every
    // traveller's link. `lang=en` is the part that actually matters.
    ticketUrl: "https://plan.tokyodisneyresort.jp/2/4/?lang=en",
    // UNVERIFIED from this environment — every Disney domain is blocked by
    // the egress proxy here, so this path could not be fetched. Same caveat
    // as goodToKnow's visa notes: plausible and conventional, not checked.
    // The owner click-tests these; fix here if one 404s.
    onPropertyHotels: { url: "https://www.tokyodisneyresort.jp/en/hotel/" },
    altArrivalAirports: [{ iata: "HND", label: "Haneda — closer to central Tokyo, often cheaper than Narita" }],
    bands: { freeUnder: 4, child: [4, 11], junior: [12, 17], adult: 18 },
    // hopperAdultUsd/hopperChildUsd are an unresearched guess (roughly 20% of
    // base) — weaker confidence than WDW/Disneyland's, which came from an
    // actual 2026 price check. Refine before relying on this one.
    /* NO PARK HOPPER. The owner confirmed it is a special-occasion product
       rather than something on sale, and Tokyo's own 1-Day Passport says so
       in its own words: it admits you to "Tokyo Disneyland OR Tokyo DisneySea
       ... designating the date of visit and Park". The shipped +$38 was an
       unresearched guess for a product a traveller cannot normally buy, which
       put money on the six-resort board that nobody could spend. Omitting the
       fields is how a resort says it has no hopper — Hong Kong and Shanghai
       already do it this way.
       The prices themselves were CHECKED against Tokyo's own page and needed
       no change: the 1-Day Passport runs JPY 8,900-10,900, and the junior and
       child ratios come out at 0.83 and 0.55 against 0.83 and 0.55 here. */
    ticket: { base: 63, child: 0.55, junior: 0.83, slope: 0.028, floor: 0.82 },
    food: { grocery: 22, qs: 35, mix: 56, ts: 94 },
    foodExamples: {
      qs: [{ name: "Pan Galactic Pizza Port", tier: "$" }, { name: "Sunshine Terrace", tier: "$" }],
      ts: [{ name: "Queen of Hearts Banquet Hall", tier: "$$$" }, { name: "Magellan's", tier: "$$$$" }],
    },
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
      h("tdr-ch", "Tokyo Disney Celebration Hotel", "Value · shuttle", 180, "value", true),
      h("tdr-ts", "Toy Story Hotel", "Moderate · monorail", 250, "moderate", true),
      /* OWNER DATA, 2026-09-23, PARTLY USABLE. The fetched rate sheet gives
         four months of real per-night rates, and Disney Ambassador Hotel's
         column is clean and distinct (JPY 51,000-106,900, typical ~66,500,
         which is $423) — a real Disney hotel this table was missing
         entirely, now added.
         THE OTHER THREE COLUMNS COLLAPSED. Tokyo Disneyland Hotel, Hotel
         MiraCosta and Toy Story Hotel carry IDENTICAL rates on most dates,
         which cannot be true of a Moderate priced beside two Deluxes: Toy
         Story at JPY 92,500 would be $588 a night, above Tokyo Disneyland
         Hotel's own real rate. The sheet's own check — that the columns
         differ on SOME dates — is too weak to rule that out. So those three
         rates are left where they were, and what the shared column does
         support (a Deluxe running JPY 92,500-96,500, or $588-614) sits close
         enough to the 620 median already on file to leave it standing. */
      h("tdr-amb", "Disney Ambassador Hotel", "Deluxe · Ikspiari walk", 425, "deluxe", true),
      h("tdr-tdh", "Tokyo Disneyland Hotel", "Deluxe · park gates", 460, "deluxe", true),
      h("tdr-mc", "Hotel MiraCosta", "Deluxe · inside DisneySea", 620, "deluxe", true),
      h("tdr-fs", "Fantasy Springs Hotel", "Deluxe · inside DisneySea", 700, "deluxe", true),
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
    parkList: [
      { name: "Shanghai Disneyland", lands: ["Mickey Avenue", "Gardens of Imagination", "Fantasyland", "Treasure Cove", "Adventure Isle", "Tomorrowland", "Toy Story Land", "Zootopia"] },
    ],
    goodToKnow: [
      "For U.S. passport holders: a visa is required to enter mainland China — you must get it before you travel (most U.S. tourists apply for a 10-year multiple-entry tourist visa). This is a different, separate requirement from Hong Kong's. Limited visa-free transit exemptions exist (up to 240 hours as of 2026) but generally only when continuing on to a third country, not for a simple round trip home. Source: U.S. State Department China travel page (travel.state.gov) — checked at write time, always confirm current requirements and processing time before booking, since a visa can take days to weeks to arrange.",
    ],
    closuresUrl: "https://wdwnt.com/refurbishments-and-closures/",
    closuresLabel: "Unofficial refurbishment tracker (WDWNT, not Disney)",
    ticketUrl: "https://www.shanghaidisneyresort.com/en/tickets/",
    // UNVERIFIED from this environment — every Disney domain is blocked by
    // the egress proxy here, so this path could not be fetched. Same caveat
    // as goodToKnow's visa notes: plausible and conventional, not checked.
    // The owner click-tests these; fix here if one 404s.
    onPropertyHotels: { url: "https://www.shanghaidisneyresort.com/en/hotels/" },
    // Hongqiao dropped (2026-09-10): mostly domestic/regional China routes,
    // so a US-origin lookup returns nothing and still costs a metered search.
    // PVG is the real gateway.
    altArrivalAirports: [],
    // CORRECTED 2026-09-23: this badge used to claim Shanghai charges
    // children by height (1.0-1.4m) rather than age, taken from model
    // knowledge with no source. The owner's own screenshot of Shanghai's
    // real purchase flow shows AGE bands — Standard 12-59, Child 3-11 —
    // which is exactly what `bands` below already models. The old claim
    // was simply wrong, not a real cost-model gap, so the badge is gone
    // rather than reworded. Same rule as everywhere else in this file: a
    // badge that outlives its reason trains people to ignore badges.
    bands: { freeUnder: 3, child: [3, 11], adult: 12 },
    /* OWNER DATA, 2026-09-23. Shanghai's own purchase flow, October 2026
       calendar: 22 bookable dates running CNY 475-799, mean CNY 579. At the
       generated rate of 6.7 CNY to the dollar that is $86. The child ratio is
       observed rather than assumed: on a CNY 719 date, Child (3-11) is CNY
       539, which is 0.75. */
    ticket: { base: 86, child: 0.75, slope: 0.04, floor: 0.7 },
    food: { grocery: 18, qs: 31, mix: 49, ts: 82 },
    foodExamples: {
      qs: [{ name: "Wandering Moon Teahouse", tier: "$" }, { name: "L'Chef Pastry", tier: "$" }],
      ts: [{ name: "Royal Banquet Hall", tier: "$$$" }, { name: "Barbossa's Bounty", tier: "$$" }],
    },
    plans: [],
    transport: { on: 0, off: 10 },
    // On-property bases recalibrated 2026-09-15 against real 2026 nightly
    // rates researched in CNY and converted (Toy Story ~CNY1,200-3,000,
    // Shanghai Disneyland Hotel ~CNY1,800-3,500, at roughly CNY7/USD) — the
    // old bases sat below even the low end of the researched range.
    hotels: [
      /* OWNER DATA, 2026-09-23, from Shanghai's own booking flow for 1-10
         December 2026. Prices there EXCLUDE a 15% service charge, which is
         added here because a traveller pays it: Toy Story garden view CNY
         1,427 and courtyard CNY 2,043 become $245 and $351 all-in, and the
         Disneyland Hotel's deluxe garden/park views (CNY 2,856-3,293) become
         $490-565.
         Both are BELOW the annual average these bases are meant to be. Early
         December is low season and the rates carried a stay-two-nights
         discount, so they are set a little above what was quoted rather than
         on it — feeding an off-peak floor into a field the seasonal
         multiplier then discounts again is mistake #2 in CLAUDE.md. */
      h("shdr-ts", "Toy Story Hotel", "Moderate · shuttle", 280, "moderate", true),
      h("shdr-sdh", "Shanghai Disneyland Hotel", "Deluxe · lakeside", 520, "deluxe", true),
      h("shdr-pd", "Pudong business hotel", "Off property · 20 min", 98, "budget", false),
      h("shdr-adj", "Resort-adjacent hotel", "Off property · 10 min", 148, "mid", false),
      h("shdr-cty", "Shanghai city 5-star", "Off property · 45 min", 225, "upscale", false),
    ],
  },
  {
    id: "hkdl", name: "Hong Kong Disneyland", city: "Lantau Island, Hong Kong", iata: "HKG",
    lat: 22.31, lon: 113.91, currency: "HKD", parks: 1, region: "pac",
    note: "1 park · smallest of the six",
    parkList: [
      { name: "Hong Kong Disneyland", lands: ["Main Street, U.S.A.", "Adventureland", "Grizzly Gulch", "Mystic Point", "Toy Story Land", "Fantasyland", "Tomorrowland", "World of Frozen"] },
    ],
    goodToKnow: [
      "For U.S. passport holders: no visa is required for tourist stays of 90 days or less — Hong Kong has its own immigration, separate from mainland China, even though mainland China requires a visa for most U.S. visitors. Just need a passport valid 6+ months. If your trip also includes mainland China (e.g. Shanghai Disney), that's a separate, additional visa requirement — see that resort's notes. Source: U.S. Consulate General Hong Kong & Macau — checked at write time, always confirm current requirements before booking.",
    ],
    closuresUrl: "https://wdwnt.com/refurbishments-and-closures/",
    closuresLabel: "Unofficial refurbishment tracker (WDWNT, not Disney)",
    ticketUrl: "https://www.hongkongdisneyland.com/book/tickets/",
    // UNVERIFIED from this environment — every Disney domain is blocked by
    // the egress proxy here, so this path could not be fetched. Same caveat
    // as goodToKnow's visa notes: plausible and conventional, not checked.
    // The owner click-tests these; fix here if one 404s.
    onPropertyHotels: { url: "https://www.hongkongdisneyland.com/hotels/" },
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
    /* OWNER DATA, 2026-09-23. Hong Kong's own reservation calendar, November
       2026: a clean two-tier week at HKD 669 Tuesday-Thursday and HKD 759
       Friday-Monday. Weighted across a week that is HKD 720, or $92 at the
       generated 7.843 to the dollar.
       The CHILD RATIO IS STILL A GUESS — the calendar shows general admission
       only, so 0.72 is unchanged and unverified. */
    ticket: { base: 92, child: 0.72, slope: 0.045, floor: 0.68 },
    food: { grocery: 20, qs: 34, mix: 53, ts: 87 },
    foodExamples: {
      qs: [{ name: "Tomorrowland Terrace", tier: "$" }, { name: "Market Place Kitchen", tier: "$" }],
      ts: [{ name: "Explorer's Club Restaurant", tier: "$$$" }, { name: "Plaza Inn", tier: "$$$" }],
    },
    plans: [],
    transport: { on: 0, off: 12 },
    hotels: [
      /* OWNER DATA, 2026-09-23, from Hong Kong's own room list. Hollywood
         Hotel ran HKD 2,550-2,890 and Explorers Lodge HKD 2,720-3,485; at the
         generated 7.843 to the dollar those midpoints are $347 and $395.
         These replace the weakest numbers in the whole table — the previous
         figures came from "starts at" rates quoted during an active 40%-off
         promotion, which is neither a median nor a rack rate, and they were
         low by around 40%.
         THE DELUXE FIGURE IS STILL DERIVED, not observed: the owner's
         screenshots cover Hollywood and Explorers Lodge only, so Hong Kong
         Disneyland Hotel keeps its previous ratio to Moderate (1.23x) applied
         to the new Moderate. It is the one number here still waiting on a
         real quote. */
      h("hkdl-hh", "Disney Hollywood Hotel", "Value · shuttle", 345, "value", true),
      h("hkdl-el", "Disney Explorers Lodge", "Moderate · shuttle", 395, "moderate", true),
      h("hkdl-hkd", "Hong Kong Disneyland Hotel", "Deluxe · walkable", 485, "deluxe", true),
      h("hkdl-kln", "Kowloon hotel", "Off property · 30 min MTR", 148, "budget", false),
      h("hkdl-tc", "Tung Chung hotel", "Off property · 10 min", 188, "mid", false),
      h("hkdl-hki", "Hong Kong Island 4-star", "Off property · 40 min", 275, "upscale", false),
    ],
  },
];

export const RESORT_BY_ID = new Map(RESORTS.map((r) => [r.id, r]));

/* =========================================================================
 * Attractions — what a resort HAS, next to what it costs.
 *
 * Price answers "which of these can we afford". It never answers "which of
 * these is our trip", and that is the question people actually start from.
 * A family who wants Zootopia has exactly one option and should be told so
 * before they compare six totals.
 *
 * ONE RULE ABOVE ALL: an attraction lists every resort that has it, and
 * "only here" is DERIVED from that list, never asserted per row. Clones
 * across resorts are normal — Ratatouille runs at both EPCOT and Walt
 * Disney Studios, TRON at both Shanghai and the Magic Kingdom — and the
 * first draft of this idea got that wrong out loud. A row that claims
 * exclusivity it doesn't have is worse than no row: it sends someone to the
 * wrong side of the planet.
 *
 * Hand-maintained here, same as goodToKnow and closuresUrl and for the same
 * reason: no API exposes this for any of the six resorts. Unlike ticket
 * prices, it does not rot quickly — headline attractions stand for years,
 * and what moves is openings and closures, which the news digest already
 * watches.
 * ====================================================================== */

export interface AttractionDef {
  /** Stable key. Never reuse one for a different attraction — a user's saved
   *  picks reference it, and a recycled id silently changes what they chose. */
  id: string;
  /** What a traveller would call it. Where resorts use different names for
   *  the same ride, pick the one most people search for and let `note` carry
   *  the difference. */
  name: string;
  /** EVERY resort that has it. One entry means genuinely only there. */
  resortIds: string[];
  /** Optional: what makes a resort's version different from its clones.
   *  Worth writing only when it would change where someone goes. */
  note?: string;
}

/**
 * STARTER SET — the owner is replacing this with their own list.
 *
 * Kept short on purpose: every row here is one Claude is confident about,
 * because a confident wrong entry is the failure this whole file is shaped
 * to avoid. Treat it the way `seedPromos.ts`'s example rows are treated —
 * real enough to build and test against, not a researched catalogue.
 */
export const ATTRACTIONS: AttractionDef[] = [
  { id: "zootopia", name: "Zootopia", resortIds: ["shdr"],
    note: "A whole themed land, and the only one anywhere." },
  { id: "mystic-manor", name: "Mystic Manor", resortIds: ["hkdl"],
    note: "Hong Kong's own take on the haunted-house idea — no Doom Buggies, a different story entirely." },
  { id: "journey-center-earth", name: "Journey to the Center of the Earth", resortIds: ["tdr"],
    note: "Tokyo DisneySea only." },
  { id: "radiator-springs-racers", name: "Radiator Springs Racers", resortIds: ["dlr"] },
  { id: "guardians-cosmic-rewind", name: "Guardians of the Galaxy: Cosmic Rewind", resortIds: ["wdw"] },
  { id: "pirates-sunken-treasure", name: "Pirates of the Caribbean: Battle for the Sunken Treasure", resortIds: ["shdr"],
    note: "Shares a name with the Pirates rides elsewhere and is a completely different attraction." },
  { id: "ratatouille", name: "Ratatouille", resortIds: ["wdw", "dlp"],
    note: "Remy's Ratatouille Adventure at EPCOT, Ratatouille: L'Aventure Totalement Toquée at Walt Disney Studios." },
  { id: "tron", name: "TRON Lightcycle / Run", resortIds: ["wdw", "shdr"] },
  { id: "rise-of-the-resistance", name: "Star Wars: Rise of the Resistance", resortIds: ["wdw", "dlr"] },
  { id: "crush-coaster", name: "Crush's Coaster", resortIds: ["dlp"] },
];

export const ATTRACTION_BY_ID = new Map(ATTRACTIONS.map((a) => [a.id, a]));

/** Every attraction this resort has. */
export function attractionsFor(resortId: string): AttractionDef[] {
  return ATTRACTIONS.filter((a) => a.resortIds.includes(resortId));
}

/**
 * True when this resort is the ONLY place you can ride it — computed from
 * `resortIds`, so it can never disagree with the data. This is the whole
 * reason the shape is a list: "only at X" is a fact about the list, not a
 * flag someone remembers to update when a clone opens.
 */
export function isOnlyAt(attraction: AttractionDef): boolean {
  return attraction.resortIds.length === 1;
}

export interface Origin { iata: string; name: string; lat: number; lon: number }
/* ===========================================================================
 * Queue-Times park ids, for the wait-time recorder.
 *
 * DRAFT UNTIL THE PROBE HAS RUN. These ids are Claude's best recollection,
 * not observations — the "Parkfare debug wait times" workflow prints the real
 * list, and it cannot be dispatched until this branch reaches the default
 * branch (GitHub only lists workflow_dispatch workflows that live there).
 *
 * The `name` is here to be CHECKED, never displayed. The collector refuses a
 * park whose returned name does not match, so a wrong id fails loudly instead
 * of quietly recording Alton Towers as Walt Disney World — which is exactly
 * the failure a draft list invites.
 *
 * Attribution: Queue-Times asks for a "Powered by Queue-Times.com" credit in
 * any app that shows their data. Nothing shows it yet, so nothing owes the
 * credit yet — but anything that ever renders these numbers must carry it.
 * ======================================================================== */
export interface QueueTimesPark { id: number; name: string }

export const QUEUE_TIMES_PARKS: Record<string, QueueTimesPark[]> = {
  wdw:  [{ id: 6, name: "Magic Kingdom" }, { id: 5, name: "Epcot" },
         { id: 7, name: "Disney's Hollywood Studios" }, { id: 8, name: "Disney's Animal Kingdom" }],
  dlr:  [{ id: 16, name: "Disneyland" }, { id: 17, name: "Disney California Adventure" }],
  dlp:  [{ id: 4, name: "Disneyland Paris" }, { id: 28, name: "Walt Disney Studios" }],
  tdr:  [{ id: 274, name: "Tokyo Disneyland" }, { id: 275, name: "Tokyo DisneySea" }],
  shdr: [{ id: 32, name: "Shanghai Disneyland" }],
  hkdl: [{ id: 31, name: "Hong Kong Disneyland" }],
};

/**
 * Only record a sample while a park is properly open for the day.
 *
 * The owner's call, and it is about what the number MEANS rather than about
 * saving requests: "sometimes wait times are single digits ... 9am - 7:00pm
 * will be enough data." Rope-drop and the last hour are genuinely quiet, so
 * including them produces an average describing an experience nobody has.
 *
 * Local to the park, which is what makes one UTC schedule work for six
 * timezones at once.
 */
export const WAIT_SAMPLE_FROM_HOUR = 9;
export const WAIT_SAMPLE_TO_HOUR = 19;

export const ORIGINS: Origin[] = [
  { iata: "ATL", name: "Atlanta", lat: 33.64, lon: -84.43 },
  { iata: "BWI", name: "Baltimore", lat: 39.18, lon: -76.67 },
  { iata: "BOS", name: "Boston", lat: 42.36, lon: -71.01 },
  { iata: "CLT", name: "Charlotte", lat: 35.21, lon: -80.94 },
  { iata: "ORD", name: "Chicago O'Hare", lat: 41.98, lon: -87.9 },
  { iata: "DFW", name: "Dallas–Fort Worth", lat: 32.9, lon: -97.04 },
  { iata: "DEN", name: "Denver", lat: 39.86, lon: -104.67 },
  { iata: "DTW", name: "Detroit", lat: 42.21, lon: -83.35 },
  { iata: "IAH", name: "Houston", lat: 29.98, lon: -95.34 },
  { iata: "LAS", name: "Las Vegas", lat: 36.08, lon: -115.15 },
  { iata: "LAX", name: "Los Angeles", lat: 33.94, lon: -118.41 },
  { iata: "MIA", name: "Miami", lat: 25.79, lon: -80.29 },
  { iata: "MSP", name: "Minneapolis", lat: 44.88, lon: -93.22 },
  { iata: "JFK", name: "New York JFK", lat: 40.64, lon: -73.78 },
  { iata: "PHL", name: "Philadelphia", lat: 39.87, lon: -75.24 },
  { iata: "PHX", name: "Phoenix", lat: 33.43, lon: -112.01 },
  { iata: "SFO", name: "San Francisco", lat: 37.62, lon: -122.38 },
  { iata: "SEA", name: "Seattle", lat: 47.45, lon: -122.31 },
  { iata: "IAD", name: "Washington, D.C. (Dulles)", lat: 38.94, lon: -77.46 },
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
  { iata: "AUS", name: "Austin", lat: 30.19, lon: -97.67 },
  { iata: "CVG", name: "Cincinnati", lat: 39.05, lon: -84.67 },
  { iata: "CLE", name: "Cleveland", lat: 41.41, lon: -81.85 },
  { iata: "CMH", name: "Columbus", lat: 39.998, lon: -82.89 },
  { iata: "RSW", name: "Fort Myers", lat: 26.54, lon: -81.76 },
  { iata: "IND", name: "Indianapolis", lat: 39.72, lon: -86.29 },
  { iata: "JAX", name: "Jacksonville", lat: 30.49, lon: -81.69 },
  { iata: "MCI", name: "Kansas City", lat: 39.3, lon: -94.71 },
  { iata: "MKE", name: "Milwaukee", lat: 42.95, lon: -87.9 },
  { iata: "BNA", name: "Nashville", lat: 36.13, lon: -86.68 },
  { iata: "MSY", name: "New Orleans", lat: 29.99, lon: -90.26 },
  { iata: "OAK", name: "Oakland", lat: 37.71, lon: -122.22 },
  { iata: "PIT", name: "Pittsburgh", lat: 40.49, lon: -80.23 },
  { iata: "PDX", name: "Portland", lat: 45.59, lon: -122.6 },
  { iata: "RDU", name: "Raleigh–Durham", lat: 35.88, lon: -78.79 },
  { iata: "SMF", name: "Sacramento", lat: 38.7, lon: -121.59 },
  { iata: "SLC", name: "Salt Lake City", lat: 40.79, lon: -111.98 },
  { iata: "SAT", name: "San Antonio", lat: 29.53, lon: -98.47 },
  { iata: "SAN", name: "San Diego", lat: 32.73, lon: -117.19 },
  { iata: "SJC", name: "San Jose", lat: 37.36, lon: -121.93 },
  { iata: "STL", name: "St. Louis", lat: 38.75, lon: -90.37 },
  { iata: "TPA", name: "Tampa", lat: 27.98, lon: -82.53 },
];

/** Every departure airport the app knows, free and Plus together. */
export const ALL_ORIGINS: Origin[] = [...ORIGINS, ...PLUS_ORIGINS];

/**
 * The order a person should be offered airports in: by the CITY they live
 * near, never by the IATA code.
 *
 * Both lists above are also declared in this order, and `config.test.ts`
 * pins that — because sorting by code produces something that looks
 * alphabetical and isn't (Atlanta, Boston, Baltimore), which is worse than
 * an obviously arbitrary order: it reads as a list you can scan and then
 * hides the entry you were scanning for.
 *
 * Free and Plus airports interleave here rather than sitting in two blocks.
 * Somebody looking for Tampa should not first have to know which side of the
 * paywall Tampa is on; the label on the row says that.
 */
export function compareOriginsByCity(a: Origin, b: Origin): number {
  return a.name.localeCompare(b.name, "en");
}

/** Every airport, free and Plus interleaved, in picker order. Sent to the
 *  browser as a list of codes so the rule lives here and nowhere else. */
export const ORIGINS_BY_CITY: Origin[] = [...ALL_ORIGINS].sort(compareOriginsByCity);

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
/**
 * Where to send somebody who wants to book this resort's own hotel.
 *
 * Disney's site, not Booking.com. On-property rooms were linking to a
 * Booking.com search for the hotel's name, which is both a worse answer than
 * Disney's own page and, at Walt Disney World, the wrong shape of answer —
 * the owner asked for the category page, so somebody pricing Moderate lands
 * on the Moderate list rather than an index of fifty hotels.
 *
 * `tier` is the ON-property category. Anything else (an off-property tier, a
 * resort with no per-category pages) falls through to the resort's one hotel
 * page, which is always a correct destination if not the most specific one.
 */
export function onPropertyHotelUrl(resort: Resort, tier?: Tier): string {
  const byTier = resort.onPropertyHotels.byTier;
  if (byTier && tier && (ON_TIERS as readonly string[]).includes(tier)) {
    return byTier[tier as OnTier] ?? resort.onPropertyHotels.url;
  }
  return resort.onPropertyHotels.url;
}

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

// ---------------------------------------------------------------- climate

/**
 * What the weather is typically doing at each resort, by month.
 *
 * WHY THIS IS A TABLE AND NOT AN API. It is the same call as ticket prices:
 * climate normals move once a decade, a traveller planning six months out
 * cannot use a forecast, and a live lookup would be a per-user provider call
 * this project's whole architecture exists to avoid.
 *
 * WHY NORMALS AND NOT LAST YEAR. The owner asked for "there were X days with
 * rain last year". Thirty-year averages answer the question better and are
 * the honest thing to show: one specific year is a sample of one, and a dry
 * September in 2025 says nothing about September 2027. The UI says
 * "typically", never "last year", because that is what the numbers are.
 *
 * CONFIDENCE. These are Claude's figures, sanity-checked against web-search
 * summaries of NOAA 1991-2020 normals where one was available (Orlando's
 * January 71/52, August 92/76 and ~51in annual rainfall all match). They were
 * NOT fetched from a primary source — every climate site, Wikipedia, and even
 * Open-Meteo's free keyless archive API are blocked by this sandbox's egress
 * proxy, which was tested rather than assumed. Treat them like the starter
 * attraction rows: right in shape, worth correcting in detail.
 *
 * THE UPGRADE PATH, so nobody re-derives it: Open-Meteo's archive API is free,
 * keyless and returns daily history anywhere in the world. Run from an
 * unblocked machine it could compute all 72 rows from real observations as a
 * BUILD-TIME script writing this table — not a request path, so the
 * cache-first invariant stays intact.
 *
 * Rain days = days with measurable precipitation (>=0.01in / 0.2mm).
 */
export interface ClimateMonth {
  highF: number;
  lowF: number;
  rainDays: number;
  /** What the season is doing — hurricanes, a rainy season, short dark days.
   *  Absent for a month with nothing a traveller needs warning about. */
  note?: { emoji: string; text: string };
}

/**
 * Month numbers a..b inclusive, 1-based, WRAPPING at the year end so a winter
 * season can be written as mo(12, 2) and mean December, January, February.
 *
 * The naive version (`length: b - a + 1`) computes a negative length for a
 * wrapping range, and Array.from turns that into an empty array — so every
 * winter note in this file silently attached to no months at all, and the
 * table looked complete while four resorts had no December, January or
 * February note. Caught in a browser, not by a test; the test below now pins
 * it.
 */
const mo = (a: number, b: number): number[] => {
  const out: number[] = [];
  for (let m = a; ; m = (m % 12) + 1) {
    out.push(m);
    if (m === b) break;
  }
  return out;
};

/**
 * Twelve [high, low, rainDays] rows, January first, with season notes painted
 * over month ranges afterwards — so a six-month hurricane season is written
 * once rather than copied into six rows that could drift apart.
 */
function climate(
  rows: ClimateRow[],
  seasons: { months: number[]; emoji: string; text: string }[] = [],
): ClimateMonth[] {
  const out: ClimateMonth[] = rows.map(([highF, lowF, rainDays]) => ({ highF, lowF, rainDays }));
  for (const s of seasons) {
    for (const m of s.months) {
      const row = out[m - 1];
      if (row) row.note = { emoji: s.emoji, text: s.text };
    }
  }
  return out;
}

/** The generated rows for one resort. Throws rather than silently yielding an
 *  empty year: a resort missing from the generated file is a broken build, not
 *  a resort with no weather. */
function rowsFor(resortId: string): ClimateRow[] {
  const rows = CLIMATE_ROWS[resortId];
  if (!rows || rows.length !== 12) {
    throw new Error(`climateData.ts has no twelve-month row set for ${resortId} — re-run climate-normals`);
  }
  return rows;
}

export const CLIMATE: Record<string, ClimateMonth[]> = {
  wdw: climate(rowsFor("wdw"),    [
      { months: mo(6, 11), emoji: "🌀",
        text: "Atlantic hurricane season runs June through November. Direct hits are rare, but September is the peak and travel insurance is worth pricing." },
      { months: mo(7, 8), emoji: "🥵",
        text: "The hottest, wettest stretch of the year — expect a heavy thunderstorm most afternoons, then sunshine again by evening." },
      { months: mo(12, 12), emoji: "🎄",
        text: "Mild and dry, and the busiest, most expensive fortnight of the year falls over Christmas and New Year." },
      { months: mo(1, 2), emoji: "🧥",
        text: "The coolest, driest months — pleasant for walking the parks, but a morning can genuinely need a jacket." },
      { months: mo(3, 5), emoji: "🌤️",
        text: "Warm, sunny and not yet humid — arguably the best weather of the year, which is why spring break and Easter are among the busiest weeks." },
    ],
  ),
  dlr: climate(rowsFor("dlr"),    [
      { months: mo(5, 6), emoji: "🌫️",
        text: "\"May Gray\" and \"June Gloom\" — mornings often start overcast and burn off by midday. It rarely actually rains." },
      { months: mo(7, 9), emoji: "☀️",
        text: "Effectively rainless and reliably warm, with low humidity by Florida standards. Evenings cool off quickly." },
      { months: mo(12, 2), emoji: "🌧️",
        text: "Southern California's wet season, such as it is — a handful of rainy days, and the coolest evenings of the year." },
      { months: mo(3, 4), emoji: "🌤️",
        text: "Mild, dry and comfortable, with none of the summer crowds until spring break lands." },
      { months: mo(10, 11), emoji: "🍂",
        text: "Warm days, cool evenings and almost no rain — the quietest good-weather stretch of the year." },
    ],
  ),
  dlp: climate(rowsFor("dlp"),    [
      { months: mo(11, 2), emoji: "🌂",
        text: "Cold, grey and dark — the sun sets before 5pm around the solstice. Rain is frequent but usually light rather than heavy." },
      { months: mo(6, 8), emoji: "🌤️",
        text: "The warmest, driest stretch and the longest days, with light until well past 9pm. Also the busiest, as most of Europe is on holiday." },
      { months: mo(3, 5), emoji: "🌦️",
        text: "Mild and changeable. Rain is spread evenly through the year here rather than concentrated in a season, so pack for showers whenever you go." },
    ],
  ),
  tdr: climate(rowsFor("tdr"),    [
      { months: mo(6, 7), emoji: "🌧️",
        text: "Tsuyu, the rainy season — roughly mid-June to mid-July. Not constant downpours, but grey, humid and wet more often than not." },
      { months: mo(8, 9), emoji: "🌀",
        text: "Typhoon season, and August is genuinely hot and humid. A typhoon can close the parks outright for a day." },
      { months: mo(3, 4), emoji: "🌸",
        text: "Cherry blossom and the most comfortable weather of the year — which is also why it is one of the most crowded and expensive times to go." },
      { months: mo(12, 2), emoji: "🧥",
        text: "Cold, dry and often clear. Crisp rather than harsh, but the parks are exposed to wind off Tokyo Bay." },
    ],
  ),
  shdr: climate(rowsFor("shdr"),    [
      { months: mo(6, 7), emoji: "🌧️",
        text: "Meiyu, the \"plum rain\" season — mid-June into July is the wettest, most humid stretch of the year." },
      { months: mo(7, 9), emoji: "🌀",
        text: "Typhoon season, overlapping the summer heat. July and August are hot and sticky, and the park has little shade." },
      { months: mo(10, 11), emoji: "🍂",
        text: "The driest, most comfortable window of the year — mild, clear and far less humid than summer." },
      { months: mo(12, 2), emoji: "🧥",
        text: "Cold and damp. Shanghai sits below freezing overnight only occasionally, but buildings are often unheated by US standards." },
    ],
  ),
  hkdl: climate(rowsFor("hkdl"),    [
      { months: mo(5, 11), emoji: "🌀",
        text: "Typhoon season, peaking July to September. Hong Kong's warning system can close the parks at a few hours' notice." },
      { months: mo(6, 8), emoji: "🥵",
        text: "Hot, humid and the wettest months of the year — rain falls on roughly two days in three." },
      { months: mo(10, 12), emoji: "🌤️",
        text: "The best weather of the year: warm, dry and comparatively low humidity. Also the most pleasant time to queue outdoors." },
      { months: mo(3, 4), emoji: "🌫️",
        text: "Warm and notoriously humid, with fog and drizzle common as the sea is still cooler than the air." },
    ],
  ),
};

/** The climate row for a resort and a 1-based month. Null rather than a throw
 *  for an unknown resort — a missing weather box must never break a board. */
export function climateFor(resortId: string, month1: number): ClimateMonth | null {
  const rows = CLIMATE[resortId];
  if (!rows || month1 < 1 || month1 > 12) return null;
  return rows[month1 - 1] ?? null;
}

/** Re-exported so the UI can say where the weather numbers came from without
 *  importing the generated file directly. */
export { CLIMATE_SOURCE };

/* ------------------------------------------------------------------ crowds */

/**
 * HOW BUSY A RESORT TYPICALLY IS, BY MONTH.
 *
 * Five bands, never a number. "Crowd level 7.2" implies a precision nobody
 * here has and invites arguments about 7.2 versus 7.6; a band is a claim you
 * can actually defend. Same reasoning as the Low/Medium/High fare-correction
 * bands.
 *
 * WHERE THE DOMESTIC NUMBERS COME FROM, and why they are better evidence than
 * they look. Walt Disney World and Disneyland are derived from DVC points
 * charts — Disney's own demand forecast, published months ahead and backed by
 * real inventory. A week priced at twice another week is Disney saying it
 * expects that week to sell out. Crucially it carries NONE of the bias that
 * killed the wait-times card: a points chart is a price, not a posted wait
 * time, so there is no operator inflating it and no reanalysis grid smearing
 * it. It is also not a measurement of crowds and must never be described as
 * one — it is a forecast of demand, which is a different and more honest
 * claim.
 *
 * THE FOUR INTERNATIONAL RESORTS HAVE NO DVC INVENTORY AT ALL, so there is no
 * chart to read and their rows are judgement — local school holidays, national
 * weeks off, and the weather already in CLIMATE. `basis` says which is which
 * per resort and the card prints it, exactly as dataConfidence does: a
 * confident wrong claim about when to go is worse than a hedged right one.
 *
 * HAND-MAINTAINED. Points charts are republished annually, so these go stale
 * quietly — ownerTasks.ts nags about `CROWDS_REVIEWED` below rather than
 * leaving that to memory.
 */
export type CrowdBand = "veryLow" | "low" | "moderate" | "high" | "peak";

/** Ordered weakest to strongest, so a caller can compare two bands without
 *  hard-coding the order in three places. */
export const CROWD_BANDS: CrowdBand[] = ["veryLow", "low", "moderate", "high", "peak"];

export const CROWD_LABELS: Record<CrowdBand, string> = {
  veryLow: "Very low",
  low: "Low",
  moderate: "Moderate",
  high: "High",
  peak: "Peak",
};

export interface CrowdYear {
  /** The strongest basis any month in this year has. Per-MONTH provenance
   *  lives in `chartMonths` below, because a chart rarely covers a whole
   *  year: Hong Kong's runs April to December and Tokyo's covers one
   *  quarter. Saying the whole resort is chart-derived when a third of it is
   *  judgement would be the confident-wrong-claim this file keeps refusing to
   *  make. */
  basis: "dvcPoints" | "estimate";
  /** Twelve bands, January first. */
  months: CrowdBand[];
  /** 1-based months whose band was read off a real points chart. Absent means
   *  none were, and every month falls back to `basis`. */
  chartMonths?: number[];
  /** Optional per-month plain-language reason ("Thanksgiving week", "Golden
   *  Week"). Keyed by 1-based month. A band with no reason still renders. */
  why?: Record<number, string>;
  /**
   * Optional real date-range bands, finer than a whole month, for resorts
   * whose points chart is itself period-banded rather than monthly (WDW's
   * Animal Kingdom Villas chart is 7 real periods covering all 365 days,
   * not 12 months). "MM-DD" to "MM-DD", inclusive, checked in array order —
   * put narrower/later windows before the broader ones they sit inside.
   *
   * This exists for exactly one reason: a MONTHLY average can be honest and
   * still mislead. December reads "moderate" averaged, but 1-23 December is
   * one of the cheapest stretches of the year and 24-31 is the single most
   * expensive — two completely different trips inside one label. Same shape
   * at Thanksgiving, where the real peak is arriving Tue-Thu (22-26 Nov ish)
   * and the weekend after is markedly cheaper, not the other way most people
   * would guess.
   *
   * When a caller supplies a real day (not just a month), `crowdFor` checks
   * these FIRST and falls back to `months`'s whole-month band only when no
   * window matches or none are defined — so every existing month-only caller
   * (quietestMonths, a bare "which month is quietest" comparison) is
   * unaffected, and only a caller pricing a real date gets the finer answer.
   */
  windows?: CrowdWindow[];
}

export interface CrowdWindow {
  from: string;
  to: string;
  band: CrowdBand;
  why?: string;
}

/**
 * When the bands were last checked against a current points chart. The owner
 * task reads this; bump it whenever you review them.
 */
export const CROWDS_REVIEWED = "2026-09-22";

/**
 * PLACEHOLDER ROWS — see CROWDS_ARE_PLACEHOLDER below.
 *
 * These are Claude's, not the owner's points charts, and the UI says so. They
 * exist only so the feature runs end to end before the real bands arrive, the
 * same standing the hand-seeded climate and exchange rows had. Replace them
 * wholesale; unlike the generated files, this one IS meant to be hand-edited.
 */
export const CROWDS: Record<string, CrowdYear> = {
  wdw: {
    /* OWNER DATA, 2026-09-23. Read off the 2027 Disney's Animal Kingdom
       Villas points chart. That chart is SEASON-BANDED rather than daily —
       seven travel periods covering all 365 days of 2027 — so each day was
       assigned its period's weekly Deluxe Studio points and averaged per
       month, then normalised across the year the same way Disneyland's was.
       All 365 days are accounted for; a gap would mean a misread period.

       TWO THINGS THE MONTHLY AVERAGE HIDES, and both are in the notes below
       because a band alone would mislead:

       December reads MODERATE because the chart splits it in half — 1-23
       December is one of the cheapest periods of the year and 24-31 is the
       single most expensive. Averaged, that is a moderate month; lived, it
       is two completely different trips. Same shape at Thanksgiving, where
       24-26 November is a peak inside an otherwise ordinary month.

       SUMMER READS LOW, and that is what the chart says rather than an
       error: Disney prices 11 June to 31 August the same as early February,
       and well below the spring-break weeks. Orlando in July is hot enough
       that demand really does sit under March and April. It will still
       surprise anyone who equates school holidays with crowds, so the note
       says it out loud. */
    basis: "dvcPoints",
    chartMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    months: ["veryLow", "moderate", "peak", "peak", "veryLow", "veryLow",
             "low", "low", "veryLow", "moderate", "moderate", "moderate"],
    why: { 1: "After the New Year the parks empty out — one of the quietest months",
           3: "Spring break: the busiest stretch of the whole year, and 21-28 March is the peak of it",
           4: "Easter and spring break keep April at the top of the year",
           6: "Quieter than you would expect — Orlando's heat keeps summer demand below spring",
           7: "Hot, and busier than June but still well under the spring months",
           9: "The quietest month of the year here",
           11: "Moderate for most of the month, but Thanksgiving week itself is a peak",
           12: "Two different months: 1-23 December is one of the cheapest weeks of the year, Christmas week the most expensive" },
    // Real per-period bands off the SAME 2027 Animal Kingdom Villas chart as
    // `months` above — this is the whole point of `windows`: the monthly
    // average is a summary of these, not a separate source. Boundaries match
    // seasonality.ts's WDW SEASON_BANDS exactly; if the chart is ever re-read,
    // update both together.
    windows: [
      { from: "09-01", to: "09-30", band: "veryLow" },
      { from: "01-01", to: "01-31", band: "low" },
      { from: "05-01", to: "05-14", band: "low" },
      { from: "05-15", to: "06-10", band: "low" },
      { from: "12-01", to: "12-23", band: "low" },
      { from: "02-01", to: "02-15", band: "moderate" },
      { from: "06-11", to: "08-31", band: "moderate" },
      { from: "10-01", to: "11-23", band: "moderate" },
      { from: "11-27", to: "11-30", band: "moderate" },
      { from: "02-16", to: "03-20", band: "high" },
      { from: "03-29", to: "04-30", band: "high" },
      { from: "11-24", to: "11-26", band: "high",
        why: "The days flying in for Thanksgiving are the real peak here — busier than the long weekend after it" },
      { from: "03-21", to: "03-28", band: "peak",
        why: "Spring break/Easter week — tied with Christmas as the single busiest stretch of the year" },
      { from: "12-24", to: "12-31", band: "peak",
        why: "Christmas/New Year's week — the single busiest stretch of the year" },
    ],
  },
  dlr: {
    /* OWNER DATA, 2026-09-23. Read off the 2026 Disney Collection Exchange
       points chart for the Disneyland Hotel — all twelve months, one hotel,
       one scale. Each day's cheapest room category was normalised against
       that chart's own range and averaged per month, so the bands describe
       where a month sits in ITS OWN resort's year, which is the only thing a
       points chart can honestly say.

       It disagreed with four of Claude's placeholder guesses and the chart
       wins every time: March and November are moderate rather than high,
       June is a peak rather than merely high, and April and September are
       quieter than guessed. */
    basis: "dvcPoints",
    chartMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    months: ["veryLow", "low", "moderate", "low", "moderate", "peak",
             "high", "low", "low", "high", "moderate", "peak"],
    why: { 1: "The quietest month of the year at Disneyland",
           6: "Summer peaks in June, ahead of July",
           8: "California schools go back early, and it shows",
           9: "One of the best-value months to go",
           10: "Halloween season is busier than people expect",
           11: "Thanksgiving week is a peak inside an otherwise moderate month",
           12: "Christmas week is the busiest of the year" },
  },
  dlp: {
    basis: "estimate",
    /* January, February and March are ORDERED by the owner's Hotel New York
       Jan-Mar 2027 points chart: March sits clearly above February, which
       sits above January. March moved up a band on that. As with Tokyo the
       chart covers one quarter, so it ranks those months against each other
       and not against the rest of the year; these stay estimates. */
    months: ["low", "moderate", "moderate", "high", "moderate", "moderate",
             "high", "high", "low", "high", "low", "high"],
    why: { 4: "French Easter holidays", 7: "European summer holidays",
           9: "The quietest month, and the weather is still good",
           10: "Toussaint half-term", 12: "Christmas season" },
  },
  tdr: {
    basis: "estimate",
    /* July, August and September are ORDERED by the owner's 2026 Jul-Sep
       points chart, which puts July clearly below September and August
       clearly above both. The chart covers one quarter, so it can rank those
       three against each other and says nothing about where they sit in the
       year — the bands stay estimates and chartMonths stays empty. July moved
       down a band on that evidence. */
    months: ["low", "low", "high", "high", "peak", "low",
             "low", "high", "moderate", "high", "moderate", "high"],
    why: { 3: "Japanese spring break", 4: "Cherry blossom season",
           5: "Golden Week is the single busiest stretch of the Japanese year",
           6: "Tsuyu, the rainy season — wet, and correspondingly quiet",
           8: "Obon and school holidays", 10: "Halloween is a major event at Tokyo" },
  },
  shdr: {
    basis: "estimate",
    months: ["low", "high", "moderate", "moderate", "peak", "moderate",
             "high", "high", "moderate", "peak", "low", "low"],
    why: { 2: "Chinese New Year", 5: "Labour Day golden week",
           7: "Chinese school summer holidays", 10: "National Day golden week",
           11: "Cool, dry and quiet — the best value month" },
  },
  hkdl: {
    /* OWNER DATA, 2026-09-23 for APRIL TO DECEMBER, read off the 2026 Hong
       Kong Disneyland Hotel points chart the same way as Disneyland's.
       January to March are NOT on that chart and remain judgement — see
       chartMonths, which the card reads so it can say which a given month
       is rather than claiming the whole year is sourced. */
    basis: "dvcPoints",
    chartMonths: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    months: ["low", "high", "low", "veryLow", "veryLow", "low",
             "peak", "peak", "veryLow", "moderate", "low", "peak"],
    why: { 2: "Chinese New Year — estimated, not backed by real demand data",
           7: "Hong Kong school holidays, and the wettest, hottest weeks",
           8: "The busiest month of the year here",
           9: "Typhoon season keeps numbers right down — the quietest month",
           12: "Christmas and the New Year run busy" },
  },
};

/**
 * FLIPPED FALSE 2026-09-25, the owner's call: the crowd bands are backed by
 * real DVC/Disney Collection Exchange points charts at Walt Disney World,
 * Disneyland and (April-December) Hong Kong Disneyland, and the remaining
 * months/resorts are judgement that already says so per-month via `basis`
 * ("estimated" vs. "real demand data" on the crowd card). The owner's read:
 * "we have the hotel demand data and that is enough here" — a blanket
 * "not yet checked" banner on top of that per-month disclosure was
 * over-hedging, not honesty. Used to be true while CROWDS held Claude's
 * placeholder bands rather than the owner's own chart reading.
 */
export const CROWDS_ARE_PLACEHOLDER = false;
