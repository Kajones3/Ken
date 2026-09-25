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
import { monthBounds, range, addDaysISO, todayISO, type ISODate } from "../dates.js";
import { hotelSeasonFactor } from "../seasonality.js";
import { onPropertyQuotesFor } from "../onProperty.js";
import type { HotelQuote } from "./types.js";

const BASE = "https://serpapi.com/search.json";

/** How many nights the sampled stay covers. */
const SAMPLE_NIGHTS = 4;

/**
 * Which night to price for a given month, or null if the month has no
 * priceable night left.
 *
 * Mid-month (the 14th) is the ideal: away from both edges, so it represents
 * the month rather than its boundary. But Google Hotels rejects a check-in
 * date in the past — `check_in_date cannot be in the past` — and the old code
 * asked for the 14th unconditionally. From the 15th of any month onward that
 * made the current month's lookup a guaranteed 400, for all six resorts, and
 * the budget counter charged for each one because it counts before the call.
 * Six of eight nightly lookups were being thrown away roughly half of every
 * month.
 *
 * So: mid-month when mid-month is still ahead of us, otherwise the soonest
 * night we can actually book, and null once even tomorrow has left the month
 * behind. Exported because the rotation must apply the same rule when it
 * decides what is worth a slot — a slot handed to an unpriceable month is a
 * slot wasted, which is the bug over again one level up.
 */
export function sampleCheckIn(month: string, today: ISODate = todayISO()): ISODate | null {
  const [first, last] = monthBounds(month);
  const midMonth = addDaysISO(first, 13);
  const soonest = addDaysISO(today, 1);
  const pick = midMonth > soonest ? midMonth : soonest;
  return pick > last ? null : pick;
}

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

/**
 * FIXED 2026-09-25 (owner's report, with a real screenshot): off-property
 * "Budget" was coming back pricier than "Mid-range" and "Upscale" — $377/night
 * for Budget against $141 for Mid-range on the same six nights, which is
 * backwards on its face.
 *
 * The old rule assigned a tier from Google's `extracted_hotel_class` (star
 * rating, 1-5) alone: class <=2 -> budget, 3 -> mid, undefined -> mid,
 * everything else -> upscale. Star class is a weak, sparse signal for what a
 * property actually costs on one sampled night — a small independent motel
 * with no class rating at all can spike on a busy weekend, while a plain
 * business hotel with a "3-star" rating sits at a normal rate, and a
 * generic "hotels near <resort>" search often returns only one or two
 * lower-class properties among ten, so a single outlier owned the whole
 * "budget" bucket with nothing to average it against.
 *
 * The fix: rank what SerpApi actually returned BY PRICE and assign tiers
 * from that ranking, same as the model already treats every other tier
 * (a category median with real per-hotel spread around it — see CLAUDE.md).
 * This guarantees budget <= mid <= upscale for these anchors by
 * construction, which star class never did, and it is the more honest
 * signal anyway: what a property actually costs, not an unrelated rating.
 */
function tiersByPrice<T extends { anchorNightly: number }>(
  anchors: T[],
): (T & { tier: "budget" | "mid" | "upscale" })[] {
  const sorted = [...anchors].sort((a, b) => a.anchorNightly - b.anchorNightly);
  const n = sorted.length;
  return sorted.map((a, i) => {
    const third = Math.floor((i * 3) / n);
    const tier = third <= 0 ? "budget" : third === 1 ? "mid" : "upscale";
    return { ...a, tier };
  });
}

export class SerpApiHotelProvider {
  /** Recorded in hotel_rates.source, so a rate this vendor really returned is
   *  distinguishable from one the mock provider invented. */
  readonly name = "serpapi_hotels";
  private readonly limiter: HourlyLimiter;
  /** Hard ceiling on paid lookups for one process, so a loop bug or an
   *  unexpectedly long month list can't quietly run up a bill. The hourly
   *  limiter alone only paces spending — it never stops it. Mirrors
   *  SerpApiFlightProvider's budget; both fail closed. */
  private spent = 0;
  private budgetWarned = false;

  constructor(
    private readonly apiKey = process.env.SERPAPI_KEY ?? "",
    perHour = Number(process.env.SERPAPI_MAX_PER_HOUR ?? 180),
    private readonly budget = Number(process.env.SERPAPI_HOTELS_BUDGET ?? 200),
    /** `resortId|month` keys this run is allowed to pay for, from
     *  jobs/hotelRotation.ts. Null means no rotation — spend on anything,
     *  up to the budget, which is the old behavior. */
    private readonly paidSlots: ReadonlySet<string> | null = null,
    private readonly today: ISODate = todayISO(),
  ) {
    if (!this.apiKey) throw new Error("SERPAPI_KEY is not set");
    this.limiter = new HourlyLimiter(perHour);
  }

  get callsSpent(): number { return this.spent; }
  get budgetRemaining(): number { return Math.max(0, this.budget - this.spent); }

  /**
   * On-property Disney hotels stay estimate-based (see file header) — real
   * off-property data gets combined with them here so this method drops
   * straight into the Provider interface's hotelMonth slot.
   *
   * on-property is free, local, and needs no network call, so a SerpApi
   * failure (quota exhausted, rate limited, outage) must not cost it too.
   * Before this, Promise.all failed the whole call on any off-property
   * error, which meant a single 429 silently stopped *even the reliable
   * on-property estimate* from refreshing — discovered when a real account
   * ran out of searches and every resort's hotel refresh came back empty,
   * including Disney's own on-property rates that had no reason to fail.
   * Off-property degrades to whatever is already cached (refresh only
   * upserts on success) rather than the whole resort/month getting nothing.
   */
  async hotelMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const onProperty = this.onPropertyMonth(resortId, month);
    let offProperty: HotelQuote[] = [];
    try {
      offProperty = await this.offPropertyMonth(resortId, month);
    } catch (e) {
      console.error(`serpapi off-property hotels ${resortId} ${month}:`, (e as Error).message);
    }
    return [...onProperty, ...offProperty];
  }

  private onPropertyMonth(resortId: string, month: string): HotelQuote[] {
    return onPropertyQuotesFor(resortId, month, "on");
  }

  /**
   * One real query for the month: a 4-night stay starting mid-month. Returns
   * up to 10 off-property properties, each anchored to that one real price
   * and then projected across every day of the month via the season curve.
   */
  private async offPropertyMonth(resortId: string, month: string): Promise<HotelQuote[]> {
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) return [];
    // Is this resort/month one of tonight's paid slots? When the caller has
    // handed us a rotation, everything outside it is on-property only — no
    // spend, no call. A null slot set means "no rotation in play" (a test, a
    // one-off script), and every month is fair game as before.
    if (this.paidSlots && !this.paidSlots.has(`${resortId}|${month}`)) return [];
    // Budget before anything else: an exhausted budget degrades to whatever
    // off-property rates are already cached (refresh upserts on success
    // only), exactly like a 429 does. On-property is unaffected either way.
    if (this.spent >= this.budget) {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        console.warn(
          `serpapi hotels: budget of ${this.budget} lookups is spent — ` +
          `off-property falls back to cached rates for the rest of this run`,
        );
      }
      return [];
    }
    const checkIn = sampleCheckIn(month, this.today);
    // Nothing left to price in this month (we are past its last night), so
    // there is no question worth paying to ask.
    if (!checkIn) return [];
    const sampleCheckOut = addDaysISO(checkIn, SAMPLE_NIGHTS);

    const url = new URL(BASE);
    url.searchParams.set("engine", "google_hotels");
    url.searchParams.set("q", `hotels near ${resort.name}`);
    url.searchParams.set("check_in_date", checkIn);
    url.searchParams.set("check_out_date", sampleCheckOut);
    url.searchParams.set("adults", "2");
    url.searchParams.set("currency", "USD");
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);

    await this.limiter.take();
    // Counted before the call, not after: SerpApi bills for a search that
    // errors or finds nothing, so charging only successes would make a
    // failing route a free infinite retry. Same rule as exactFare.ts.
    this.spent++;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`serpapi hotels ${resortId} ${month} -> ${res.status} ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as { properties?: SerpApiProperty[] };
    const properties = json?.properties ?? [];

    const rawAnchors = properties.slice(0, 10)
      .map((p) => {
        const nightly = p.rate_per_night?.extracted_before_taxes_fees
          ?? p.rate_per_night?.extracted_lowest
          ?? p.extracted_price;
        if (!nightly || nightly <= 0) return null;
        return {
          hotelId: `serp-${p.property_token ?? p.name}`,
          hotelName: p.name,
          descriptor: "Off property",
          deepLink: p.link,
          anchorNightly: nightly,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
    // Tiered by price, not star class — see tiersByPrice()'s doc comment for
    // why: it guarantees budget <= mid <= upscale, which star class did not.
    const anchors = tiersByPrice(rawAnchors);

    const anchorFactor = hotelSeasonFactor(resortId, checkIn);
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
