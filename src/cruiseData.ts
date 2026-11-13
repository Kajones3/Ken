/**
 * Loads what cruise pricing needs (cruisePricing.ts) and the owner's list of
 * cruise data holes (/admin -> Cruises). Read-only.
 */
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { addDaysISO } from "./dates.js";
import { listCruises } from "./cruisesAdventures.js";
import { settingsMap } from "./settings.js";
import { ORIGINS } from "./config.js";
import { loadFareModel } from "./fareModelDb.js";
import { holidayFlightPremium } from "./holidayWindows.js";
import { SERPAPI_FLIGHTS } from "./observations.js";
import { DRIVING, irsMileageRate } from "./config.js";
import { haversineMiles } from "./geo.js";
import { loadMileageRates } from "./mileageRates.js";
import { loadRoadMiles, routeKey, ensureRoadMiles, osrmMiles, roadMilesLive, type RouteWant } from "./roadMiles.js";
import { DRIVE_PORTS, MAX_PORT_DRIVE_MILES, parkingKey, type HomePort } from "./cruiseFacts.js";
import type { DriveLookup } from "./cruisePricing.js";
import { HOME_PORTS, PORTS_OF_CALL, PARKING_NOT_USED, homePortOf, portsOfCall, excursionAt } from "./cruiseFacts.js";
import { CRUISE_FRESH_DAYS, pickCruiseFare, type BoughtFare, type FlightLookup, type SightingIn } from "./cruisePricing.js";

export async function loadSightings(db: Db): Promise<SightingIn[]> {
  return (await listCruises(db, 5000)).map((c) => ({
    title: c.title, nights: c.nights, departurePort: c.departurePort, ports: c.ports, ship: c.ship,
    sailDate: c.sailDate, sailEnd: c.sailEnd, cabin: c.cabin, priceUsd: c.priceUsd, soldOut: c.soldOut,
    partyAdults: c.partyAdults, partyChildren: c.partyChildren, seenOn: c.seenOn, savedAt: c.savedAt,
  }));
}

export async function gratuityRates(db: Db): Promise<{ regular: number; concierge: number }> {
  let set = new Map<string, number>();
  try { set = await settingsMap(db); } catch { /* shipped rates */ }
  return { regular: set.get("cruise.gratuityPerNight") ?? 16, concierge: set.get("cruise.gratuityConciergePerNight") ?? 27.25 };
}

/** Every paid fare bought from `origin` to the cruise airports, still ahead. */
export async function boughtCruiseFares(db: Db, origin: string, airports: string[], today: string): Promise<BoughtFare[]> {
  if (!airports.length) return [];
  const r = await db.query<any>(
    `select destination, depart_date, trip_length, price_usd from flight_observations
      where source = $1 and origin = $2 and destination = any($3) and depart_date > $4
        and observed_at > now() - interval '120 days'`,
    [SERPAPI_FLIGHTS, origin, airports, today]);
  return r.rows.map((x) => ({ destination: String(x.destination).trim(), departDate: dateStr(x.depart_date),
    tripLength: Number(x.trip_length), priceUsd: Number(x.price_usd) }));
}

/** The flight lookup for one traveler: bought fares first, then (for a Disney
 *  World airport only) the formula travelers already see for that route. */
export async function cruiseFlightLookup(db: Db, origin: string, today: string): Promise<FlightLookup> {
  const bought = await boughtCruiseFares(db, origin, HOME_PORTS.map((p) => p.airport), today);
  let model: ((dest: string, date: string) => number | null) | undefined;
  try {
    const m = await loadFareModel(db);
    let set = new Map<string, number>();
    try { set = await settingsMap(db); } catch { /* defaults */ }
    model = (dest, date) => {
      const p = m.predict(origin, dest, date);
      if (!p) return null;
      const h = holidayFlightPremium(date);
      return p.value * (h ? 1 + (set.get(h.settingKey) ?? h.defaultPct) / 100 : 1);
    };
  } catch { model = undefined; }
  return (dest, depart, nights) => pickCruiseFare(bought, dest, depart, nights, model);
}

export interface CruiseHolesReport {
  freshDays: number;
  sailings: { title: string; sailDate: string; port: string | null; parties: string[]; missing: string[];
    flights: { airport: string; originsWithFare: number; of: number } | null }[];
  ports: { name: string; transfer: string; parking: string; airport: string }[];
  excursions: { port: string; status: string }[];
  standing: string[];
}

/** What the owner still needs for cruises to show (owner: "I just need to
 *  know where the holes are"). Never shown to travelers. */
export async function cruiseHoles(db: Db, today: string): Promise<CruiseHolesReport> {
  const rows = await loadSightings(db);
  let parkingSet = new Map<string, number>();
  try { parkingSet = await settingsMap(db); } catch { /* defaults */ }
  const since = addDaysISO(today, -CRUISE_FRESH_DAYS);
  const info = new Map<string, { ports: string | null; port: string | null }>();
  for (const r of rows) {
    const t = info.get(r.title) ?? { ports: null, port: null };
    t.ports ??= r.ports; t.port ??= r.departurePort; info.set(r.title, t);
  }
  const sail = new Map<string, { title: string; sailDate: string; parties: Set<string> }>();
  for (const r of rows) {
    if (!r.sailDate || r.sailDate <= today || r.seenOn < since || r.soldOut || r.priceUsd === null) continue;
    const k = `${r.title}|${r.sailDate}`;
    const s = sail.get(k) ?? { title: r.title, sailDate: r.sailDate, parties: new Set<string>() };
    s.parties.add(r.partyAdults === null ? "party not recorded"
      : `${r.partyAdults} adult${r.partyAdults === 1 ? "" : "s"}${r.partyChildren ? ` + ${r.partyChildren} child${r.partyChildren === 1 ? "" : "ren"}` : ""}`);
    sail.set(k, s);
  }
  // Which rotation airports already have a bought fare to each port airport, by month.
  const fares = await db.query<any>(
    `select destination, to_char(depart_date, 'YYYY-MM') m, count(distinct origin) n from flight_observations
      where source = $1 and destination = any($2) and depart_date > $3 and origin = any($4)
      group by 1, 2`, [SERPAPI_FLIGHTS, HOME_PORTS.map((p) => p.airport), today, ORIGINS.map((o) => o.iata)]);
  const fareCount = new Map(fares.rows.map((x) => [`${String(x.destination).trim()}|${x.m}`, Number(x.n)]));

  const sailings = [...sail.values()].sort((a, b) => a.sailDate.localeCompare(b.sailDate)).map((s) => {
    const t = info.get(s.title)!;
    const port = homePortOf(t.port) ?? homePortOf(s.title);
    const missing: string[] = [];
    if (!port) missing.push("which home port");
    if (!t.ports) missing.push("ports of call (save the cruise's card from Disney's list)");
    else {
      const pc = portsOfCall(t.ports);
      if (pc.unknown.length) missing.push(`port adventure prices: ${pc.unknown.join(", ")}`);
      const none = pc.known.filter((p) => !excursionAt(p)).map((p) => p.name);
      if (none.length) missing.push(`port adventure prices: ${none.join(", ")}`);
    }
    if (![...s.parties].some((p) => p !== "party not recorded")) missing.push("the party the price was set for");
    if (port && port.airport !== "MCO" && !(fareCount.get(`${port.airport}|${s.sailDate.slice(0, 7)}`) ?? 0)) {
      missing.push(`a flight to ${port.airport} that month (bought nightly, or when a Planner Pro member searches it)`);
    }
    return {
      title: s.title, sailDate: s.sailDate, port: port?.name ?? null, parties: [...s.parties], missing,
      flights: port ? { airport: port.airport, originsWithFare: fareCount.get(`${port.airport}|${s.sailDate.slice(0, 7)}`) ?? 0, of: ORIGINS.length } : null,
    };
  });
  return {
    freshDays: CRUISE_FRESH_DAYS,
    sailings,
    ports: HOME_PORTS.map((p) => ({
      name: p.name, airport: p.airport,
      transfer: p.transferUsd === null ? "MISSING: Disney's price" : `$${p.transferUsd} a guest each way, ${p.transferMinutes}`,
      parking: parkingLine(p.id, p.parking, parkingSet.get(parkingKey(p.id))),
    })),
    excursions: portsOfCallStatus(),
    standing: [
      "A price only works for the party Disney's page was set to (2 adults, 2 adults + 2 children ...): other parties don't see that sailing. Save each sailing for the parties you want covered.",
      "Driving to a port: offered within one day's drive (500 road miles) when that port has a parking price, priced like a drive to the parks (gas, IRS wear and tear, parking for nights + 1 days). Someone within 100 miles of the port's airport can only drive. Each cruise card has an \"I'm driving\" switch.",
      "No hotel the night before: Disney's guidelines allow flying in on sailing day (latest arrivals: MCO 11:30 AM, FLL 12:30 PM, IAH 10:45 AM, SAN 12:15 PM, YVR 11:15 AM).",
      "Flights to Fort Lauderdale, Houston, San Diego and Vancouver come only from fares we bought: a sailing shows once a fare that month exists (bought nightly, ~50 searches a month, plus Planner Pro searches). Port Canaveral uses the same flight formula as Walt Disney World.",
      "Transfers are charged for every guest, infants included (Disney's page says \"per guest\").",
      "Port adventure prices are Disney's own listings, undated; one typical (median) adventure per guest per port.",
      "Weather at the ports and ship details (age, size, what's on board) aren't in yet.",
    ],
  };
}

function parkingLine(id: string, official: { perDayUsd: number; source: string } | null, set: number | undefined): string {
  if (!(DRIVE_PORTS as readonly string[]).includes(id)) return "Not looked up (nobody drives there from the US)";
  const v = set ?? official?.perDayUsd ?? 0;
  if (v > 0) return `$${v} a day, used for anyone driving${official && v === official.perDayUsd ? ` (official: ${official.source})` : " (your number)"}`;
  return `NOT SET: driving there isn't offered. Type a price in Rates & settings -> Cruises. ${PARKING_NOT_USED[id] ?? ""}`;
}
const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
function portsOfCallStatus(): { port: string; status: string }[] {
  return PORTS_OF_CALL.map((p) => {
    const e = excursionAt(p);
    return { port: p.name, status: p.privateIsland ? "Disney's island: $0 (our choice)"
      : e ? `$${money(e.adult)} adult / $${money(e.child)} child (median of ${p.listings.length} Disney listing${p.listings.length === 1 ? "" : "s"})`
      : "MISSING: no Disney listing found" };
  });
}

/** drive_routes key for a cruise port (roadMiles.ts keeps resorts by id). */
export const portRouteId = (portId: string) => `port-${portId}`;

/** Road miles from home airports to the ports someone might drive to. */
export function portRouteWants(from: { lat: number; lon: number }[]): RouteWant[] {
  return from.flatMap((o) => HOME_PORTS.filter((p) => (DRIVE_PORTS as readonly string[]).includes(p.id))
    .filter((p) => haversineMiles(o.lat, o.lon, p.terminal.lat, p.terminal.lon) <= MAX_PORT_DRIVE_MILES)
    .map((p) => ({ from: { lat: o.lat, lon: o.lon }, to: p.terminal, resortId: portRouteId(p.id) })));
}

/**
 * Driving to a port for one traveler, priced like a drive to the parks
 * (pricing.ts): gas at today's price and 25 mpg, plus the IRS mileage rate
 * for wear and tear, both ways; parking from /admin. Road miles from the map
 * when held, else the straight line x 1.25, as for the parks. Only ports with
 * a parking price set and within one day's drive.
 */
export async function cruiseDriveLookup(db: Db, from: { lat: number; lon: number },
  opts: { wear?: boolean } = {}): Promise<DriveLookup> {
  if (roadMilesLive()) {
    await Promise.race([
      ensureRoadMiles(db, portRouteWants([from]), osrmMiles,
        { straightMiles: (w) => haversineMiles(w.from.lat, w.from.lon, w.to.lat, w.to.lon) }).catch(() => 0),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }
  const miles = await loadRoadMiles(db);
  let set = new Map<string, number>();
  try { set = await settingsMap(db); } catch { /* shipped defaults below */ }
  const gas = await db.query<any>(`select price_per_gallon_usd from gas_prices order by as_of desc limit 1`).catch(() => ({ rows: [] as any[] }));
  const gasPrice = gas.rows[0] ? Number(gas.rows[0].price_per_gallon_usd) : DRIVING.fallbackGasPriceUsd;
  const rates = await loadMileageRates(db).catch(() => []);
  const PARKING_DEFAULT: Record<string, number> = { canaveral: 20, fll: 25 };
  return (port: HomePort, sailDate: string) => {
    if (!(DRIVE_PORTS as readonly string[]).includes(port.id)) return null;
    const parkingPerDay = set.get(parkingKey(port.id)) ?? PARKING_DEFAULT[port.id] ?? 0;
    if (!(parkingPerDay > 0)) return null;
    const mapMiles = miles.get(routeKey(from, portRouteId(port.id)));
    const oneWayMiles = mapMiles ?? haversineMiles(from.lat, from.lon, port.terminal.lat, port.terminal.lon) * DRIVING.roadDistanceFactor;
    if (oneWayMiles > MAX_PORT_DRIVE_MILES) return null;
    const rate = irsMileageRate(sailDate, rates);
    if (!rate.ok) return null;
    const half = Number(sailDate.slice(5, 7)) <= 6 ? "h1" : "h2";
    const perMile = set.get(`mileage.${rate.rateYear}.${half}`) ?? rate.ratePerMile;
    const round = oneWayMiles * 2;
    return { oneWayMiles, fromMap: mapMiles !== undefined, gasUsd: (round / DRIVING.mpg) * gasPrice,
      wearUsd: opts.wear === false ? 0 : round * perMile, parkingPerDay };
  };
}
