/**
 * Where an Adventures by Disney trip starts, for pricing the flights to it
 * (owner, 2026-11-14: "We had Paris flight information for Disneyland
 * Paris ... why couldn't we use the same for this?").
 *
 * Only CITY trips that start and end in the same city are placed here (the
 * "Escape" trips): fly in, fly home from the same airport. A touring trip
 * (Croatia & Slovenia, Thailand) starts in one city and ends in another, and
 * we don't know which without the itinerary, so it gets no airport and its
 * flights stay "not in this price yet". Never a guess at a route.
 */

import { quotedEstimate, type PriceBook } from "./pricing.js";
import { bucketFor } from "./config.js";
import type { FareFound } from "./cruisePricing.js";

export interface AbdPlace {
  city: string;
  /** The airport travelers fly into and home from. */
  airport: string;
  match: RegExp;
  /** Outside the US: the flight leaves the evening before day 1. */
  abroad: boolean;
}

export const ABD_PLACES: AbdPlace[] = [
  { city: "Paris", airport: "CDG", match: /\bparis\b/i, abroad: true },
  { city: "London", airport: "LHR", match: /\blondon\b/i, abroad: true },
  { city: "Munich", airport: "MUC", match: /\bmunich\b/i, abroad: true },
  { city: "Barcelona", airport: "BCN", match: /\bbarcelona\b/i, abroad: true },
  { city: "Rome", airport: "FCO", match: /\brome\b/i, abroad: true },
  { city: "Amsterdam", airport: "AMS", match: /\bamsterdam\b/i, abroad: true },
  { city: "Dublin", airport: "DUB", match: /\bdublin\b/i, abroad: true },
  { city: "Vienna", airport: "VIE", match: /\bvienna\b/i, abroad: true },
  { city: "Prague", airport: "PRG", match: /\bprague\b/i, abroad: true },
  { city: "Lisbon", airport: "LIS", match: /\blisbon\b/i, abroad: true },
  { city: "Southern California", airport: "LAX", match: /southern california|disneyland resort/i, abroad: false },
];

/** The ABD airports, for checking a request names one of ours. */
export const ABD_AIRPORTS = new Set(ABD_PLACES.map((p) => p.airport));

/** The place a trip flies to, when it is a one-city trip we can place. */
export function abdPlaceOf(trip: { tripName: string; destination: string | null; tripType: string | null }): AbdPlace | null {
  if (!/escape/i.test(trip.tripType ?? "") && !/escape/i.test(trip.tripName)) return null;
  const text = `${trip.tripName} ${trip.destination ?? ""}`;
  return ABD_PLACES.find((p) => p.match.test(text)) ?? null;
}

/** Flight dates for a trip: abroad, leave the evening before day 1. */
export function abdFlightDates(place: AbdPlace, departureDate: string, returnDate: string | null, nights: number | null):
  { depart: string; back: string; tripLength: number } {
  const add = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  const depart = place.abroad ? add(departureDate, -1) : departureDate;
  const back = returnDate ?? add(departureDate, Math.max(1, nights ?? 2));
  const tripLength = Math.round((Date.parse(back) - Date.parse(depart)) / 86_400_000);
  return { depart, back, tripLength };
}

export interface AbdFlight {
  airport: string; city: string; depart: string; back: string; tripLength: number;
  perSeat: number | null; seats: number; total: number | null; how: string | null;
}

/**
 * The flight a party takes to an Adventures by Disney city, priced the way
 * the parks price theirs: a fare we bought near the date first, then the real
 * fare or the estimate the Disneyland Paris card would show for that date
 * (the estimate wins over a cheaper free-feed fare, as on the board). Pure.
 */
export function abdFlight(place: AbdPlace, d: { departureDate: string; returnDate: string | null; nights: number | null },
  origin: string, seats: number,
  lookup: ((dest: string, depart: string, nights: number) => FareFound | null) | null,
  book: PriceBook | null): AbdFlight {
  const fd = abdFlightDates(place, d.departureDate, d.returnDate, d.nights);
  let f = lookup ? lookup(place.airport, fd.depart, fd.tripLength) : null;
  if (!f && book) {
    const row = book.flight(origin, place.airport, fd.depart, bucketFor(fd.tripLength));
    const est = quotedEstimate(book, origin, place.airport, fd.depart);
    const real = row && row.price > 0 ? row.price : undefined;
    const v = real !== undefined && est !== undefined ? Math.max(real, est) : real ?? est;
    if (v && v > 0) f = { perSeat: Math.round(v * 100) / 100, how: real !== undefined && real >= (est ?? 0) ? "bought" : "model", date: fd.depart };
  }
  return { airport: place.airport, city: place.city, ...fd, seats,
    perSeat: f ? f.perSeat : null, total: f ? Math.round(f.perSeat * seats * 100) / 100 : null, how: f ? f.how : null };
}
