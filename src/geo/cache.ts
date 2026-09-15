/**
 * Nominatim's usage policy requires caching results rather than re-querying
 * the same thing. This is that cache — a plain lookup table keyed by the
 * normalized query text, checked before ever calling the provider. Distinct
 * from the refresh-job cache pattern used for flights/hotels/tickets: those
 * are pre-fetched in bulk every morning, this is filled lazily as people
 * actually type city names, since there's no way to pre-cache "every
 * possible city" the way there is a fixed set of routes to fetch.
 */
import type { Db } from "../db.js";
import type { GeocodeProvider, GeocodeResult } from "./types.js";

export async function cachedGeocode(db: Db, provider: GeocodeProvider, query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  const key = trimmed.toLowerCase();
  if (!key) return [];
  const cached = await db.query(`select results from geocode_cache where query_text = $1`, [key]);
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
