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
  ON_TIERS, OFF_TIERS, RESORT_BY_ID, bucketFor,
  type Band, type FoodStyle, type Resort, type Stay, type Tier, type TierIndex, type HotelDef,
} from "./config.js";
import { addDaysISO, type ISODate } from "./dates.js";

// ---------------------------------------------------------------- inputs

export interface TripParams {
  origin: string;
  adults: number;
  childAges: number[];
  nights: number;
  parkDays: number;
  stay: Stay;
  tier: TierIndex;
  food: FoodStyle;
}

/** A rate or fare the user supplied themselves. Never below the cheapest known fare. */
export interface ResortOverride { nightly?: number; farePerSeat?: number }
export type Overrides = Record<string, ResortOverride | undefined>;

// ---------------------------------------------------------------- cache view

export interface FlightRow { price: number; carrier?: string; stops: number; deepLink?: string }
export interface HotelNight {
  hotelId: string; name: string; descriptor: string;
  nightly: number; tier: Tier; onProperty: boolean; deepLink?: string;
}
export interface TicketRow { adult: number; child: number; junior?: number }

export interface PriceBook {
  flight(origin: string, dest: string, date: ISODate, tripLength: number): FlightRow | undefined;
  hotelNights(resortId: string, date: ISODate): HotelNight[];
  ticket(resortId: string, date: ISODate): TicketRow | undefined;
  /** Oldest row backing this book, so the UI can say "prices as of ...". */
  oldestFetchedAt: Date | null;
}

// ---------------------------------------------------------------- outputs

export interface TripPrice {
  start: ISODate;
  total: number;
  flights: number;
  tickets: number;
  hotel: number;        // rooms + transport
  rooms: number;
  transport: number;
  food: number;
  perSeatFare: number;
  hotelPick: HotelNight | { hotelId: "custom"; name: string; nightly: number; onProperty: boolean };
  hotelTier: { requested: TierIndex; actual: TierIndex; swapped: boolean; custom: boolean };
  foodPlan: { label: string; adult: number; child: number } | null;
  partySize: number;
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
  if (stay === "off") return null;          // every Disney dining plan needs an on-property stay
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

  // --- flights -----------------------------------------------------------
  const row = book.flight(params.origin, resort.iata, start, bucket);
  if (!row && ov.farePerSeat === undefined) {
    return { ok: false, reason: `no cached fare for ${params.origin}-${resort.iata} on ${start}` };
  }
  // An override may raise the fare but never fall below the cheapest fare we know of.
  const floor = row?.price ?? 0;
  const perSeatFare = ov.farePerSeat !== undefined ? Math.max(ov.farePerSeat, floor) : floor;
  const flights = ages.reduce((sum, age) => sum + perSeatFare * flightMultiplier(age), 0);

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

  if (ov.nightly !== undefined && ov.nightly > 0) {
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

  // Off-property looks cheaper than it is until you pay to park at the parks.
  const perDay = hotelPick.onProperty ? resort.transport.on : resort.transport.off;
  const transport = perDay * (params.nights + 1);
  const hotel = rooms + transport;

  const total = flights + tickets + hotel + food;
  if (!Number.isFinite(total)) return { ok: false, reason: "non-finite total" };

  return {
    ok: true,
    price: {
      start, total, flights, tickets, hotel, rooms, transport, food,
      perSeatFare, hotelPick, hotelTier, foodPlan, partySize: ages.length,
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
