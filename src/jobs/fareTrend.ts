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

export async function computeFareTrend(db: Db): Promise<{ id: string; sampleRoutes: number } | null> {
  const current = await db.query<{ origin: string; destination: string; current_avg: string }>(
    `select origin, destination, avg(price_usd) as current_avg
       from flight_prices
      where fetched_at > now() - interval '21 days'
      group by origin, destination`,
  );
  const baseline = await db.query<
    { origin: string; destination: string; avg_fare_usd: string; year: number; quarter: number }
  >(
    `select distinct on (origin, destination) origin, destination, avg_fare_usd, year, quarter
       from historical_fares
      order by origin, destination, year desc, quarter desc`,
  );
  const baselineMap = new Map(baseline.rows.map((r) => [`${r.origin}|${r.destination}`, r]));

  const ratios: number[] = [];
  let newestYear = 0, newestQuarter = 0;
  for (const c of current.rows) {
    const b = baselineMap.get(`${c.origin}|${c.destination}`);
    if (!b) continue;
    const currentAvg = Number(c.current_avg);
    const baselineAvg = Number(b.avg_fare_usd);
    if (!Number.isFinite(currentAvg) || !Number.isFinite(baselineAvg) || baselineAvg <= 0) continue;
    ratios.push(currentAvg / baselineAvg);
    if (b.year > newestYear || (b.year === newestYear && b.quarter > newestQuarter)) {
      newestYear = b.year;
      newestQuarter = b.quarter;
    }
  }

  const result = trimmedMultiplier(ratios);
  if (!result) return null; // too few overlapping routes — leave fare_trend as-is, not junk

  const id = randomUUID();
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter)
     values ($1,$2,$3,$4,$5,$6)`,
    [id, result.multiplier, result.low, result.high, ratios.length, `${newestYear}Q${newestQuarter}`],
  );
  return { id, sampleRoutes: ratios.length };
}
