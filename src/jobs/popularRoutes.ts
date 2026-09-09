/**
 * Nightly: buy real fares for the routes people actually search.
 *
 * This is the half of the pricing model that costs money, and it is
 * deliberately the small half. Pre-fetching every supported route is not
 * affordable (19 origins x 11 airports x 3 trip lengths x 365 days is
 * ~229,000 metered lookups), so instead:
 *
 *   1. route_searches records what people ask for (see routeDemand.ts).
 *   2. This job spends a bounded number of real lookups on the busiest of
 *      those, sampling a few dates per route/month rather than every day.
 *   3. jobs/fareTrend.ts measures how far those real fares sit from the
 *      same routes' BTS medians, and
 *   4. book.ts moves *every other* route's BTS median by that same
 *      percentage, labelled as an estimate.
 *
 * So a busy route gets a real number, and a quiet one gets a real
 * historical median moved by a real, currently-measured trend. Neither is
 * a made-up curve.
 *
 * Every lookup is bounded twice over: SERPAPI_FLIGHTS_BUDGET caps the
 * provider itself, and POPULAR_ROUTES_LIMIT caps how many routes are
 * considered. Both fail closed — no key, no spend.
 */
import { randomUUID } from "node:crypto";
import { monthBounds, quarterOf, todayISO, addDaysISO } from "../dates.js";
import { getDb, type Db } from "../db.js";
import { popularRoutes, trendAnchorRoutes, type PopularRoute } from "../routeDemand.js";
import { SerpApiFlightProvider } from "../providers/serpapiFlights.js";
import { TRIP_BUCKETS } from "../config.js";

/**
 * Which departure dates to actually buy for one route/month. Sampling, not
 * every day: fares within a month move far less than fares across seasons,
 * and a handful of real anchor points per month is what the trend needs.
 * Days 7/14/21 avoid both month edges, where a "month" search is least
 * likely to land.
 */
export function sampleDates(month: string, perMonth: number): string[] {
  const [first, last] = monthBounds(month);
  const lastDay = Number(last.slice(8, 10));
  const out: string[] = [];
  const step = Math.max(1, Math.floor(lastDay / (perMonth + 1)));
  for (let i = 1; i <= perMonth; i++) {
    const day = Math.min(lastDay, step * i);
    const iso = `${month}-${String(day).padStart(2, "0")}`;
    if (iso >= first && !out.includes(iso)) out.push(iso);
  }
  return out;
}

export interface PopularRoutesOptions {
  limit?: number;
  datesPerMonth?: number;
  /** Which trip lengths to buy. One by default: the middle bucket is what a
   *  typical search lands on, and buying all three triples the bill for a
   *  trend that reads the same either way. */
  buckets?: number[];
  routes?: PopularRoute[];
  provider?: Pick<SerpApiFlightProvider, "quote" | "callsSpent" | "budgetRemaining">;
}

export async function runPopularRoutes(db: Db, opts: PopularRoutesOptions = {}) {
  const limit = opts.limit ?? Number(process.env.POPULAR_ROUTES_LIMIT ?? 12);
  const datesPerMonth = opts.datesPerMonth ?? Number(process.env.POPULAR_ROUTES_DATES ?? 3);
  const buckets = opts.buckets ?? [TRIP_BUCKETS[Math.floor(TRIP_BUCKETS.length / 2)]!];

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'popular_routes',$2)`,
    [runId, `limit ${limit} x ${datesPerMonth} dates x ${buckets.length} bucket(s)`]);

  let routes = opts.routes ?? await popularRoutes(db, limit);

  // Top up with trend anchors so the multiplier stays computable even on a
  // day when demand was thin or entirely international (see
  // trendAnchorRoutes). Without this, one busy Tokyo day would leave every
  // estimated route in the app showing "no cached price".
  if (!opts.routes) {
    const anchorMonth = (routes[0]?.departMonth) ?? addDaysISO(todayISO(), 90).slice(0, 7);
    const anchors = await trendAnchorRoutes(db, quarterOf(`${anchorMonth}-01`), anchorMonth);
    const seen = new Set(routes.map((r) => `${r.origin}|${r.destination}|${r.departMonth}`));
    for (const a of anchors) {
      const key = `${a.origin}|${a.destination}|${a.departMonth}`;
      if (!seen.has(key)) { routes.push(a); seen.add(key); }
    }
  }

  let calls = 0, rows = 0, errors = 0, misses = 0;

  if (routes.length) {
    const provider = opts.provider ?? new SerpApiFlightProvider();
    outer: for (const route of routes) {
      for (const bucket of buckets) {
        for (const date of sampleDates(route.departMonth, datesPerMonth)) {
          if (provider.budgetRemaining <= 0) {
            console.warn("popular-routes: provider budget exhausted, stopping early");
            break outer;
          }
          try {
            calls++;
            const q = await provider.quote(route.origin, route.destination, date, bucket);
            if (!q) { misses++; continue; }
            // Same upsert contract as the main refresh: on success only. A
            // failed lookup leaves yesterday's real fare in place.
            await db.query(
              `insert into flight_prices
                 (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,source,fetched_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'serpapi_flights',now())
               on conflict (origin,destination,depart_date,trip_length) do update set
                 price_usd = excluded.price_usd, carrier = excluded.carrier,
                 stops = excluded.stops, deep_link = excluded.deep_link,
                 source = excluded.source, fetched_at = excluded.fetched_at`,
              [q.origin, q.destination, q.departDate, q.tripLength,
               q.priceUsd, q.carrier ?? null, q.stops, q.deepLink ?? null],
            );
            rows++;
          } catch (e) {
            errors++;
            console.error(`popular ${route.origin}->${route.destination} ${date}:`, (e as Error).message);
          }
        }
      }
    }
  }

  await db.query(
    `update fetch_runs set finished_at = now(), calls = $2, rows_written = $3, errors = $4,
       note = note || ' · ' || $5 where id = $1`,
    [runId, calls, rows, errors, `${routes.length} routes, ${misses} with no fare`],
  );
  return { runId, routes: routes.length, calls, rows, errors, misses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.SERPAPI_KEY) {
    console.log("popular-routes: SERPAPI_KEY not set — nothing bought, estimates stay as they are.");
    process.exit(0);
  }
  const db = await getDb();
  const res = await runPopularRoutes(db);
  console.log(
    `popular-routes done: ${res.routes} routes, ${res.calls} calls, ` +
    `${res.rows} real fares written, ${res.misses} with no fare, ${res.errors} errors`,
  );
  await db.close();
}
