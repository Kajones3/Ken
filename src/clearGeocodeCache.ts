/**
 * One-off admin script: wipe geocode_cache entirely. Same shape as
 * grantPlus.ts — a command, not an endpoint. Needed when a bad cached
 * result (e.g. from a provider bug or a filtering-logic bug that's since
 * been fixed in code) is stuck being served forever, since cachedGeocode()
 * normally only re-fetches once a row passes its TTL (src/geo/cache.ts).
 *
 *   npm run clear-geocode-cache
 */
import { getDb, type Db } from "./db.js";

export async function clearGeocodeCache(db: Db): Promise<number> {
  const { rows } = await db.query(`delete from geocode_cache returning 1`);
  return rows.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const n = await clearGeocodeCache(db);
  console.log(`✓ geocode_cache cleared: ${n} row(s) deleted`);
  await db.close();
}
