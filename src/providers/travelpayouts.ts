/**
 * Real adapter. Needs TRAVELPAYOUTS_TOKEN and TRAVELPAYOUTS_MARKER.
 *
 * Two things this class is responsible for and the rest of the app is not:
 *   1. staying under the published per-minute rate limit, and
 *   2. backing off on a 429 instead of hammering.
 *
 * Verify the endpoint shapes against current Travelpayouts docs before relying
 * on this in production — response formats change and this was written to the
 * documented shape, not against a live key.
 */
import { RESORT_BY_ID } from "../config.js";
import { monthBounds, range } from "../dates.js";
import type { FlightQuote, HotelQuote, Provider } from "./types.js";

const BASE = "https://api.travelpayouts.com";

class RateLimiter {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number) {}
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) { this.stamps.push(now); return; }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.stamps[0]!) + 50));
    }
  }
}

export class TravelpayoutsProvider implements Provider {
  readonly name = "travelpayouts";
  private readonly limiter: RateLimiter;

  constructor(
    private readonly token = process.env.TRAVELPAYOUTS_TOKEN ?? "",
    private readonly marker = process.env.TRAVELPAYOUTS_MARKER ?? "",
    perMinute = Number(process.env.MAX_REQUESTS_PER_MINUTE ?? 240),
  ) {
    if (!this.token) throw new Error("TRAVELPAYOUTS_TOKEN is not set");
    this.limiter = new RateLimiter(perMinute);
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.limiter.take();
      const res = await fetch(url, { headers: { "X-Access-Token": this.token } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
        continue;
      }
      if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text().catch(() => "")}`);
      return res.json();
    }
    throw new Error(`${path}: rate limited after 5 attempts`);
  }

  async flightMonth(origin: string, destination: string, month: string, tripLength: number): Promise<FlightQuote[]> {
    const json = await this.get("/v1/prices/calendar", {
      origin, destination, depart_date: month, currency: "usd",
      calendar_type: "departure_date", trip_duration: String(tripLength), token: this.token,
    });
    const data = (json?.data ?? {}) as Record<string, any>;
    const out: FlightQuote[] = [];
    for (const [date, v] of Object.entries(data)) {
      const price = Number(v?.price);
      if (!Number.isFinite(price) || price <= 0) continue;      // never write junk into the cache
      // This endpoint does not reliably honor depart_date/trip_duration — it
      // can hand back fares for a completely different month, or a trip
      // length nowhere near what was asked for, without any error. Trusting
      // those blindly wrote real-looking but wrong prices under the wrong
      // date/trip-length label (verified 2026-09-08: a request for one exact
      // date came back with the identical sample of unrelated dates months
      // away, every time). Only keep a row if it's actually the date
      // requested and within one night of the requested trip length — a
      // wider ±3 tolerance was tried and reverted (2026-09-09): it let a
      // real fare for a genuinely shorter trip (e.g. 4 nights) get stored
      // and displayed as if it were the price for a longer one (e.g. 7
      // nights), silently understating the total by a lot, since nothing
      // downstream records or discloses that the real duration differed.
      // A route/date this tight a tolerance can't match now falls through
      // to the BTS-baseline estimate (src/jobs/fareTrend.ts, book.ts's
      // flightEstimate) instead — an honestly-labeled estimate beats a
      // silently-wrong real-looking number. Also require departure_at/
      // return_at to actually be present: a row missing both used to be
      // kept on faith with no duration check at all, looser than even the
      // old ±3 window.
      if (!date.startsWith(month)) continue;
      if (!v?.departure_at || !v?.return_at) continue;
      const nights = Math.round(
        (new Date(v.return_at).getTime() - new Date(v.departure_at).getTime()) / 86_400_000,
      );
      if (Math.abs(nights - tripLength) > 1) continue;
      out.push({
        origin, destination, departDate: date, tripLength, priceUsd: price,
        carrier: v?.airline ? String(v.airline) : undefined,
        stops: Number(v?.transfers ?? 0),
        deepLink: `https://www.aviasales.com/search/${origin}${date.slice(8, 10)}${date.slice(5, 7)}${destination}1?marker=${this.marker}`,
      });
    }
    return out;
  }

  /**
   * Hotel rates. Travelpayouts exposes hotel search through its Hotellook
   * brands; wire the endpoint you are approved for here. Until then this
   * throws loudly rather than silently returning nothing, so a half-configured
   * deployment fails at the refresh job instead of showing users empty results.
   */
  async hotelMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) return [];
    void monthBounds(month); void range;
    throw new Error(
      "TravelpayoutsProvider.hotelMonth is not wired yet. Connect your approved " +
      "Hotellook endpoint, or run with the mock provider while you wait for approval.",
    );
  }
}
