/**
 * Real round-trip fares via SerpApi's Google Flights API.
 *
 * Why this exists alongside providers/travelpayouts.ts, rather than
 * replacing it outright: the two answer different questions, and only one
 * of them answers ours.
 *
 * Travelpayouts' /v1/prices/calendar is a "cheapest fares our users
 * recently found" feed. Verified against the live key (2026-09-09), a
 * request for ATL->MCO, depart 2027-03, trip_duration=7 came back with:
 * six dates, none of them in March 2027 (they were in Sep/Oct 2026);
 * destination "ORL", the city, not the MCO airport that was asked for;
 * durations of 0, 2 and 3 nights against the 7 requested; and prices of
 * $36-$200 with an `expires_at` one hour out. It cannot be asked for a
 * specific date, so almost everything it returns is correctly discarded,
 * and the months people actually search end up empty.
 *
 * Google Flights, same route and dates, returns the dates asked for, the
 * airports asked for, `"type": "Round trip"`, and real carriers and
 * durations. It is metered per search, so the nightly job spends it only
 * on the routes people actually search (see routeDemand.ts) — every other
 * route is estimated from its BTS median, moved by the trend these real
 * fares measure.
 *
 * PRICE SEMANTICS, which are easy to get backwards and expensive if you
 * do: this adapter always queries `adults=1`, so the number it returns is
 * a ONE-ADULT round-trip fare. pricing.ts multiplies a per-seat fare by
 * the traveller count itself, so passing a party-of-N total through here
 * would multiply the party size in twice. Do not "optimise" this by
 * asking for the real party size.
 */
import type { FlightQuote } from "./types.js";

const BASE = "https://serpapi.com/search.json";

interface SerpApiFlight {
  price?: number;
  type?: string;
  total_duration?: number;
  flights?: { airline?: string; flight_number?: string }[];
  layovers?: unknown[];
}
interface SerpApiFlightsResponse {
  best_flights?: SerpApiFlight[];
  other_flights?: SerpApiFlight[];
  price_insights?: { lowest_price?: number; typical_price_range?: number[] };
  error?: string;
}

/** SerpApi's plans cap throughput per hour — stay well under it. */
class HourlyLimiter {
  private stamps: number[] = [];
  constructor(private readonly perHour: number) {}
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
      if (this.stamps.length < this.perHour) { this.stamps.push(now); return; }
      await new Promise((r) => setTimeout(r, 3_600_000 - (now - this.stamps[0]!) + 250));
    }
  }
}

export interface RealFare {
  priceUsd: number;
  carrier?: string;
  stops: number;
  deepLink: string;
}

export class SerpApiFlightProvider {
  readonly name = "serpapi_flights";
  private readonly limiter: HourlyLimiter;
  /** Hard ceiling on paid lookups for one process, so a loop bug or an
   *  unexpectedly long popular-route list can't quietly run up a bill. */
  private spent = 0;

  constructor(
    private readonly apiKey = process.env.SERPAPI_KEY ?? "",
    perHour = Number(process.env.SERPAPI_MAX_PER_HOUR ?? 180),
    private readonly budget = Number(process.env.SERPAPI_FLIGHTS_BUDGET ?? 200),
  ) {
    if (!this.apiKey) throw new Error("SERPAPI_KEY is not set");
    this.limiter = new HourlyLimiter(perHour);
  }

  get callsSpent(): number { return this.spent; }
  get budgetRemaining(): number { return Math.max(0, this.budget - this.spent); }

  /**
   * One real round-trip fare for one exact date pair. Returns null rather
   * than throwing on a route Google has nothing for — a missing fare is an
   * ordinary outcome here, and the caller falls back to the BTS estimate.
   */
  async roundTrip(
    origin: string, destination: string, departDate: string, nights: number,
  ): Promise<RealFare | null> {
    if (this.spent >= this.budget) return null;
    const returnDate = new Date(new Date(departDate + "T00:00:00Z").getTime() + nights * 86_400_000)
      .toISOString().slice(0, 10);

    const url = new URL(BASE);
    for (const [k, v] of Object.entries({
      engine: "google_flights",
      departure_id: origin,
      arrival_id: destination,
      outbound_date: departDate,
      return_date: returnDate,
      currency: "USD",
      hl: "en",
      gl: "us",
      type: "1",          // round trip
      adults: "1",        // see PRICE SEMANTICS above — never the real party size
      api_key: this.apiKey,
    })) url.searchParams.set(k, v);

    await this.limiter.take();
    this.spent++;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`google_flights ${origin}-${destination} ${departDate} -> ${res.status}`);
    const json = (await res.json()) as SerpApiFlightsResponse;
    if (json.error) return null;   // "no flights found" is reported as an error string

    const all = [...(json.best_flights ?? []), ...(json.other_flights ?? [])]
      .filter((f) => Number.isFinite(f.price) && (f.price as number) > 0);
    if (!all.length) return null;

    // The cheapest genuinely round-trip itinerary. `price_insights.
    // lowest_price` is deliberately NOT used as the headline: it can
    // reflect a fare that isn't in the returned itinerary list at all, so
    // it produces exactly the "shown $200, click through to $700" gap this
    // whole change exists to close.
    const roundTrips = all.filter((f) => !f.type || /round/i.test(f.type));
    const pick = (roundTrips.length ? roundTrips : all)
      .reduce((a, b) => ((a.price as number) <= (b.price as number) ? a : b));

    return {
      priceUsd: pick.price as number,
      carrier: pick.flights?.[0]?.airline,
      stops: Math.max(0, (pick.flights?.length ?? 1) - 1),
      deepLink: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        `Flights from ${origin} to ${destination} on ${departDate} through ${returnDate}`,
      )}`,
    };
  }

  /** Convenience wrapper matching the FlightQuote shape the cache stores. */
  async quote(
    origin: string, destination: string, departDate: string, tripLength: number,
  ): Promise<FlightQuote | null> {
    const f = await this.roundTrip(origin, destination, departDate, tripLength);
    if (!f) return null;
    return {
      origin, destination, departDate, tripLength,
      priceUsd: f.priceUsd, carrier: f.carrier, stops: f.stops, deepLink: f.deepLink,
    };
  }
}
