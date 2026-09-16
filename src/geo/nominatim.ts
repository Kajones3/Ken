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

/**
 * Real-world evidence, both from a live "27540" postal-code search
 * (2026-09-16): Nominatim's own `countrycodes=us` request parameter does
 * NOT reliably exclude non-US matches for a bare structured `postalcode`
 * query — a first attempt then trusted `addressdetails=1`'s returned
 * `address.country_code` field instead, which *also* did not reliably
 * come back "us"-only (results in France and Poland still got through) —
 * evidently either that field isn't populated the way documented for this
 * query shape, or something else about it can't be trusted blind. Rather
 * than guess again at which part of Nominatim's structured response is
 * reliable, this checks the one thing that's been correct in every example
 * seen so far, including the ones that leaked through both earlier
 * attempts: `display_name` itself always ends with the place's country,
 * in English, and every non-US result observed ended in that country's own
 * name ("...Ivry-la-Bataille... France", "...powiat opatowski... Polska"),
 * never "United States". This is a plain string check, nothing to get
 * subtly wrong about a response schema.
 */
export function isUsResult(displayName: string): boolean {
  return /\bunited states( of america)?$/i.test(displayName.trim());
}

export class NominatimGeocodeProvider implements GeocodeProvider {
  readonly name = "nominatim";
  async search(query: string): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (!q) return [];
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    // Kept as a request-side hint even though it's proven unreliable alone
    // (see isUsResult above) — costs nothing, may narrow the upstream set.
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
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows
      .filter((r) => isUsResult(r.display_name))
      .map((r) => ({ label: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }
}
