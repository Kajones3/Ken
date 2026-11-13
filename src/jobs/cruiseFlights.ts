/**
 * Nightly: buy real fares to the cruise ports' airports (owner, 2026-11-13:
 * "Buy flights when a planner pro member searches. Also, use about 50
 * searches per month to buy cruise port ... flights we don't use yet").
 *
 * Fort Lauderdale, Houston, San Diego and Vancouver are not resort airports,
 * so no formula prices them: a cruise from there shows only once a fare is
 * bought (cruisePricing.ts). Each search buys the EXACT sailing: out on
 * sailing day, back the day the cruise ends.
 *
 * Order: routes a Planner Pro member searched with cruises on (route_searches,
 * last 30 days), then never-bought home airport + port pairs, then the rest.
 * A sailing that already has a bought fare within 3 days is skipped (the
 * pricing would use it anyway). Port Canaveral (MCO) is left to the normal
 * Disney World buying.
 */
import type { Db } from "../db.js";
import { addDaysISO } from "../dates.js";
import { ORIGINS, ORIGIN_BY_IATA, RESORT_BY_ARRIVAL_AIRPORT, NO_FLY_RADIUS_MILES } from "../config.js";
import { haversineMiles } from "../geo.js";
import { HOME_PORTS, homePortOf } from "../cruiseFacts.js";
import { CRUISE_FRESH_DAYS } from "../cruisePricing.js";
import { loadSightings } from "../cruiseData.js";
import { SERPAPI_FLIGHTS } from "../observations.js";

/** Port airports that only cruises use (no resort prices from them). */
export const CRUISE_ONLY_AIRPORTS = new Set(
  HOME_PORTS.map((p) => p.airport).filter((a) => !RESORT_BY_ARRIVAL_AIRPORT.has(a)),
);

/** About 50 a month: 1 on every third night, 2 on the others. */
export function cruiseSlotsTonight(dayNumber: number): number {
  return dayNumber % 3 === 0 ? 1 : 2;
}

export interface CruiseBuy { origin: string; destination: string; date: string; nights: number; why: "demand" | "rotation" }

/** Pure: pick tonight's cruise-port searches. */
export function pickCruiseBuys(input: {
  sailings: { airport: string; sailDate: string; nights: number }[];
  demand: { origin: string; destination: string; month: string; searches: number }[];
  bought: { origin: string; destination: string; departDate: string }[];
  origins: { iata: string; lat: number; lon: number }[];
  n: number;
  lastSaleDay: string;
}): CruiseBuy[] {
  const day = (d: string) => Date.parse(d) / 86_400_000;
  const covered = (o: string, a: string, d: string) =>
    input.bought.some((b) => b.origin === o && b.destination === a && Math.abs(day(b.departDate) - day(d)) <= 3);
  const pairCount = new Map<string, number>();
  for (const b of input.bought) pairCount.set(`${b.origin}|${b.destination}`, (pairCount.get(`${b.origin}|${b.destination}`) ?? 0) + 1);
  const port = (a: string) => HOME_PORTS.find((p) => p.airport === a);
  const far = (o: { lat: number; lon: number }, a: string) => {
    const p = port(a); return !!p && haversineMiles(o.lat, o.lon, p.lat, p.lon) >= NO_FLY_RADIUS_MILES;
  };
  const sailings = input.sailings
    .filter((s) => CRUISE_ONLY_AIRPORTS.has(s.airport) && s.sailDate <= input.lastSaleDay)
    .sort((a, b) => a.sailDate.localeCompare(b.sailDate));
  const out: CruiseBuy[] = [];
  const taken = new Set<string>();
  const add = (o: string, s: { airport: string; sailDate: string; nights: number }, why: CruiseBuy["why"]) => {
    const k = `${o}|${s.airport}|${s.sailDate}`;
    if (out.length >= input.n || taken.has(k) || covered(o, s.airport, s.sailDate)) return;
    const og = input.origins.find((x) => x.iata === o);
    if (!og || o === s.airport || !far(og, s.airport)) return;
    taken.add(k);
    out.push({ origin: o, destination: s.airport, date: s.sailDate, nights: s.nights, why });
  };
  for (const d of [...input.demand].sort((a, b) => b.searches - a.searches)) {
    for (const s of sailings) if (s.airport === d.destination && s.sailDate.slice(0, 7) === d.month) add(d.origin, s, "demand");
  }
  const pairs = sailings.flatMap((s) => input.origins.map((o) => ({ o: o.iata, s })))
    .sort((a, b) => (pairCount.get(`${a.o}|${a.s.airport}`) ?? 0) - (pairCount.get(`${b.o}|${b.s.airport}`) ?? 0)
      || a.s.sailDate.localeCompare(b.s.sailDate) || a.o.localeCompare(b.o));
  for (const x of pairs) add(x.o, x.s, "rotation");
  return out;
}

/** Reads tonight's inputs and picks the searches. */
export async function cruiseBuysTonight(db: Db, n: number, today: string, lastSaleDay: string): Promise<CruiseBuy[]> {
  if (n <= 0) return [];
  const since = addDaysISO(today, -CRUISE_FRESH_DAYS);
  const sail = new Map<string, { airport: string; sailDate: string; nights: number }>();
  for (const r of await loadSightings(db)) {
    if (!r.sailDate || r.sailDate <= today || r.seenOn < since || r.soldOut) continue;
    const nights = r.nights ?? (r.sailEnd ? Math.round((Date.parse(r.sailEnd) - Date.parse(r.sailDate)) / 86_400_000) : 0);
    const p = homePortOf(r.departurePort) ?? homePortOf(r.title);
    if (!p || nights <= 0) continue;
    sail.set(`${p.airport}|${r.sailDate}`, { airport: p.airport, sailDate: r.sailDate, nights });
  }
  const airports = [...CRUISE_ONLY_AIRPORTS];
  const demand = await db.query<any>(
    `select origin, destination, depart_month, searches from route_searches
      where destination = any($1) and last_searched_at > now() - interval '30 days'`, [airports]);
  const bought = await db.query<any>(
    `select origin, destination, depart_date::text d from flight_observations
      where source = $1 and destination = any($2) and depart_date > $3`, [SERPAPI_FLIGHTS, airports, today]);
  const demandOrigins = demand.rows.map((r) => String(r.origin).trim());
  const origins = [...new Set([...ORIGINS.map((o) => o.iata), ...demandOrigins])]
    .map((i) => ORIGIN_BY_IATA.get(i)).filter((o): o is NonNullable<typeof o> => !!o);
  return pickCruiseBuys({
    sailings: [...sail.values()],
    demand: demand.rows.map((r) => ({ origin: String(r.origin).trim(), destination: String(r.destination).trim(),
      month: String(r.depart_month), searches: Number(r.searches) })),
    bought: bought.rows.map((r) => ({ origin: String(r.origin).trim(), destination: String(r.destination).trim(), departDate: String(r.d).slice(0, 10) })),
    origins, n, lastSaleDay,
  });
}
