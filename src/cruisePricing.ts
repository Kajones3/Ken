/**
 * A Disney cruise priced like a park trip, Planner Pro only (owner,
 * 2026-11-13). Pure: the sightings, the traveler's party and a flight lookup
 * come in; priced sailings and the holes come out.
 *
 * The rule (owner: "DO NOT GUESS ... I like the functionality of cruises
 * falling off rather than giving bad information"): a sailing is priced only
 * when EVERY line has a real number behind it. Anything missing drops the
 * sailing and is listed as a hole for the owner, never shown to travelers.
 *
 * Lines, for the whole party:
 *  - Cruise fare: Disney's average per person (taxes, fees and port expenses
 *    included) for the SAME party the owner's screenshot was set to, times
 *    the guests. A different party is a hole: Disney's average changes with
 *    who is in the room.
 *  - Gratuities: Disney's rate per guest per night, infants included.
 *  - Flights: round trip to the port's airport, arriving on sailing day
 *    (Disney's guidelines allow it), back the day the cruise ends. Lap
 *    infants (under 2) fly free.
 *  - Transfers: Disney's airport-to-port price per guest, both ways.
 *  - Port adventures: one typical (median) Disney port adventure per guest
 *    at each port of call; adults and children 10+ at the adult price,
 *    3-9 at the child price, under 3 free. Disney's private islands count $0.
 */
import { addDaysISO } from "./dates.js";
import { haversineMiles } from "./geo.js";
import { NO_FLY_RADIUS_MILES } from "./config.js";
import { homePortOf, portsOfCall, excursionAt, type HomePort } from "./cruiseFacts.js";

/** A saved price is used for this many days after the owner saw it. Disney
 *  reprices sailings often; an older price falls off rather than mislead. */
export const CRUISE_FRESH_DAYS = 21;
export const EXCURSION_CHILD_FROM = 3, EXCURSION_ADULT_FROM = 10, LAP_INFANT_UNDER = 2;

export interface SightingIn {
  title: string; nights: number | null; departurePort: string | null; ports: string | null; ship: string | null;
  sailDate: string | null; sailEnd: string | null; cabin: string | null; priceUsd: number | null;
  soldOut: boolean; partyAdults: number | null; partyChildren: number | null; seenOn: string; savedAt?: string;
}
export interface CruiseParty { adults: number; childAges: number[] }
export interface FareFound { perSeat: number; how: "bought" | "bought_month" | "model"; date: string }
/** Round-trip fare per seat from the traveler's airport to `dest`. */
export type FlightLookup = (dest: string, depart: string, nights: number) => FareFound | null;

export interface PricedCruise {
  id: string; title: string; ship: string | null; port: { id: string; name: string; airport: string };
  sailDate: string; sailEnd: string; nights: number; cabin: string; seenOn: string;
  guests: number; perPersonFare: number;
  lines: { fare: number; gratuities: number; flights: number; transfers: number; excursions: number };
  total: number;
  flight: FareFound & { seats: number };
  gratuityPerNight: number;
  transfer: { perGuest: number; minutes: string };
  latestArrival: string | null;
  excursions: { port: string; adult: number; child: number; privateIsland: boolean }[];
}
export interface CruiseHole { title: string; sailDate: string | null; what: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

function nightsOf(s: SightingIn): number | null {
  if (s.nights) return s.nights;
  if (s.sailDate && s.sailEnd) {
    const n = Math.round((Date.parse(s.sailEnd) - Date.parse(s.sailDate)) / 86_400_000);
    return n > 0 ? n : null;
  }
  return null;
}

/** The newest fresh price per sailing + room, and the cheapest open room per
 *  sailing, for one party. */
export function freshSailings(rows: SightingIn[], party: { adults: number; children: number }, today: string, month?: string) {
  const since = addDaysISO(today, -CRUISE_FRESH_DAYS);
  const latest = new Map<string, SightingIn>();
  for (const r of rows) {
    if (!r.sailDate || r.sailDate <= today) continue;
    if (month && r.sailDate.slice(0, 7) !== month) continue;
    if (r.partyAdults !== party.adults || (r.partyChildren ?? 0) !== party.children || r.partyAdults === null) continue;
    if (r.seenOn < since) continue;
    const k = `${r.title}|${r.sailDate}|${r.cabin ?? ""}`;
    const prev = latest.get(k);
    if (!prev || r.seenOn > prev.seenOn || (r.seenOn === prev.seenOn && (r.savedAt ?? "") > (prev.savedAt ?? ""))) latest.set(k, r);
  }
  const best = new Map<string, SightingIn>();
  for (const r of latest.values()) {
    if (r.soldOut || r.priceUsd === null || !r.cabin) continue;
    const k = `${r.title}|${r.sailDate}`;
    const prev = best.get(k);
    if (!prev || r.priceUsd! < prev.priceUsd!) best.set(k, r);
  }
  return [...best.values()];
}

export interface PriceCruisesInput {
  rows: SightingIn[];
  party: CruiseParty;
  origin: { iata: string; lat: number; lon: number } | null;
  today: string;
  month?: string;
  rates: { regular: number; concierge: number };
  flight: FlightLookup;
}

export function priceCruises(inp: PriceCruisesInput): { priced: PricedCruise[]; holes: CruiseHole[] } {
  const { party } = inp;
  const guests = party.adults + party.childAges.length;
  const priced: PricedCruise[] = [], holes: CruiseHole[] = [];
  // Details a dated row may not carry: borrowed from any row of the same cruise.
  const byTitle = new Map<string, { ports: string | null; ship: string | null; port: string | null }>();
  for (const r of inp.rows) {
    const t = byTitle.get(r.title) ?? { ports: null, ship: null, port: null };
    t.ports ??= r.ports; t.ship ??= r.ship; t.port ??= r.departurePort;
    byTitle.set(r.title, t);
  }
  const hole = (s: SightingIn, what: string) => { holes.push({ title: s.title, sailDate: s.sailDate, what }); };
  for (const s of freshSailings(inp.rows, { adults: party.adults, children: party.childAges.length }, inp.today, inp.month)) {
    const info = byTitle.get(s.title)!;
    const nights = nightsOf(s);
    if (!nights) { hole(s, "how many nights"); continue; }
    const sailEnd = s.sailEnd ?? addDaysISO(s.sailDate!, nights);
    const port: HomePort | null = homePortOf(s.departurePort ?? info.port) ?? homePortOf(s.title);
    if (!port) { hole(s, "which home port it sails from"); continue; }
    if (port.transferUsd === null) { hole(s, `Disney's transfer price at ${port.name}`); continue; }
    if (!inp.origin) { hole(s, "the traveler's home airport"); continue; }
    if (inp.origin.iata === port.airport
      || haversineMiles(inp.origin.lat, inp.origin.lon, port.lat, port.lon) < NO_FLY_RADIUS_MILES) {
      hole(s, `driving to ${port.name} (not priced yet)`); continue;
    }
    // Port adventures.
    const ports = portsOfCall(info.ports);
    if (!info.ports) { hole(s, "its ports of call"); continue; }
    if (ports.unknown.length) { hole(s, `port adventure prices for ${ports.unknown.join(", ")}`); continue; }
    const exc = ports.known.map((p) => ({ p, e: excursionAt(p) }));
    const noPrice = exc.filter((x) => !x.e).map((x) => x.p.name);
    if (noPrice.length) { hole(s, `port adventure prices for ${noPrice.join(", ")}`); continue; }
    // Flights.
    const fare = inp.flight(port.airport, s.sailDate!, nights);
    if (!fare) { hole(s, `a flight ${inp.origin.iata}-${port.airport} that month`); continue; }

    const seats = party.adults + party.childAges.filter((a) => a >= LAP_INFANT_UNDER).length;
    const adultsExc = party.adults + party.childAges.filter((a) => a >= EXCURSION_ADULT_FROM).length;
    const kidsExc = party.childAges.filter((a) => a >= EXCURSION_CHILD_FROM && a < EXCURSION_ADULT_FROM).length;
    const concierge = s.cabin === "concierge" || s.cabin === "suite";
    const perNight = concierge ? inp.rates.concierge : inp.rates.regular;
    const lines = {
      fare: round2(s.priceUsd! * guests),
      gratuities: round2(guests * nights * perNight),
      flights: round2(fare.perSeat * seats),
      transfers: round2(2 * port.transferUsd * guests),
      excursions: round2(exc.reduce((t, x) => t + x.e!.adult * adultsExc + x.e!.child * kidsExc, 0)),
    };
    priced.push({
      id: `${s.title}|${s.sailDate}`, title: s.title, ship: s.ship ?? info.ship,
      port: { id: port.id, name: port.name, airport: port.airport },
      sailDate: s.sailDate!, sailEnd, nights, cabin: s.cabin!, seenOn: s.seenOn, guests,
      perPersonFare: s.priceUsd!, lines,
      total: round2(lines.fare + lines.gratuities + lines.flights + lines.transfers + lines.excursions),
      flight: { ...fare, seats }, gratuityPerNight: perNight,
      transfer: { perGuest: port.transferUsd, minutes: port.transferMinutes },
      latestArrival: port.latestArrival,
      excursions: exc.map((x) => ({ port: x.p.name, adult: x.e!.adult, child: x.e!.child, privateIsland: !!x.p.privateIsland })),
    });
  }
  priced.sort((a, b) => a.total - b.total);
  return { priced, holes };
}

/** "N sailings cost less than X": what a free visitor is told. Counts only. */
export function countUnder(priced: PricedCruise[], under: number): number {
  return priced.filter((c) => c.total <= under).length;
}

/**
 * Pick a fare for a sailing from bought fares (pure): the nearest bought
 * departure within 3 days of sailing day, else the median bought fare that
 * month, else the model (resort airports only), else nothing.
 */
export interface BoughtFare { destination: string; departDate: string; tripLength: number; priceUsd: number }
export function pickCruiseFare(bought: BoughtFare[], dest: string, depart: string, nights: number,
  model?: (dest: string, date: string) => number | null): FareFound | null {
  const mine = bought.filter((b) => b.destination === dest);
  const day = (d: string) => Date.parse(d) / 86_400_000;
  const near = mine
    .map((b) => ({ b, gap: Math.abs(day(b.departDate) - day(depart)) }))
    .filter((x) => x.gap <= 3)
    .sort((a, b) => a.gap - b.gap || Math.abs(a.b.tripLength - nights) - Math.abs(b.b.tripLength - nights));
  if (near.length) return { perSeat: near[0]!.b.priceUsd, how: "bought", date: near[0]!.b.departDate };
  const month = mine.filter((b) => b.departDate.slice(0, 7) === depart.slice(0, 7)).map((b) => b.priceUsd).sort((a, b) => a - b);
  if (month.length) {
    const m = month.length >> 1;
    return { perSeat: round2(month.length % 2 ? month[m]! : (month[m - 1]! + month[m]!) / 2), how: "bought_month", date: depart };
  }
  const v = model?.(dest, depart) ?? null;
  return v && v > 0 ? { perSeat: round2(v), how: "model", date: depart } : null;
}
