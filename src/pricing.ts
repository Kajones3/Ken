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
  ON_TIERS, OFF_TIERS, RESORT_BY_ID, ORIGIN_BY_IATA, DRIVING, CAR_RENTAL, bucketFor, irsMileageRate,
  type Band, type FoodStyle, type Resort, type Stay, type Tier, type TierIndex, type HotelDef,
  type MileageRateLookup,
} from "./config.js";
import { addDaysISO, type ISODate } from "./dates.js";
import { haversineMiles } from "./geo.js";

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
  /** Rent a car — for whichever mode this params object represents. "drive":
   *  rent instead of putting miles on your own car (replaces wearAndTearUsd
   *  with rentalCarUsd, gas still applies). "fly"/"miles": rent something to
   *  get around once there (rentalCarUsd is a new line, on top of flights).
   *  A mixed board can send this true for the driving leg, the flying legs,
   *  both, or neither — see server.ts's gettingThereParams(). */
  rentalCar?: boolean;
  /** "drive" only. Defaults to true (unset behaves the same as true) so the
   *  total keeps including a real cost by default, same reasoning as always
   *  including off-property parking/transfers — an option shouldn't look
   *  artificially cheap by omitting something real. The IRS standard
   *  mileage rate bundles depreciation, maintenance and insurance into one
   *  per-mile number, not just gas, which can dwarf the gas line on a long
   *  drive and read as misleading to someone who doesn't think of their own
   *  car's depreciation as a cost of THIS trip — set false to drop it and
   *  price gas only. Moot (and hidden in the UI) whenever rentalCar is true,
   *  since a rental already has no wear-and-tear cost to the user. */
  includeWearAndTear?: boolean;
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
  };
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
  /** Only when the search asked to compare on- AND off-property. What the two
   *  sides actually cost over these dates, parking and transfers included, so
   *  "Compare both" can say what it found instead of silently picking. */
  stayCompare: {
    on: { name: string; nightly: number; total: number };
    off: { name: string; nightly: number; total: number };
    cheaper: "on" | "off";
    savesPerNight: number;
    savesTotal: number;
  } | null;
  foodPlan: { label: string; adult: number; child: number } | null;
  partySize: number;
  /** Curated and personal discounts actually applied — empty when none. rooms/tickets/total already reflect these. */
  appliedPromos: AppliedPromo[];
  /** Gas + optional overnight stop + wear-and-tear, replacing flights
   *  entirely when transportMode is "drive". $0 otherwise. Never includes
   *  rentalCarUsd — that's always its own separate line, see below. */
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
  /** Renting a car — set whenever params.rentalCar is true, regardless of
   *  drive or fly mode. Always its own line in `total`, never folded into
   *  `driving` (drive mode zeroes wearAndTearUsd instead, since a rental
   *  isn't wear on a car you own). */
  rentalCarUsd: number;
  rentalCarPick: { dailyRateUsd: number; nights: number } | null;
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
      (stay === "both" || (stay === "on") === h.onProperty) &&
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
  const all = nights.filter((h) => stay === "both" || (stay === "on") === h.onProperty);
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
function carRentalRate(book: PriceBook): number {
  return book.setting?.("carRental.dailyRateUsd") ?? CAR_RENTAL.dailyRateUsd;
}

// ---------------------------------------------------------------- food

export function planFor(resort: Resort, p: TripParams, stay: Stay) {
  if (p.food !== "plan") return null;
  if (!resort.plans.length) return null;
  if (stay === "off" || stay === "none") return null;   // every Disney dining plan needs an on-property stay
  return resort.plans[Math.min(1, resort.plans.length - 1)]!;
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
    // A rental has no wear-and-tear cost to the user — that's priced into
    // the rental fee already, and rentalCarUsd (below) covers it separately.
    // includeWearAndTear === false is the user's own opt-out (see TripParams)
    // — unset/true keeps the default of including it.
    const chargingWearAndTear = !(params.rentalCar || params.includeWearAndTear === false);
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
    const useRow = !!row && !(est && est.med > row.price);
    // Flying: an override may raise the fare but never fall below the cheapest fare we know of —
    // "cheapest we know of" is still the real row, even on the rare date the median corrects it up.
    // Miles: a real redemption isn't a market-price guess, so no floor — it can go below the
    // cheapest cash fare, discounted straight off the cache (or the user's own number, if set).
    const floor = row?.price ?? est?.med ?? 0;
    const modelFare = useRow ? row!.price : (est?.med ?? floor);
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
      : est
      ? { price: est.med, estimate: est }
      : null;
  }

  // --- tickets -----------------------------------------------------------
  const multiDay = Math.max(resort.ticket.floor, 1 - resort.ticket.slope * (params.parkDays - 1));
  let tickets = 0;
  for (let i = 0; i < params.parkDays; i++) {
    const day = addDaysISO(start, Math.min(i, params.nights));
    const t = book.ticket(resort.id, day);
    if (!t) return { ok: false, reason: `no ticket price for ${resort.id} on ${day}` };
    for (const age of ages) {
      const band = bandOf(resort, age);
      const gate = band === "infant" ? 0
        : band === "child" ? t.child
        : band === "junior" ? (t.junior ?? t.adult * (resort.ticket.junior ?? 0.9))
        : t.adult;
      tickets += gate * multiDay;
    }
  }

  // --- park hopper (flat per-ticket add-on, not scaled by parkDays or ------
  // --- season) — silently a no-op at a resort with no hopper price. --------
  let hopperUsd = 0;
  // Owner override first, shipped value second — the same two-line shape
  // everywhere below, so there is no doubt which wins.
  const hopperAdult = book.setting?.(`hopper.${resort.id}.adult`) ?? resort.ticket.hopperAdultUsd;
  const hopperChild = book.setting?.(`hopper.${resort.id}.child`) ?? resort.ticket.hopperChildUsd;
  if (params.hopper && hopperAdult) {
    for (const age of ages) {
      const band = bandOf(resort, age);
      hopperUsd += band === "infant" ? 0
        : band === "child" ? (hopperChild ?? hopperAdult)
        : band === "junior" ? hopperAdult * (resort.ticket.junior ?? 0.9)
        : hopperAdult;
    }
    tickets += hopperUsd;
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
    const style = params.food === "plan" ? "qs" : params.food;
    const rate = resort.food[style];
    const days = params.nights + FOOD_DAY_ALLOWANCE;
    for (const age of ages) food += rate * foodMultiplier(bandOf(resort, age)) * days;
  }

  // --- hotel -------------------------------------------------------------
  // A dining plan forces an on-property stay, because that is how Disney sells it.
  const stay: Stay = foodPlan && stayForResort === "both" ? "on" : stayForResort;

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

  /* "Compare both" widened the hotel pool to on- AND off-property and picked
   * whichever was cheaper — correctly, and completely silently, so the owner's
   * reasonable read was that the control did nothing at all.
   *
   * This is what it costs, priced the same way the rest of the card is: the
   * two sides compared over the dates actually being priced, INCLUDING
   * parking and transfers, because off-property's parking is exactly the cost
   * people leave out when they conclude off-property is cheaper. Computed
   * here from the book slice already loaded — no extra request, no provider
   * call. Null whenever there is nothing to compare (one side has no cached
   * rate, a typed nightly rate has replaced both, or the search wasn't
   * comparing in the first place). */
  let stayCompare: TripPrice["stayCompare"] = null;
  if (params.stay === "both" && stay === "both" && ov.nightly === undefined) {
    const on = cheapestStay(book, resort.id, start, params.nights, "on", params.tier);
    const off = cheapestStay(book, resort.id, start, params.nights, "off", params.tier);
    if (on && off) {
      const onTotal = on.rooms + transportPerDay(book, resort, true) * params.nights;
      const offTotal = off.rooms + transportPerDay(book, resort, false) * params.nights;
      stayCompare = {
        on: { name: on.hotel.name, nightly: on.rooms / params.nights, total: onTotal },
        off: { name: off.hotel.name, nightly: off.rooms / params.nights, total: offTotal },
        cheaper: onTotal <= offTotal ? "on" : "off",
        savesPerNight: Math.abs(onTotal - offTotal) / params.nights,
        savesTotal: Math.abs(onTotal - offTotal),
      };
    }
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
  const transport = perDay * (params.nights + 1);
  const hotel = rooms + transport;

  // --- rental car — always its own line, whether renting for the drive -----
  // --- (instead of your own car) or renting once you've flown in. ----------
  const rentalCarUsd = params.rentalCar
    ? Math.round(carRentalRate(book) * (params.nights + 1) * 100) / 100
    : 0;
  const rentalCarPick: TripPrice["rentalCarPick"] = params.rentalCar
    ? { dailyRateUsd: carRentalRate(book), nights: params.nights }
    : null;

  const total = Math.max(0, flights + tickets + hotel + food + driving + rentalCarUsd - flatOffTotal);
  if (!Number.isFinite(total)) return { ok: false, reason: "non-finite total" };

  return {
    ok: true,
    price: {
      start, destination, total, flights, tickets, hotel, rooms, transport, food,
      perSeatFare, flightPick, fareBelowFloor,
      hotelPick, hotelTier, stayCompare, foodPlan, partySize: ages.length,
      appliedPromos,
      driving, drivingPick, transportMode, hopperUsd,
      rentalCarUsd, rentalCarPick,
    },
  };
}

/** Cheapest priceable start date in a window. Gaps are skipped, not fatal. */
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
