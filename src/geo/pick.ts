/**
 * Neither Nominatim nor ip-api needs an account or API key — unlike every
 * other real provider in this codebase, there's no key to gate on. Default
 * to mock anyway (same "no live calls unless deliberately turned on" rule
 * as everywhere else) so tests, smoke, and local dev never depend on this
 * environment's network reaching two more third-party services. Set
 * GEOCODE_LIVE=true to use the real ones.
 */
import type { GeocodeProvider, IpLocateProvider } from "./types.js";
import { MockGeocodeProvider, MockIpLocateProvider } from "./mock.js";
import { NominatimGeocodeProvider } from "./nominatim.js";
import { IpApiLocateProvider } from "./ipapi.js";

const live = process.env.GEOCODE_LIVE === "true";

export function pickGeocodeProvider(): GeocodeProvider {
  return live ? new NominatimGeocodeProvider() : new MockGeocodeProvider();
}
export function pickIpLocateProvider(): IpLocateProvider {
  return live ? new IpApiLocateProvider() : new MockIpLocateProvider();
}
