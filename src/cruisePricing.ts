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

/** Driving to a port, for one traveler: what the car costs both ways. */
export interface DriveFound {
  oneWayMiles: number; fromMap: boolean; gasUsd: number; wearUsd: number; parkingPerDay: number;
}
/** Null = driving to this port isn't offered (no parking price, too far, or abroad). */
export type DriveLookup = (port: HomePort, sailDate: string, nights: number) => DriveFound | null;

export interface CruiseTravel {
  fly: { total: number; flights: number; transfers: number; flight: FareFound & { seats: number } } | null;
  drive: { total: number; gas: number; wear: number; parking: number; parkingDays: number; parkingPerDay: number;
    roundTripMiles: number; fromMap: boolean } | null;
  /** What the card opens on: flying, unless the port is too close to fly. */
  default: "fly" | "drive";
  /** Why flying isn't offered, when it isn't: "close" = under 100 miles,
   *  "no_fare" = no fare bought to that airport yet, "no_transfer" = no
   *  Disney transfer price for that port. */
  noFly: "close" | "no_fare" | "no_transfer" | null;
}

export interface PricedCruise {
  id: string; title: string; ship: string | null; port: { id: string; name: string; airport: string };
  sailDate: string; sailEnd: string; nights: number; cabin: string; seenOn: string;
  guests: number; perPersonFare: number;
  /** Null = Disney's own price for this exact party; otherwise how we got there. */
  estimate: FareEstimate | null;
  /** flights + transfers follow `travel.default`; drive's costs are in travel.drive. */
  lines: { fare: number; gratuities: number; flights: number; transfers: number; excursions: number };
  /** Everything but getting to the ship. */
  base: number;
  total: number;
  travel: CruiseTravel;
  gratuityPerNight: number;
  transfer: { perGuest: number; minutes: string };
  latestArrival: string | null;
  excursions: { port: string; adult: number; child: number; privateIsland: boolean }[];
}
export interface CruiseHole { title: string; sailDate: string | null; what: string }
/** A sailing whose cruise fare we can estimate for the party but not the rest
 *  (getting there or port adventures): shown as "cruise only", never mixed
 *  in with whole-trip totals. */
export interface CruiseOnly {
  id: string; title: string; ship: string | null; port: string | null; sailDate: string; sailEnd: string;
  nights: number; cabin: string; seenOn: string; guests: number; perPersonFare: number;
  estimate: FareEstimate | null; lines: { fare: number; gratuities: number }; total: number; gratuityPerNight: number;
  notIncluded: ("getting there" | "port adventures")[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function nightsOf(s: SightingIn): number | null {
  if (s.nights) return s.nights;
  if (s.sailDate && s.sailEnd) {
    const n = Math.round((Date.parse(s.sailEnd) - Date.parse(s.sailDate)) / 86_400_000);
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Staterooms for a party (owner, 2026-11-14: "a party of 6, we can guestimate
 * two staterooms"): a Disney stateroom sleeps up to 4 (most rooms; some 5),
 * so the party is split into the fewest rooms of up to 4, as evenly as it
 * goes, and every room needs an adult. Null = not enough adults to go round.
 */
export const ROOM_MAX_GUESTS = 4;
export function roomsFor(adults: number, children: number): number[] | null {
  const n = adults + children;
  if (n < 1 || adults < 1) return null;
  const rooms = Math.ceil(n / ROOM_MAX_GUESTS);
  if (adults < rooms) return null;
  const base = Math.floor(n / rooms), extra = n % rooms;
  return Array.from({ length: rooms }, (_, i) => base + (i < extra ? 1 : 0));
}
/** Disney's fare structure, as its Rate Details panels show it: the first two
 *  guests in a room pay the full fare (one guest alone still pays for two),
 *  the 3rd and 4th pay a share of it. Weight in "full fares". */
export function roomWeight(guests: number, extraShare: number): number {
  return 2 + extraShare * Math.max(0, guests - 2);
}
const partyWeight = (rooms: number[], share: number) => rooms.reduce((t, k) => t + roomWeight(k, share), 0);
/** The 3rd/4th guest share when no price summary has taught one yet: the
 *  owner's Port Canaveral panel (2026-11-13), $105 vs $194. */
export const DEFAULT_EXTRA_GUEST_SHARE = 0.54;

/** How a party's fare was reached when Disney's price was for another party. */
export interface FareEstimate {
  fromAdults: number; fromChildren: number; rooms: number[]; extraShare: number;
}
export interface FreshSailing {
  row: SightingIn;
  /** Cruise fare for the whole asked-for party. */
  fare: number;
  estimate: FareEstimate | null;
}

/**
 * The newest fresh price per sailing + room + party, then per sailing the
 * cheapest open room for the asked-for party. Disney's exact party wins;
 * otherwise the saved party closest in size, re-shaped with roomsFor and
 * roomWeight (owner, 2026-11-14: "no matter their search persons, we should
 * return something ... just be clear with the user on what we estimated").
 */
export function freshSailings(rows: SightingIn[], party: { adults: number; children: number }, today: string,
  month?: string, extraShare = DEFAULT_EXTRA_GUEST_SHARE): FreshSailing[] {
  const since = addDaysISO(today, -CRUISE_FRESH_DAYS);
  const latest = new Map<string, SightingIn>();
  for (const r of rows) {
    if (!r.sailDate || r.sailDate <= today) continue;
    if (month && r.sailDate.slice(0, 7) !== month) continue;
    if (r.partyAdults === null || r.partyAdults < 1) continue;
    if (r.seenOn < since) continue;
    const k = `${r.title}|${r.sailDate}|${r.cabin ?? ""}|${r.partyAdults}+${r.partyChildren ?? 0}`;
    const prev = latest.get(k);
    if (!prev || r.seenOn > prev.seenOn || (r.seenOn === prev.seenOn && (r.savedAt ?? "") > (prev.savedAt ?? ""))) latest.set(k, r);
  }
  const guests = party.adults + party.children;
  const want = roomsFor(party.adults, party.children);
  // Per sailing + room, the saved party to use.
  const pick = new Map<string, SightingIn>();
  const score = (r: SightingIn) => {
    const exact = r.partyAdults === party.adults && (r.partyChildren ?? 0) === party.children;
    return exact ? -1 : Math.abs(r.partyAdults! + (r.partyChildren ?? 0) - guests);
  };
  for (const r of latest.values()) {
    if (!r.cabin) continue;
    const k = `${r.title}|${r.sailDate}|${r.cabin}`;
    const prev = pick.get(k);
    if (!prev || score(r) < score(prev) || (score(r) === score(prev) && r.seenOn > prev.seenOn)) pick.set(k, r);
  }
  const best = new Map<string, FreshSailing>();
  for (const r of pick.values()) {
    if (r.soldOut || r.priceUsd === null) continue;
    let fare: number, estimate: FareEstimate | null = null;
    if (score(r) === -1) fare = r.priceUsd * guests;
    else {
      if (!want) continue;
      const from = roomsFor(r.partyAdults!, r.partyChildren ?? 0);
      if (!from) continue;
      const fromGuests = r.partyAdults! + (r.partyChildren ?? 0);
      const perFull = (r.priceUsd * fromGuests) / partyWeight(from, extraShare);
      fare = perFull * partyWeight(want, extraShare);
      estimate = { fromAdults: r.partyAdults!, fromChildren: r.partyChildren ?? 0, rooms: want, extraShare };
    }
    const k = `${r.title}|${r.sailDate}`;
    const prev = best.get(k);
    if (!prev || fare < prev.fare) best.set(k, { row: r, fare: round2(fare), estimate });
  }
  return [...best.values()];
}

/** Every sailing we know of in a month, priced or not (the free count, and
 *  the Planner Pro list of sailings without a recent price). */
export interface KnownSailing { title: string; sailDate: string; nights: number | null; ship: string | null; port: string | null }
export function knownSailings(rows: SightingIn[], today: string, month: string): KnownSailing[] {
  const out = new Map<string, KnownSailing>();
  const info = new Map<string, { ship: string | null; port: string | null; nights: number | null }>();
  for (const r of rows) {
    const t = info.get(r.title) ?? { ship: null, port: null, nights: null };
    t.ship ??= r.ship; t.port ??= r.departurePort; t.nights ??= nightsOf(r);
    info.set(r.title, t);
  }
  for (const r of rows) {
    if (!r.sailDate || r.sailDate <= today || r.sailDate.slice(0, 7) !== month) continue;
    const k = `${r.title}|${r.sailDate}`;
    if (out.has(k)) continue;
    const t = info.get(r.title)!;
    const port = homePortOf(t.port) ?? homePortOf(r.title);
    out.set(k, { title: r.title, sailDate: r.sailDate, nights: nightsOf(r) ?? t.nights, ship: t.ship, port: port?.name ?? null });
  }
  return [...out.values()].sort((a, b) => a.sailDate.localeCompare(b.sailDate) || a.title.localeCompare(b.title));
}

export interface PriceCruisesInput {
  rows: SightingIn[];
  party: CruiseParty;
  origin: { iata: string; lat: number; lon: number } | null;
  today: string;
  month?: string;
  rates: { regular: number; concierge: number };
  flight: FlightLookup;
  /** Omitted = driving is never offered. */
  drive?: DriveLookup;
  /** The 3rd/4th guest's share of a full fare (learned from price summaries). */
  extraShare?: number;
}

export function priceCruises(inp: PriceCruisesInput): { priced: PricedCruise[]; cruiseOnly: CruiseOnly[]; holes: CruiseHole[] } {
  const { party } = inp;
  const guests = party.adults + party.childAges.length;
  const priced: PricedCruise[] = [], holes: CruiseHole[] = [], cruiseOnly: CruiseOnly[] = [];
  // Details a dated row may not carry: borrowed from any row of the same cruise.
  const byTitle = new Map<string, { ports: string | null; ship: string | null; port: string | null }>();
  for (const r of inp.rows) {
    const t = byTitle.get(r.title) ?? { ports: null, ship: null, port: null };
    t.ports ??= r.ports; t.ship ??= r.ship; t.port ??= r.departurePort;
    byTitle.set(r.title, t);
  }
  const hole = (s: SightingIn, what: string) => { holes.push({ title: s.title, sailDate: s.sailDate, what }); };
  const share = inp.extraShare ?? DEFAULT_EXTRA_GUEST_SHARE;
  const adultsGuests = party.adults, kids = party.childAges.length;
  if (!roomsFor(adultsGuests, kids)) {
    holes.push({ title: "(this party)", sailDate: null, what: "every stateroom needs an adult: not enough adults for the rooms this party needs" });
  }
  for (const fs of freshSailings(inp.rows, { adults: adultsGuests, children: kids }, inp.today, inp.month, share)) {
    const s = fs.row;
    const info = byTitle.get(s.title)!;
    const nights = nightsOf(s);
    if (!nights) { hole(s, "how many nights"); continue; }
    const sailEnd = s.sailEnd ?? addDaysISO(s.sailDate!, nights);
    const concierge = s.cabin === "concierge" || s.cabin === "suite";
    const perNight = concierge ? inp.rates.concierge : inp.rates.regular;
    const fareLine = fs.fare, gratLine = round2(guests * nights * perNight);
    const port: HomePort | null = homePortOf(s.departurePort ?? info.port) ?? homePortOf(s.title);
    // Something we can't price beyond the cruise itself: kept as "cruise only".
    const only = (what: string, missing: CruiseOnly["notIncluded"]) => {
      hole(s, what);
      cruiseOnly.push({
        id: `${s.title}|${s.sailDate}`, title: s.title, ship: s.ship ?? info.ship, port: port?.name ?? null,
        sailDate: s.sailDate!, sailEnd, nights, cabin: s.cabin!, seenOn: s.seenOn, guests,
        perPersonFare: round2(fareLine / guests), estimate: fs.estimate,
        lines: { fare: fareLine, gratuities: gratLine }, total: round2(fareLine + gratLine), gratuityPerNight: perNight,
        notIncluded: missing,
      });
    };
    if (!port) { only("which home port it sails from", ["getting there"]); continue; }
    if (!inp.origin) { only("the traveler's home airport", ["getting there"]); continue; }
    // Port adventures.
    const excMissing: string | null = !info.ports ? "its ports of call" : null;
    const ports = info.ports ? portsOfCall(info.ports) : { known: [], unknown: [] as string[] };
    const exc = ports.known.map((p) => ({ p, e: excursionAt(p) }));
    const noPrice = [...ports.unknown, ...exc.filter((x) => !x.e).map((x) => x.p.name)];
    const excHole = excMissing ?? (noPrice.length ? `port adventure prices for ${noPrice.join(", ")}` : null);

    // Getting to the ship: flying (fare + Disney's transfer) and/or driving
    // (gas, wear and parking). Too close to fly = driving only.
    const tooClose = inp.origin.iata === port.airport
      || haversineMiles(inp.origin.lat, inp.origin.lon, port.lat, port.lon) < NO_FLY_RADIUS_MILES;
    let fly: CruiseTravel["fly"] = null;
    const flyWhy: string[] = [];
    if (tooClose) flyWhy.push("too close to fly");
    else if (port.transferUsd === null) flyWhy.push(`Disney's transfer price at ${port.name}`);
    else {
      const fare = inp.flight(port.airport, s.sailDate!, nights);
      if (!fare) flyWhy.push(`a flight ${inp.origin.iata}-${port.airport} that month`);
      else {
        const seats = party.adults + party.childAges.filter((a) => a >= LAP_INFANT_UNDER).length;
        const flights = round2(fare.perSeat * seats), transfers = round2(2 * port.transferUsd * guests);
        fly = { total: round2(flights + transfers), flights, transfers, flight: { ...fare, seats } };
      }
    }
    let drive: CruiseTravel["drive"] = null;
    const d = inp.drive?.(port, s.sailDate!, nights) ?? null;
    if (d) {
      const parkingDays = nights + 1;
      const parking = round2(d.parkingPerDay * parkingDays);
      drive = { total: round2(d.gasUsd + d.wearUsd + parking), gas: round2(d.gasUsd), wear: round2(d.wearUsd),
        parking, parkingDays, parkingPerDay: d.parkingPerDay, roundTripMiles: Math.round(d.oneWayMiles * 2), fromMap: d.fromMap };
    }
    if (!fly && !drive) {
      const why = tooClose ? `driving to ${port.name} (its parking is set to 0)` : flyWhy.join("; ")
        + (inp.drive ? `; driving to ${port.name} not offered (its parking is set to 0)` : "");
      only(excHole ? `${why}; ${excHole}` : why, excHole ? ["getting there", "port adventures"] : ["getting there"]);
      continue;
    }
    if (excHole) { only(excHole, ["port adventures"]); continue; }
    const mode: "fly" | "drive" = fly ? "fly" : "drive";

    const adultsExc = party.adults + party.childAges.filter((a) => a >= EXCURSION_ADULT_FROM).length;
    const kidsExc = party.childAges.filter((a) => a >= EXCURSION_CHILD_FROM && a < EXCURSION_ADULT_FROM).length;
    const lines = {
      fare: fareLine,
      gratuities: gratLine,
      flights: mode === "fly" ? fly!.flights : 0,
      transfers: mode === "fly" ? fly!.transfers : 0,
      excursions: round2(exc.reduce((t, x) => t + x.e!.adult * adultsExc + x.e!.child * kidsExc, 0)),
    };
    const base = round2(lines.fare + lines.gratuities + lines.excursions);
    priced.push({
      id: `${s.title}|${s.sailDate}`, title: s.title, ship: s.ship ?? info.ship,
      port: { id: port.id, name: port.name, airport: port.airport },
      sailDate: s.sailDate!, sailEnd, nights, cabin: s.cabin!, seenOn: s.seenOn, guests,
      perPersonFare: fs.estimate ? round2(fareLine / guests) : s.priceUsd!, estimate: fs.estimate, lines, base,
      total: round2(base + (mode === "fly" ? fly!.total : drive!.total)),
      travel: { fly, drive, default: mode, noFly: fly ? null : tooClose ? "close" : port.transferUsd === null ? "no_transfer" : "no_fare" },
      gratuityPerNight: perNight,
      transfer: { perGuest: port.transferUsd ?? 0, minutes: port.transferMinutes },
      latestArrival: port.latestArrival,
      excursions: exc.map((x) => ({ port: x.p.name, adult: x.e!.adult, child: x.e!.child, privateIsland: !!x.p.privateIsland })),
    });
  }
  priced.sort((a, b) => a.total - b.total);
  cruiseOnly.sort((a, b) => a.sailDate.localeCompare(b.sailDate));
  return { priced, cruiseOnly, holes };
}

/** "N sailings cost less than X": what a free visitor is told. Counts only.
 *  A sailing counts if either way of getting there fits. */
export function countUnder(priced: PricedCruise[], under: number): number {
  return priced.filter((c) => Math.min(...[c.travel.fly?.total, c.travel.drive?.total]
    .filter((x): x is number => x !== undefined).map((t) => c.base + t)) <= under).length;
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
