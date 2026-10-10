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
  out.push(`  BTS quarters held: ${bq.rows.map((r) => `${r.year} Q${r.quarter} (${r.n})`).join(", ")}`);
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
