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
  ON_TIERS, OFF_TIERS, RESORT_BY_ID, ORIGIN_BY_IATA, DRIVING, CAR_RENTAL, bucketFor, irsMileageRatePerMile,
  type Band, type FoodStyle, type Resort, type Stay, type Tier, type TierIndex, type HotelDef,
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
}

export type PromoEffectKind = "room_pct_off" | "room_flat_off" | "free_dining" | "ticket_pct_off" | "flat_off_total";

/** A rate or fare the user supplied themselves. Never below the cheapest known fare. */
export interface ResortOverride {
  nightly?: number; farePerSeat?: number;
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
   *  entirely when transportMode is "drive". $0 otherwise. Never includes
   *  rentalCarUsd — that's always its own separate line, see below. */
  driving: number;
  drivingPick: {
    from: string; roundTripMiles: number; gasPricePerGallonUsd: number;
    gasCostUsd: number; overnightUsd: number; wearAndTearUsd: number;
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
    const wearAndTearUsd = params.rentalCar ? 0 : roundTripMiles * irsMileageRatePerMile(start);
    driving = Math.round((gasCostUsd + overnightUsd + wearAndTearUsd) * 100) / 100;
    drivingPick = {
      from: fromLabel, roundTripMiles: Math.round(roundTripMiles),
      gasPricePerGallonUsd, gasCostUsd: Math.round(gasCostUsd * 100) / 100, overnightUsd,
      wearAndTearUsd: Math.round(wearAndTearUsd * 100) / 100,
    };
  } else {
    const row = book.flight(params.origin, destination, start, bucket);
    // No exact cache hit — fall back to a BTS-baseline x trend estimate
    // before giving up. Still an honest gap (undefined) for most routes
    // today, since BTS coverage is domestic-leaning; this never fabricates
    // a number where flightEstimate() itself has nothing.
    const est = !row ? book.flightEstimate?.(params.origin, destination) : undefined;
    if (!row && !est && ov.farePerSeat === undefined) {
      return { ok: false, reason: `no cached fare for ${params.origin}-${destination} on ${start}` };
    }
    // Flying: an override may raise the fare but never fall below the cheapest fare we know of.
    // Miles: a real redemption isn't a market-price guess, so no floor — it can go below the
    // cheapest cash fare, discounted straight off the cache (or the user's own number, if set).
    const floor = row?.price ?? est?.med ?? 0;
    if (transportMode === "miles") {
      const base = ov.farePerSeat !== undefined ? ov.farePerSeat : floor;
      const milesPct = Math.min(100, Math.max(0, params.milesPct ?? 0));
      perSeatFare = Math.max(0, base * (1 - milesPct / 100));
    } else {
      perSeatFare = ov.farePerSeat !== undefined ? Math.max(ov.farePerSeat, floor) : floor;
    }
    flights = ages.reduce((sum, age) => sum + perSeatFare * flightMultiplier(age), 0);
    flightPick = row
      ? { price: row.price, carrier: row.carrier, stops: row.stops, deepLink: row.deepLink }
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
  if (params.hopper && resort.ticket.hopperAdultUsd) {
    for (const age of ages) {
      const band = bandOf(resort, age);
      hopperUsd += band === "infant" ? 0
        : band === "child" ? (resort.ticket.hopperChildUsd ?? resort.ticket.hopperAdultUsd)
        : band === "junior" ? resort.ticket.hopperAdultUsd * (resort.ticket.junior ?? 0.9)
        : resort.ticket.hopperAdultUsd;
    }
    tickets += hopperUsd;
  }

  // --- food --------------------------------------------------------------
  const foodPlan = planFor(resort, params, params.stay);
  let food = 0;
  if (foodPlan) {
    for (const age of ages) {
      const band = bandOf(resort, age);
      if (band === "infant") continue;
      food += (band === "child" ? foodPlan.child : foodPlan.adult) * params.nights;
    }
  } else {
    const style = params.food === "plan" ? "qs" : params.food;
    const rate = resort.food[style];
    const days = params.nights + FOOD_DAY_ALLOWANCE;
    for (const age of ages) food += rate * foodMultiplier(bandOf(resort, age)) * days;
  }

  // --- hotel -------------------------------------------------------------
  // A dining plan forces an on-property stay, because that is how Disney sells it.
  const stay: Stay = foodPlan && params.stay === "both" ? "on" : params.stay;

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
    const pick = poolFor(firstNight, stay, params.tier);
    if (!pick.pool.length) return { ok: false, reason: `no hotel matches stay=${stay} tier=${params.tier}` };

    let best: HotelNight | null = null;
    let bestCost = Infinity;
    for (const candidate of pick.pool) {
      let cost = 0;
      let complete = true;
      for (let i = 0; i < params.nights; i++) {
        const night = book.hotelNights(resort.id, addDaysISO(start, i))
          .find((x) => x.hotelId === candidate.hotelId);
        if (!night) { complete = false; break; }
        cost += night.nightly;
      }
      if (complete && cost < bestCost) { bestCost = cost; best = candidate; }
    }
    if (!best) return { ok: false, reason: `incomplete hotel data for ${resort.id} from ${start}` };
    rooms = bestCost;
    hotelPick = best;
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
      if (source === "global" && ov.nightly !== undefined) {
        appliedPromos.push({ source, label, kind, amountUsd: 0, historical, skipped: "you set your own nightly rate" });
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
  const perDay = stay === "none" ? 0 : hotelPick.onProperty ? resort.transport.on : resort.transport.off;
  const transport = perDay * (params.nights + 1);
  const hotel = rooms + transport;

  // --- rental car — always its own line, whether renting for the drive -----
  // --- (instead of your own car) or renting once you've flown in. ----------
  const rentalCarUsd = params.rentalCar
    ? Math.round(CAR_RENTAL.dailyRateUsd * (params.nights + 1) * 100) / 100
    : 0;
  const rentalCarPick: TripPrice["rentalCarPick"] = params.rentalCar
    ? { dailyRateUsd: CAR_RENTAL.dailyRateUsd, nights: params.nights }
    : null;

  const total = Math.max(0, flights + tickets + hotel + food + driving + rentalCarUsd - flatOffTotal);
  if (!Number.isFinite(total)) return { ok: false, reason: "non-finite total" };

  return {
    ok: true,
    price: {
      start, destination, total, flights, tickets, hotel, rooms, transport, food,
      perSeatFare, flightPick,
      hotelPick, hotelTier, foodPlan, partySize: ages.length,
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
