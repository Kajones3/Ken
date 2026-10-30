/**
 * Road miles from a map, for driving trips (owner, 2026-10-31: "I thought we
 * were going to price road miles from a map?").
 *
 * Driving used to be the straight-line distance x 1.25 (`DRIVING.roadDistanceFactor`),
 * a guess. Now each start point -> resort is asked ONCE of OpenStreetMap's
 * free routing service (OSRM, router.project-osrm.org: no key, no charge;
 * its rules ask for no more than one request a second and a credit, which
 * the driving card gives) and kept for good in `drive_routes`. Roads move
 * slowly; a route is never re-asked.
 *
 *  - Home airports are filled by the nightly refresh (at most 41 x 2 routes,
 *    once ever), so a search from any of them reads a map distance.
 *  - A typed city (driving mode's "Departing from") is asked the first time
 *    someone searches from it, with a short wait; if the map service is slow
 *    or down, that search uses the old estimate and the next one the map.
 *  - Start points are rounded to 2 decimals (about half a mile), so two
 *    people typing the same town share one lookup.
 *
 * Same standing as the city search (src/geo/): the one kind of provider call
 * made on a visitor's request, because nobody can pre-fetch every town a
 * person might type. Live only where there's a real database (Render and
 * the GitHub jobs) unless ROAD_MILES_LIVE=false; tests and local runs never
 * leave the machine and price the estimate.
 */
import type { Db } from "./db.js";

export interface RoutePoint { lat: number; lon: number }

export const ROAD_MILES_SOURCE = "OpenStreetMap (OSRM)";
const METERS_PER_MILE = 1609.344;
/** A map answer further than this from the straight line is a routing slip
 *  (a ferry, a wrong snap), not a road; keep the estimate instead. */
const MAX_DETOUR = 2.5;

export const pointKey = (p: RoutePoint) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
export const routeKey = (p: RoutePoint, resortId: string) => `${pointKey(p)}|${resortId}`;

export function roadMilesLive(): boolean {
  return process.env.ROAD_MILES_LIVE === "true" || (process.env.ROAD_MILES_LIVE !== "false" && !!process.env.DATABASE_URL);
}

/** One route's driving miles from OSRM, or null when it has no answer. */
export async function osrmMiles(from: RoutePoint, to: RoutePoint, timeoutMs = 4000): Promise<number | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": "PricingTheMagic/1.0 (pricingthemagic.com)" } });
    if (!res.ok) return null;
    const j = await res.json() as { code?: string; routes?: Array<{ distance?: number }> };
    const meters = j.code === "Ok" ? j.routes?.[0]?.distance : undefined;
    return typeof meters === "number" && meters > 0 ? Math.round((meters / METERS_PER_MILE) * 10) / 10 : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Every route held, as `routeKey` -> one-way miles. Small (a few hundred rows). */
export async function loadRoadMiles(db: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const r = await db.query(`select from_key, resort_id, miles from drive_routes`);
    for (const x of r.rows as Array<{ from_key: string; resort_id: string; miles: string | number }>) {
      out.set(`${x.from_key}|${x.resort_id}`, Number(x.miles));
    }
  } catch { /* no table yet: every drive uses the estimate */ }
  return out;
}

export type Fetcher = (from: RoutePoint, to: RoutePoint) => Promise<number | null>;
export interface RouteWant { from: RoutePoint; to: RoutePoint; resortId: string }

/**
 * Looks up and keeps any wanted route not held yet. One request at a time,
 * a second apart (the service's rule). Returns how many were added. A route
 * the map can't answer is skipped, not stored, so it's asked again later.
 */
export async function ensureRoadMiles(
  db: Db, wants: RouteWant[], fetcher: Fetcher = osrmMiles, opts: { pauseMs?: number; straightMiles?: (w: RouteWant) => number } = {},
): Promise<number> {
  const held = await loadRoadMiles(db);
  const seen = new Set<string>();
  const todo = wants.filter((w) => {
    const k = routeKey(w.from, w.resortId);
    if (held.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let added = 0;
  for (const [i, w] of todo.entries()) {
    if (i > 0 && (opts.pauseMs ?? 1100) > 0) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1100));
    const miles = await fetcher(w.from, w.to);
    if (miles === null) continue;
    const straight = opts.straightMiles?.(w);
    if (straight && (miles < straight * 0.95 || miles > straight * MAX_DETOUR)) continue;
    try {
      await db.query(
        `insert into drive_routes (from_key, resort_id, miles, source) values ($1,$2,$3,'osrm')
         on conflict (from_key, resort_id) do nothing`, [pointKey(w.from), w.resortId, miles]);
      added++;
    } catch { return added; }   // no table yet
  }
  return added;
}
