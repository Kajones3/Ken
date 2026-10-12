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
import { unzipBody } from "../rawResponses.js";
import { loadForecastScores } from "../fareForecasts.js";
import { loadScoreboard } from "../fareScoreboard.js";
import { loadModelInputs } from "../fareModelDb.js";
import { fitFareModel, isInternational, leaveOneOut } from "../fareModel.js";
import { weekdayPattern, WEEKDAYS } from "../dayOfWeek.js";
import { loadIndicatorStudy } from "../indicatorStudy.js";
import { ORIGINS, RESORTS, TRIP_BUCKETS } from "../config.js";
import { getDb, type Db } from "../db.js";
import { addDaysISO, monthKey, todayISO } from "../dates.js";
import { nationalBtsAverage, basisVerdict, BTS_PUBLISHED_AVG_USD } from "../fareHealth.js";

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
            coalesce(source, '(unlabeled)') as source,
            min(carrier) as carrier,
            count(*) as n,
            min(price_usd) as min_p,
            max(price_usd) as max_p,
            percentile_cont(0.5) within group (order by price_usd) as med_p
       from flight_prices
      where origin = $1 and depart_date >= $2
      group by destination, month, trip_length, coalesce(source, '(unlabeled)')
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
       from fare_trend where kind = 'domestic' order by computed_at desc limit 3`,
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

  // --- 3b. What the trend can see: why it has the sample it has ---
  // Mirrors computeFareTrend's own filters (serpapi_flights, last 21 days,
  // same route + quarter as a bts_db1b baseline), split so the owner can see
  // where the bought fares went and which ones found no baseline to compare.
  out.push("## Fares the trend could use (serpapi_flights, last 21 days)");
  const bought = await db.query<{ origin: string; destination: string; quarter: number; fares: string; has_base: boolean }>(
    `select g.origin, g.destination, g.quarter, g.fares,
            exists (select 1 from historical_fares h
                     where h.source = 'bts_db1b' and h.origin = g.origin
                       and h.destination = g.destination and h.quarter = g.quarter) as has_base
       from (select origin, destination, extract(quarter from depart_date)::int as quarter, count(*) as fares
               from flight_prices
              where source = 'serpapi_flights' and fetched_at > now() - interval '21 days'
              group by 1, 2, 3) g
      order by has_base desc, g.destination, g.origin, g.quarter`,
  );
  const domestic = new Set(["MCO", "TPA", "SNA", "LAX"]);
  const dom = bought.rows.filter((r) => domestic.has(r.destination));
  const intl = bought.rows.filter((r) => !domestic.has(r.destination));
  const sum = (rows: typeof bought.rows) => rows.reduce((n, r) => n + Number(r.fares), 0);
  out.push(`International: ${sum(intl)} fares across ${intl.length} route+quarter pairs (no government baseline exists, so never counted)`);
  out.push(`Domestic: ${sum(dom)} fares across ${dom.length} route+quarter pairs, ${dom.filter((r) => r.has_base).length} with a matching baseline`);
  for (const r of dom) out.push(`   ${r.origin}->${r.destination} Q${r.quarter}: ${r.fares} fare(s)${r.has_base ? "" : "  NO BASELINE for this quarter"}`);
  const byDay = await db.query<{ day: string; dom: string; intl: string }>(
    `select fetched_at::date::text as day,
            count(*) filter (where destination = any($1)) as dom,
            count(*) filter (where not destination = any($1)) as intl
       from flight_prices
      where source = 'serpapi_flights' and fetched_at > now() - interval '21 days'
      group by 1 order by 1`,
    [[...domestic]],
  );
  out.push("Bought per day (domestic / international):");
  for (const r of byDay.rows) out.push(`   ${r.day}: ${r.dom} / ${r.intl}`);
  // fetch_runs keeps what each paid job WROTE, so a gap between that and
  // what is still tagged serpapi_flights means rows were overwritten since.
  const wrote = await db.query<{ job: string; rows: string; runs: string }>(
    `select job, coalesce(sum(rows_written), 0)::text as rows, count(*)::text as runs
       from fetch_runs
      where started_at > now() - interval '21 days' and job in ('popular_routes', 'intl_sweep', 'exact_fare')
      group by job`,
  ).catch(() => ({ rows: [] as { job: string; rows: string; runs: string }[] }));
  for (const r of wrote.rows) out.push(`Paid job ${r.job} wrote ${r.rows} fare(s) in ${r.runs} run(s); ${sum(bought.rows)} still carry the serpapi_flights tag`);
  // The record itself (flight_observations, append-only since 2026-10-04):
  // what each paid run wrote beside what the record holds from that run.
  try {
    out.push("The record (flight_observations), by source:");
    const rec = await db.query<{ source: string; n: string; newest: unknown }>(
      `select source, count(*)::text as n, max(observed_at) as newest from flight_observations group by 1 order by 2 desc`);
    for (const r of rec.rows) out.push(`   ${r.source}: ${r.n} fares, newest ${String(r.newest).slice(4, 21)}`);
    const since = await db.query<{ done_at: unknown }>(`select done_at from schema_marks where name = 'flight_observations_backfill'`);
    out.push(`   (record started ${String(since.rows[0]?.done_at ?? "never").slice(4, 21)})`);
    const perRun = await db.query<{ job: string; started_at: unknown; rows_written: number; kept: string; ins: string; ranged: string }>(
      `select r.job, r.started_at, r.rows_written,
              (select count(*) from flight_observations o
                where o.source = 'serpapi_flights' and o.observed_at >= r.started_at
                  and o.observed_at <= coalesce(r.finished_at, now()) + interval '1 minute')::text as kept,
              (select count(*) from flight_insights i
                where i.source = 'serpapi_flights' and i.observed_at >= r.started_at
                  and i.observed_at <= coalesce(r.finished_at, now()) + interval '1 minute')::text as ins,
              (select count(typical_low) from flight_insights i
                where i.source = 'serpapi_flights' and i.observed_at >= r.started_at
                  and i.observed_at <= coalesce(r.finished_at, now()) + interval '1 minute')::text as ranged
         from fetch_runs r
        where r.job in ('popular_routes', 'intl_sweep') and r.started_at > now() - interval '14 days'
          and r.finished_at is not null
        order by r.started_at`);
    out.push("Paid runs, last 14 days: written / kept in the record / with Google's typical range");
    // Measured inside the same query, by each run's own time window. (A
    // per-run lookup by started_at missed: JS dates drop the microseconds.)
    for (const r of perRun.rows) out.push(`   ${String(r.started_at).slice(4, 21)} ${r.job}: ${r.rows_written} / ${r.kept} / ${r.ranged} of ${r.ins} insights`);
  } catch (e) {
    out.push(`The record could not be read: ${(e as Error).message}`);
  }
  // Google's whole answers (provider_responses, 2026-10-06), and how much
  // room they take: Neon's free plan holds 0.5 GB for the whole database.
  try {
    const raw = await db.query<{ source: string; n: string; raw_mb: string; stored_mb: string; newest: unknown }>(
      `select source, count(*)::text as n,
              round(sum(bytes) / 1048576.0, 1)::text as raw_mb,
              round(sum(octet_length(body_gz)) / 1048576.0, 1)::text as stored_mb,
              max(fetched_at) as newest
         from provider_responses group by source order by source`);
    out.push("Google's whole answers kept (provider_responses):");
    if (!raw.rows.length) out.push("   none yet");
    for (const r of raw.rows) out.push(`   ${r.source}: ${r.n} answers, ${r.raw_mb} MB as sent, ${r.stored_mb} MB stored (compressed), newest ${String(r.newest).slice(4, 21)}`);
    const size = await db.query<{ mb: string }>(`select round(pg_database_size(current_database()) / 1048576.0)::text as mb`)
      .catch(() => ({ rows: [] as { mb: string }[] }));
    if (size.rows[0]) out.push(`   whole database: ${size.rows[0].mb} MB (Neon free plan: 512 MB)`);
  } catch (e) {
    out.push(`Google's whole answers could not be read: ${(e as Error).message}`);
  }
  // The hotel record: per refresh run, paid searches made (from its note)
  // beside the pulls hotel_samples holds from that run.
  try {
    const { slotCount } = await import("../dataIntake.js");
    const hr = await db.query<{ started_at: unknown; finished_at: unknown; note: string; pulls: string; rates: string }>(
      `select r.started_at, r.finished_at, r.note,
              (select count(distinct (s.resort_id, s.month, s.pulled_at)) from hotel_samples s
                where s.pulled_at >= r.started_at and s.pulled_at <= coalesce(r.finished_at, now()) + interval '1 minute')::text as pulls,
              (select count(*) from hotel_samples s
                where s.pulled_at >= r.started_at and s.pulled_at <= coalesce(r.finished_at, now()) + interval '1 minute')::text as rates
         from fetch_runs r
        where r.job = 'refresh' and r.started_at > now() - interval '14 days' and r.finished_at is not null
        order by r.started_at`);
    out.push("Hotel searches per refresh run, last 14 days: made / pulls kept (rates kept)");
    for (const r of hr.rows) out.push(`   ${String(r.started_at).slice(4, 21)}: ${slotCount(r.note)} / ${r.pulls} (${r.rates})`);
    const first = await db.query<{ first: unknown; n: string }>(`select min(pulled_at) as first, count(*)::text as n from hotel_samples`);
    out.push(`   (hotel_samples: ${first.rows[0]?.n} rates, first written ${String(first.rows[0]?.first).slice(4, 21)})`);
    const ex = await db.query<{ n: string; extra: string; usual: string; sites: string }>(
      `select count(*)::text as n, count(extra)::text as extra,
              count(*) filter (where extra ? 'usualNightly')::text as usual,
              count(*) filter (where extra ? 'prices')::text as sites
         from hotel_samples where pulled_at > now() - interval '14 days'`).catch(() => ({ rows: [] as { n: string; extra: string; usual: string; sites: string }[] }));
    const e = ex.rows[0];
    if (e) out.push(`   last 14 days: ${e.n} rates; ${e.extra} with Google's extra details, ${e.usual} with a "less than usual" price, ${e.sites} with per-site prices`);
  } catch (e) {
    out.push(`The hotel record could not be read: ${(e as Error).message}`);
  }
  const bySource = await db.query<{ source: string; n: string }>(
    `select coalesce(source, '(none)') as source, count(*)::text as n from flight_prices
      where fetched_at > now() - interval '21 days' group by 1 order by 2 desc`,
  );
  const allSources = await db.query<{ source: string; n: string; oldest: unknown; newest: unknown; from_day: unknown; to_day: unknown }>(
    `select coalesce(source, '(none)') as source, count(*)::text as n,
            min(fetched_at) as oldest, max(fetched_at) as newest,
            min(depart_date) as from_day, max(depart_date) as to_day
       from flight_prices group by 1 order by 2 desc`,
  );
  out.push("All flight rows ever stored, by source (fetched oldest..newest; departure dates covered):");
  for (const r of allSources.rows) {
    out.push(`   ${r.source}: ${r.n} rows, fetched ${String(r.oldest).slice(4, 15)} .. ${String(r.newest).slice(4, 15)}, departing ${String(r.from_day).slice(4, 15)} .. ${String(r.to_day).slice(4, 15)}`);
  }
  const hotelSources = await db.query<{ source: string; on_property: boolean; n: string; oldest: unknown; newest: unknown; hotels: string }>(
    `select coalesce(source, '(none)') as source, on_property, count(*)::text as n,
            min(fetched_at) as oldest, max(fetched_at) as newest, count(distinct hotel_id)::text as hotels
       from hotel_rates group by 1, 2 order by 1, 2`,
  );
  out.push("All hotel rows ever stored, by source:");
  for (const r of hotelSources.rows) {
    out.push(`   ${r.source} ${r.on_property ? "on property" : "off property"}: ${r.n} rows, ${r.hotels} hotels, fetched ${String(r.oldest).slice(4, 15)} .. ${String(r.newest).slice(4, 15)}`);
  }
  out.push("All flight rows written in the last 21 days, by source: "
    + bySource.rows.map((r) => `${r.source} ${r.n}`).join(", "));
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
  // DB1B's MktFare is ONE LEG and btsBaseline.ts doubles it (settled
  // 2026-09-28; see that file's header for the proof). BTS publishes an
  // average domestic ITINERARY fare of around $390; our own national
  // passenger-weighted average should land near it. Half of it means the
  // doubling was lost; double means it happened twice. The same check now
  // rides the owner's daily email (fareHealth.ts), because this report
  // printed "SUSPICIOUS" for a week with nobody reading it.
  // International baselines are rebuilt only when intl-sweep runs. Fares
  // bought before 2026-09-15 were the CHEAPEST itinerary, not the median,
  // so a baseline built from them reads low (2026-10-03 scorecard question).
  out.push("## International baselines (sampled_live) — when built, from what");
  const ib = await db.query<{ n: string; oldest: unknown; newest: unknown; med: string }>(
    `select count(*) as n, min(fetched_at) as oldest, max(fetched_at) as newest,
            percentile_cont(0.5) within group (order by median_fare_usd) as med
       from historical_fares where source = 'sampled_live'`,
  );
  const ibr = ib.rows[0];
  out.push(`  ${ibr?.n ?? 0} rows, built ${String(ibr?.oldest ?? "-").slice(0, 24)} .. ${String(ibr?.newest ?? "-").slice(0, 24)}, median of medians $${Math.round(Number(ibr?.med ?? 0))}`);
  const iff = await db.query<{ era: string; n: string; med: string }>(
    `select case when fetched_at < '2026-09-15' then 'before 09-15 (cheapest itinerary)' else 'since 09-15 (median itinerary)' end as era,
            count(*) as n, percentile_cont(0.5) within group (order by price_usd) as med
       from flight_prices
      where source = 'serpapi_flights' and depart_date >= current_date
        and destination in ('CDG','NRT','HND','PVG','HKG')
      group by 1 order by 1`,
  );
  for (const r of iff.rows) out.push(`  future intl fares bought ${r.era}: ${r.n}, median $${Math.round(Number(r.med))}`);
  out.push("");

  // 2026-10-10: the owner's St. Louis -> Paris fare read ~$500 a seat high.
  // The international trend is ONE multiplier pooled over Europe and Asia, so
  // if bought Asian fares sit far above their seed and Paris fares don't,
  // Paris gets pushed up by Asia's correction. This shows each destination's
  // own ratio (bought fare / seed for the same route and quarter).
  out.push("## International: bought fare vs seed guess, per destination");
  const tr = await db.query<{ kind: string; multiplier: string; sample_routes: number; computed_at: unknown }>(
    `select distinct on (kind) kind, multiplier, sample_routes, computed_at
       from fare_trend order by kind, computed_at desc`,
  );
  for (const r of tr.rows) out.push(`  latest ${r.kind} trend: x${Number(r.multiplier).toFixed(3)} from ${r.sample_routes} routes (${String(r.computed_at).slice(0, 15)})`);
  const pd = await db.query<{ destination: string; n: string; routes: string; bought: string; seed: string; ratio: string; lo: string; hi: string }>(
    `with b as (
       select o.origin, o.destination, extract(quarter from o.depart_date)::int as q, o.price_usd
         from flight_observations o
        where o.source = 'serpapi_flights' and o.destination in ('CDG','NRT','HND','PVG','HKG')
     ), s as (
       select distinct on (origin, destination, quarter) origin, destination, quarter,
              coalesce(median_fare_usd, avg_fare_usd) as seed
         from historical_fares where source = 'seed_guess'
        order by origin, destination, quarter, year desc
     )
     select b.destination, count(*) as n, count(distinct b.origin) as routes,
            percentile_cont(0.5) within group (order by b.price_usd) as bought,
            percentile_cont(0.5) within group (order by s.seed) as seed,
            percentile_cont(0.5) within group (order by b.price_usd / s.seed) as ratio,
            percentile_cont(0.25) within group (order by b.price_usd / s.seed) as lo,
            percentile_cont(0.75) within group (order by b.price_usd / s.seed) as hi
       from b join s on s.origin = b.origin and s.destination = b.destination and s.quarter = b.q
      group by b.destination order by b.destination`,
  );
  for (const r of pd.rows) {
    out.push(`  ${r.destination}: ${r.n} fares from ${r.routes} cities, bought median $${Math.round(Number(r.bought))}`
      + ` vs seed $${Math.round(Number(r.seed))} -> x${Number(r.ratio).toFixed(2)} (middle half x${Number(r.lo).toFixed(2)}-x${Number(r.hi).toFixed(2)})`);
  }
  // Same, split by travel quarter: the seed's season shape (Q1 x0.85 ... Q3
  // x1.37) is multiplied by ONE trend measured on whatever quarters we bought.
  const pq = await db.query<{ region: string; q: number; n: string; ratio: string }>(
    `with b as (
       select o.origin, o.destination, extract(quarter from o.depart_date)::int as q, o.price_usd
         from flight_observations o
        where o.source = 'serpapi_flights' and o.destination in ('CDG','NRT','HND','PVG','HKG')
     ), s as (
       select distinct on (origin, destination, quarter) origin, destination, quarter,
              coalesce(median_fare_usd, avg_fare_usd) as seed
         from historical_fares where source = 'seed_guess'
        order by origin, destination, quarter, year desc
     )
     select case when b.destination = 'CDG' then 'Europe' else 'Asia' end as region, b.q,
            count(*) as n, percentile_cont(0.5) within group (order by b.price_usd / s.seed) as ratio
       from b join s on s.origin = b.origin and s.destination = b.destination and s.quarter = b.q
      group by 1, 2 order by 1, 2`,
  );
  for (const r of pq.rows) out.push(`  ${r.region} Q${r.q}: ${r.n} fares, bought/seed x${Number(r.ratio).toFixed(2)}`);
  // Our bought fare (Google's MEDIAN itinerary) against Google's own
  // "typical price" range for the same search.
  const gi = await db.query<{ destination: string; n: string; bought: string; lo: string; hi: string; lowest: string; above: string }>(
    `select o.destination, count(*) as n,
            percentile_cont(0.5) within group (order by o.price_usd) as bought,
            percentile_cont(0.5) within group (order by i.typical_low) as lo,
            percentile_cont(0.5) within group (order by i.typical_high) as hi,
            percentile_cont(0.5) within group (order by i.lowest_price) as lowest,
            sum(case when o.price_usd > i.typical_high then 1 else 0 end) as above
       from flight_observations o
       join flight_insights i on i.origin = o.origin and i.destination = o.destination
        and i.depart_date = o.depart_date and i.trip_length = o.trip_length
        and abs(extract(epoch from (i.observed_at - o.observed_at))) < 3600
      where o.source = 'serpapi_flights' and i.typical_low is not null
      group by 1 order by 1`,
  );
  out.push("  Bought fare vs Google's own 'typical price' for the same search:");
  for (const r of gi.rows) out.push(`    ${r.destination}: ${r.n} searches, our fare median $${Math.round(Number(r.bought))}, Google typical $${Math.round(Number(r.lo))}-$${Math.round(Number(r.hi))}, Google lowest $${Math.round(Number(r.lowest))}; ${r.above} above Google's typical range`);
  // 2026-10-10: our bought domestic fares sat ABOVE Google's own "typical
  // price" on every search. Open a few of Google's whole answers (kept in
  // provider_responses) and print what each part of the answer says, so we
  // can tell what Google's typical range is measuring.
  out.push("  Google's whole answer, a few domestic searches:");
  const raws = await db.query<{ request: Record<string, string>; body_gz: Uint8Array; fetched_at: unknown }>(
    `select request, body_gz, fetched_at from provider_responses
      where kind = 'google_flights' and status = 200
        and request->>'arrival_id' in ('MCO','LAX','SNA','TPA')
      order by fetched_at desc limit 4`,
  );
  for (const r of raws.rows) {
    try {
      const j = JSON.parse(unzipBody(r.body_gz)) as {
        best_flights?: { price?: number; type?: string; flights?: { airline?: string }[] }[];
        other_flights?: { price?: number; type?: string; flights?: { airline?: string }[] }[];
        price_insights?: { lowest_price?: number; typical_price_range?: number[]; price_level?: string; price_history?: [number, number][] };
        search_parameters?: Record<string, unknown>;
      };
      const all = [...(j.best_flights ?? []), ...(j.other_flights ?? [])].filter((f) => (f.price ?? 0) > 0);
      const prices = all.map((f) => f.price as number).sort((a, b) => a - b);
      const pi = j.price_insights ?? {};
      const hist = pi.price_history ?? [];
      const q = r.request;
      out.push(`    ${q.departure_id}->${q.arrival_id} ${q.outbound_date}..${q.return_date} adults=${q.adults} type=${q.type} (bought ${String(r.fetched_at).slice(4, 15)})`);
      out.push(`      ${prices.length} itineraries: cheapest $${prices[0]}, median $${prices[Math.floor((prices.length - 1) / 2)]}, dearest $${prices[prices.length - 1]}; types ${[...new Set(all.map((f) => f.type))].join("/")}`);
      out.push(`      cheapest 5 with airline: ${all.sort((a, b) => (a.price as number) - (b.price as number)).slice(0, 5).map((f) => `$${f.price} ${f.flights?.[0]?.airline ?? "?"}`).join(", ")}`);
      out.push(`      Google: lowest $${pi.lowest_price}, typical ${JSON.stringify(pi.typical_price_range)}, level ${pi.price_level}; history ${hist.length} points, last ${hist.slice(-3).map((h) => `$${h[1]}`).join(" ")}`);
    } catch (e) {
      out.push(`    could not read one answer: ${(e as Error).message}`);
    }
  }
  const stl = await db.query<{ destination: string; depart_date: unknown; price_usd: string; observed_at: unknown }>(
    `select destination, depart_date, price_usd, observed_at from flight_observations
      where source = 'serpapi_flights' and origin = 'STL' order by observed_at desc limit 20`,
  );
  out.push(`  St. Louis fares bought: ${stl.rows.length}`);
  for (const r of stl.rows) out.push(`    STL->${r.destination} departing ${String(r.depart_date).slice(0, 15)}: $${Math.round(Number(r.price_usd))}`);
  const bq = await db.query<{ year: number; quarter: number; n: string }>(
    `select year, quarter, count(*) as n from historical_fares where source = 'bts_db1b' group by 1,2 order by 1,2`,
  );
  const bm = await db.query<{ year: number; month: number; routes: string; tickets: string; files: string }>(
    `select year, month, count(*) as routes, sum(itin_count) as tickets, string_agg(distinct file, ',') as files
       from historical_fares_monthly group by 1, 2 order by 1, 2`,
  ).catch(() => ({ rows: [] }));
  out.push(`  BTS monthly survey held (route-months / tickets): ${bm.rows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")} ${r.routes}/${r.tickets}`).join(", ") || "none"}`);
  const bmEx = await db.query<{ origin: string; destination: string; year: number; month: number; median_fare_usd: string; itin_count: number }>(
    `select origin, destination, year, month, median_fare_usd, itin_count from historical_fares_monthly
      where origin in ('BNA','ATL','STL','ORD') and destination in ('MCO','LAX') order by origin, destination, year, month`,
  ).catch(() => ({ rows: [] }));
  for (const r of bmEx.rows) out.push(`    ${r.origin}->${r.destination} ${r.year}-${String(r.month).padStart(2, "0")}: median $${Math.round(Number(r.median_fare_usd))} from ${r.itin_count} tickets`);
  out.push(`  BTS quarters held: ${bq.rows.map((r) => `${r.year} Q${r.quarter} (${r.n})`).join(", ")}`);
  out.push("");

  // Owner, 2026-10-10: "I can drive to RDU, ATL, CLT or IAD. How much could I
  // save by leaving out of Dulles instead of RDU?" Same destination, same
  // month or quarter, side by side.
  out.push("## Nearby home airports, same destination (survey medians, round trip incl. tax)");
  const homes = ["RDU", "IAD", "DCA", "BWI", "CLT", "ATL", "RIC", "GSO", "ORF"];
  const nm = await db.query<{ origin: string; destination: string; year: number; month: number; p25_fare_usd: string; median_fare_usd: string; p75_fare_usd: string; itin_count: number }>(
    `select distinct on (origin, destination, year, month) origin, destination, year, month,
            p25_fare_usd, median_fare_usd, p75_fare_usd, itin_count
       from historical_fares_monthly where origin = any($1)
      order by origin, destination, year, month, loaded_at desc`,
    [homes],
  ).catch(() => ({ rows: [] }));
  for (const r of [...nm.rows].sort((a, b) => a.destination.localeCompare(b.destination) || a.year - b.year || a.month - b.month || Number(a.median_fare_usd) - Number(b.median_fare_usd))) {
    out.push(`    monthly ${r.year}-${String(r.month).padStart(2, "0")} ${r.origin}->${r.destination}: p25 $${Math.round(Number(r.p25_fare_usd))} · median $${Math.round(Number(r.median_fare_usd))} · p75 $${Math.round(Number(r.p75_fare_usd))} (${r.itin_count} tickets)`);
  }
  const nq = await db.query<{ origin: string; destination: string; year: number; quarter: number; p25_fare_usd: string | null; median_fare_usd: string | null; p75_fare_usd: string | null; passengers_sampled: string | null }>(
    `select origin, destination, year, quarter, p25_fare_usd, median_fare_usd, p75_fare_usd, passengers_sampled
       from historical_fares where source = 'bts_db1b' and origin = any($1)
      order by destination, year, quarter, median_fare_usd`,
    [homes],
  );
  for (const r of nq.rows) {
    out.push(`    quarterly ${r.year} Q${r.quarter} ${r.origin}->${r.destination}: p25 $${Math.round(Number(r.p25_fare_usd))} · median $${Math.round(Number(r.median_fare_usd))} · p75 $${Math.round(Number(r.p75_fare_usd))} (${r.passengers_sampled ?? "?"} passengers sampled)`);
  }
  const nb = await db.query<{ origin: string; destination: string; depart_date: unknown; price_usd: string }>(
    `select origin, destination, depart_date, price_usd from flight_observations
      where source = 'serpapi_flights' and origin = any($1) order by destination, depart_date, origin`,
    [homes],
  );
  // Owner, 2026-10-10: "Do we have international fares from each of the top
  // 10 airports?" Every home airport we offer, with what we've bought from it.
  const byOrigin = await db.query<{ origin: string; destination: string; n: string }>(
    `select origin, destination, count(*) as n from flight_observations
      where source = 'serpapi_flights' group by 1, 2`,
  );
  const searched = await db.query<{ origin: string; n: string }>(
    `select origin, sum(searches) as n from search_days group by 1`,
  ).catch(() => ({ rows: [] as { origin: string; n: string }[] }));
  const searchesBy = new Map(searched.rows.map((r) => [r.origin, Number(r.n)]));
  const { ORIGINS: FREE, PLUS_ORIGINS: PLUS } = await import("../config.js");
  const intlDests = ["CDG", "NRT", "HND", "PVG", "HKG"];
  out.push("## Fares bought, by home airport (all paid fares in the record)");
  out.push("  airport  list  US  intl  CDG NRT HND PVG HKG  searches");
  for (const o of [...FREE.map((x) => ({ ...x, list: "free" })), ...PLUS.map((x) => ({ ...x, list: "plus" }))]) {
    const rows = byOrigin.rows.filter((r) => r.origin === o.iata);
    const n = (d: string) => Number(rows.find((r) => r.destination === d)?.n ?? 0);
    const intl = intlDests.reduce((s, d) => s + n(d), 0);
    const us = rows.reduce((s, r) => s + Number(r.n), 0) - intl;
    out.push(`  ${o.iata.padEnd(7)}  ${o.list}  ${String(us).padStart(3)}  ${String(intl).padStart(4)}  ${intlDests.map((d) => String(n(d)).padStart(3)).join(" ")}  ${searchesBy.get(o.iata) ?? 0}`);
  }
  out.push("");
  const afl = await db.query<{ file: string; n: string; loaded: unknown }>(
    `select file, count(*) as n, max(loaded_at) as loaded from airport_fare_levels group by 1 order by 1`,
  ).catch(() => ({ rows: [] as { file: string; n: string; loaded: unknown }[] }));
  out.push(`  BTS airport fare tables held: ${afl.rows.map((r) => `${r.file} (${r.n})`).join(", ") || "none"}`);
  const lv = await db.query<{ code: string; year: number; quarter: number; avg_fare_usd: string; adjusted_fare_usd: string | null }>(
    `select code, year, quarter, avg_fare_usd, adjusted_fare_usd from airport_fare_levels
      where code = any($1) order by code, year, quarter`, [homes],
  ).catch(() => ({ rows: [] as { code: string; year: number; quarter: number; avg_fare_usd: string; adjusted_fare_usd: string | null }[] }));
  for (const r of lv.rows) out.push(`    ${r.code} ${r.year} Q${r.quarter}: average fare $${Math.round(Number(r.avg_fare_usd))}${r.adjusted_fare_usd ? ` ($${Math.round(Number(r.adjusted_fare_usd))} in 2026 Q2 dollars)` : ""}`);
  out.push(`  Fares we bought from these airports: ${nb.rows.length}`);
  for (const r of nb.rows) out.push(`    ${r.origin}->${r.destination} departing ${String(r.depart_date).slice(0, 15)}: $${Math.round(Number(r.price_usd))}`);
  out.push("");

  // Owner, 2026-10-11: "Is our candidate formula actually working?" The
  // Flights page's live column is graded partly on fares it already learned
  // from; fare_forecasts holds what BOTH formulas said before each fare was
  // bought, which is the fair head-to-head.
  out.push("## Candidate vs live: the fair test (numbers written down BEFORE buying)");
  try {
    const fs = await loadForecastScores(db, 30);
    const z = (x: { n: number; inZonePct: number | null; within5Pct: number | null; lowPct: number | null; highPct: number | null; typicalOffPct: number | null; medianPct: number | null }) =>
      `n ${x.n} · within ±10% ${x.inZonePct ?? "-"}% · ±5% ${x.within5Pct ?? "-"}% · low ${x.lowPct ?? "-"}% · high ${x.highPct ?? "-"}% · typically off ${x.typicalOffPct ?? "-"}% · middle fare leans ${x.medianPct ?? "-"}%`;
    out.push(`  since ${fs.since}, ${fs.n} graded, ${fs.noFare} with no fare; shown was a real fare ${fs.shownKinds.realFare}, an estimate ${fs.shownKinds.estimate}`);
    for (const [label, g] of [["US", fs.domestic], ["International", fs.international]] as const) {
      out.push(`  ${label}`);
      out.push(`    shown to travelers: ${z(g.shown)}`);
      out.push(`    live estimate:      ${z(g.live)}`);
      out.push(`    candidate:          ${z(g.candidate)}`);
    }
    const sb = await loadScoreboard(db, 30);
    out.push(`  Flights page (live partly in-sample, candidate leave-one-out):`);
    out.push(`    US live ${z(sb.compare.live.domestic)}`);
    out.push(`    US cand ${z(sb.compare.candidate.domestic)}`);
    out.push(`    Intl live ${z(sb.compare.live.international)}`);
    out.push(`    Intl cand ${z(sb.compare.candidate.international)}`);

    // Where the candidate misses: real / candidate, by destination and quarter.
    const inputs = await loadModelInputs(db, 90);
    const idx = inputs.fares.map((_, i) => i);
    const loo = leaveOneOut(inputs, idx);
    const groups = new Map<string, number[]>();
    const add = (k: string, v: number) => groups.set(k, [...(groups.get(k) ?? []), v]);
    for (const [i, pred] of loo) {
      const f = inputs.fares[i]!;
      const r = f.price / pred;
      const q = Math.ceil(Number(f.departDate.slice(5, 7)) / 3);
      add(`dest ${f.destination}`, r);
      add(`${isInternational(f.destination) ? "intl" : "US"} Q${q}`, r);
    }
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
    out.push("  Candidate (leave-one-out), real fare / candidate, median by group (1.00 = right on):");
    for (const [k, v] of [...groups].sort()) out.push(`    ${k.padEnd(10)} ${med(v).toFixed(2)} (${v.length} fares)`);
    const m = fitFareModel(inputs);
    const L = m.levers;
    out.push(`  What the candidate has learned: calibration US ${L.calibration.dom.toFixed(2)} · Europe ${L.calibration.europe.toFixed(2)} · Asia ${L.calibration.asia.toFixed(2)}`);
    out.push(`    destination: ${Object.entries(L.destination).sort().map(([k, v]) => `${k} ${v.factor.toFixed(2)} (${v.fares})`).join(", ")}`);
    out.push(`    season: ${Object.entries(L.season).sort().map(([k, v]) => `${k} ${v.factor.toFixed(2)} (${v.fares})`).join(", ")}`);
    out.push(`    month (on top of the quarter): ${Object.entries(L.month).sort().map(([k, v]) => `${k} ${v.factor.toFixed(2)} (${v.fares})`).join(", ")}`);
    out.push(`    budget airlines (US): slope ${L.budget.slope.toFixed(2)} per 100% share (mean share ${(100 * L.budget.meanShare).toFixed(0)}%, ${L.budget.fares} fares): a route 10 points above the mean prices ${((Math.exp(L.budget.slope * 0.1) - 1) * 100).toFixed(1)}%`);
    out.push(`    day of week, from ${L.dayOfWeekFrom}: ${Object.entries(L.dayOfWeek).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${WEEKDAYS[Number(k)]} ${v.factor.toFixed(2)} (${v.fares})`).join(", ")}`);
    for (const [o, d, dt] of [["ATL", "MCO", "2027-03-15"], ["RDU", "CDG", "2027-06-15"], ["ATL", "NRT", "2027-03-15"], ["CLT", "LAX", "2027-03-15"]] as const) {
      const p = m.predict(o, d, dt as never);
      out.push(`    sample ${o}->${d} ${dt}: ${p ? `$${Math.round(p.value)} = prior $${p.parts.prior} (${p.parts.priorKind}) x calib ${p.parts.calibration.toFixed(2)} x dest ${p.parts.destination.toFixed(2)} x season ${p.parts.season.toFixed(2)} x month ${p.parts.month.toFixed(2)} x day ${p.parts.dayOfWeek.toFixed(2)} x budget ${p.parts.budget.toFixed(2)} x route ${p.parts.route.toFixed(2)} (${p.parts.routeSearches} searches)` : "none"}`);
    }
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  // Owner, 2026-10-12: "WHY ARE WE NOT USING DATA?!" Google's usual hotel
  // prices and booking-site prices now feed pricing; this is the report.
  out.push("## Hotels: what Google tells us beyond the price, and how close we are (hotelLearning.ts)");
  try {
    const { loadHotelLearning, hotelLearningLines } = await import("../hotelLearning.js");
    for (const l of hotelLearningLines(await loadHotelLearning(db))) out.push(`  ${l}`);
    const { loadHotelScoreboard } = await import("../hotelScoreboard.js");
    const hs = await loadHotelScoreboard(db);
    const z = (name: string, x: { n: number; inZonePct: number | null; typicalOffPct: number | null; medianPct: number | null }) =>
      out.push(`  ${name}: ${x.n ? `${x.inZonePct}% within ±${hs.zonePct}%, typically off ${x.typicalOffPct}%, middle leans ${x.medianPct}% (${x.n})` : "none yet"}`);
    z("Disney hotels, what travelers see vs Google", hs.graded.disney.all);
    z("Off-property, what we showed vs the next search", hs.graded.offProperty.all);
    z("Your hotel price checks", hs.graded.hotelChecks.all);
    for (const r of hs.graded.disney.byResort) z(`  Disney hotels at ${r.name}`, r.score);
    for (const r of hs.disney.rows.slice(0, 12)) {
      out.push(`    ${r.resort} ${r.hotel} ${r.month}: our base $${Math.round(r.ours)}, shown $${Math.round(r.shown)}, Google $${Math.round(r.google)} (shown ${r.shownPct > 0 ? "+" : ""}${r.shownPct}%)`);
    }
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  // Owner, 2026-10-12: "Omaha to MCO we show $450, Kayak $400-700 with most
  // at ~$500: that works. Omaha to Tokyo we show $2,000, Kayak $800-2,000
  // with most at $1,200." Two questions, both read-only: (1) inside one
  // Google answer, where does the itinerary we keep (the MIDDLE one) sit
  // against the cheapest and the most common price, US vs abroad? (2) what
  // does a traveler see today for an international route we never bought?
  out.push("## Inside one Google answer: the middle itinerary vs the most common price (last 30 days)");
  try {
    const ra = await db.query<{ request: unknown; body_gz: Uint8Array }>(
      `select request, body_gz from provider_responses
        where kind = 'google_flights' and status = 200 and fetched_at > now() - interval '30 days'`,
    );
    type Sp = { n: number; min: number; p25: number; mid: number; common: number; stops: number; twoStopShare: number; hours: number };
    const per: Record<string, Sp[]> = { US: [], Europe: [], Asia: [] };
    const q = (s: number[], f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]!;
    for (const r of ra.rows) {
      const req = (typeof r.request === "string" ? JSON.parse(r.request) : r.request) as Record<string, string>;
      let json: { best_flights?: { price?: number; type?: string; flights?: unknown[]; total_duration?: number }[];
                  other_flights?: { price?: number; type?: string; flights?: unknown[]; total_duration?: number }[] };
      try { json = JSON.parse(unzipBody(r.body_gz)); } catch { continue; }
      const all = [...(json.best_flights ?? []), ...(json.other_flights ?? [])].filter((f) => Number(f.price) > 0);
      const rt = all.filter((f) => !f.type || /round/i.test(f.type));
      const pool = (rt.length ? rt : all).sort((a, b) => a.price! - b.price!);
      if (pool.length < 3) continue;
      const prices = pool.map((f) => f.price!);
      const pick = pool[Math.floor((pool.length - 1) / 2)]!;
      // "Most common": the fullest 10%-wide price band, its middle.
      let best = { count: 0, at: prices[0]! };
      for (const p0 of prices) {
        const c = prices.filter((p) => p >= p0 && p < p0 * 1.1).length;
        if (c > best.count) best = { count: c, at: Math.sqrt(p0 * p0 * 1.1) };
      }
      const dest = String(req.arrival_id ?? "");
      const region = !isInternational(dest) ? "US" : dest === "CDG" || dest === "ORY" ? "Europe" : "Asia";
      per[region]!.push({ n: pool.length, min: prices[0]!, p25: q(prices, 0.25), mid: pick.price!, common: best.at,
        stops: Math.max(0, (pick.flights?.length ?? 1) - 1),
        twoStopShare: pool.filter((f) => (f.flights?.length ?? 1) >= 3).length / pool.length,
        hours: (pick.total_duration ?? 0) / 60 });
    }
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
    for (const [region, xs] of Object.entries(per)) {
      if (!xs.length) { out.push(`  ${region}: no kept answers`); continue; }
      out.push(`  ${region}: ${xs.length} searches, ${Math.round(med(xs.map((x) => x.n)))} itineraries each (median).`
        + ` Against the middle one we keep: cheapest x${med(xs.map((x) => x.min / x.mid)).toFixed(2)},`
        + ` quarter-way up x${med(xs.map((x) => x.p25 / x.mid)).toFixed(2)},`
        + ` most common price x${med(xs.map((x) => x.common / x.mid)).toFixed(2)}.`
        + ` The middle one: ${med(xs.map((x) => x.stops))} stop(s), ${med(xs.map((x) => x.hours)).toFixed(1)} h outbound;`
        + ` ${Math.round(med(xs.map((x) => x.twoStopShare)) * 100)}% of itineraries have 2+ stops.`);
    }
    out.push("  (x1.00 = the same as the fare we keep and grade against; below 1 = cheaper than it.)");
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");
  out.push("## What a traveler sees today for an international route we never bought (Kansas City, the nearest origin to Omaha)");
  try {
    const { loadBook } = await import("../book.js");
    const { quotedEstimate } = await import("../pricing.js");
    const { loadFareModel } = await import("../fareModelDb.js");
    const { plannableMonths } = await import("../config.js");
    const model = await loadFareModel(db);
    const bought = await db.query<{ destination: string; m: string; n: string; med: string }>(
      `select destination, to_char(depart_date, 'YYYY-MM') as m, count(*)::text as n,
              percentile_cont(0.5) within group (order by price_usd)::text as med
         from flight_observations where source = 'serpapi_flights' and destination in ('HND','NRT','CDG')
        group by 1, 2`,
    );
    for (const dest of ["HND", "CDG"]) {
      const resort = RESORTS.find((r) => r.iata === dest || r.altArrivalAirports.some((a) => a.iata === dest))!;
      const cells: string[] = [];
      for (const m of plannableMonths(todayISO())) {
        const date = `${m}-15`;
        const book = await loadBook(db, { origin: "MCI", destinations: [dest], resortIds: [resort.id], from: date, to: date, tripLength: 7 }, { formula: "live" });
        const live = quotedEstimate(book, "MCI", dest, date);
        const cand = model.predict("MCI", dest, date)?.value;
        const others = bought.rows.filter((r) => r.m === m && (dest === "CDG" ? r.destination === "CDG" : r.destination !== "CDG"));
        const n = others.reduce((t, r) => t + Number(r.n), 0);
        const otherMed = others.length ? Math.round(Math.max(...others.map((r) => Number(r.med)))) : null;
        cells.push(`${m}: shown $${live ? Math.round(live) : "—"}, candidate $${cand ? Math.round(cand) : "—"}`
          + (n ? `, bought from other cities $${otherMed} (${n})` : ""));
      }
      out.push(`  MCI -> ${dest}:`);
      for (const c of cells) out.push(`    ${c}`);
    }
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  // Owner, 2026-10-12: "The 15th consistently lands on different days
  // depending what month we are in. We should be learning from that AND
  // travel payouts." What each source says about weekday and lead time.
  out.push("## Day of week and booking ahead: what the data says");
  try {
    const paid = await db.query<{ dow: number; n: string; dom: string; intl: string }>(
      `select extract(dow from depart_date)::int as dow, count(*)::text as n,
              count(*) filter (where destination in ('MCO','TPA','SNA','LAX'))::text as dom,
              count(*) filter (where destination not in ('MCO','TPA','SNA','LAX'))::text as intl
         from flight_observations where source = 'serpapi_flights' group by 1 order by 1`);
    out.push("  Paid fares by departure weekday (the 15th until 2026-10-12, then the 8th-22nd by route):");
    out.push(`    ${paid.rows.map((r) => `${WEEKDAYS[r.dow]} ${r.n} (US ${r.dom}, intl ${r.intl})`).join(" · ") || "none"}`);
    const tp = await db.query<{ origin: string; destination: string; depart_date: unknown; trip_length: number; price_usd: string }>(
      `select distinct on (origin, destination, depart_date, trip_length)
              origin, destination, depart_date, trip_length, price_usd
         from flight_observations where source like 'travelpayouts%'
        order by origin, destination, depart_date, trip_length, observed_at desc`);
    const rows = tp.rows.map((r) => ({
      origin: r.origin, destination: r.destination, tripLength: r.trip_length, price: Number(r.price_usd),
      departDate: r.depart_date instanceof Date ? r.depart_date.toISOString().slice(0, 10) : String(r.depart_date).slice(0, 10),
    }));
    const pat = weekdayPattern(rows);
    out.push(`  Free feed (Travelpayouts): ${rows.length} distinct route-date fares; weekday vs the same route, month and trip length:`);
    out.push(`    ${pat.map((p) => `${WEEKDAYS[p.day]} ${p.factor.toFixed(2)} (${p.fares} fares, ${p.groups} route-months)`).join(" · ") || "no route-month has fares on two weekdays yet"}`);
    const lead = await db.query<{ b: string; n: string }>(
      `select width_bucket((depart_date - observed_at::date), 0, 390, 13)::text as b, count(*)::text as n
         from flight_observations where source like 'travelpayouts%' group by 1 order by 1::int`);
    out.push(`  Free feed, how far ahead each fare was seen (30-day buckets): ${lead.rows.map((r) => `${(Number(r.b) - 1) * 30}-${Number(r.b) * 30}d ${r.n}`).join(", ") || "none"}`);
    const ph = await db.query<{ history: unknown; depart_date: unknown }>(
      `select history, depart_date from flight_insights where history is not null`);
    const byLead = new Map<number, number[]>();
    for (const r of ph.rows) {
      const h = (typeof r.history === "string" ? JSON.parse(r.history) : r.history) as [number, number][];
      if (!Array.isArray(h) || h.length < 2) continue;
      const dep = Date.parse((r.depart_date instanceof Date ? r.depart_date.toISOString() : String(r.depart_date)).slice(0, 10) + "T00:00:00Z");
      const last = h[h.length - 1]![1];
      for (const [t, p] of h) {
        const b = Math.floor((dep - t * 1000) / 86_400_000 / 30);
        byLead.set(b, [...(byLead.get(b) ?? []), p / last]);
      }
    }
    const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]!; };
    out.push(`  Google's price history: ${ph.rows.length} searches carry one. Price vs the day we searched, by months before departure:`);
    out.push(`    ${[...byLead].sort(([a], [b]) => a - b).map(([b, v]) => `${b * 30}-${b * 30 + 30}d ${med(v).toFixed(2)} (${v.length} points)`).join(" · ") || "none"}`);
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  // Owner, 2026-10-12: "What is the likelihood we actually get to 90%
  // correct prices within 10% error?" Two real fares for the SAME route,
  // date and trip length, seen on different days, show how far apart reality
  // is with itself. No formula can beat that.
  // Owner, 2026-10-12: "can we read those columns please?" (the airline
  // columns of BTS's monthly survey) and "Our US data seems SO off". Which
  // survey figure lines up best with what our paid US fares actually cost?
  out.push("## Airlines on each route (BTS monthly survey), and which survey figure fits our US fares");
  try {
    const mo = await db.query<{ origin: string; destination: string; month: number; median_fare_usd: string;
      median_no_budget_usd: string | null; budget_share: string | null; carriers: unknown; window_medians: unknown; itin_count: number }>(
      `select distinct on (origin, destination, month) origin, destination, month, median_fare_usd,
              median_no_budget_usd, budget_share, carriers, window_medians, itin_count
         from historical_fares_monthly where carriers is not null and itin_count >= 30
        order by origin, destination, month, year desc, loaded_at desc`);
    out.push(`  route-months with airline figures: ${mo.rows.length}`);
    const js = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Record<string, number>;
    for (const r of mo.rows.filter((x) => ["ATL-MCO", "RDU-MCO", "CLT-MCO", "DEN-MCO", "ATL-LAX", "RDU-LAX"].includes(`${x.origin.trim()}-${x.destination.trim()}`))) {
      const c = Object.entries(js(r.carriers)).sort((a, b) => b[1] - a[1]);
      const tot = c.reduce((s, [, v]) => s + v, 0);
      out.push(`    ${r.origin.trim()}->${r.destination.trim()} month ${r.month}: median $${Math.round(Number(r.median_fare_usd))}, without budget airlines $${r.median_no_budget_usd ? Math.round(Number(r.median_no_budget_usd)) : "-"}, budget share ${Math.round(100 * Number(r.budget_share))}%; airlines ${c.slice(0, 6).map(([k, v]) => `${k} ${Math.round((100 * v) / tot)}%`).join(", ")}`);
      out.push(`      by how far ahead: ${Object.entries(js(r.window_medians)).sort().map(([k, v]) => `${k} $${Math.round(v)}`).join(", ")}`);
    }
    const all = await db.query<{ k: string; pax: string }>(
      `select k, round(sum(v::numeric))::text as pax from (
         select distinct on (origin, destination, month) window_medians, purchase_window
           from historical_fares_monthly where carriers is not null
          order by origin, destination, month, year desc, loaded_at desc) m,
         jsonb_each_text(m.purchase_window) as w(k, v) group by k order by k`);
    out.push(`  purchase-window groups (BTS's codes) and passengers: ${all.rows.map((r) => `${r.k} ${r.pax}`).join(", ")}`);

    // Each US paid fare against the survey for the same route and calendar
    // month: plain median vs median without budget airlines. After one
    // overall scale, how far off is each? Lower = the better footing.
    const paid = await db.query<{ origin: string; destination: string; depart_date: unknown; price_usd: string }>(
      `select origin, destination, depart_date, price_usd from flight_observations
        where source = 'serpapi_flights' and destination in ('MCO','TPA','LAX','SNA')`);
    const key = (o: string, d: string, m: number) => `${o}|${d}|${m}`;
    const byKey = new Map(mo.rows.map((r) => [key(r.origin.trim(), r.destination.trim(), r.month), r]));
    const rowsU: { plain: number; noBudget: number; share: number; w91?: number; w22?: number }[] = [];
    for (const f of paid.rows) {
      const d = f.depart_date instanceof Date ? f.depart_date.toISOString() : String(f.depart_date);
      const m = byKey.get(key(f.origin.trim(), f.destination.trim(), Number(d.slice(5, 7))));
      if (!m || !m.median_no_budget_usd) continue;
      const p = Number(f.price_usd);
      const wm = js(m.window_medians);
      rowsU.push({ plain: Math.log(p / Number(m.median_fare_usd)), noBudget: Math.log(p / Number(m.median_no_budget_usd)), share: Number(m.budget_share),
        w91: wm["91UP"] ? Math.log(p / wm["91UP"]) : undefined, w22: wm["2290"] ? Math.log(p / wm["2290"]) : undefined });
    }
    const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)]! : NaN; };
    const fit = (xs: number[]) => {
      const c = med(xs);
      const offs = xs.map((x) => Math.abs(Math.exp(x - c) - 1));
      return `scale x${Math.exp(c).toFixed(2)}, then typically off ${(100 * med(offs)).toFixed(1)}%, ${Math.round((100 * offs.filter((o) => o <= 0.1).length) / Math.max(1, offs.length))}% within ±10%`;
    };
    out.push(`  US paid fares with a survey row for the same route and calendar month: ${rowsU.length}`);
    if (rowsU.length) {
      out.push(`    against the plain survey median:            ${fit(rowsU.map((r) => r.plain))}`);
      out.push(`    against the median without budget airlines: ${fit(rowsU.map((r) => r.noBudget))}`);
      const w91 = rowsU.filter((r) => r.w91 != null), w22 = rowsU.filter((r) => r.w22 != null);
      out.push(`    against the median of tickets bought 91+ days ahead (${w91.length}): ${fit(w91.map((r) => r.w91!))}; plain median on the same fares: ${fit(w91.map((r) => r.plain))}`);
      out.push(`    against the median of tickets bought 22-90 days ahead (${w22.length}): ${fit(w22.map((r) => r.w22!))}`);
      const lo = rowsU.filter((r) => r.share < 0.1), hi = rowsU.filter((r) => r.share >= 0.1);
      out.push(`    paid / plain median: routes under 10% budget airlines x${Math.exp(med(lo.map((r) => r.plain))).toFixed(2)} (${lo.length}), 10%+ budget x${Math.exp(med(hi.map((r) => r.plain))).toFixed(2)} (${hi.length})`);
    }
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  out.push("## The noise floor: the same flight, priced on two different days");
  try {
    const pairs = async (sourceSql: string, minLead: number) => (await db.query<{ n: string; w10: string; w5: string; med: string }>(
      `with o as (
         select origin, destination, depart_date, trip_length, price_usd, observed_at::date as day
           from flight_observations where ${sourceSql} and (depart_date - observed_at::date) >= $1),
       p as (
         select abs(b.price_usd - a.price_usd) / a.price_usd as gap
           from o a join o b on a.origin = b.origin and a.destination = b.destination
            and a.depart_date = b.depart_date and a.trip_length = b.trip_length and b.day > a.day)
       select count(*)::text as n,
              coalesce(round(100.0 * avg(case when gap <= 0.10 then 1 else 0 end)), 0)::text as w10,
              coalesce(round(100.0 * avg(case when gap <= 0.05 then 1 else 0 end)), 0)::text as w5,
              coalesce(round(100 * percentile_cont(0.5) within group (order by gap)::numeric, 1), 0)::text as med
         from p`, [minLead])).rows[0]!;
    const paid = await pairs(`source = 'serpapi_flights'`, 0);
    out.push(`  Paid fares bought twice (same route, date, trip length): ${paid.n} pairs; within 10% of each other ${paid.w10}%, within 5% ${paid.w5}%, typically apart ${paid.med}%`);
    // The free feed can't answer this: it hands back the same stored price
    // night after night, so "the same flight on two days" there is mostly
    // the same number twice. Google's own day-by-day history can.
    const hist = await db.query<{ history: unknown }>(`select history from flight_insights where history is not null`);
    let pts = 0, in10 = 0;
    for (const r of hist.rows) {
      const h = (typeof r.history === "string" ? JSON.parse(r.history) : r.history) as [number, number][];
      if (!Array.isArray(h) || h.length < 2) continue;
      const last = h[h.length - 1]![1];
      for (const [, p] of h.slice(0, -1)) { pts++; if (Math.abs(p - last) / last <= 0.10) in10++; }
    }
    out.push(`  Google's price history (the cheapest seat, day by day, up to ~2 months before we searched): ${pts} days from ${hist.rows.length} searches; ${pts ? Math.round((100 * in10) / pts) : 0}% within 10% of the price on the day we searched`);
    // Different days in the same month: what quoting one number for a whole
    // month (or a typical day) is up against.
    const spread = await db.query<{ n: string; w10: string }>(
      `with f as (
         select distinct on (origin, destination, depart_date, trip_length)
                origin, destination, depart_date, trip_length, price_usd
           from flight_observations where source like 'travelpayouts%'
          order by origin, destination, depart_date, trip_length, observed_at desc),
       g as (
         select origin, destination, date_trunc('month', depart_date) as m, trip_length,
                percentile_cont(0.5) within group (order by price_usd) as mid, count(*) as n
           from f group by 1, 2, 3, 4)
       select count(*)::text as n,
              coalesce(round(100.0 * avg(case when abs(f.price_usd - g.mid) / g.mid <= 0.10 then 1 else 0 end)), 0)::text as w10
         from f join g on g.origin = f.origin and g.destination = f.destination and g.trip_length = f.trip_length
          and g.m = date_trunc('month', f.depart_date)
        where g.n >= 3`);
    const sp = spread.rows[0]!;
    out.push(`  Free feed, different days in the same route and month: ${sp.n} fares; ${sp.w10}% within 10% of that month's middle`);
    out.push("  (However often reality lands within 10% of itself is roughly the ceiling for any formula.)");
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  out.push("## Indicator study (the /admin tab), graded on fares each model never saw");
  try {
    const st = await loadIndicatorStudy(db);
    const cv = (c: { medianOffPct: number; within10Pct: number } | null | undefined) =>
      c ? `${c.within10Pct}% within ±10%, typically off ${c.medianOffPct}%` : "not enough fares";
    out.push(`  Model 1 (route, season, timing): ${st.structure?.fares ?? 0} fares; ${cv(st.structure?.cv)}; plain model ${cv(st.structure?.plainCv)}`);
    out.push(`  Model 2 (+ Google's typical price only, as before 2026-10-12): ${cv(st.model2.beforeNewSignals)}`);
    out.push(`  Model 2 (+ price level, flight options, free-feed fare): ${st.withGoogle?.fares ?? 0} fares; ${cv(st.withGoogle?.cv)}; ${st.model2.withFeedFare} fares had a free-feed fare that week`);
    for (const e of st.withGoogle?.effects ?? []) {
      out.push(`    ${e.label}: ${e.effectPct == null ? "can't tell" : `${e.effectPct >= 0 ? "+" : ""}${e.effectPct}%`} (${e.verdict}${e.agreePct != null ? `, ${e.agreePct}% agree` : ""}), moves fares ${e.weightPct ?? "-"}%`);
    }
  } catch (e) {
    out.push(`  could not compute: ${(e as Error).message}`);
  }
  out.push("");

  // Owner, 2026-10-11: a Paris ticket check read -6% when the real price was
  // far above ours. The last few checks exactly as stored.
  out.push("## Latest price checks, as stored");
  const pc = await db.query<Record<string, unknown>>(
    `select checked_on, resort_id, category, item, detail, start_date, end_date, adults, seniors, children_ages,
            amount, currency, price_is, unit_usd, unit, match_key, model_usd, app_usd, not_counted, source
       from price_checks order by created_at desc nulls last limit 6`,
  ).catch(async () => db.query<Record<string, unknown>>(`select * from price_checks order by checked_on desc limit 6`));
  for (const r of pc.rows) out.push("  " + JSON.stringify(r));
  out.push("");

  out.push("## Baseline sanity — are these round trips?");
  const nat = await nationalBtsAverage(db);
  if (!nat) {
    out.push("No BTS rows to check. Run the bts-baseline workflow.");
  } else {
    const nationalAvg = nat.avg;
    out.push(`Our national passenger-weighted average: $${nationalAvg.toFixed(2)}`
      + ` (${nat.routes} routes, ${Math.round(nat.passengers).toLocaleString("en-US")} passengers sampled)`);
    out.push(`BTS's published average domestic itinerary fare: roughly $${BTS_PUBLISHED_AVG_USD} in recent years.`);
    const verdict = basisVerdict(nationalAvg);
    if (verdict === "low") {
      out.push(`*** SUSPICIOUS — far below $${BTS_PUBLISHED_AVG_USD}. The baseline looks like ONE LEG`);
      out.push(`    rather than a round trip, which halves every domestic estimate. Check that`);
      out.push(`    db/schema.sql has run (npm run migrate) and see src/jobs/btsBaseline.ts.`);
    } else if (verdict === "high") {
      out.push(`*** SUSPICIOUS — far ABOVE $${BTS_PUBLISHED_AVG_USD}. Check the fare is not being doubled twice.`);
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
