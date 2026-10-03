/**
 * What a deal is worth in dollars, for the deal email (owner, 2026-10-03:
 * the email should say "A Deal May Save You $X on your Disney Trip").
 *
 * A percent is not a saving: 25% off rooms is $300 on one trip and $1,500 on
 * another. So the saving is measured with our own numbers, the same way the
 * board would show it: one trip priced on a typical arrival day inside the
 * deal's travel dates, once with deals turned off and once with this deal.
 *
 * Whose trip: the member's most recent saved search when they have one (its
 * party, nights, hotel and food), otherwise a standard trip (2 adults, 6
 * nights, a Moderate Disney hotel, a mix of quick and table service). The
 * email says which, because "may save you $X" is only honest next to what X
 * was measured on.
 *
 * Flights are left out of both prices (excludeFlights): no deal touches them,
 * and a route with no fare would otherwise stop the saving being measured.
 * Reads the cache only; no provider calls, like the rest of the alert job.
 */
import type { Db } from "./db.js";
import { RESORTS, RESORT_BY_ID, bucketFor, firstPlannableMonth } from "./config.js";
import { loadBook } from "./book.js";
import { priceTrip, typicalIn, type TripParams, type Overrides, type ResortOverride } from "./pricing.js";
import { addDaysISO, range, todayISO, type ISODate } from "./dates.js";

export interface DealForSaving {
  id: string; resortId: string | null; effectKind: string;
  startsOn: ISODate; endsOn: ISODate; minNights: number | null;
}
export interface DealSaving {
  resortId: string; date: ISODate;
  without: number; withDeal: number; saving: number;
  /** "your saved search" or "a standard trip", plus the trip in words. */
  basis: string;
}

export const STANDARD_TRIP: TripParams = {
  origin: "ATL", adults: 2, childAges: [], nights: 6, stay: "on", tier: 1, food: "mix",
};

/** The trip a member's own saved search describes, or null. Only the parts
 *  that change what a deal is worth are read; anything odd falls back. */
export function tripFromSaved(p: Record<string, unknown> | null | undefined): TripParams | null {
  if (!p || typeof p !== "object") return null;
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  };
  const ages = Array.isArray(p.childAges) ? p.childAges.map(Number).filter((a) => a >= 0 && a <= 17).slice(0, 8) : [];
  const stay = ["on", "off", "none"].includes(String(p.stay)) ? String(p.stay) as TripParams["stay"] : "on";
  const foods = ["grocery", "someQs", "qs", "mix", "ts", "someCharacter", "character", "plan"];
  return {
    origin: typeof p.origin === "string" ? p.origin.toUpperCase().slice(0, 3) : "ATL",
    adults: n(p.adults, 1, 12, 2), childAges: ages, nights: n(p.nights, 1, 30, 6),
    stay, tier: n(p.tier, 0, 2, 1) as TripParams["tier"],
    food: (foods.includes(String(p.food)) ? p.food : "mix") as TripParams["food"],
    hopper: p.hopper === true, hotelRooms: n(p.hotelRooms, 1, 6, 1), seniors: n(p.seniors, 0, 12, 0),
  };
}

const TIER_WORD = ["Value", "Moderate", "Deluxe"];
export function describeTrip(t: TripParams): string {
  const kids = t.childAges.length;
  const party = `${t.adults} adult${t.adults === 1 ? "" : "s"}${kids ? `, ${kids} child${kids === 1 ? "" : "ren"}` : ""}`;
  const stay = t.stay === "on" ? `a ${TIER_WORD[t.tier] ?? "Moderate"} Disney hotel` : t.stay === "off" ? "a hotel off property" : "no hotel";
  return `${t.nights} nights, ${party}, ${stay}`;
}

/** Arrival days worth trying: inside the deal's dates and the months people
 *  can plan, every few days so a long deal stays quick to price. */
export function sampleDates(deal: DealForSaving, today: ISODate): ISODate[] {
  const first = `${firstPlannableMonth(today)}-01`;
  const last = addDaysISO(today, 365);
  const from = deal.startsOn > first ? deal.startsOn : first;
  const to = deal.endsOn < last ? deal.endsOn : last;
  if (to < from) return [];
  const all = range(from, to);
  const step = Math.max(1, Math.ceil(all.length / 40));
  return all.filter((_, i) => i % step === 0);
}

async function savingAt(db: Db, deal: DealForSaving, resortId: string, trip: TripParams, today: ISODate):
  Promise<{ date: ISODate; without: number; withDeal: number } | null> {
  const resort = RESORT_BY_ID.get(resortId);
  if (!resort) return null;
  const dates = sampleDates(deal, today);
  if (!dates.length) return null;
  const book = await loadBook(db, {
    origin: trip.origin, destinations: [resort.iata], resortIds: [resortId],
    from: dates[0]!, to: addDaysISO(dates[dates.length - 1]!, trip.nights + 1),
    tripLength: bucketFor(trip.nights),
  });
  const ov = (o: ResortOverride): Overrides => ({ [resortId]: { excludeFlights: true, ...o } });
  const { typical } = typicalIn(book, resort, trip, ov({ promoId: "none" }), dates);
  if (!typical) return null;
  const date = typical.start;
  const withDeal = priceTrip(book, resort, trip, ov({ promoId: deal.id }), date);
  if (!withDeal.ok) return null;
  return { date, without: typical.total, withDeal: withDeal.price.total };
}

/**
 * The saving on one trip, or null when we can't price one (no hotel rates
 * cached for those dates, a deal already over...). The email falls back to
 * plain wording then rather than inventing a figure.
 */
export async function dealSaving(db: Db, deal: DealForSaving, saved: TripParams | null,
  opts: { today?: ISODate; preferResort?: string | null } = {}): Promise<DealSaving | null> {
  const today = opts.today ?? todayISO();
  const base = saved ?? STANDARD_TRIP;
  // A deal for packages of 4+ nights is measured on a stay that qualifies;
  // a free dining plan on a trip that buys the plan.
  const trip: TripParams = {
    ...base,
    nights: deal.minNights && base.nights < deal.minNights ? deal.minNights : base.nights,
    ...(deal.effectKind === "free_dining" ? { food: "plan" as const, stay: "on" as const } : {}),
  };
  const resorts = deal.resortId ? [deal.resortId]
    : opts.preferResort && RESORT_BY_ID.has(opts.preferResort) ? [opts.preferResort] : RESORTS.map((r) => r.id);
  let best: DealSaving | null = null;
  for (const rid of resorts) {
    const r = await savingAt(db, deal, rid, trip, today);
    if (!r) continue;
    // Rounded first, so the three numbers in the email add up.
    const without = Math.round(r.without), withDeal = Math.round(r.withDeal), saving = without - withDeal;
    if (saving > 0 && (!best || saving > best.saving)) {
      best = { resortId: rid, date: r.date, without, withDeal, saving,
        basis: `${saved ? "your saved search" : "a standard trip"} (${describeTrip(trip)})` };
    }
  }
  return best;
}
