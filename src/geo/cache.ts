/**
 * Nominatim's usage policy requires caching results rather than re-querying
 * the same thing. This is that cache — a plain lookup table keyed by the
 * normalized query text, checked before ever calling the provider. Distinct
 * from the refresh-job cache pattern used for flights/hotels/tickets: those
 * are pre-fetched in bulk every morning, this is filled lazily as people
 * actually type city names, since there's no way to pre-cache "every
 * possible city" the way there is a fixed set of routes to fetch.
 *
 * Rows expire after CACHE_TTL. A real address's coordinates don't change,
 * so this isn't tracking real-world drift — it's a self-healing bound on
 * how long a *bad* cached row (a provider bug, or a since-fixed filtering
 * bug in nominatim.ts) can be served before the next request re-runs
 * today's code. Found 2026-09-16: a "27540" search cached during an
 * earlier broken filtering attempt kept returning the same wrong non-US
 * results through two later deploys that had actually fixed the filter,
 * because nothing here ever read `cached_at` for staleness.
 */
import type { Db } from "../db.js";
import type { GeocodeProvider, GeocodeResult } from "./types.js";

const CACHE_TTL = "7 days";

export async function cachedGeocode(db: Db, provider: GeocodeProvider, query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  const key = trimmed.toLowerCase();
  if (!key) return [];
  const cached = await db.query(
    `select results from geocode_cache
      where query_text = $1
        and cached_at > now() - interval '${CACHE_TTL}'`,
    [key],
  );
  if (cached.rows[0]) return cached.rows[0].results as GeocodeResult[];

  // The lowercased key is only for the cache's own lookup/storage — the
  // provider itself gets what the person actually typed. Passing the
  // lowercased key here (found 2026-09-15) meant a real Nominatim result's
  // display_name still came back fine (its search is case-insensitive), but
  // the mock provider's echoed label ended up permanently lowercase — "type
  // Raleigh, see raleigh back" — which reads as broken regardless of which
  // provider is actually active.
  const results = await provider.search(trimmed);
  await db.query(
    `insert into geocode_cache (query_text, results, cached_at) values ($1,$2,now())
     on conflict (query_text) do update set results = excluded.results, cached_at = excluded.cached_at`,
    [key, JSON.stringify(results)],
  );
  return results;
}
