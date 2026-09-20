/**
 * Generates plausible prices with no account and no network. Everything is
 * deterministic, so two runs produce identical data and tests are stable.
 * Swap for the Travelpayouts adapter when you have a token — nothing else changes.
 */
import { ORIGIN_BY_IATA, RESORT_BY_ID } from "../config.js";
import { monthBounds, range } from "../dates.js";
import { haversineMiles } from "../geo.js";
import { jitter, seasonOf } from "../seasonality.js";
import { onPropertyQuotesFor } from "../onProperty.js";
import type { FlightQuote, HotelQuote, Provider } from "./types.js";

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
    const dist = haversineMiles(o.lat, o.lon, resort.lat, resort.lon);
    // Coefficients fit against researched 2026 market averages (see README
    // "How a flight number is arrived at"): US->Europe ~$754 median,
    // US->Asia ~$1,087 median, at each region's typical US-origin distance.
    // The old atl/pac coefficients (245+dist*0.062, 330+dist*0.058, floor
    // 420) undershot real fares by roughly 2x on transatlantic/transpacific
    // routes -- close enough to a domestic fare that a production deploy
    // running on mock data (no TRAVELPAYOUTS_TOKEN set) silently priced
    // Tokyo/Paris/Shanghai/Hong Kong flights at domestic-trip money.
    const base = resort.region === "dom" ? 78 + dist * 0.082
      : resort.region === "atl" ? 200 + dist * 0.124
      : 350 + dist * 0.109;
    const floorPrice = resort.region === "dom" ? 98 : resort.region === "atl" ? 550 : 700;
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
    // Standing in for a vendor, so this one generates the off-property rooms
    // too — hence "all". The rates themselves come from the same generator the
    // real provider uses, so the owner's corrections apply in both.
    return onPropertyQuotesFor(resortId, month, "all");
  }
}
