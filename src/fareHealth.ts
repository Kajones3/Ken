/**
 * Two checks on the flight-estimate machinery, for the owner's daily email
 * and the coverage report (2026-09-29).
 *
 * Both exist because of the same failure. Every domestic estimate ran at half
 * a round trip for weeks, and the coverage report printed "SUSPICIOUS — $204
 * vs $390" on 2026-09-22, but only in a report somebody has to run by hand.
 * Meanwhile the nightly correction printed "trend skipped" every night since
 * 2026-09-09 and nobody saw that either. A number that is wrong by half still
 * looks like a perfectly good number, so the warning has to come to the owner
 * rather than wait to be found.
 */
import type { Db } from "./db.js";

/** BTS's published average domestic itinerary fare, in recent years. */
export const BTS_PUBLISHED_AVG_USD = 390;
/** Outside these, our own average is off by something like a factor of two. */
export const BASIS_LOW_USD = 260;
export const BASIS_HIGH_USD = 620;
/** The correction is recomputed nightly; a week without one is worth a line. */
export const TREND_STALE_DAYS = 7;

export interface NationalAverage { avg: number; routes: number; passengers: number }

/** Our own passenger-weighted average across every BTS route we hold. */
export async function nationalBtsAverage(db: Db): Promise<NationalAverage | null> {
  try {
    const { rows } = await db.query<{ avg: string | null; routes: string; pax: string | null }>(
      `select sum(avg_fare_usd * passengers_sampled) / nullif(sum(passengers_sampled), 0) as avg,
              count(*) as routes, sum(passengers_sampled) as pax
         from historical_fares
        where source = 'bts_db1b' and avg_fare_usd > 0 and passengers_sampled > 0`,
    );
    const avg = rows[0]?.avg == null ? NaN : Number(rows[0].avg);
    if (!Number.isFinite(avg)) return null;
    return { avg, routes: Number(rows[0]!.routes), passengers: Number(rows[0]!.pax ?? 0) };
  } catch {
    return null;
  }
}

/** A rough comparison with a national figure: it catches a factor of two,
 *  not a few percent — our routes are leisure routes, not a national sample. */
export function basisVerdict(avg: number): "ok" | "low" | "high" {
  if (avg < BASIS_LOW_USD) return "low";
  if (avg > BASIS_HIGH_USD) return "high";
  return "ok";
}

/** Whole days since the fare trend was last recomputed; null if never. */
export async function trendAgeDays(db: Db, now = new Date()): Promise<number | null> {
  try {
    const { rows } = await db.query<{ at: Date | string | null }>(
      `select max(computed_at) as at from fare_trend where kind = 'domestic'`,
    );
    const at = rows[0]?.at;
    if (!at) return null;
    const t = at instanceof Date ? at.getTime() : Date.parse(String(at));
    return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86_400_000) : null;
  } catch {
    return null;
  }
}
