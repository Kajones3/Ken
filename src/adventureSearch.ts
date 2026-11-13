/**
 * Adventures by Disney beside the parks (owner, 2026-11-14): "When a user
 * searches for a date where we KNOW we have an ABD, we should return that."
 * Pure: the owner's saved departures (Rates & Dates screenshots) and the
 * traveler's party come in; this month's departures come out.
 *
 * Only Adventures by Disney's own trip price is used (per person, as shown on
 * its Rates & Dates page). Flights, meals not included and guide tips are NOT
 * priced yet, and the card says so: ABD pricing as a whole trip is not built.
 */
import type { AdventureSighting } from "./cruisesAdventures.js";

/** ABD's child column is "11 and under" unless the page says otherwise. */
export const ABD_CHILD_MAX_AGE = 11;

export interface AdventureDeparture {
  id: string; tripName: string; destination: string | null; tripType: string | null;
  days: number | null; nights: number | null; departureDate: string; returnDate: string | null;
  adultUsd: number; childUsd: number | null; adultOnly: boolean; childMaxAge: number;
  minAge: number | null; seenOn: string; highlights: string[];
}

/** The newest saved price per trip + departure date, departing in `month`. */
export function adventuresInMonth(rows: AdventureSighting[], today: string, month: string): AdventureDeparture[] {
  const latest = new Map<string, AdventureSighting>();
  for (const r of rows) {
    if (!r.departureDate || r.departureDate <= today || r.departureDate.slice(0, 7) !== month) continue;
    const k = `${r.tripName}|${r.departureDate}`;
    const prev = latest.get(k);
    if (!prev || r.seenOn > prev.seenOn || (r.seenOn === prev.seenOn && r.savedAt > prev.savedAt)) latest.set(k, r);
  }
  // Trip facts a dated row may not carry (min age, highlights): from any row of the same trip.
  const facts = new Map<string, { minAge: number | null; highlights: string[]; destination: string | null; tripType: string | null; days: number | null; nights: number | null }>();
  for (const r of rows) {
    const f = facts.get(r.tripName) ?? { minAge: null, highlights: [], destination: null, tripType: null, days: null, nights: null };
    f.minAge ??= r.minAge; f.destination ??= r.destination; f.tripType ??= r.tripType; f.days ??= r.days; f.nights ??= r.nights;
    if (!f.highlights.length && r.highlights.length) f.highlights = r.highlights;
    facts.set(r.tripName, f);
  }
  const fx = (r: AdventureSighting) => (r.price > 0 ? r.priceUsd / r.price : 1);
  return [...latest.values()].map((r) => {
    const f = facts.get(r.tripName)!;
    return {
      id: `${r.tripName}|${r.departureDate}`, tripName: r.tripName, destination: r.destination ?? f.destination,
      tripType: r.tripType ?? f.tripType, days: r.days ?? f.days, nights: r.nights ?? f.nights,
      departureDate: r.departureDate!, returnDate: r.returnDate,
      adultUsd: Math.round(r.priceUsd * 100) / 100,
      childUsd: r.childPrice === null ? null : Math.round(r.childPrice * fx(r) * 100) / 100,
      adultOnly: r.adultOnly, childMaxAge: r.childMaxAge ?? ABD_CHILD_MAX_AGE,
      minAge: r.minAge ?? f.minAge, seenOn: r.seenOn, highlights: f.highlights,
    };
  }).sort((a, b) => a.departureDate.localeCompare(b.departureDate) || a.adultUsd - b.adultUsd);
}

export type PartyPrice =
  | { ok: true; total: number; adults: number; children: number; adultUsd: number; childUsd: number | null }
  | { ok: false; why: string };

/** ABD's price for the party: adults (and children over the child column's
 *  age) at the adult price, children at the child price. */
export function priceForParty(d: AdventureDeparture, party: { adults: number; childAges: number[] }): PartyPrice {
  const kids = party.childAges;
  if (d.adultOnly && kids.length) return { ok: false, why: "This departure is for adults only" };
  if (d.minAge !== null && kids.some((a) => a < d.minAge!)) return { ok: false, why: `This trip is for ages ${d.minAge} and up` };
  const asChild = kids.filter((a) => a <= d.childMaxAge).length;
  const asAdult = party.adults + kids.length - asChild;
  // No child price shown: a child pays the adult price (say so rather than guess lower).
  const child = d.childUsd ?? d.adultUsd;
  return { ok: true, total: Math.round((asAdult * d.adultUsd + asChild * child) * 100) / 100,
    adults: asAdult, children: asChild, adultUsd: d.adultUsd, childUsd: d.childUsd };
}

/** "From under $X a person" for a free visitor: the cheapest adult price,
 *  rounded UP to the next $500, so it's a ceiling, never a quote. */
export function underPerPerson(deps: AdventureDeparture[]): number | null {
  if (!deps.length) return null;
  const min = Math.min(...deps.map((d) => d.adultUsd));
  return Math.ceil((min + 0.01) / 500) * 500;
}
