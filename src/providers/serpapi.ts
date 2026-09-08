/**
 * Off-property hotel data via SerpApi's Google Hotels API.
 *
 * On-property Disney hotels are left alone here — they're still generated
 * from the researched `base` rates in config.ts, same as the mock provider,
 * because that data is already reasonably trustworthy and a per-hotel SerpApi
 * lookup for every on-property hotel would multiply call volume for no real
 * accuracy gain (Disney doesn't discount transactionally the way a random
 * off-property chain hotel does).
 *
 * Off-property is the part CLAUDE.md flags as the weakest line, so this is
 * where real data goes: one area search ("hotels near <resort>") per resort
 * per month, not one call per hotel — Google Hotels only prices one specific
 * stay per call (unlike the flight calendar endpoint, which returns a whole
 * month for one call), so the single sampled price is projected across every
 * day of the month using the same seasonal curve the mock data already uses.
 * That means day-to-day variation is still approximate, but the level it's
 * anchored to is a real price instead of a guess.
 *
 * Written to SerpApi's documented Google Hotels response shape, verified
 * against one real key during development (not load-tested) — same caveat
 * as every other real provider in this project.
 */
import { RESORT_BY_ID } from "../config.js";
import { monthBounds, range, addDaysISO } from "../dates.js";
import { hotelSeasonFactor } from "../seasonality.js";
import type { HotelQuote } from "./types.js";

const BASE = "https://serpapi.com/search.json";

interface SerpApiProperty {
  name: string;
  property_token?: string;
  link?: string;
  gps_coordinates?: { latitude: number; longitude: number };
  extracted_hotel_class?: number;
  rate_per_night?: { extracted_lowest?: number; extracted_before_taxes_fees?: number };
  extracted_price?: number;
}

/** SerpApi's Starter plan caps throughput at 200/hour — stay well under that. */
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

function tierFromClass(hotelClass: number | undefined): "budget" | "mid" | "upscale" {
  if (hotelClass === undefined) return "mid";
  if (hotelClass <= 2) return "budget";
  if (hotelClass === 3) return "mid";
  return "upscale";
}

export class SerpApiHotelProvider {
  private readonly limiter: HourlyLimiter;

  constructor(
    private readonly apiKey = process.env.SERPAPI_KEY ?? "",
    perHour = Number(process.env.SERPAPI_MAX_PER_HOUR ?? 180),
  ) {
    if (!this.apiKey) throw new Error("SERPAPI_KEY is not set");
    this.limiter = new HourlyLimiter(perHour);
  }

  /**
   * On-property Disney hotels stay estimate-based (see file header) — real
   * off-property data gets combined with them here so this method drops
   * straight into the Provider interface's hotelMonth slot.
   */
  async hotelMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const [onProperty, offProperty] = await Promise.all([
      this.onPropertyMonth(resortId, month),
      this.offPropertyMonth(resortId, month),
    ]);
    return [...onProperty, ...offProperty];
  }

  private onPropertyMonth(resortId: string, month: string): HotelQuote[] {
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) return [];
    const [from, to] = monthBounds(month);
    const out: HotelQuote[] = [];
    for (const date of range(from, to)) {
      const f = hotelSeasonFactor(resortId, date);
      for (const h of resort.hotels.filter((h) => h.onProperty)) {
        out.push({
          hotelId: h.id, resortId, hotelName: h.name, descriptor: h.descriptor,
          stayDate: date, nightlyUsd: Math.round(h.base * f * 100) / 100,
          tier: h.tier, onProperty: true,
          deepLink: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(h.name)}&checkin=${date}`,
        });
      }
    }
    return out;
  }

  /**
   * One real query for the month: a 4-night stay starting mid-month. Returns
   * up to 10 off-property properties, each anchored to that one real price
   * and then projected across every day of the month via the season curve.
   */
  private async offPropertyMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) return [];
    const [from] = monthBounds(month);
    const sampleCheckIn = addDaysISO(from, 13);
    const sampleCheckOut = addDaysISO(sampleCheckIn, 4);

    const url = new URL(BASE);
    url.searchParams.set("engine", "google_hotels");
    url.searchParams.set("q", `hotels near ${resort.name}`);
    url.searchParams.set("check_in_date", sampleCheckIn);
    url.searchParams.set("check_out_date", sampleCheckOut);
    url.searchParams.set("adults", "2");
    url.searchParams.set("currency", "USD");
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);

    await this.limiter.take();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`serpapi hotels ${resortId} ${month} -> ${res.status} ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as { properties?: SerpApiProperty[] };
    const properties = json?.properties ?? [];

    const anchors = properties.slice(0, 10)
      .map((p) => {
        const nightly = p.rate_per_night?.extracted_before_taxes_fees
          ?? p.rate_per_night?.extracted_lowest
          ?? p.extracted_price;
        if (!nightly || nightly <= 0) return null;
        return {
          hotelId: `serp-${p.property_token ?? p.name}`,
          hotelName: p.name,
          descriptor: "Off property",
          tier: tierFromClass(p.extracted_hotel_class),
          deepLink: p.link,
          anchorNightly: nightly,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const anchorFactor = hotelSeasonFactor(resortId, sampleCheckIn);
    const [monthFrom, monthTo] = monthBounds(month);
    const out: HotelQuote[] = [];
    for (const date of range(monthFrom, monthTo)) {
      const f = hotelSeasonFactor(resortId, date);
      for (const a of anchors) {
        out.push({
          hotelId: a.hotelId, resortId, hotelName: a.hotelName, descriptor: a.descriptor,
          stayDate: date, nightlyUsd: Math.round((a.anchorNightly / anchorFactor) * f * 100) / 100,
          tier: a.tier, onProperty: false, deepLink: a.deepLink,
        });
      }
    }
    return out;
  }
}
