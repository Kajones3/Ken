/**
 * The single source of truth for what a trip costs.
 *
 * This module is imported by the API server (what the user sees), the alert job
 * (what we compare against later), and the tests. It is deliberately pure and
 * synchronous: callers load a slice of the cache into a PriceBook first, then
 * price hundreds of candidate dates without touching the database again.
 *
 * Nothing here throws on missing data. A trip that cannot be priced returns
 * { ok: false, reason } so a gap in the cache can never reach a user as NaN.
 */
import {
  ON_TIERS, OFF_TIERS, RESORT_BY_ID, ORIGIN_BY_IATA, DRIVING, bucketFor, irsMileageRate,
  type Band, type FoodStyle, type Resort, type Stay, type Tier, type TierIndex, type HotelDef,
  type MileageRateLookup,
} from "./config.js";
import { addDaysISO, type ISODate } from "./dates.js";
import { haversineMiles } from "./geo.js";
import { holidayFlightPremium } from "./holidayWindows.js";
import {
  findTier, passPriceKey, dvcCredit, DVC_TAKE_HOME_PER_POINT, DVC_TAKE_HOME_KEY,
  type PassHolding, type DvcRental,
} from "./memberships.js";

// ---------------------------------------------------------------- inputs

/** How the party gets to the resort. Undefined/"fly" = today's behavior,
 *  every existing caller unaffected. */
export type TransportMode = "fly" | "drive" | "miles";

export interface TripParams {
  origin: string;
  adults: number;
  childAges: number[];
  nights: number;
  parkDays: number;
  stay: Stay;
  tier: TierIndex;
  food: FoodStyle;
  /** Which airport to price flights into. Undefined = the resort's own primary
   *  `iata` (every existing caller is unaffected). Never trust this from a
   *  client as a bare string beyond the resort it's paired with — server.ts
   *  resolves it against that resort's own altArrivalAirports before this is
   *  ever set, so a request for one resort can't end up priced against a
   *  totally unrelated airport. */
  destination?: string;
  /** Undefined = "fly", today's behavior. Free for everyone — this isn't a
   *  Plus feature, it's a different way to answer "what does this trip cost".
   *  "drive" reuses `origin` as the starting city (the existing ORIGINS
   *  list, an IATA-keyed metro with a known lat/lon) unless `originPoint` is
   *  set. US-only for now. */
  transportMode?: TransportMode;
  /** "drive" only, and only when `origin` isn't one of the fixed ORIGINS —
   *  a geocoded arbitrary starting city (see src/geo/). When set, this
   *  bypasses ORIGIN_BY_IATA entirely; flying mode never reads this, since
   *  flight pricing is airport-cache-keyed and can't be an arbitrary point. */
  originPoint?: { label: string; lat: number; lon: number };
  /** "drive" only — an optional overnight stop on the way, priced at the
   *  user's own typed estimate (there's no real waypoint-hotel data to guess
   *  from the way resort hotel rates are guessed). Nights × cost/night, not
   *  a single flat amount, so a two-night stopover prices like one. */
  overnightStop?: { label: string; nights: number; costPerNightUsd: number } | null;
  /** "miles" only, 0-100. A real mile redemption isn't a market-price guess
   *  the way a typed cash fare is, so this is allowed to price below the
   *  cheapest cash fare found — see the no-floor branch in priceTrip. */
  milesPct?: number;
  /** Park Hopper as a flat per-ticket add-on. Free for everyone. Silently
   *  ignored (never throws) at a resort with no hopperAdultUsd configured —
   *  Hong Kong and Shanghai each have one park and no hopper product. */
  hopper?: boolean;
  /** "drive" only. Defaults to true (unset behaves the same as true) so the
   *  total keeps including a real cost by default, same reasoning as always
   *  including off-property parking/transfers — an option shouldn't look
   *  artificially cheap by omitting something real. The IRS standard
   *  mileage rate bundles depreciation, maintenance and insurance into one
   *  per-mile number, not just gas, which can dwarf the gas line on a long
   *  drive and read as misleading to someone who doesn't think of their own
   *  car's depreciation as a cost of THIS trip — set false to drop it and
   *  price gas only. */
  includeWearAndTear?: boolean;
  /** Annual passes the traveller already holds, one entry per resort. Only
   *  the entry matching THIS resort does anything — a Magic Key does not get
   *  you into Magic Kingdom, and the board prices six resorts at once, so a
   *  holding has to name the resort it belongs to. */
  annualPasses?: PassHolding[];
  /** DVC points the traveller intends to rent out, and what they expect to
   *  take home per point. A credit against the trip, not a discount on any
   *  one line — the money has nothing to do with what a room here costs. */
  dvcRental?: DvcRental | null;
  /** Which day of the month the board quoted: a typical one (the default) or
   *  the cheapest. It changes nothing about how a single date is priced —
   *  priceTrip never reads it — but it is saved with a trip so the alert job
   *  re-prices on the same basis the traveller was shown. */
  priceBasis?: "typical" | "cheapest";
}

export type PromoEffectKind = "room_pct_off" | "room_flat_off" | "free_dining" | "ticket_pct_off" | "flat_off_total";

/** A rate or fare the user supplied themselves. */
export interface ResortOverride {
  nightly?: number; farePerSeat?: number;
  /** What this whole party spends on food in a day, all of them together —
   *  NOT per person. The owner's call, on the grounds that "we spend about
   *  $250 a day" is a number people actually know about themselves, where a
   *  per-head figure is one they have to do arithmetic to produce.
   *
   *  The cost of that choice, stated rather than hidden: the model's own
   *  per-age scaling (an infant eats free, a child eats less) stops applying,
   *  because a party total already contains whatever the party eats. Changing
   *  the party size afterwards therefore does NOT move this number — the
   *  detail card says so. Part-days are still applied, so it is multiplied by
   *  nights + FOOD_DAY_ALLOWANCE, not by nights. */
  foodPerDayUsd?: number;
  /** "I've already got this sorted — don't count it in the total" (a free
   *  family/points room, flights already booked separately, etc.). Not a
   *  price claim like nightly/farePerSeat — it says the line doesn't belong
   *  in the total at all. Mutually exclusive with the matching numeric field
   *  in the UI (checking one clears the other); if a request somehow carries
   *  both, the exclude flag wins here — the numeric field is ignored, not
   *  partially applied. */
  excludeHotel?: boolean;
  excludeFlights?: boolean;
  /** Picks a row from the curated promos table — its effect is always looked up server-side, never trusted from the client. */
  promoId?: string;
  /** The user's own claim (Annual Passholder, DVC, a code they found) — unverified, affects only their own price. */
  personalPromo?: { kind: PromoEffectKind; value: number; label: string };
}
export type Overrides = Record<string, ResortOverride | undefined>;

// ---------------------------------------------------------------- cache view

export interface FlightRow {
  price: number; carrier?: string; stops?: number; deepLink?: string;
  /** Only set when this row came from PriceBook.flightEstimate() rather than
   *  a real flight_prices cache hit: this route's real BTS median fare for
   *  the same quarter, moved by the percentage that the routes we *do* price
   *  for real have moved since that baseline. `low`/`high` are the route's
   *  own p25/p75 spread moved the same way. The UI must render this visibly
   *  differently from a real fare, never presented as one.
   *
   *  `seasonMatched` is false when no baseline existed for the quarter being
   *  searched and an off-season one was used instead — a materially weaker
   *  estimate, and the UI says so rather than hiding it. */
  estimate?: {
    low: number; med: number; high: number; basisQuarter: string;
    seasonMatched?: boolean; trendPct?: number;
    /** True when the baseline came from real fares sampled recently on this
     *  route rather than a historical survey — the only way an international
     *  route gets an estimate at all, since BTS covers US domestic only. No
     *  trend is applied to these: they are already at today's prices. */
    sampledLive?: boolean;
    /** How many real fares on this exact route and quarter the correction was
     *  measured from. Undefined means no route-specific evidence existed and
     *  the global trend was used instead. One sample is real evidence but
     *  could be a peak date, so the UI discloses the count rather than
     *  presenting a one-fare correction as settled. */
    routeSamples?: number;
    /** True when the owner has entered a real fare they saw on this route and
     *  quarter, and it moved this estimate. Surfaced rather than hidden: a
     *  number a human has corrected deserves to say so, and it is still an
     *  estimate, not a quote. */
    ownerCorrected?: boolean;
    /** Set when `start` falls in a real named holiday travel week (see
     *  holidayWindows.ts) and this estimate was moved by that week's
     *  owner-editable premium — never applied to a real cached fare, only
     *  to the fallback estimate, so a real per-date price is never
     *  double-counted against a national-average adjustment. */
    holidayPremiumPct?: number;
    holidayLabel?: string;
  };
}
/**
 * Where in a route's own observed fare range the shown estimate sits.
 *
 * 0 = p25, 50 = the median, 100 = p75. The owner's call, in their words:
 * "lean high". The reasoning is this project's oldest rule — showing $100 and
 * landing on $200 is the failure the whole estimate machinery exists to
 * prevent, while showing high and finding it cheaper costs nobody a booking.
 *
 * It is NOT a fudge factor. Every value it can produce is interpolated
 * between three real observed statistics of that route's own fare
 * distribution, so it can only ever choose among numbers people actually
 * paid. It cannot invent one outside the spread.
 *
 * Owner-editable, because the right lean is a judgement about how travellers
 * react to a number and not something the code can know.
 */
export const ESTIMATE_LEAN_KEY = "flight.estimateLean";
export const DEFAULT_ESTIMATE_LEAN = 100;

/**
 * Piecewise-linear through p25 -> median -> p75. Pure.
 *
 * Piecewise rather than a straight line from low to high because the median
 * is the point that carries meaning: a lean of 50 has to land exactly on it,
 * and a straight interpolation would miss it whenever the spread is
 * lopsided — which on a real fare distribution it usually is.
 */
export function leanedFare(
  est: { low: number; med: number; high: number },
  leanPct: number,
): number {
  const t = Number.isFinite(leanPct) ? Math.max(0, Math.min(100, leanPct)) : DEFAULT_ESTIMATE_LEAN;
  // The three arrive sorted from book.ts, but a caller could hand over
  // anything; guard rather than return a number below the low end.
  const lo = Math.min(est.low, est.med, est.high);
  const mid = est.med;
  const hi = Math.max(est.low, est.med, est.high);
  if (t <= 50) return lo + (mid - lo) * (t / 50);
  return mid + (hi - mid) * ((t - 50) / 50);
}

export interface HotelNight {
  hotelId: string; name: string; descriptor: string;
  nightly: number; tier: Tier; onProperty: boolean; deepLink?: string;
}
export interface TicketRow { adult: number; child: number; junior?: number }
export interface PromoRow {
  id: string; resortId: string | null; label: string;
  effectKind: PromoEffectKind; effectValue: number;
  startsOn: ISODate; endsOn: ISODate; historical: boolean; sourceNote: string;
}
export interface AppliedPromo {
  source: "global" | "personal"; label: string; kind: PromoEffectKind;
  amountUsd: number; historical: boolean; skipped?: string;
}

export interface PriceBook {
  flight(origin: string, dest: string, date: ISODate, tripLength: number): FlightRow | undefined;
  /** Route-level BTS-baseline x trend fallback for when there's no exact
   *  cached fare — undefined when this route has no BTS baseline (expected
   *  for most international routes today) or no trend has been computed
   *  yet. Optional on the interface so bookFrom() (tests) needs no changes. */
  flightEstimate?(origin: string, dest: string): FlightRow["estimate"] | undefined;
  hotelNights(resortId: string, date: ISODate): HotelNight[];
  ticket(resortId: string, date: ISODate): TicketRow | undefined;
  promosFor(resortId: string, date: ISODate): PromoRow[];
  /** The most recent cached national average — undefined falls back to
   *  DRIVING.fallbackGasPriceUsd rather than a hard failure. */
  gasPrice(): { pricePerGallonUsd: number; asOf: string } | undefined;
  /**
   * An owner-set override for one of the numbers this app runs on — a hotel
   * rate, parking, a hopper differential, the mileage rate. Undefined means
   * "not overridden", and every caller falls back to the value in config.ts.
   *
   * It rides on the book because pricing.ts is pure and synchronous and must
   * stay that way: the book is already the one thing loaded from the database
   * and handed in, so overrides arrive by the same door as prices rather than
   * pricing.ts learning to do I/O.
   *
   * Optional on the interface so bookFrom() — every pricing test — needs no
   * changes and keeps exercising the shipped defaults, which is exactly what
   * those tests are for.
   */
  setting?(key: string): number | undefined;
  /** Oldest row backing this book, so the UI can say "prices as of ...". */
  oldestFetchedAt: Date | null;
}

// ---------------------------------------------------------------- outputs

export interface TripPrice {
  start: ISODate;
  /** The airport this trip was actually priced into — the resort's primary
   *  unless params.destination asked for one of its alternates. Always echo
   *  this back to the user rather than assuming they know which one was used. */
  destination: string;
  total: number;
  flights: number;
  tickets: number;
  hotel: number;        // rooms + transport
  rooms: number;
  transport: number;
  food: number;
  perSeatFare: number;
  /** Set when the traveller's own airfare number is below the cheapest fare
   *  the cache knows about for this route and date. It used to be impossible
   *  to be here at all — the override was clamped up to that floor. It now
   *  stands, and this is what the detail card says so on. */
  fareBelowFloor: { yours: number; cheapestKnown: number } | null;
  /** The cached flight this fare came from — price is the real floor, even
   *  when an override raised it. Carries `.estimate` instead of a real
   *  `.stops`/`.deepLink` when there was no exact cache hit and this fell
   *  back to a BTS-baseline estimate; see FlightRow. */
  flightPick: FlightRow | null;
  hotelPick: HotelNight
    | { hotelId: "custom"; name: string; nightly: number; onProperty: boolean }
    | { hotelId: "none"; name: "No hotel"; nightly: 0; onProperty: false };
  hotelTier: { requested: TierIndex; actual: TierIndex; swapped: boolean; custom: boolean };
  foodPlan: { label: string; adult: number; child: number } | null;
  partySize: number;
  /** Curated and personal discounts actually applied — empty when none. rooms/tickets/total already reflect these. */
  appliedPromos: AppliedPromo[];
  /** Gas + optional overnight stop + wear-and-tear, replacing flights
   *  entirely when transportMode is "drive". $0 otherwise. */
  driving: number;
  drivingPick: {
    from: string; roundTripMiles: number; gasPricePerGallonUsd: number;
    gasCostUsd: number; overnightUsd: number; wearAndTearUsd: number;
    /** Which IRS rate wearAndTearUsd was computed at, and whether it's the
     *  real rate for the trip's own year or an older one carried forward
     *  because the IRS hasn't published that year yet. null when no
     *  wear-and-tear was charged at all (a rental, or the user opted out). */
    mileageRate: MileageRateUsed;
  } | null;
  transportMode: TransportMode;
  /** How much of `tickets` is Park Hopper — 0 unless params.hopper was set
   *  and this resort has a hopper price configured. Broken out so the UI can
   *  show it as its own line rather than folding it silently into the base
   *  ticket number. */
  hopperUsd: number;
  /** Annual passes and DVC point rental — null when the traveller said
   *  nothing about either. See src/memberships.ts for why a pass is reported
   *  as a counterfactual rather than charged to this one trip. */
  membership: {
    pass: {
      resortId: string;
      tierId: string;
      label: string;
      /** How many passes they said they hold. */
      count: number;
      /** How many of them this party can actually use — you cannot put a
       *  fifth pass on a party of four. */
      used: number;
      pricePerPassUsd: number;
      /** What the passes cost for a year, all of them. NOT part of `total`. */
      annualCostUsd: number;
      /** Tickets, hopper and parking this trip did not have to pay for.
       *  `total` already reflects these. */
      savedUsd: number;
      /** What this trip's gate costs would have been without the passes —
       *  the "what happens if I don't buy it" number, and the one to weigh
       *  against annualCostUsd. */
      ticketsWithoutPassUsd: number;
      /** True while passes are assumed to cover the priciest tickets first.
       *  Always true today; here so the card can say so rather than implying
       *  the app knows who holds what. */
      coversDearestFirst: boolean;
    } | null;
    dvc: {
      points: number;
      takeHomePerPointUsd: number;
      /** Subtracted from `total`. Money in the member's pocket, not a
       *  discount on anything this trip buys. */
      creditUsd: number;
    } | null;
  } | null;
}
/**
 * The IRS standard mileage rate a driving trip's wear-and-tear line was
 * actually priced at. `carriedForward` is the honest bit: true means the trip
 * falls in a year the IRS hasn't published a rate for yet, so the newest rate
 * on file was reused. Nothing in the UI renders this — it's here so the
 * calculation is inspectable and testable, same as gasPricePerGallonUsd. The
 * owner hears about a carried-forward rate through the news-digest email.
 */
export type MileageRateUsed =
  | { ratePerMile: number; rateYear: number; tripYear: number; carriedForward: boolean }
  | null;

export type PriceResult = { ok: true; price: TripPrice } | { ok: false; reason: string };

// ---------------------------------------------------------------- age bands

export function bandOf(resort: Resort, age: number): Band {
  const b = resort.bands;
  if (age < b.freeUnder) return "infant";
  if (b.junior && age >= b.junior[0] && age <= b.junior[1]) return "junior";
  if (age >= b.child[0] && age <= b.child[1]) return "child";
  return "adult";
}

export function ticketMultiplier(resort: Resort, band: Band): number {
  switch (band) {
    case "infant": return 0;
    case "child": return resort.ticket.child;
    case "junior": return resort.ticket.junior ?? 0.9;
    case "adult": return 1;
  }
}

/** Under-3s eat from an adult's plate at every resort, on a plan or off it. */
export function foodMultiplier(band: Band): number {
  switch (band) {
    case "infant": return 0;
    case "child": return 0.55;
    case "junior": return 0.9;
    case "adult": return 1;
  }
}

/** Under-2s travel as lap infants. */
export function flightMultiplier(age: number): number {
  return age < 2 ? 0.1 : 1;
}

export function partyAges(p: TripParams): number[] {
  return [...Array.from({ length: p.adults }, () => 30), ...p.childAges];
}

// ---------------------------------------------------------------- hotels

export interface HotelPick {
  pool: HotelNight[]; actual: TierIndex; swapped: boolean;
}

/**
 * Hotels matching the requested stay and category. Not every resort offers every
 * category — Tokyo has no on-property moderate, Shanghai has two hotels in total —
 * so step outward to the nearest one and report that we did.
 */
export function poolFor(nights: HotelNight[], stay: Stay, tier: TierIndex): HotelPick {
  const gather = (t: TierIndex): HotelNight[] =>
    nights.filter((h) =>
      (stay === "on") === h.onProperty &&
      h.tier === (h.onProperty ? ON_TIERS[t] : OFF_TIERS[t]));

  const direct = gather(tier);
  if (direct.length) return { pool: direct, actual: tier, swapped: false };
  for (let d = 1; d < 3; d++) {
    for (const t of [tier - d, tier + d] as number[]) {
      if (t < 0 || t > 2) continue;
      const p = gather(t as TierIndex);
      if (p.length) return { pool: p, actual: t as TierIndex, swapped: true };
    }
  }
  const all = nights.filter((h) => (stay === "on") === h.onProperty);
  return { pool: all, actual: tier, swapped: true };
}

/**
 * The cheapest hotel in the requested pool that has a rate for EVERY night of
 * the stay. Extracted from priceTrip so "Compare both" can ask the same
 * question of each side separately without a second pass over the book —
 * a partial-week hotel is not a cheaper hotel, it is a gap in the cache, and
 * that rule must not be re-implemented per caller.
 */
export function cheapestStay(
  book: PriceBook, resortId: string, start: ISODate, nights: number, stay: Stay, tier: TierIndex,
): { rooms: number; hotel: HotelNight; actual: TierIndex; swapped: boolean } | null {
  const firstNight = book.hotelNights(resortId, start);
  if (!firstNight.length) return null;
  const pick = poolFor(firstNight, stay, tier);
  if (!pick.pool.length) return null;

  let best: HotelNight | null = null;
  let bestCost = Infinity;
  for (const candidate of pick.pool) {
    let cost = 0;
    let complete = true;
    for (let i = 0; i < nights; i++) {
      const night = book.hotelNights(resortId, addDaysISO(start, i))
        .find((x) => x.hotelId === candidate.hotelId);
      if (!night) { complete = false; break; }
      cost += night.nightly;
    }
    if (complete && cost < bestCost) { bestCost = cost; best = candidate; }
  }
  return best ? { rooms: bestCost, hotel: best, actual: pick.actual, swapped: pick.swapped } : null;
}

/**
 * The IRS rate the lookup chose, with the owner's override for THAT year and
 * half-year if one is set.
 *
 * Deliberately substitutes only the rate. Which year was used, and whether it
 * was carried forward from an older one, are findings about the lookup — and
 * the owner-facing stale-rate warning depends on them, so an override must not
 * be able to silence a warning that a year is missing.
 */
function withMileageOverride(book: PriceBook, r: MileageRateLookup, dateISO: string): MileageRateLookup {
  if (!r.ok) return r;
  const half = Number(dateISO.slice(5, 7)) <= 6 ? "h1" : "h2";
  const override = book.setting?.(`mileage.${r.rateYear}.${half}`);
  return override === undefined ? r : { ...r, ratePerMile: override };
}

/** Parking and transfers per day, owner override first. */
function transportPerDay(book: PriceBook, resort: Resort, onProperty: boolean): number {
  return book.setting?.(`transport.${resort.id}.${onProperty ? "on" : "off"}`)
    ?? (onProperty ? resort.transport.on : resort.transport.off);
}

/** The flat national rental-car rate, owner override first. */
// ---------------------------------------------------------------- food

export function planFor(resort: Resort, p: TripParams, stay: Stay) {
  if (p.food !== "plan") return null;
  if (!resort.plans.length) return null;
  if (stay === "off" || stay === "none") return null;   // every Disney dining plan needs an on-property stay
  return resort.plans[Math.min(1, resort.plans.length - 1)]!;
}

/**
 * A per-person-per-day rate for any of the seven real dining styles.
 *
 * "someQs" and "someCharacter" are not their own researched numbers —
 * they're the midpoint between the two styles they sit between (see
 * FoodStyle's doc comment in config.ts). Averaging is the honest amount of
 * precision to claim for "some of each": there is no real data on what
 * fraction of meals a traveller who picks this actually eats at each style,
 * so a straight midpoint is a starting point, not a measurement.
 *
 * "plan" falls back to "qs" — reached only when a dining plan was requested
 * but priceTrip couldn't apply one (see planFor), same fallback the model
 * has always used.
 */
export function foodRate(resort: Resort, style: FoodStyle): number {
  const f = resort.food;
  switch (style) {
    case "grocery": return f.grocery;
    case "someQs": return (f.grocery + f.qs) / 2;
    case "qs": case "plan": return f.qs;
    case "mix": return f.mix;
    case "ts": return f.ts;
    case "someCharacter": return (f.ts + f.character) / 2;
    case "character": return f.character;
  }
}

// ---------------------------------------------------------------- the model

const FOOD_DAY_ALLOWANCE = 0.4;             // arrival and departure are part-days

export function priceTrip(
  book: PriceBook, resort: Resort, params: TripParams,
  overrides: Overrides, start: ISODate,
): PriceResult {
  if (params.nights < 1) return { ok: false, reason: "nights must be at least 1" };
  if (params.parkDays < 1) return { ok: false, reason: "park days must be at least 1" };
  if (params.adults < 1) return { ok: false, reason: "a trip needs at least one adult" };

  const ages = partyAges(params);
  const ov = overrides[resort.id] ?? {};
  const bucket = bucketFor(params.nights);

  // --- flights, or driving instead of flying ------------------------------
  const transportMode: TransportMode = params.transportMode ?? "fly";
  const destination = params.destination ?? resort.iata;
  let flights = 0, perSeatFare = 0;
  let fareBelowFloor: TripPrice["fareBelowFloor"] = null;
  let flightPick: TripPrice["flightPick"] = null;
  let driving = 0;
  let drivingPick: TripPrice["drivingPick"] = null;

  if (transportMode === "drive") {
    // US-only, and only to a domestic resort — driving is a real option
    // between US cities and WDW/Disneyland, not across an ocean. Fails
    // cleanly rather than computing a technically-real but meaningless
    // dollar figure for "driving" to Tokyo or Paris.
    if (resort.region !== "dom") {
      return { ok: false, reason: `driving isn't a real option to ${resort.name} — try flying instead` };
    }
    // A geocoded arbitrary city (params.originPoint) takes priority over the
    // fixed ORIGINS list — flying mode never sets originPoint, since flight
    // pricing is airport-cache-keyed and can't be an arbitrary point.
    const from = params.originPoint ?? ORIGIN_BY_IATA.get(params.origin);
    if (!from) return { ok: false, reason: `unknown starting city ${params.origin}` };
    const fromLabel = params.originPoint ? params.originPoint.label : params.origin;
    const oneWayMiles = haversineMiles(from.lat, from.lon, resort.lat, resort.lon) * DRIVING.roadDistanceFactor;
    const roundTripMiles = oneWayMiles * 2;
    const gas = book.gasPrice();
    const gasPricePerGallonUsd = gas?.pricePerGallonUsd ?? DRIVING.fallbackGasPriceUsd;
    const gasCostUsd = (roundTripMiles / DRIVING.mpg) * gasPricePerGallonUsd;
    const stop = params.overnightStop;
    const overnightUsd = stop ? Math.max(0, stop.nights) * Math.max(0, stop.costPerNightUsd) : 0;
    // includeWearAndTear === false is the user's own opt-out (see TripParams)
    // — unset/true keeps the default of including it.
    const chargingWearAndTear = params.includeWearAndTear !== false;
    let wearAndTearUsd = 0;
    let mileageRate: MileageRateUsed = null;
    if (chargingWearAndTear) {
      // Year-aware: the IRS sets a new rate every December, so a trip in a year
      // we have no published figure for reuses the newest one on file — flagged
      // as carried forward, which the owner-only news-digest email reports and
      // the UI deliberately does NOT show (owner's call: a stale-rate banner on
      // a trip page is noise to a traveller, and the number barely moves). Once
      // the newest rate is too old to stand behind, this refuses instead, rather
      // than quietly pricing on it.
      const rate = withMileageOverride(book, irsMileageRate(start), start);
      if (!rate.ok) return { ok: false, reason: rate.reason };
      wearAndTearUsd = roundTripMiles * rate.ratePerMile;
      mileageRate = {
        ratePerMile: rate.ratePerMile, rateYear: rate.rateYear,
        tripYear: rate.tripYear, carriedForward: rate.carriedForward,
      };
    }
    driving = Math.round((gasCostUsd + overnightUsd + wearAndTearUsd) * 100) / 100;
    drivingPick = {
      from: fromLabel, roundTripMiles: Math.round(roundTripMiles),
      gasPricePerGallonUsd, gasCostUsd: Math.round(gasCostUsd * 100) / 100, overnightUsd,
      wearAndTearUsd: Math.round(wearAndTearUsd * 100) / 100, mileageRate,
    };
  } else if (ov.excludeFlights) {
    // "I've already got flights sorted" — not a price claim, so this
    // deliberately does NOT go through the cache-gap check or the floor
    // clamp below. The floor exists to stop someone claiming a lower price
    // than a real fare we found; this isn't claiming any price at all, it's
    // removing the line entirely. Bypassing the cache-gap check also means a
    // trip with genuinely no flight data for this route still prices
    // successfully once flights are excluded, rather than hard-failing.
    flights = 0;
    perSeatFare = 0;
    flightPick = null;
  } else {
    const row = book.flight(params.origin, destination, start, bucket);
    // Always compute the median estimate too, even when a real row exists —
    // a "real" cached fare can itself be a deal-feed's cheapest-found number
    // (Travelpayouts' calendar endpoint is documented as exactly this: a
    // "cheapest fares our users recently found" feed, not a representative
    // one), so it isn't automatically more trustworthy than the route's own
    // honest median. This never fabricates a number where flightEstimate()
    // itself has nothing — est stays undefined for most routes, since BTS
    // coverage is domestic-leaning.
    const est = book.flightEstimate?.(params.origin, destination);
    if (!row && !est && ov.farePerSeat === undefined) {
      return { ok: false, reason: `no cached fare for ${params.origin}-${destination} on ${start}` };
    }
    // The median wins when it's higher than the real row — a rock-bottom
    // deal-feed price gets corrected up to the honest median rather than
    // quietly undercutting what most travellers will actually pay; a real
    // fare that's already representative (at or above the median) still
    // shows as real, plain, with its carrier and booking link.
    // Deliberately still the MEDIAN, not the leaned figure. This decides
    // whether a real cached fare is trustworthy enough to show, and the
    // honest central estimate is the right yardstick for that. Comparing
    // against a leaned figure would start overriding real fares far more
    // often, which is a different change wearing this one's clothes.
    const useRow = !!row && !(est && est.med > row.price);
    // A holiday week's premium only ever adjusts an ESTIMATE, never a real
    // cached fare — a real fare for that exact date already reflects
    // whatever the market actually charges, so layering a national-average
    // premium on top of it would double-count. Computed from `est` (the raw,
    // unmodified estimate) only when useRow is already decided, so the
    // premium can never itself tip a real row into looking "too cheap" and
    // getting overridden — see holidayFlightPremium's own doc comment for
    // why this can't come from BTS.
    const holiday = !useRow ? holidayFlightPremium(start) : null;
    const estAdjusted = est && holiday
      ? (() => {
          const pct = book.setting?.(holiday.settingKey) ?? holiday.defaultPct;
          const mult = 1 + pct / 100;
          const r2 = (n: number) => Math.round(n * 100) / 100;
          return { ...est, low: r2(est.low * mult), med: r2(est.med * mult), high: r2(est.high * mult),
                    holidayPremiumPct: pct, holidayLabel: holiday.label };
        })()
      : est;
    // Whenever an ESTIMATE is what gets shown, it is leaned. See
    // ESTIMATE_LEAN_KEY: the owner's call is to lean high, because an
    // estimate that comes in low is the one that costs somebody at checkout.
    const leanPct = book.setting?.(ESTIMATE_LEAN_KEY) ?? DEFAULT_ESTIMATE_LEAN;
    const estShown = estAdjusted ? leanedFare(estAdjusted, leanPct) : undefined;
    // Flying: an override may raise the fare but never fall below the cheapest fare we know of —
    // "cheapest we know of" is still the real row, even on the rare date the median corrects it up.
    // Miles: a real redemption isn't a market-price guess, so no floor — it can go below the
    // cheapest cash fare, discounted straight off the cache (or the user's own number, if set).
    const floor = row?.price ?? estAdjusted?.med ?? 0;
    const modelFare = useRow ? row!.price : (estShown ?? floor);
    if (transportMode === "miles") {
      const base = ov.farePerSeat !== undefined ? ov.farePerSeat : modelFare;
      const milesPct = Math.min(100, Math.max(0, params.milesPct ?? 0));
      perSeatFare = Math.max(0, base * (1 - milesPct / 100));
    } else {
      // The floor used to be ENFORCED here (Math.max), so typing a number
      // below the cheapest known fare silently priced the trip at the floor
      // instead. The owner reversed that: the box is now a plain number and
      // your number is your number. The claim is still worth flagging, so
      // fareBelowFloor is reported and the detail card says plainly that the
      // cache has nothing this cheap — warn, don't overrule.
      perSeatFare = ov.farePerSeat !== undefined ? Math.max(0, ov.farePerSeat) : modelFare;
      if (ov.farePerSeat !== undefined && floor > 0 && perSeatFare < floor) {
        fareBelowFloor = { yours: perSeatFare, cheapestKnown: floor };
      }
    }
    flights = ages.reduce((sum, age) => sum + perSeatFare * flightMultiplier(age), 0);
    flightPick = useRow
      ? { price: row!.price, carrier: row!.carrier, stops: row!.stops, deepLink: row!.deepLink }
      // The leaned figure, NOT est.med — this is the number the card prints,
      // and it has to be the same one the total was built from. Having the
      // two disagree is worse than either choice on its own: a reader adds
      // up the card and gets a different answer from the board.
      : estAdjusted
      ? { price: estShown ?? estAdjusted.med, estimate: estAdjusted }
      : null;
  }

  // --- tickets -----------------------------------------------------------
  const multiDay = ticketMultiDay(resort, params.parkDays);
  // Per traveller, not one running total, because an annual pass covers
  // PEOPLE. Zeroing a share of one lump sum would be arithmetic that happens
  // to land near the right answer for a party that is all adults and be
  // wrong for every other party.
  const ticketPerHead = ages.map(() => 0);
  for (let i = 0; i < params.parkDays; i++) {
    const day = addDaysISO(start, Math.min(i, params.nights));
    const t = book.ticket(resort.id, day);
    if (!t) return { ok: false, reason: `no ticket price for ${resort.id} on ${day}` };
    ages.forEach((age, idx) => {
      const band = bandOf(resort, age);
      const gate = band === "infant" ? 0
        : band === "child" ? t.child
        : band === "junior" ? (t.junior ?? t.adult * (resort.ticket.junior ?? 0.9))
        : t.adult;
      ticketPerHead[idx] = (ticketPerHead[idx] ?? 0) + gate * multiDay;
    });
  }
  let tickets = ticketPerHead.reduce((a, b) => a + b, 0);

  // --- park hopper: a per-ticket add-on that scales with TICKET LENGTH -----
  // --- where the resort publishes one, flat where it does not, and a real --
  // --- no-op at a resort that does not sell one (Tokyo, Hong Kong, -----------
  // --- Shanghai). Never scaled by season. ----------------------------------
  let hopperUsd = 0;
  // Owner override first, shipped value second — the same two-line shape
  // everywhere below, so there is no doubt which wins.
  // The owner's own figure still wins outright — if they have set one, it is
  // used flat, because a typed number is a decision and silently scaling it
  // by trip length would be the app overruling them.
  const ownerAdult = book.setting?.(`hopper.${resort.id}.adult`);
  const ownerChild = book.setting?.(`hopper.${resort.id}.child`);
  const hopperAdult = ownerAdult ?? hopperPerTicket(resort, params.parkDays, resort.ticket.hopperAdultUsd);
  const hopperChild = ownerChild ?? hopperPerTicket(resort, params.parkDays, resort.ticket.hopperChildUsd);
  const hopperPerHead = ages.map((age) => {
    if (!params.hopper || !hopperAdult) return 0;
    const band = bandOf(resort, age);
    return band === "infant" ? 0
      : band === "child" ? (hopperChild ?? hopperAdult)
      : band === "junior" ? hopperAdult * (resort.ticket.junior ?? 0.9)
      : hopperAdult;
  });
  hopperUsd = hopperPerHead.reduce((a, b) => a + b, 0);
  tickets += hopperUsd;

  /* --- annual passes ----------------------------------------------------
   * A pass you already hold does not make this trip cheaper to Disney; it
   * makes it cheaper to YOU, which is the number the traveller is asking
   * about. So the gate cost for whoever holds one drops to zero here, and the
   * pass's own annual price is reported separately rather than charged to
   * this trip — see src/memberships.ts for why that is the honest shape.
   *
   * Passes are applied to the DEAREST tickets first. Nothing here knows which
   * member of a family holds which pass, and this is the optimistic reading,
   * so `coversDearestFirst` rides along and the card says so. */
  const holding = (params.annualPasses ?? []).find((h) => h.resortId === resort.id);
  const tier = holding ? findTier(holding.resortId, holding.tierId) : undefined;
  let passResult: NonNullable<TripPrice["membership"]>["pass"] = null;
  let parkingPassPct = 0;
  if (holding && tier) {
    const used = Math.min(holding.count, ages.length);
    const order = ticketPerHead
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => b.v - a.v)
      .slice(0, used)
      .map((x) => x.idx);
    let ticketsSaved = 0;
    for (const idx of order) {
      ticketsSaved += ticketPerHead[idx]!;
      if (tier.hopperIncluded) ticketsSaved += hopperPerHead[idx]!;
    }
    tickets = Math.max(0, tickets - ticketsSaved);
    hopperUsd = tier.hopperIncluded
      ? hopperPerHead.filter((_, idx) => !order.includes(idx)).reduce((a, b) => a + b, 0)
      : hopperUsd;
    // The parking perk is a share of the resort's parking-and-transfers line,
    // applied below once that line exists. A party with one pass among four
    // still only parks one car, so this is not scaled by how many they hold.
    parkingPassPct = Math.min(100, Math.max(0, tier.parkingPct));
    const pricePerPassUsd = book.setting?.(passPriceKey(resort.id, tier.id)) ?? tier.priceUsd;
    passResult = {
      resortId: resort.id, tierId: tier.id, label: tier.label,
      count: holding.count, used, pricePerPassUsd,
      annualCostUsd: Math.round(pricePerPassUsd * holding.count * 100) / 100,
      savedUsd: ticketsSaved,
      ticketsWithoutPassUsd: ticketsSaved,
      coversDearestFirst: true,
    };
  }

  // --- food --------------------------------------------------------------
  // excludeHotel folds into the effective stay used for THIS resort only —
  // "I've already got a room sorted" behaves exactly like the global "no
  // hotel wanted" case (no dining plan, no on-site transport line) without
  // being a new branch: it reuses the stay==="none" handling below.
  const stayForResort: Stay = ov.excludeHotel ? "none" : params.stay;
  const foodPlan = planFor(resort, params, stayForResort);
  let food = 0;
  if (foodPlan) {
    for (const age of ages) {
      const band = bandOf(resort, age);
      if (band === "infant") continue;
      food += (band === "child" ? foodPlan.child : foodPlan.adult) * params.nights;
    }
  } else if (ov.foodPerDayUsd !== undefined) {
    // A party total, so no per-age scaling — see ResortOverride.foodPerDayUsd.
    food = Math.max(0, ov.foodPerDayUsd) * (params.nights + FOOD_DAY_ALLOWANCE);
  } else {
    const rate = foodRate(resort, params.food);
    const days = params.nights + FOOD_DAY_ALLOWANCE;
    for (const age of ages) food += rate * foodMultiplier(bandOf(resort, age)) * days;
  }

  // --- hotel -------------------------------------------------------------
  const stay: Stay = stayForResort;

  let rooms: number;
  let hotelPick: TripPrice["hotelPick"];
  let hotelTier: TripPrice["hotelTier"];

  if (stay === "none") {
    // No hotel wanted at all — not "off property," genuinely $0, no pick.
    rooms = 0;
    hotelPick = { hotelId: "none", name: "No hotel", nightly: 0, onProperty: false };
    hotelTier = { requested: params.tier, actual: params.tier, swapped: false, custom: false };
  } else if (ov.nightly !== undefined && ov.nightly > 0) {
    // A rate you found is a rate you found — it does not flex with the season.
    rooms = ov.nightly * params.nights;
    hotelPick = { hotelId: "custom", name: "Your rate", nightly: ov.nightly, onProperty: stay !== "off" };
    hotelTier = { requested: params.tier, actual: params.tier, swapped: false, custom: true };
  } else {
    const firstNight = book.hotelNights(resort.id, start);
    if (!firstNight.length) return { ok: false, reason: `no cached hotel rates for ${resort.id} on ${start}` };
    const pick = cheapestStay(book, resort.id, start, params.nights, stay, params.tier);
    if (!pick) return { ok: false, reason: `no hotel matches stay=${stay} tier=${params.tier} for ${resort.id} from ${start}` };
    rooms = pick.rooms;
    hotelPick = pick.hotel;
    hotelTier = { requested: params.tier, actual: pick.actual, swapped: pick.swapped, custom: false };
  }

  // --- promos: a curated guess (looked up server-side, never trusted from --
  // --- the client beyond its id) and the user's own claimed discount -------
  const appliedPromos: AppliedPromo[] = [];
  const clampPct = (v: number) => Math.min(100, Math.max(0, v));
  let flatOffTotal = 0;

  const applyPromoEffect = (
    source: "global" | "personal", label: string, kind: PromoEffectKind, value: number, historical: boolean,
  ) => {
    if (kind === "room_pct_off" || kind === "room_flat_off") {
      // A curated guess shouldn't second-guess a rate the user already found
      // themselves — but the user's own claim about their own price may.
      // Same reasoning applies to a room that's been excluded entirely: a
      // discount on a $0 room says nothing useful.
      if (source === "global" && (ov.nightly !== undefined || ov.excludeHotel)) {
        appliedPromos.push({
          source, label, kind, amountUsd: 0, historical,
          skipped: ov.excludeHotel ? "you're not counting a hotel here" : "you set your own nightly rate",
        });
        return;
      }
      const before = rooms;
      rooms = kind === "room_pct_off" ? rooms * (1 - clampPct(value) / 100) : Math.max(0, rooms - value);
      appliedPromos.push({ source, label, kind, amountUsd: before - rooms, historical });
    } else if (kind === "ticket_pct_off") {
      const before = tickets;
      tickets = tickets * (1 - clampPct(value) / 100);
      appliedPromos.push({ source, label, kind, amountUsd: before - tickets, historical });
    } else if (kind === "free_dining") {
      if (foodPlan) {
        appliedPromos.push({ source, label, kind, amountUsd: food, historical });
        food = 0;
      } else {
        appliedPromos.push({ source, label, kind, amountUsd: 0, historical, skipped: "no dining plan on this trip" });
      }
    } else if (kind === "flat_off_total") {
      const amountUsd = Math.max(0, value);
      flatOffTotal += amountUsd;
      appliedPromos.push({ source, label, kind, amountUsd, historical });
    }
  };

  if (ov.promoId) {
    const promo = book.promosFor(resort.id, start).find((candidate) => candidate.id === ov.promoId);
    if (promo) applyPromoEffect("global", promo.label, promo.effectKind, promo.effectValue, promo.historical);
    // An unknown/expired promoId is silently ignored — never a hard failure over a stale id.
  }
  if (ov.personalPromo) {
    applyPromoEffect("personal", ov.personalPromo.label, ov.personalPromo.kind, ov.personalPromo.value, false);
  }

  // Off-property looks cheaper than it is until you pay to park at the parks —
  // unless there's no hotel at all, in which case there's nothing to model.
  const perDay = stay === "none" ? 0 : transportPerDay(book, resort, hotelPick.onProperty);
  const transportFull = perDay * (params.nights + 1);
  // A pass's parking perk lands here rather than on the ticket line, because
  // parking is what it actually pays for. On property this is usually zero
  // already, so the perk quietly does nothing — which is correct, not a bug.
  const transport = Math.round(transportFull * (1 - parkingPassPct / 100) * 100) / 100;
  if (passResult) {
    passResult.savedUsd = Math.round((passResult.savedUsd + (transportFull - transport)) * 100) / 100;
  }
  const hotel = rooms + transport;

  /* --- DVC points rented out --------------------------------------------
   * Money the member receives for points they are not using, set against
   * what this trip costs them. Deliberately a credit on the TOTAL and not a
   * discount on the hotel line: renting points has nothing to do with what a
   * room here costs, and folding it into the room would make the hotel
   * comparison between six resorts lie. */
  const dvcPerPoint = book.setting?.(DVC_TAKE_HOME_KEY) ?? DVC_TAKE_HOME_PER_POINT;
  const dvc = params.dvcRental && params.dvcRental.points > 0
    ? {
        points: params.dvcRental.points,
        takeHomePerPointUsd: params.dvcRental.takeHomePerPointUsd || dvcPerPoint,
        creditUsd: 0,
      }
    : null;
  if (dvc) dvc.creditUsd = dvcCredit({ points: dvc.points, takeHomePerPointUsd: dvc.takeHomePerPointUsd });

  const membership: TripPrice["membership"] = passResult || dvc ? { pass: passResult, dvc } : null;

  const total = Math.max(0, flights + tickets + hotel + food + driving
    - flatOffTotal - (dvc?.creditUsd ?? 0));
  if (!Number.isFinite(total)) return { ok: false, reason: "non-finite total" };

  return {
    ok: true,
    price: {
      start, destination, total, flights, tickets, hotel, rooms, transport, food,
      perSeatFare, flightPick, fareBelowFloor,
      hotelPick, hotelTier, foodPlan, partySize: ages.length,
      appliedPromos,
      driving, drivingPick, transportMode, hopperUsd,
      membership,
    },
  };
}

/** Cheapest priceable start date in a window. Gaps are skipped, not fatal. */
/** How much of each tail a month's prices are trimmed by before averaging. */
export const TYPICAL_TRIM_KEY = "search.typicalTrimPct";
export const DEFAULT_TYPICAL_TRIM = 10;
/** Below this many priced dates, trimming throws away too much to be worth
 *  it — a four-date month trimmed 10% either way is just the mean anyway. */
export const MIN_DATES_TO_TRIM = 10;

export interface MonthSpread {
  /** Cheapest and dearest priced day in the window. */
  low: number;
  high: number;
  /** The straight average of every priced day. */
  mean: number;
  /** The average after the cheapest and dearest tails are dropped — the
   *  number the board quotes. */
  trimmedMean: number;
  /** How many days were priced, and how many were dropped from EACH tail. */
  priced: number;
  trimmedPerTail: number;
  /** The cheapest day itself, so the card can name a date rather than just
   *  a number. A floor with no date attached is not actionable. */
  lowDate: ISODate;
}

export interface TypicalPick {
  /** The day the board quotes: the priced day whose total lands nearest the
   *  trimmed mean. A REAL bookable date with a real breakdown, never a
   *  composite — a total averaged across days belongs to no trip anybody can
   *  book, and every line under it would contradict it. */
  typical: TripPrice | null;
  /** The cheapest day, still computed and still offered. */
  cheapest: TripPrice | null;
  spread: MonthSpread | null;
  priced: number;
  skipped: string[];
}

/**
 * Price a window and pick the day worth QUOTING, not the luckiest one.
 *
 * The board used to show the cheapest day in the month. That reads as a
 * quote and behaves as a floor: the owner's October example priced Houston
 * to Orlando at $143 against a month whose days ran $87 to $1,122. The $87
 * was real and it was Halloween.
 *
 * The fix is a trimmed mean, and the reasoning is the owner's: the dear days
 * are dear BECAUSE that is when people fly, and the rock-bottom days are
 * cheap because those seats go out empty. Neither tail describes a trip
 * somebody is actually going to take, so both are dropped before averaging.
 * That is not the same argument as this project's older median-not-mean rule
 * for BTS fares — there the mean was dragged by unrepresentative itineraries;
 * here BOTH ends are unrepresentative and the middle is the product.
 *
 * Worked against the owner's October calendar: mean $354, median $222,
 * trimmed mean $309, cheapest $87. The trim drops $87/$94/$112 and
 * $1,122/$1,049/$760 and leaves every ordinary day standing.
 *
 * The cheapest day is NOT discarded — it is returned beside the typical one,
 * because "as low as $87 if you can fly on the 31st" is genuinely useful and
 * withholding it to make a headline look better would be the same dishonesty
 * one rung up.
 */
export function typicalIn(
  book: PriceBook, resort: Resort, params: TripParams,
  overrides: Overrides, dates: ISODate[],
): TypicalPick {
  const priced: { date: ISODate; price: TripPrice }[] = [];
  const skipped: string[] = [];
  for (const d of dates) {
    const r = priceTrip(book, resort, params, overrides, d);
    if (!r.ok) { skipped.push(`${d}: ${r.reason}`); continue; }
    priced.push({ date: d, price: r.price });
  }
  if (!priced.length) return { typical: null, cheapest: null, spread: null, priced: 0, skipped };

  const byTotal = [...priced].sort((a, b) => a.price.total - b.price.total || (a.date < b.date ? -1 : 1));
  const cheapest = byTotal[0]!;
  const dearest = byTotal[byTotal.length - 1]!;

  const raw = book.setting?.(TYPICAL_TRIM_KEY) ?? DEFAULT_TYPICAL_TRIM;
  const trimPct = Number.isFinite(raw) ? Math.max(0, Math.min(45, raw)) : DEFAULT_TYPICAL_TRIM;
  // Floor, not round: trimming must never remove more than it is asked to,
  // and 45% is capped above so a trim can never empty the set from both ends.
  const perTail = byTotal.length >= MIN_DATES_TO_TRIM
    ? Math.min(Math.floor((byTotal.length * trimPct) / 100), Math.floor((byTotal.length - 1) / 2))
    : 0;
  const kept = perTail > 0 ? byTotal.slice(perTail, byTotal.length - perTail) : byTotal;

  const mean = byTotal.reduce((sum, x) => sum + x.price.total, 0) / byTotal.length;
  const trimmedMean = kept.reduce((sum, x) => sum + x.price.total, 0) / kept.length;

  // The kept day nearest the trimmed mean. Chosen from `kept` rather than
  // from every priced day so a trimmed outlier can never come back as the
  // headline, which it can when the distribution is lopsided enough that the
  // trimmed mean sits closer to a dropped day than to any surviving one.
  let typical = kept[0]!;
  for (const x of kept) {
    if (Math.abs(x.price.total - trimmedMean) < Math.abs(typical.price.total - trimmedMean)) typical = x;
  }

  return {
    typical: typical.price,
    cheapest: cheapest.price,
    spread: {
      low: cheapest.price.total, high: dearest.price.total,
      mean, trimmedMean, priced: byTotal.length, trimmedPerTail: perTail,
      lowDate: cheapest.date,
    },
    priced: byTotal.length,
    skipped,
  };
}

/**
 * How much a multi-day ticket discounts a single day's gate price.
 *
 * Two sources, and the real one wins. Where a resort publishes actual
 * multi-day totals (`multiDayAdultUsd`) the factor is derived from them, so
 * the board charges what Disney charges. Everywhere else it is the old
 * base x slope line, unchanged.
 *
 * Deriving rather than storing a factor is deliberate: the config holds
 * numbers somebody can check against Disney's own page, and the arithmetic
 * that turns them into a discount lives here where it is tested.
 *
 * PAST THE END OF THE TABLE the last marginal day is repeated — Walt Disney
 * World's seventh day costs $30, so an eighth is priced at $30 too. That is
 * far closer than falling back to a curve fitted to a different shape, and it
 * degrades gently rather than stepping.
 *
 * A factor is NOT clamped to 1. Disneyland's two-day ticket genuinely costs
 * more per day than its one-day ($167.50 against $149), so the factor is
 * 1.124 and must stay there; clamping would quietly undercharge the single
 * most common Disneyland trip.
 */
export function ticketMultiDay(resort: Resort, parkDays: number): number {
  const days = Math.max(1, Math.round(parkDays));
  const totals = resort.ticket.multiDayAdultUsd;
  if (totals && totals.length >= 2 && totals[0]! > 0) {
    const oneDay = totals[0]!;
    let total: number;
    if (days <= totals.length) {
      total = totals[days - 1]!;
    } else {
      const last = totals[totals.length - 1]!;
      const marginal = last - totals[totals.length - 2]!;
      total = last + marginal * (days - totals.length);
    }
    const factor = total / (oneDay * days);
    if (Number.isFinite(factor) && factor > 0) return factor;
  }
  return Math.max(resort.ticket.floor, 1 - resort.ticket.slope * (days - 1));
}

/**
 * The Park Hopper add-on for one ticket of this length. Real published
 * add-ons by day count where a resort has them, the flat figure otherwise,
 * and zero at a resort that does not sell one at all.
 */
export function hopperPerTicket(
  resort: Resort, parkDays: number, flat: number | undefined,
): number {
  const byDays = resort.ticket.hopperByDaysUsd;
  if (byDays && byDays.length) {
    const days = Math.max(1, Math.round(parkDays));
    return byDays[Math.min(days, byDays.length) - 1] ?? flat ?? 0;
  }
  return flat ?? 0;
}

export function cheapestIn(
  book: PriceBook, resort: Resort, params: TripParams,
  overrides: Overrides, dates: ISODate[],
): { best: TripPrice | null; priced: number; skipped: string[] } {
  let best: TripPrice | null = null;
  const skipped: string[] = [];
  let priced = 0;
  for (const d of dates) {
    const r = priceTrip(book, resort, params, overrides, d);
    if (!r.ok) { skipped.push(`${d}: ${r.reason}`); continue; }
    priced++;
    if (!best || r.price.total < best.total) best = r.price;
  }
  return { best, priced, skipped };
}

export function resortById(id: string): Resort {
  const r = RESORT_BY_ID.get(id);
  if (!r) throw new Error(`unknown resort: ${id}`);
  return r;
}

export type { HotelDef };
