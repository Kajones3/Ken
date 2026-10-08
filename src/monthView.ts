/**
 * "Best months to go": one typical whole-trip total per plannable month, per
 * resort. Plus (owner, 2026-10-08), replacing the day-by-day trip price
 * calendar.
 *
 * Why months and not days: a flight estimate is one number per route per
 * QUARTER (the government fare survey is quarterly), every paid fare departs
 * on the 15th, and an off-property hotel is one sampled night per month. So
 * a per-day total mostly wiggled with the hotel season curve, plus a few
 * spikes where we happen to hold a real fare. A dollar figure on every day
 * read as advice ("Tuesday is $40 cheaper") that the data could not back.
 * A month is the finest grain where every input means something.
 *
 * Each month is priced exactly the way the board prices a month: typicalIn()
 * over every arrival day, the quoted total being a real day near the trimmed
 * average. So the March tile and the board's March total are the same number.
 *
 * Pure, no I/O, like pricing.ts.
 */
import { typicalIn, type Overrides, type PriceBook, type TripParams } from "./pricing.js";
import type { Resort } from "./config.js";
import type { ISODate } from "./dates.js";
import { monthBounds, range } from "./dates.js";

export type MonthLevel = "cheaper" | "typical" | "pricier";

export interface MonthQuote {
  /** "YYYY-MM" */
  month: string;
  /** The typical whole-trip total for an arrival that month (what the board would quote). */
  total: number | null;
  /** The cheapest arrival day's total that month, for "as low as". */
  cheapest: number | null;
  /** Priced as a drive because no flight price exists yet (the board's stand-in). */
  drove?: boolean;
  level: MonthLevel | null;
}

/** Within this share of the resort's own middle month counts as "typical". */
export const MONTH_TYPICAL_BAND = 0.05;

/**
 * Cheaper / typical / pricier against this resort's OWN middle month, not
 * against the other resorts: the question is "when should we go to Tokyo",
 * and Tokyo's cheapest month can still cost more than Orlando's dearest.
 * Three levels, not nine: finer shading would claim precision the monthly
 * totals do not have.
 */
export function monthLevels(totals: (number | null)[], band = MONTH_TYPICAL_BAND): (MonthLevel | null)[] {
  const priced = totals.filter((t): t is number => t !== null).sort((a, b) => a - b);
  if (!priced.length) return totals.map(() => null);
  const mid = priced.length % 2
    ? priced[(priced.length - 1) / 2]!
    : (priced[priced.length / 2 - 1]! + priced[priced.length / 2]!) / 2;
  return totals.map((t) => {
    if (t === null) return null;
    if (t < mid * (1 - band)) return "cheaper";
    if (t > mid * (1 + band)) return "pricier";
    return "typical";
  });
}

/**
 * Prices every month. `fallback`, when given, is the same trip as a drive:
 * used for a month with no flight price at all, exactly like the board's
 * stand-in for a short US hop nobody has bought a fare for yet.
 */
export function quoteMonths(
  book: PriceBook, resort: Resort, params: TripParams, overrides: Overrides,
  months: string[], fallback?: TripParams,
): MonthQuote[] {
  const rows = months.map((month) => {
    const [from, to] = monthBounds(month);
    const dates = range(from, to) as ISODate[];
    let pick = typicalIn(book, resort, params, overrides, dates);
    let drove = false;
    if (!pick.typical && fallback && pick.skipped.some((r) => /no cached fare/.test(r))) {
      const asDrive = typicalIn(book, resort, fallback, overrides, dates);
      if (asDrive.typical) { pick = asDrive; drove = true; }
    }
    return {
      month,
      total: pick.typical ? Math.round(pick.typical.total) : null,
      cheapest: pick.cheapest ? Math.round(pick.cheapest.total) : null,
      ...(drove ? { drove } : {}),
    };
  });
  const levels = monthLevels(rows.map((r) => r.total));
  return rows.map((r, i) => ({ ...r, level: levels[i]! }));
}
