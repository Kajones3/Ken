/**
 * Deterministic, no-network stand-ins for geocoding and IP lookup — same
 * "no account needed" pattern as MockProvider/MockGasProvider. A typed city
 * name gets a plausible continental-US point derived from a hash of the
 * text, not a real geocode; good enough to exercise the driving-mode path
 * in tests/dev without a live Nominatim/ip-api call.
 */
import { jitter } from "../seasonality.js";
import type { GeocodeProvider, GeocodeResult, IpLocateProvider, IpLocateResult } from "./types.js";

function pointFor(seed: string): { lat: number; lon: number } {
  const lat = 39 + jitter(`geo:lat:${seed}`) * 8;   // roughly continental-US spread
  const lon = -98 + jitter(`geo:lon:${seed}`) * 20;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

export class MockGeocodeProvider implements GeocodeProvider {
  readonly name = "mock";
  async search(query: string): Promise<GeocodeResult[]> {
    const q = query.trim();
    if (!q) return [];
    return [{ label: q, ...pointFor(q.toLowerCase()) }];
  }
}

export class MockIpLocateProvider implements IpLocateProvider {
  readonly name = "mock";
  async locate(ip: string): Promise<IpLocateResult | null> {
    if (!ip) return null;
    return { label: "Atlanta, Georgia", ...pointFor(`ip:${ip}`) };
  }
}
