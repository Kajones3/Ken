/**
 * /admin "Data holes" (part 3 of the /admin rework, owner 2026-10-16): where
 * we know the least, and what will fill each hole. Read-only.
 *
 * FLIGHTS, per route (home airport -> each resort's main airport, the only
 * airports we price):
 *  - Government survey rows: BTS quarterly (`historical_fares`, bts_db1b)
 *    and monthly (`historical_fares_monthly`, enough tickets). International
 *    routes have none: BTS surveys domestic flights only.
 *  - Free feed fares (`flight_observations`, travelpayouts*) and fares we
 *    bought (serpapi_flights), last 90 days; Google answers kept whole
 *    (`provider_responses`), last 90 days.
 *  - Searches travelers made (`route_searches`).
 * The list puts first the routes people search that hold the fewest fares we
 * bought: need = (searches + 1) / (bought fares + 1).
 * Each hole gets one action:
 *  - "rotation": one of the 19 airports the nightly job rotates through; its
 *    place in the queue at ROTATION_PER_NIGHT a night gives a rough date.
 *  - "not in rotation": one of the other 22 airports; buy it once by naming
 *    it in the popular-routes workflow, or screenshot a fare into price checks.
 *  - "government": we hold fares but no monthly survey; BTS publishes months
 *    late (the newest file is the date said).
 * The government's airfare index (BLS) is one national line, not per route.
 *
 * HOTELS, per resort and plannable month: Google's rates kept in the last 45
 * days, the last search and what it priced, and when the nightly rotation
 * (stalest first, HOTEL_SEARCHES_PER_NIGHT a night) next reaches it. A month
 * Google won't price yet (past ~360 days) says so.
 */
import type { Db } from "./db.js";
import { ALL_ORIGINS, ORIGINS, RESORTS, isLocalRoute, isMainArrivalAirport, mainArrivalAirport, plannableMonths } from "./config.js";
import { MONTHLY_MIN_TICKETS } from "./book.js";
import { rotationRoutes } from "./routeDemand.js";
import { rotateHotelSlots } from "./jobs/hotelRotation.js";
import { sampleCheckIn } from "./providers/serpapi.js";
import { loadIndexSeries, latestPeriod, periodName } from "./airfareIndex.js";
import { addDaysISO, type ISODate } from "./dates.js";

/** Rotation slots popular-routes keeps every night (a third of 18). */
export const ROTATION_PER_NIGHT = 6;
/** Paid hotel searches a night (refresh, SERPAPI_HOTELS_BUDGET). */
export const HOTEL_SEARCHES_PER_NIGHT = 12;
export const HOLES_SHOWN = 25;

export type RouteAction =
  | { kind: "rotation"; byDate: ISODate }
  | { kind: "not in rotation" }
  | { kind: "government"; newestSurvey: string | null };

export interface RouteData {
  origin: string; destination: string; resortId: string; intl: boolean;
  btsQuarters: number; btsMonths: number;
  feed90: number; paid90: number; answers90: number;
  searches: number;
  inRotation: boolean;
  /** 0-based place in tonight's rotation queue (rotation airports only). */
  queuePlace: number | null;
}
export interface RouteHole extends RouteData { need: number; action: RouteAction }

/** Pure: rank routes and pick each one's action. */
export function rankRouteHoles(routes: RouteData[], today: ISODate, newestSurvey: string | null, limit = HOLES_SHOWN): RouteHole[] {
  return routes
    .map((r) => {
      const need = (r.searches + 1) / (r.paid90 + 1);
      let action: RouteAction;
      if (!r.intl && r.paid90 > 0 && r.btsMonths === 0) action = { kind: "government", newestSurvey };
      else if (r.inRotation && r.queuePlace !== null) {
        action = { kind: "rotation", byDate: addDaysISO(today, Math.floor(r.queuePlace / ROTATION_PER_NIGHT) + 1) };
      } else action = { kind: "not in rotation" };
      return { ...r, need, action };
    })
    .sort((a, b) => b.need - a.need || a.feed90 - b.feed90 || a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination))
    .slice(0, limit);
}

export interface HotelHole {
  resortId: string; month: string;
  samples45: number;
  lastSearch: string | null; lastPriced: number | null;
  /** When the rotation next reaches it, or null if Google won't price it yet. */
  nextSearch: ISODate | null;
  tooFar: boolean;
}

export interface DataHoles {
  asOf: string;
  routes: { total: number; noPaid: number; noSurveyIntl: number; holes: RouteHole[] };
  bls: { latest: string | null };
  newestSurvey: string | null;
  hotels: { total: number; empty: number; holes: HotelHole[] };
}

const count = async (db: Db, sql: string, params: unknown[] = []) => {
  const m = new Map<string, number>();
  try {
    const r = await db.query<{ o: string; d: string; n: string }>(sql, params);
    for (const x of r.rows) {
      const k = `${String(x.o).trim()}|${mainArrivalAirport(String(x.d).trim())}`;
      m.set(k, (m.get(k) ?? 0) + Number(x.n));
    }
  } catch { /* table missing locally: counts as nothing held */ }
  return m;
};

export async function loadDataHoles(db: Db, now: Date = new Date()): Promise<DataHoles> {
  const today = now.toISOString().slice(0, 10) as ISODate;
  const mains = RESORTS.map((r) => ({ iata: r.iata, resort: r }));
  const [bts, monthly, feed, paid, answers, searches] = await Promise.all([
    count(db, `select origin o, destination d, count(*) n from historical_fares where source = 'bts_db1b' group by 1, 2`),
    count(db, `select origin o, destination d, count(distinct (year, month)) n from historical_fares_monthly
                where itin_count >= $1 group by 1, 2`, [MONTHLY_MIN_TICKETS]),
    count(db, `select origin o, destination d, count(*) n from flight_observations
                where source like 'travelpayouts%' and observed_at > now() - interval '90 days' group by 1, 2`),
    count(db, `select origin o, destination d, count(*) n from flight_observations
                where source = 'serpapi_flights' and observed_at > now() - interval '90 days' group by 1, 2`),
    count(db, `select request->>'departure_id' o, request->>'arrival_id' d, count(*) n from provider_responses
                where kind = 'google_flights' and status = 200 and fetched_at > now() - interval '90 days' group by 1, 2`),
    count(db, `select origin o, destination d, sum(searches) n from route_searches group by 1, 2`),
  ]);
  const queue = await rotationRoutes(db, 10_000, today.slice(0, 7)).catch(() => []);
  const place = new Map(queue.map((q, i) => [`${q.origin}|${q.destination}`, i]));
  const rotating = new Set(ORIGINS.map((o) => o.iata));

  const routes: RouteData[] = [];
  for (const o of ALL_ORIGINS) {
    for (const { iata, resort } of mains) {
      if (!isMainArrivalAirport(iata) || isLocalRoute(o.iata, iata)) continue;
      const k = `${o.iata}|${iata}`;
      routes.push({
        origin: o.iata, destination: iata, resortId: resort.id, intl: resort.region !== "dom",
        btsQuarters: bts.get(k) ?? 0, btsMonths: monthly.get(k) ?? 0,
        feed90: feed.get(k) ?? 0, paid90: paid.get(k) ?? 0, answers90: answers.get(k) ?? 0,
        searches: searches.get(k) ?? 0,
        inRotation: rotating.has(o.iata), queuePlace: place.get(k) ?? null,
      });
    }
  }

  let newestSurvey: string | null = null;
  try {
    const r = await db.query<{ y: number; m: number }>(
      `select year y, month m from historical_fares_monthly where itin_count >= $1 order by year desc, month desc limit 1`, [MONTHLY_MIN_TICKETS]);
    if (r.rows[0]) newestSurvey = periodName(`${r.rows[0].y}-${String(r.rows[0].m).padStart(2, "0")}`);
  } catch { /* none loaded */ }
  let blsLatest: string | null = null;
  try {
    const s = (await loadIndexSeries(db)).cpiNsa;
    const p = s ? latestPeriod(s) : undefined;
    blsLatest = p ? periodName(p) : null;
  } catch { /* none loaded */ }

  // Hotels: every resort x plannable month, in the order the rotation takes them.
  const months = plannableMonths(today);
  const order = await rotateHotelSlots(db, { months, limit: 10_000, today }).catch(() => []);
  const hotelPlace = new Map(order.map((s, i) => [`${s.resortId}|${s.month}`, i]));
  const samples = new Map<string, number>();
  const last = new Map<string, { at: string; priced: number }>();
  try {
    for (const r of (await db.query<{ resort_id: string; month: string; n: string }>(
      `select resort_id, month, count(*) n from hotel_samples where pulled_at > now() - interval '45 days' group by 1, 2`)).rows) {
      samples.set(`${r.resort_id}|${r.month}`, Number(r.n));
    }
    for (const r of (await db.query<{ resort_id: string; month: string; at: unknown; priced: number }>(
      `select distinct on (resort_id, month) resort_id, month, searched_at at, priced from hotel_searches
        order by resort_id, month, searched_at desc`)).rows) {
      const at = r.at instanceof Date ? r.at.toISOString() : String(r.at);
      last.set(`${r.resort_id}|${r.month}`, { at: at.slice(0, 10), priced: Number(r.priced) });
    }
  } catch { /* tables missing locally */ }
  const hotelRows: HotelHole[] = [];
  for (const r of RESORTS) {
    for (const m of months) {
      const k = `${r.id}|${m}`;
      const pos = hotelPlace.get(k);
      const tooFar = !sampleCheckIn(m, today);
      hotelRows.push({
        resortId: r.id, month: m, samples45: samples.get(k) ?? 0,
        lastSearch: last.get(k)?.at ?? null, lastPriced: last.get(k)?.priced ?? null,
        nextSearch: tooFar || pos === undefined ? null : addDaysISO(today, Math.floor(pos / HOTEL_SEARCHES_PER_NIGHT) + 1),
        tooFar,
      });
    }
  }
  const hotelHoles = [...hotelRows].sort((a, b) => a.samples45 - b.samples45 || a.month.localeCompare(b.month)).slice(0, HOLES_SHOWN);

  return {
    asOf: now.toISOString(),
    routes: {
      total: routes.length,
      noPaid: routes.filter((r) => r.paid90 === 0).length,
      noSurveyIntl: routes.filter((r) => r.intl).length,
      holes: rankRouteHoles(routes, today, newestSurvey),
    },
    bls: { latest: blsLatest },
    newestSurvey,
    hotels: { total: hotelRows.length, empty: hotelRows.filter((h) => h.samples45 === 0).length, holes: hotelHoles },
  };
}
