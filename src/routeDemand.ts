/**
 * Which routes people actually search, so the nightly job can spend its
 * metered real-fare lookups where they matter.
 *
 * The economics this exists to serve: a real fare costs money per lookup,
 * and pre-fetching all 209 supported routes x 12 months x 3 trip lengths
 * every night is not affordable at any plan. But a real fare on a *busy*
 * route is worth far more than one on a route nobody searches — not only
 * because it's shown directly, but because it's what measures the trend
 * that every estimated route is moved by (see jobs/fareTrend.ts).
 *
 * Deliberately not per-user: no user id, no session id, no IP. This is
 * route popularity and nothing else, and it should stay that way — the
 * nightly job only ever needs "how many people asked about ATL-MCO in
 * March", never who they were.
 */
import { ORIGINS, RESORTS } from "./config.js";
import type { Db } from "./db.js";

export interface PopularRoute {
  origin: string;
  destination: string;
  departMonth: string;
  searches: number;
}

/** Every arrival airport the app prices — primaries plus alternates. Same
 *  shape jobs/coverage.ts builds for its report. */
function arrivalAirports(): string[] {
  return RESORTS.flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]);
}

/**
 * Records one search. Never throws: a failure to log demand must not fail
 * the search the user is actually waiting on — this is telemetry feeding a
 * cost optimisation, not part of pricing.
 */
export async function recordSearch(
  db: Db, origin: string, destinations: string[], departMonth: string,
): Promise<void> {
  if (!origin || !departMonth) return;
  try {
    for (const destination of new Set(destinations)) {
      if (!destination) continue;
      await db.query(
        `insert into route_searches (origin, destination, depart_month, searches, last_searched_at)
         values ($1,$2,$3,1,now())
         on conflict (origin, destination, depart_month) do update set
           searches = route_searches.searches + 1, last_searched_at = now()`,
        [origin, destination, departMonth],
      );
    }
  } catch (e) {
    console.error("recordSearch failed (ignored):", (e as Error).message);
  }
}

/**
 * The busiest routes worth buying a real fare for tonight.
 *
 * Ordered by recent demand, not all-time: `withinDays` drops a route that
 * was popular once and hasn't been touched since, so last spring's
 * one-off research doesn't permanently occupy a paid slot. Past months are
 * excluded outright — nobody can book them.
 */
export async function popularRoutes(
  db: Db, limit: number, withinDays = 30, today = new Date().toISOString().slice(0, 10),
): Promise<PopularRoute[]> {
  const r = await db.query<{ origin: string; destination: string; depart_month: string; searches: number }>(
    `select origin, destination, depart_month, searches
       from route_searches
      where last_searched_at > now() - ($2 || ' days')::interval
        and depart_month >= $3
      order by searches desc, last_searched_at desc
      limit $1`,
    [limit, String(withinDays), today.slice(0, 7)],
  );
  return r.rows.map((x) => ({
    origin: x.origin, destination: x.destination,
    departMonth: x.depart_month, searches: Number(x.searches),
  }));
}

/**
 * Routes bought purely to keep the trend measurable.
 *
 * The trend multiplier needs at least three routes that have BOTH a real
 * current fare and a BTS baseline for the same quarter. Real demand does not
 * guarantee that: searches cluster (everyone asks about the same one or two
 * routes), and international routes have no BTS coverage at all, since DB1B
 * is a US-domestic survey. Without anchors, a busy day of Tokyo searches
 * leaves the trend uncomputable and every estimate in the app falls back to
 * "no cached price".
 *
 * These are chosen by BTS sample size — the routes whose historical median
 * rests on the most real passengers, so the ratio measured against them is
 * the most trustworthy one available.
 *
 * The two-level query matters (fixed 2026-09-17). This used to be a single
 * `distinct on (origin, destination) ... order by origin, destination,
 * passengers_sampled desc limit 3`, which reads as "biggest sample first"
 * but is not: Postgres requires `distinct on`'s leading ORDER BY terms to
 * match its distinct columns, so `passengers_sampled` only broke ties
 * *within* one route and never influenced which routes came back. The
 * effect was alphabetical — the same three airports every night forever,
 * re-bought over the same rows, so paid coverage never widened. Ranking by
 * sample size has to happen in an outer query over the de-duplicated rows.
 */
export async function trendAnchorRoutes(
  db: Db, quarter: number, departMonth: string, limit = 3,
): Promise<PopularRoute[]> {
  const r = await db.query<{ origin: string; destination: string }>(
    `select origin, destination from (
       select distinct on (origin, destination) origin, destination, passengers_sampled
         from historical_fares
        where quarter = $1 and coalesce(median_fare_usd, avg_fare_usd) > 0
        order by origin, destination, passengers_sampled desc
     ) best
     order by passengers_sampled desc nulls last, origin, destination
     limit $2`,
    [quarter, limit],
  );
  return r.rows.map((x) => ({
    origin: x.origin, destination: x.destination, departMonth, searches: 0,
  }));
}

/**
 * Routes bought to widen coverage when nobody has searched anything.
 *
 * Demand-driven buying assumes there is demand. Before launch there isn't:
 * `route_searches` is empty or near-empty, so the nightly job would spend
 * its whole budget on the same handful of anchor routes every night,
 * overwriting the same rows via `on conflict do update` and never learning
 * anything new. This is the round-robin that fixes that.
 *
 * Staleness order, never-bought first, so a route bought tonight goes to the
 * back of the queue. Only `serpapi_flights` rows count as "bought" — a
 * Travelpayouts row or an estimate is not a real fare for this route, so a
 * route carrying only those is still unvisited as far as rotation cares.
 *
 * Why this is worth more than it looks: a bought fare corrects that route's
 * whole *quarter* (see book.ts), not just its date. ~19 origins x 9 arrival
 * airports is ~171 routes, so at ten lookups a night the rotation touches
 * every route the app prices inside about three weeks.
 */
export async function rotationRoutes(
  db: Db, limit: number, departMonth: string, exclude: Set<string> = new Set(),
): Promise<PopularRoute[]> {
  if (limit <= 0) return [];
  const dests = arrivalAirports();
  const seen = await db.query<{ origin: string; destination: string; last_bought: Date | null }>(
    `select origin, destination, max(fetched_at) as last_bought
       from flight_prices
      where source = 'serpapi_flights'
      group by origin, destination`,
  );
  const lastBought = new Map(
    seen.rows.map((r) => [`${r.origin}|${r.destination}`, r.last_bought ? new Date(r.last_bought).getTime() : 0]),
  );

  const candidates: { origin: string; destination: string; at: number }[] = [];
  for (const o of ORIGINS) {
    for (const d of dests) {
      const key = `${o.iata}|${d}`;
      if (exclude.has(key)) continue;
      candidates.push({ origin: o.iata, destination: d, at: lastBought.get(key) ?? 0 });
    }
  }
  candidates.sort((a, b) => a.at - b.at || a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination));
  return candidates.slice(0, limit).map((c) => ({
    origin: c.origin, destination: c.destination, departMonth, searches: 0,
  }));
}
