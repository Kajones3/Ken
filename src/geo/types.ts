/**
 * Geocoding a free-typed city, and a best-effort "where is this request
 * coming from" IP lookup. Both back the driving-mode "Departing from"
 * search box — this is the one place the app calls an external provider
 * live, on a user's request, rather than reading a pre-refreshed cache.
 * See src/geo/pick.ts and CLAUDE.md for why that's a deliberate, disclosed
 * exception to the project's "users never call a provider API" rule.
 */
export interface GeocodeResult { label: string; lat: number; lon: number }
export interface GeocodeProvider {
  readonly name: string;
  search(query: string): Promise<GeocodeResult[]>;
}

export interface IpLocateResult { label: string; lat: number; lon: number }
export interface IpLocateProvider {
  readonly name: string;
  locate(ip: string): Promise<IpLocateResult | null>;
}
