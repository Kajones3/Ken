/**
 * Turns a BTS historical baseline into a present-day estimate: how much
 * current real Travelpayouts fares differ from the BTS baseline, averaged
 * (trimmed) across whichever routes we happen to have both for right now.
 * Runs as part of the daily refresh (src/jobs/refresh.ts) — it only reads
 * Postgres, no provider call of its own, so it needs no separate schedule.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";

export interface TrendResult { multiplier: number; low: number; high: number }

/**
 * Pure math, no I/O. Sorts ratios, trims one from each end once there are
 * >=5 (to blunt one outlier route), and returns the trimmed mean plus its
 * min/max as the Low/High spread — the actual observed range of price
 * movement across real routes, not an invented percentage. Returns null
 * below 3 ratios (too thin to trust — caller should skip writing a new
 * row and keep serving the last good one). If every trimmed ratio is
 * identical (a tiny sample), widens +-10% around the mean so Low/Med/High
 * never render as three identical numbers — a deliberate, documented
 * fallback, not a second hidden algorithm.
 */
export function trimmedMultiplier(ratios: number[]): TrendResult | null {
  if (ratios.length < 3) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  const multiplier = trimmed.reduce((s, r) => s + r, 0) / trimmed.length;
  let low = trimmed[0]!;
  let high = trimmed[trimmed.length - 1]!;
  if (low === high) {
    low = multiplier * 0.9;
    high = multiplier * 1.1;
  }
  return {
    multiplier: Math.round(multiplier * 10000) / 10000,
    low: Math.round(low * 10000) / 10000,
    high: Math.round(high * 10000) / 10000,
  };
}

/**
 * kind 'domestic' measures bought fares against BTS DB1B baselines; kind
 * 'intl' measures bought international fares against the seeded
 * international guesses (2026-10-03: those read ~30% low against the first
 * real fares, and nothing was correcting them). Each moves only its own
 * baselines — see book.ts.
 */
export type TrendKind = "domestic" | "intl" | "domestic_monthly";

/**
 * kind 'domestic_monthly' (2026-10-10) measures bought fares against BTS's
 * MONTHLY survey (DB1C, historical_fares_monthly) for the same route and
 * calendar month. It moves only estimates built on a monthly row, so a
 * correction learned against a 2025 quarter is never stacked on a 2026 month.
 */
export async function computeFareTrend(db: Db, kind: TrendKind = "domestic"): Promise<{ id: string; sampleRoutes: number } | null> {
  if (kind === "domestic_monthly") return computeMonthlyTrend(db);
  // Like for like, on both axes that matter:
  //   - MEDIAN vs MEDIAN, because the estimate this multiplier scales is a
  //     median. Comparing a current mean against a historical median would
  //     bake the difference between those two statistics into the trend and
  //     call it a price movement.
  //   - SAME QUARTER vs SAME QUARTER, because a route's fares are seasonal.
  //     Measuring March fares against a July baseline reports summer as a
  //     price rise, then applies that "rise" to every other route.
  // Only fares from a source we trust. This multiplier moves EVERY estimated
  // route in the app, so measuring it from Travelpayouts' calendar rows —
  // city-level, wrong-duration, hour-expiry fares that skew cheap — would
  // drag every estimate down with them, which is the exact "shown $200,
  // click through to $700" failure this is meant to prevent. Rows written
  // before the source column existed are null and excluded on the same
  // grounds: unlabeled rows are overwhelmingly those old ones.
  const trusted = (process.env.FARE_TREND_SOURCES ?? "serpapi_flights")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const current = await db.query<
    { origin: string; destination: string; quarter: number; current_med: string }
  >(
    `select origin, destination,
            extract(quarter from depart_date)::int as quarter,
            percentile_cont(0.5) within group (order by price_usd) as current_med
       from flight_prices
      where fetched_at > now() - interval '21 days'
        and source = any($1)
      group by origin, destination, quarter`,
    [trusted],
  );
  // Historical survey baselines only. A baseline built from the very fares
  // being measured (jobs/intlBaseline.ts writes those for international
  // routes) would compare a number against itself, contributing a ratio of
  // ~1.0 and quietly dragging the real multiplier toward "no change".
  const baseline = await db.query<
    { origin: string; destination: string; median_fare_usd: string; avg_fare_usd: string; year: number; quarter: number }
  >(
    `select distinct on (origin, destination, quarter)
            origin, destination, median_fare_usd, avg_fare_usd, year, quarter
       from historical_fares
      where source = $1
      order by origin, destination, quarter, year desc`,
    [kind === "intl" ? "seed_guess" : "bts_db1b"],
  );
  const baselineMap = new Map(
    baseline.rows.map((r) => [`${r.origin}|${r.destination}|${r.quarter}`, r]),
  );

  const ratios: number[] = [];
  let newestYear = 0, newestQuarter = 0;
  for (const c of current.rows) {
    const b = baselineMap.get(`${c.origin}|${c.destination}|${c.quarter}`);
    if (!b) continue;
    const currentMed = Number(c.current_med);
    const baselineMed = Number(b.median_fare_usd ?? b.avg_fare_usd);
    if (!Number.isFinite(currentMed) || !Number.isFinite(baselineMed) || baselineMed <= 0) continue;
    ratios.push(currentMed / baselineMed);
    if (b.year > newestYear || (b.year === newestYear && b.quarter > newestQuarter)) {
      newestYear = b.year;
      newestQuarter = b.quarter;
    }
  }

  // International starts from a flat guess, so it waits for a few more fares
  // than domestic before saying anything.
  const result = ratios.length >= (kind === "intl" ? 5 : 3) ? trimmedMultiplier(ratios) : null;
  if (!result) return null; // too few overlapping routes — leave fare_trend as-is, not junk

  const id = randomUUID();
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter, kind)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, result.multiplier, result.low, result.high, ratios.length, `${newestYear}Q${newestQuarter}`, kind],
  );
  return { id, sampleRoutes: ratios.length };
}

async function computeMonthlyTrend(db: Db): Promise<{ id: string; sampleRoutes: number } | null> {
  const trusted = (process.env.FARE_TREND_SOURCES ?? "serpapi_flights")
    .split(",").map((x) => x.trim()).filter(Boolean);
  const current = await db.query<{ origin: string; destination: string; month: number; current_med: string }>(
    `select origin, destination, extract(month from depart_date)::int as month,
            percentile_cont(0.5) within group (order by price_usd) as current_med
       from flight_prices
      where fetched_at > now() - interval '21 days' and source = any($1)
      group by origin, destination, month`,
    [trusted],
  );
  // Newest survey year for each route and month, newest load of it.
  const baseline = await db.query<{ origin: string; destination: string; month: number; year: number; median_fare_usd: string }>(
    `select distinct on (origin, destination, month) origin, destination, month, year, median_fare_usd
       from historical_fares_monthly
      order by origin, destination, month, year desc, loaded_at desc`,
  );
  const map = new Map(baseline.rows.map((r) => [`${r.origin}|${r.destination}|${r.month}`, r]));
  const ratios: number[] = [];
  let newest = "";
  for (const c of current.rows) {
    const b = map.get(`${c.origin}|${c.destination}|${c.month}`);
    if (!b) continue;
    const cur = Number(c.current_med), base = Number(b.median_fare_usd);
    if (!Number.isFinite(cur) || !Number.isFinite(base) || base <= 0) continue;
    ratios.push(cur / base);
    const label = `${b.year}-${String(b.month).padStart(2, "0")}`;
    if (label > newest) newest = label;
  }
  const result = ratios.length >= 3 ? trimmedMultiplier(ratios) : null;
  if (!result) return null;
  const id = randomUUID();
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter, kind)
     values ($1,$2,$3,$4,$5,$6,'domestic_monthly')`,
    [id, result.multiplier, result.low, result.high, ratios.length, newest],
  );
  return { id, sampleRoutes: ratios.length };
}
