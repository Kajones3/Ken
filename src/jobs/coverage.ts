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
  const fp = await db.query<{ destination: string; month: string; trip_length: number; source: string | null; carrier: string | null; n: string; min_p: string; max_p: string; med_p: string }>(
    `select destination,
            to_char(depart_date,'YYYY-MM') as month,
            trip_length,
            coalesce(source, '(unlabelled)') as source,
            min(carrier) as carrier,
            count(*) as n,
            min(price_usd) as min_p,
            max(price_usd) as max_p,
            percentile_cont(0.5) within group (order by price_usd) as med_p
       from flight_prices
      where origin = $1 and depart_date >= $2
      group by destination, month, trip_length, coalesce(source, '(unlabelled)')
      order by destination, month, trip_length, source`,
    [origin, today],
  );

  out.push("## Real cached fares in flight_prices");
  if (!fp.rows.length) {
    out.push("NONE. Every date from this origin falls back to an estimate or a gap.");
  } else {
    out.push("dest  month    nights  source            rows  min      median   max      carrier");
    for (const r of fp.rows) {
      out.push(
        `${r.destination}   ${r.month}  ${String(r.trip_length).padStart(6)}  ${String(r.source).padEnd(16)}  ${String(r.n).padStart(4)}  ` +
        `${Number(r.min_p).toFixed(0).padStart(7)}  ${Number(r.med_p).toFixed(0).padStart(7)}  ${Number(r.max_p).toFixed(0).padStart(7)}  ${r.carrier ?? "-"}`,
      );
    }
    // Which provider wrote these rows, and how cheap each one runs. The
    // question this exists for: a fare far below every other source for the
    // same route is a deal-feed row, not a bookable round trip.
    const bySource = new Map<string, { n: number; min: number; max: number; sum: number }>();
    for (const r of fp.rows) {
      const k = String(r.source);
      const acc = bySource.get(k) ?? { n: 0, min: Infinity, max: 0, sum: 0 };
      acc.n += Number(r.n);
      acc.min = Math.min(acc.min, Number(r.min_p));
      acc.max = Math.max(acc.max, Number(r.max_p));
      acc.sum += Number(r.med_p) * Number(r.n);
      bySource.set(k, acc);
    }
    out.push("");
    out.push("### By source — who wrote these fares");
    out.push("source            rows  min      max      mean-of-medians");
    for (const [k, v] of [...bySource].sort((a, b) => b[1].n - a[1].n)) {
      out.push(
        `${k.padEnd(16)}  ${String(v.n).padStart(4)}  ${v.min.toFixed(0).padStart(7)}  ${v.max.toFixed(0).padStart(7)}  ${(v.sum / v.n).toFixed(0).padStart(15)}`,
      );
    }
    out.push("");
    out.push("Read this before fixing anything: `travelpayouts` rows come from a");
    out.push("'cheapest fares our users recently found' feed and skew cheap; they are");
    out.push("already excluded from the fare trend. `serpapi_flights` is a real");
    out.push("round-trip lookup. A suspiciously low fare sitting under `travelpayouts`");
    out.push("means the row is the deal feed, not a bug in the estimate path.");
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

  // --- 4b. Is the baseline on the right BASIS? ---
  //
  // DB1B's MktFare is the whole round trip, not one leg — BTS's own
  // documentation describes the Market table as holding a "prorated" fare
  // for a "directional" market, which reads like one leg and is the obvious
  // way to get this wrong in either direction. It was checked against a real
  // 2024 Q4 file when the parser was written, and checked again on
  // 2026-09-22 against the fare trend: across 74 routes, real round-trip
  // SerpApi fares sat between 0.58x and 1.24x the BTS baseline. Had the
  // baseline been one leg, every one of those ratios would have been near 2.
  //
  // This check exists so that stops being something anyone has to reason
  // about. BTS publishes an average domestic ITINERARY fare, around $390 in
  // recent years; our own national passenger-weighted average should land in
  // the same neighbourhood. Half of it means the basis slipped to one leg;
  // double means it is being counted twice. A fare that is wrong by a factor
  // of two is still a perfectly plausible-looking fare, which is exactly why
  // nothing inside the program can notice it.
  const basis = await db.query<{ avg: string | null; routes: string; pax: string }>(
    `select sum(avg_fare_usd * passengers_sampled) / nullif(sum(passengers_sampled), 0) as avg,
            count(*) as routes,
            sum(passengers_sampled) as pax
       from historical_fares
      where source = 'bts_db1b' and avg_fare_usd > 0 and passengers_sampled > 0`,
  );
  out.push("## Baseline sanity — are these round trips?");
  const row = basis.rows[0];
  const nationalAvg = row?.avg == null ? null : Number(row.avg);
  if (nationalAvg == null || !Number.isFinite(nationalAvg)) {
    out.push("No BTS rows to check. Run the bts-baseline workflow.");
  } else {
    out.push(`Our national passenger-weighted average: $${nationalAvg.toFixed(2)}`
      + ` (${row!.routes} routes, ${Math.round(Number(row!.pax)).toLocaleString("en-US")} passengers sampled)`);
    out.push("BTS's published average domestic itinerary fare: roughly $390 in recent years.");
    // Bands rather than a pass/fail: this is a rough external comparison
    // between our leisure-route subset and a national figure, so it can
    // only catch an error of the size that actually matters — a factor of
    // two. Anything subtler is not what this check is for.
    if (nationalAvg < 260) {
      out.push(`*** SUSPICIOUS — far below $390. Check whether MktFare has started being`);
      out.push(`    read as ONE LEG rather than the whole round trip; that would halve every`);
      out.push(`    domestic estimate in the app. See the header of src/jobs/btsBaseline.ts.`);
    } else if (nationalAvg > 620) {
      out.push(`*** SUSPICIOUS — far ABOVE $390. Check the fare is not being counted twice.`);
    } else {
      out.push("Plausible: the round-trip basis looks right.");
    }
    out.push("(Our routes are leisure routes to six resorts, not a national sample, so exact");
    out.push(" agreement is not expected — this is here to catch a factor of two, not a few percent.)");
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
