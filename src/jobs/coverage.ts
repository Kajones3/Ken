/**
 * Read-only cache coverage report.
 *
 * Answers the one question you cannot answer from the refresh job's own
 * "N calls, M rows" summary: for a trip someone would actually search,
 * how much of what they see is a *real cached fare* and how much is a
 * BTS-baseline estimate (or nothing at all)?
 *
 * This exists because a refresh run can report "success, 8,890 rows" while
 * the months a user actually searches hold almost no real fares — the
 * Travelpayouts calendar endpoint returns whatever dates it likes, so a
 * call "succeeding" says nothing about the month you asked for.
 *
 * Touches nothing: select-only, no provider calls, no writes.
 */
import { ORIGINS, RESORTS, TRIP_BUCKETS } from "../config.js";
import { getDb, type Db } from "../db.js";
import { addDaysISO, monthKey, todayISO } from "../dates.js";

export interface MonthCoverage {
  month: string;
  realDates: number;
  estimateDates: number;
  gapDates: number;
}

/** Every airport a trip can be priced into, primary plus alternates. */
function allDestinations(): { iata: string; resortId: string }[] {
  return RESORTS.flatMap((r) => [
    { iata: r.iata, resortId: r.id },
    ...r.altArrivalAirports.map((a) => ({ iata: a.iata, resortId: r.id })),
  ]);
}

export async function report(db: Db, origin: string, monthsAhead = 12): Promise<string> {
  const out: string[] = [];
  const today = todayISO();
  const dests = allDestinations();

  out.push(`# Cache coverage from ${origin} — generated ${today}`);
  out.push("");

  // --- 1. What the flight cache actually holds, by destination and month ---
  const fp = await db.query<{ destination: string; month: string; trip_length: number; n: string; min_p: string; max_p: string; med_p: string }>(
    `select destination,
            to_char(depart_date,'YYYY-MM') as month,
            trip_length,
            count(*) as n,
            min(price_usd) as min_p,
            max(price_usd) as max_p,
            percentile_cont(0.5) within group (order by price_usd) as med_p
       from flight_prices
      where origin = $1 and depart_date >= $2
      group by destination, month, trip_length
      order by destination, month, trip_length`,
    [origin, today],
  );

  out.push("## Real cached fares in flight_prices");
  if (!fp.rows.length) {
    out.push("NONE. Every date from this origin falls back to an estimate or a gap.");
  } else {
    out.push("dest  month    nights  rows  min      median   max");
    for (const r of fp.rows) {
      out.push(
        `${r.destination}   ${r.month}  ${String(r.trip_length).padStart(6)}  ${String(r.n).padStart(4)}  ` +
        `${Number(r.min_p).toFixed(0).padStart(7)}  ${Number(r.med_p).toFixed(0).padStart(7)}  ${Number(r.max_p).toFixed(0).padStart(7)}`,
      );
    }
  }
  out.push("");

  // --- 2. Per-month verdict: real vs estimate vs gap, for a 7-night trip ---
  // 7 nights is the middle bucket and the one a typical search lands on.
  const bucket = TRIP_BUCKETS.includes(7 as never) ? 7 : TRIP_BUCKETS[0]!;
  const hf = await db.query<{ destination: string; avg_fare_usd: string; year: number; quarter: number }>(
    `select distinct on (destination) destination, avg_fare_usd, year, quarter
       from historical_fares
      where origin = $1
      order by destination, year desc, quarter desc`,
    [origin],
  );
  const baseline = new Map(hf.rows.map((r) => [r.destination, r]));

  out.push(`## Per-month verdict for a ${bucket}-night trip (what a searcher sees)`);
  out.push("real = a cached fare for that exact date · est = BTS baseline x trend · gap = 'no cached price'");
  out.push("");

  for (const d of dests) {
    const line: string[] = [];
    for (let m = 0; m < monthsAhead; m++) {
      const month = monthKey(addDaysISO(today, m * 30));
      const c = await db.query<{ n: string }>(
        `select count(*) as n from flight_prices
          where origin = $1 and destination = $2 and trip_length = $3
            and to_char(depart_date,'YYYY-MM') = $4 and depart_date >= $5`,
        [origin, d.iata, bucket, month, today],
      );
      const real = Number(c.rows[0]?.n ?? 0);
      const mark = real > 0 ? `${month}:${real}` : baseline.has(d.iata) ? `${month}:est` : `${month}:GAP`;
      line.push(mark);
    }
    const b = baseline.get(d.iata);
    const bNote = b
      ? `baseline ${Number(b.avg_fare_usd).toFixed(0)} (${b.year}Q${b.quarter})`
      : "NO BTS BASELINE";
    out.push(`${d.iata} (${d.resortId})  ${bNote}`);
    out.push(`   ${line.join("  ")}`);
  }
  out.push("");

  // --- 3. The trend multiplier every estimate is scaled by ---
  const ft = await db.query<{ multiplier: string; low_multiplier: string; high_multiplier: string; sample_routes: number; computed_at: string }>(
    `select multiplier, low_multiplier, high_multiplier, sample_routes, computed_at
       from fare_trend order by computed_at desc limit 3`,
  );
  out.push("## fare_trend (multiplies every BTS baseline into a shown estimate)");
  if (!ft.rows.length) {
    out.push("NONE — with no trend row, flightEstimate() returns undefined and every");
    out.push("estimate-only date is a hard gap.");
  } else {
    for (const r of ft.rows) {
      out.push(
        `x${Number(r.multiplier).toFixed(3)} (low x${Number(r.low_multiplier).toFixed(3)}, ` +
        `high x${Number(r.high_multiplier).toFixed(3)}) from ${r.sample_routes} routes @ ${r.computed_at}`,
      );
    }
  }
  out.push("");

  // --- 4. BTS baseline coverage across every origin, not just this one ---
  const cov = await db.query<{ destination: string; origins: string; routes: string }>(
    `select destination, count(*) as routes, string_agg(distinct origin, ',' order by origin) as origins
       from historical_fares group by destination order by destination`,
  );
  out.push(`## BTS baseline coverage (all ${ORIGINS.length} origins)`);
  if (!cov.rows.length) {
    out.push("EMPTY — historical_fares has no rows at all. Run the bts-baseline workflow.");
  } else {
    for (const r of cov.rows) {
      out.push(`${r.destination}: ${r.routes}/${ORIGINS.length} origins  [${r.origins}]`);
    }
  }
  out.push("");

  // --- 5. Freshness ---
  const runs = await db.query<{ job: string; note: string; calls: number; rows_written: number; errors: number; finished_at: string }>(
    `select job, note, calls, rows_written, errors, finished_at
       from fetch_runs order by started_at desc limit 5`,
  );
  out.push("## Last 5 fetch runs");
  for (const r of runs.rows) {
    out.push(`${r.finished_at ?? "(unfinished)"}  ${r.job}  calls=${r.calls} rows=${r.rows_written} errors=${r.errors}  ${r.note}`);
  }

  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const origin = (process.env.COVERAGE_ORIGIN ?? "ATL").toUpperCase();
  const months = Number(process.env.COVERAGE_MONTHS ?? 12);
  console.log(await report(db, origin, months));
  await db.close();
}
