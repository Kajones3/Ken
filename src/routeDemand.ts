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
import type { Db } from "./db.js";

export interface PopularRoute {
  origin: string;
  destination: string;
  departMonth: string;
  searches: number;
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
