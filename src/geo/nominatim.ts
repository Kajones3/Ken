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

const US_ZIP = /^\d{5}(-\d{4})?$/;

export class NominatimGeocodeProvider implements GeocodeProvider {
  readonly name = "nominatim";
  async search(query: string): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (!q) return [];
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    // addressdetails=1 gets a structured address.country_code back on every
    // row, which is what actually gates the US-only filter below — see why.
    url.searchParams.set("addressdetails", "1");
    // Driving mode only ever prices a real option to a US domestic resort
    // (pricing.ts refuses non-"dom" regions outright), so every lookup asks
    // to be biased to the US. Found live (2026-09-16) that this request-side
    // restriction is NOT reliable for a bare postal-code search specifically:
    // a real "27540" postalcode lookup with countrycodes=us set still
    // returned matches in Ukraine, Spain, and France alongside the real
    // Holly Springs, NC result — plenty of countries reuse 5-digit postal
    // formats, and Nominatim's own countrycodes filter evidently doesn't
    // bind tightly enough to a structured postalcode-only query to exclude
    // them. countrycodes stays set (it costs nothing and may narrow the
    // upstream result set even if imperfectly), but it is NOT trusted alone
    // — every row is filtered again below using its own returned
    // address.country_code, which is the one thing in the response that
    // actually says what country a result is in.
    url.searchParams.set("countrycodes", "us");
    // The "Driving from" field only ever asks for a ZIP now (city names were
    // dropped — ambiguous: multiple towns share a name across states, and
    // OpenStreetMap's own naming for a place like New York City can surprise
    // people). Nominatim's structured `postalcode` search targets postal
    // boundaries directly, which is more precise than its freeform `q` for
    // a ZIP specifically — `q` has to first guess whether a string of digits
    // is a postcode, a street number, or something else. Per Nominatim's own
    // docs, `postalcode` and `q` are mutually exclusive in one request, so
    // this always picks exactly one. Anything not shaped like a ZIP still
    // falls back to freeform `q` — defensive only; the UI itself never sends
    // that path today.
    if (US_ZIP.test(q)) {
      url.searchParams.set("postalcode", q.slice(0, 5));
    } else {
      url.searchParams.set("q", q);
    }
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const rows = (await res.json()) as {
      display_name: string; lat: string; lon: string; address?: { country_code?: string };
    }[];
    return rows
      .filter((r) => (r.address?.country_code ?? "").toLowerCase() === "us")
      .map((r) => ({ label: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }
}
