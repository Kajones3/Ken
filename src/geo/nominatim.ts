/**
 * OpenStreetMap Nominatim — free, keyless geocoding. Its usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/) requires a
 * real identifying User-Agent, attribution, and caching results rather than
 * re-querying the same thing — the caching half lives in src/geo/cache.ts,
 * which every caller is expected to go through instead of calling this
 * provider directly. Written to the documented request shape; like every
 * other real provider in this codebase, not run against live traffic from
 * this environment (network here is proxied/restricted) — verify it
 * resolves on the first real deploy.
 */
import type { GeocodeProvider, GeocodeResult } from "./types.js";

const USER_AGENT = "Parkfare/1.0 (+https://github.com/kajones3/ken; trip cost comparator, low volume)";

export class NominatimGeocodeProvider implements GeocodeProvider {
  readonly name = "nominatim";
  async search(query: string): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (!q) return [];
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    // Driving mode only ever prices a real option to a US domestic resort
    // (pricing.ts refuses non-"dom" regions outright), and Nominatim's
    // freeform "q" already matches US ZIP codes the same way it matches
    // city names — a 5-digit ZIP is a real, unambiguous alternative to a
    // city name someone might type inconsistently ("New York City" vs.
    // "New York"). Biasing to the US keeps a bare ZIP from ever resolving
    // to some other country's postal system, and keeps city-name results
    // from ever landing outside the country driving mode is scoped to.
    url.searchParams.set("countrycodes", "us");
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }
}
