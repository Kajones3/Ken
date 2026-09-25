/**
 * On-property nightly rates, generated locally from each hotel's base rate.
 *
 * Disney publishes no rate API, so these rows are ours: a hotel's base rate
 * moved by the season curve, written into `hotel_rates` alongside the
 * off-property rates a vendor really returned. Both providers were generating
 * them with identical code, which is now here once.
 *
 * THE REASON THIS MODULE EXISTS AT ALL is the owner's base rate. The admin
 * page lets the owner correct a hotel's rate, but the number a traveler sees
 * comes from `hotel_rates`, which the nightly refresh regenerates — so unless
 * the generator reads the owner's value, every correction would be silently
 * reverted the following morning, with nothing anywhere reporting it. That is
 * the same shape of failure as the `www` trap in CLAUDE.md: a setting the
 * program never reads back, so nothing can notice it stopped applying.
 *
 * `effectiveBase()` is therefore the ONE place a hotel's nightly base is
 * decided, and everything that generates a rate goes through it.
 */
import { RESORT_BY_ID, onPropertyHotelUrl, type Resort, type HotelDef } from "./config.js";
import { hotelSeasonFactor } from "./seasonality.js";
import { monthBounds, range } from "./dates.js";
import { cachedSetting } from "./settings.js";
import type { HotelQuote } from "./providers/types.js";

/** What this hotel's nightly base actually is: the owner's correction if they
 *  have made one, the shipped figure otherwise. */
export function effectiveBase(h: HotelDef): number {
  return cachedSetting(`hotel.${h.id}.base`, h.base);
}

/**
 * Every on-property night in a month, priced from the effective base.
 *
 * `which` exists because the two callers differ: the mock provider stands in
 * for a vendor and so generates off-property rooms too, while the real one
 * generates only the on-property side and buys the rest.
 */
export function onPropertyQuotes(
  resort: Resort, month: string, which: "on" | "all" = "on",
): HotelQuote[] {
  const [from, to] = monthBounds(month);
  const hotels = which === "on" ? resort.hotels.filter((h) => h.onProperty) : resort.hotels;
  const out: HotelQuote[] = [];
  for (const date of range(from, to)) {
    const f = hotelSeasonFactor(resort.id, date);
    for (const h of hotels) {
      out.push({
        hotelId: h.id, resortId: resort.id, hotelName: h.name, descriptor: h.descriptor,
        stayDate: date, nightlyUsd: Math.round(effectiveBase(h) * f * 100) / 100,
        tier: h.tier, onProperty: h.onProperty,
        deepLink: onPropertyHotelUrl(resort, h.tier),
      });
    }
  }
  return out;
}

/** Same, by resort id, for callers that only have one. */
export function onPropertyQuotesFor(resortId: string, month: string, which: "on" | "all" = "on"): HotelQuote[] {
  const resort = RESORT_BY_ID.get(resortId);
  return resort ? onPropertyQuotes(resort, month, which) : [];
}
