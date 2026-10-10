/**
 * "Would flying from a nearby airport be cheaper?" (owner, 2026-10-10: "I
 * can drive to RDU, ATL, CLT or IAD. How much could I save by leaving out
 * of Dulles instead of RDU?").
 *
 * For each US resort, compares what people actually paid from the home
 * airport with what they paid from every other airport we offer within a
 * day's drive, to the SAME destination in the SAME month (or quarter): the
 * government's fare surveys, like with like. It names the one that saves
 * the most per seat, if any saves enough to be worth a drive.
 *
 * Advice only. It never changes a total, and the line says so. The
 * international resorts get nothing: the surveys are US-domestic, and our
 * international estimate is one figure for every US city, so a difference
 * there would be invented.
 */
import type { Db } from "./db.js";
import { ALL_ORIGINS, RESORTS } from "./config.js";
import { haversineMiles } from "./geo.js";
import { MONTHLY_MIN_TICKETS } from "./book.js";

/** Straight-line miles. ~375 is about 7 hours on the road: RDU to Atlanta. */
export const NEARBY_MAX_MILES = 375;
/** Smaller savings than this aren't worth a drive (and are inside the
 *  survey's own noise). */
export const NEARBY_MIN_SAVING_PER_SEAT = 40;
export const NEARBY_MIN_SAVING_PCT = 5;

const ORIGIN = new Map(ALL_ORIGINS.map((o) => [o.iata, o]));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Every other airport we offer within a drive of `origin`, nearest first. */
export function nearbyOrigins(origin: string): { iata: string; name: string; miles: number }[] {
  const o = ORIGIN.get(origin);
  if (!o) return [];
  return ALL_ORIGINS
    .filter((x) => x.iata !== origin)
    .map((x) => ({ iata: x.iata, name: x.name, miles: haversineMiles(o.lat, o.lon, x.lat, x.lon) }))
    .filter((x) => x.miles <= NEARBY_MAX_MILES)
    .sort((a, b) => a.miles - b.miles);
}

/** Rough driving time from straight-line miles (roads wind ~20%; ~62 mph
 *  average), to the half hour. A guess, and the line says "about". */
export function driveHours(straightMiles: number): number {
  return Math.max(0.5, Math.round((straightMiles * 1.2) / 62 * 2) / 2);
}

export interface SurveyFare { origin: string; median: number; period: string }

export interface NearbyCheaper {
  origin: string; name: string; driveHours: number;
  homeMedian: number; altMedian: number; savingPerSeat: number; period: string;
}

/** The nearby airport that saves the most per seat, or null. `fares` holds
 *  the home airport and the nearby ones for ONE destination and ONE period.
 *  Pure. */
export function pickNearbyCheaper(home: string, fares: SurveyFare[]): NearbyCheaper | null {
  const h = fares.find((f) => f.origin === home);
  if (!h) return null;
  let best: NearbyCheaper | null = null;
  for (const n of nearbyOrigins(home)) {
    const f = fares.find((x) => x.origin === n.iata && x.period === h.period);
    if (!f) continue;
    const saving = h.median - f.median;
    if (saving < NEARBY_MIN_SAVING_PER_SEAT || saving / h.median * 100 < NEARBY_MIN_SAVING_PCT) continue;
    if (!best || saving > best.savingPerSeat) {
      best = {
        origin: n.iata, name: n.name, driveHours: driveHours(n.miles),
        homeMedian: Math.round(h.median), altMedian: Math.round(f.median),
        savingPerSeat: Math.round(saving), period: h.period,
      };
    }
  }
  return best;
}

/**
 * For each destination airport, the nearby airport worth the drive for a
 * trip in `month` ("2027-03"), or nothing. Prefers the monthly survey (same
 * calendar month, the newest year the home airport has one with enough
 * tickets); otherwise the quarterly survey (same quarter, newest year).
 * Nearby airports are only compared within that same period.
 */
export async function loadNearbyCheaper(
  db: Db, origin: string, destinations: string[], month: string,
): Promise<Map<string, NearbyCheaper>> {
  const out = new Map<string, NearbyCheaper>();
  const near = nearbyOrigins(origin).map((n) => n.iata);
  if (!near.length || !destinations.length) return out;
  const all = [origin, ...near];
  const mo = Number(month.slice(5, 7));
  const q = Math.ceil(mo / 3);

  const monthly = (await db.query<{ origin: string; destination: string; year: number; median: string }>(
    `select distinct on (origin, destination, year) origin, destination, year, median_fare_usd as median
       from historical_fares_monthly
      where origin = any($1) and destination = any($2) and month = $3 and itin_count >= $4
      order by origin, destination, year, loaded_at desc`,
    [all, destinations, mo, MONTHLY_MIN_TICKETS],
  ).catch(() => ({ rows: [] }))).rows;
  const quarterly = (await db.query<{ origin: string; destination: string; year: number; median: string }>(
    `select origin, destination, year, median_fare_usd as median
       from historical_fares
      where source = 'bts_db1b' and origin = any($1) and destination = any($2) and quarter = $3
        and median_fare_usd is not null`,
    [all, destinations, q],
  )).rows;

  for (const d of destinations) {
    const pick = (rows: typeof monthly, label: (y: number) => string) => {
      const home = rows.filter((r) => r.origin.trim() === origin && r.destination.trim() === d);
      if (!home.length) return null;
      const year = Math.max(...home.map((r) => Number(r.year)));
      const period = label(year);
      const fares = rows
        .filter((r) => r.destination.trim() === d && Number(r.year) === year)
        .map((r) => ({ origin: r.origin.trim(), median: Number(r.median), period }));
      return { found: true, best: pickNearbyCheaper(origin, fares) };
    };
    const m = pick(monthly, (y) => `${MONTHS[mo - 1]} ${y}`) ?? pick(quarterly, (y) => `${MONTHS[(q - 1) * 3]}–${MONTHS[q * 3 - 1]} ${y}`);
    if (m?.best) out.set(d, m.best);
  }
  return out;
}

/** The US resorts' arrival airports, for callers that want them all. */
export function domesticArrivalAirports(): string[] {
  return RESORTS.filter((r) => r.region === "dom").flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]);
}
