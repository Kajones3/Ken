/**
 * Turn bought international fares into a per-quarter baseline.
 *
 * Why this exists: BTS DB1B is a US *domestic* survey. Verified against a
 * real 2024 Q4 file (2026-09-10) — grepping all 8.5 million rows for "CDG",
 * the international airport most likely to appear, returns nothing at all.
 * So for CDG/NRT/HND/PVG/HKG there is no historical baseline to fall back
 * on, and `flightEstimate()` has nothing to work with.
 *
 * Without this, a bought international fare covers only the one date and
 * trip length it was bought for. Every other date on that route is a hard
 * "no cached price" gap — buying one date a month per route leaves ~99% of
 * international dates blank. With it, the same purchase anchors the whole
 * quarter: the median of what we actually paid becomes that route's
 * baseline, and every other date in the quarter is a labelled estimate off
 * it, exactly as domestic routes work off DB1B.
 *
 * THE ONE THING NOT TO GET WRONG: a baseline built from fares sampled today
 * is already at today's prices. The fare_trend multiplier exists to carry an
 * OLD (2024/2025) baseline forward to now — applying it to a
 * freshly-sampled one would inflate a current price by the same percentage
 * a second time. Rows written here are tagged `sampled_live` and book.ts
 * applies no trend to them. See `TREND_APPLIES_TO` there.
 */
import { randomUUID } from "node:crypto";
import { RESORTS } from "../config.js";
import { getDb, type Db } from "../db.js";
import { weightedPercentile } from "./btsBaseline.js";

/** Marks a baseline captured from live fares rather than a historical survey. */
export const SAMPLED_LIVE = "sampled_live";

/** Every arrival airport at a resort outside the US. */
export function internationalDestinations(): string[] {
  return RESORTS
    .filter((r) => r.region !== "dom")
    .flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]);
}

export interface IntlBaselineOptions {
  /** Minimum real fares on a route/quarter before a baseline is worth
   *  writing. Two points is not a distribution; a median off it is noise
   *  wearing a median's clothes. */
  minSamples?: number;
  destinations?: string[];
}

export async function runIntlBaseline(db: Db, opts: IntlBaselineOptions = {}) {
  const minSamples = opts.minSamples ?? Number(process.env.INTL_BASELINE_MIN_SAMPLES ?? 3);
  const destinations = opts.destinations ?? internationalDestinations();

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'intl_baseline',$2)`,
    [runId, `${destinations.length} intl airports, min ${minSamples} samples`]);

  // Real fares only, grouped by the quarter they depart in. Travelpayouts
  // rows are excluded for the same reason they are excluded from the trend:
  // city-level, wrong-duration, hour-expiry fares that skew cheap.
  const rows = await db.query<{
    origin: string; destination: string; year: number; quarter: number; price_usd: string;
  }>(
    `select origin, destination,
            extract(year from depart_date)::int as year,
            extract(quarter from depart_date)::int as quarter,
            price_usd
       from flight_prices
      where destination = any($1)
        and source = 'serpapi_flights'
        and depart_date >= current_date`,
    [destinations],
  );

  const groups = new Map<string, number[]>();
  for (const r of rows.rows) {
    const price = Number(r.price_usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = `${r.origin}|${r.destination}|${r.year}|${r.quarter}`;
    groups.set(key, [...(groups.get(key) ?? []), price]);
  }

  let written = 0, skipped = 0;
  for (const [key, prices] of groups) {
    if (prices.length < minSamples) { skipped++; continue; }
    const [origin, destination, year, quarter] = key.split("|");
    // Equal weights: unlike BTS rows, each of these is one real quoted fare,
    // not a sample standing for N passengers.
    const pairs = prices.map((fare) => ({ fare, weight: 1 }));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const median = r2(weightedPercentile(pairs, 0.5));
    await db.query(
      `insert into historical_fares
         (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,
          passengers_sampled,itin_count,source,fetched_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,now())
       on conflict (origin,destination,year,quarter) do update set
         avg_fare_usd = excluded.avg_fare_usd,
         p25_fare_usd = excluded.p25_fare_usd,
         median_fare_usd = excluded.median_fare_usd,
         p75_fare_usd = excluded.p75_fare_usd,
         itin_count = excluded.itin_count,
         source = excluded.source,
         fetched_at = excluded.fetched_at
       -- Never let a live sample overwrite a real DB1B survey row. If BTS
       -- ever does cover a route, the survey wins: it rests on millions of
       -- real itineraries, this rests on a handful of quotes.
       where historical_fares.source = excluded.source`,
      [origin, destination, Number(year), Number(quarter),
       r2(prices.reduce((s, p) => s + p, 0) / prices.length),
       r2(weightedPercentile(pairs, 0.25)), median, r2(weightedPercentile(pairs, 0.75)),
       prices.length, SAMPLED_LIVE],
    );
    written++;
  }

  await db.query(
    `update fetch_runs set finished_at = now(), calls = 0, rows_written = $2, errors = 0,
       note = note || ' · ' || $3 where id = $1`,
    [runId, written, `${written} baselines, ${skipped} below ${minSamples} samples`],
  );
  return { runId, written, skipped, groups: groups.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const res = await runIntlBaseline(db);
  console.log(
    `intl baseline done: ${res.written} route/quarter baselines written, ` +
    `${res.skipped} skipped for too few samples (of ${res.groups} groups)`,
  );
  await db.close();
}
