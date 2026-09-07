/**
 * Generates plausible prices with no account and no network. Everything is
 * deterministic, so two runs produce identical data and tests are stable.
 * Swap for the Travelpayouts adapter when you have a token — nothing else changes.
 */
import { ORIGIN_BY_IATA, RESORT_BY_ID } from "../config.js";
import { monthBounds, range } from "../dates.js";
import { hotelSeasonFactor, jitter, seasonOf } from "../seasonality.js";
import type { FlightQuote, HotelQuote, Provider } from "./types.js";

function haversine(a1: number, o1: number, a2: number, o2: number): number {
  const R = 3958.8, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(a2 - a1), dLon = rad(o2 - o1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const CARRIERS: Record<string, string[]> = {
  wdw: ["Delta", "Southwest", "JetBlue"], dlr: ["Alaska", "United", "Southwest"],
  dlp: ["Air France", "Delta", "Norse Atlantic"], tdr: ["ANA", "Japan Airlines", "United"],
  shdr: ["China Eastern", "United", "Delta"], hkdl: ["Cathay Pacific", "United", "Delta"],
};

export class MockProvider implements Provider {
  readonly name = "mock";

  async flightMonth(origin: string, destination: string, month: string, tripLength: number): Promise<FlightQuote[]> {
    const o = ORIGIN_BY_IATA.get(origin);
    // Matches the resort by its primary airport OR any alternate (e.g. TPA
    // for WDW) — the resort's own lat/lon/region/season still drive the
    // generated price, only the airport code differs.
    const resort = [...RESORT_BY_ID.values()].find((r) =>
      r.iata === destination || r.altArrivalAirports.some((a) => a.iata === destination));
    if (!o || !resort) return [];
    const dist = haversine(o.lat, o.lon, resort.lat, resort.lon);
    const base = resort.region === "dom" ? 78 + dist * 0.082
      : resort.region === "atl" ? 245 + dist * 0.062
      : 330 + dist * 0.058;
    const floorPrice = resort.region === "dom" ? 98 : 420;
    const carriers = CARRIERS[resort.id] ?? ["Delta"];

    const [from, to] = monthBounds(month);
    return range(from, to).map((date) => {
      const s = seasonOf(resort.id, date).m;
      const seasonAdj = 1 + (s - 1) * 0.72;
      const j = 1 + jitter(origin + resort.id + date) * 0.07;
      const price = Math.max(floorPrice, base * seasonAdj * j);
      const nonstop = dist < 1350;
      return {
        origin, destination, departDate: date, tripLength,
        priceUsd: Math.round(price * 100) / 100,
        carrier: carriers[Math.abs(Math.round(jitter(date + origin) * 100)) % carriers.length]!,
        stops: nonstop ? 0 : 1,
        deepLink: `https://www.google.com/travel/flights?q=${origin}+to+${destination}+${date}`,
      } satisfies FlightQuote;
    });
  }

  async hotelMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) return [];
    const [from, to] = monthBounds(month);
    const out: HotelQuote[] = [];
    for (const date of range(from, to)) {
      const f = hotelSeasonFactor(resortId, date);
      for (const h of resort.hotels) {
        out.push({
          hotelId: h.id, resortId, hotelName: h.name, descriptor: h.descriptor,
          stayDate: date, nightlyUsd: Math.round(h.base * f * 100) / 100,
          tier: h.tier, onProperty: h.onProperty,
          deepLink: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(h.name)}&checkin=${date}`,
        });
      }
    }
    return out;
  }
}
