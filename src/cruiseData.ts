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
      parking: p.parking ? `$${p.parking.perDayUsd} a day (${p.parking.status}: ${p.parking.source})`
        : PARKING_NOT_USED[p.id] ? `Not used: ${PARKING_NOT_USED[p.id]}` : "Not looked up",
    })),
    excursions: portsOfCallStatus(),
    standing: [
      "A price only works for the party Disney's page was set to (2 adults, 2 adults + 2 children ...): other parties don't see that sailing. Save each sailing for the parties you want covered.",
      "Driving to a port isn't priced yet (someone within 100 miles of the port's airport sees no cruise from that port). Parking figures are stored for when it is.",
      "No hotel the night before: Disney's guidelines allow flying in on sailing day (latest arrivals: MCO 11:30 AM, FLL 12:30 PM, IAH 10:45 AM, SAN 12:15 PM, YVR 11:15 AM).",
      "Flights to Fort Lauderdale, Houston, San Diego and Vancouver come only from fares we bought: a sailing shows once a fare that month exists (bought nightly, ~50 searches a month, plus Planner Pro searches). Port Canaveral uses the same flight formula as Walt Disney World.",
      "Transfers are charged for every guest, infants included (Disney's page says \"per guest\").",
      "Port adventure prices are Disney's own listings, undated; one typical (median) adventure per guest per port.",
      "Weather at the ports and ship details (age, size, what's on board) aren't in yet.",
    ],
  };
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
