/**
 * Monthly: sample real fares on every international route, then turn them
 * into per-quarter baselines.
 *
 * Domestic routes get their baseline free, from the BTS DB1B survey.
 * International routes get nothing — DB1B is US-domestic only (verified:
 * grepping a whole 2024 Q4 file for "CDG" returns zero rows). So the only
 * way Paris, Tokyo, Shanghai and Hong Kong can be priced at all is to buy a
 * few real fares and let those stand in for the survey.
 *
 * Cost, which is the whole reason this is monthly rather than nightly:
 *   19 origins x 5 international airports  = 95 routes
 *   x 12 travel months x 1 sampled date    = 1,140 metered lookups a month
 * That sits inside SerpApi's $75/month Developer plan (5,000 included) with
 * room to spare. Raising INTL_SWEEP_DATES multiplies it directly — 2 dates
 * is 2,280/month, 3 is 3,420 — so check the plan before turning it up.
 *
 * Bounded the same way every paid job here is: a route cap, a date cap, and
 * a hard per-run ceiling inside the provider. No SERPAPI_KEY, no spend.
 */
import { randomUUID } from "node:crypto";
import { ORIGINS } from "../config.js";
import { addDaysISO, monthKey, todayISO } from "../dates.js";
import { getDb, type Db } from "../db.js";
import { SerpApiFlightProvider } from "../providers/serpapiFlights.js";
import { TRIP_BUCKETS } from "../config.js";
import { internationalDestinations, runIntlBaseline } from "./intlBaseline.js";
import { sampleDates } from "./popularRoutes.js";

export interface IntlSweepOptions {
  months?: number;
  datesPerMonth?: number;
  origins?: string[];
  destinations?: string[];
  bucket?: number;
  provider?: Pick<SerpApiFlightProvider, "quote" | "budgetRemaining">;
  /** Skip the baseline rebuild — used by tests that assert on raw fares. */
  skipBaseline?: boolean;
}

export async function runIntlSweep(db: Db, opts: IntlSweepOptions = {}) {
  const months = opts.months ?? Number(process.env.INTL_SWEEP_MONTHS ?? 12);
  const datesPerMonth = opts.datesPerMonth ?? Number(process.env.INTL_SWEEP_DATES ?? 1);
  const origins = opts.origins ?? ORIGINS.map((o) => o.iata);
  // INTL_SWEEP_DESTINATIONS lets the workflow shard the sweep one airport
  // per job. 1,140 sequential lookups at ~180/hour is over 6 hours, past
  // GitHub's job ceiling — and a timeout would kill the run before the
  // baseline step, leaving fares bought but nothing built from them.
  const envDests = (process.env.INTL_SWEEP_DESTINATIONS ?? "")
    .split(",").map((d) => d.trim().toUpperCase()).filter(Boolean);
  const allIntl = internationalDestinations();
  const requested = opts.destinations ?? (envDests.length ? envDests : allIntl);
  // Never let an env var widen this beyond the app's own international list.
  const destinations = requested.filter((d) => allIntl.includes(d));
  if (!destinations.length) {
    throw new Error(
      `no international destinations to sweep (asked for ${requested.join(",") || "none"}; ` +
      `valid: ${allIntl.join(",")})`,
    );
  }
  // One trip length. The baseline this feeds is route-level, not per-bucket,
  // so a 4- and an 11-night search both read the same estimate — buying all
  // three lengths would triple the bill for a number that reads the same.
  const bucket = opts.bucket ?? TRIP_BUCKETS[Math.floor(TRIP_BUCKETS.length / 2)]!;

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'intl_sweep',$2)`,
    [runId, `${origins.length}x${destinations.length} routes, ${months}mo x ${datesPerMonth} dates`]);

  const today = todayISO();
  const travelMonths = Array.from({ length: months }, (_, i) => monthKey(addDaysISO(today, i * 30)));

  let calls = 0, rows = 0, errors = 0, misses = 0;
  const provider = opts.provider ?? new SerpApiFlightProvider();

  outer: for (const destination of destinations) {
    for (const origin of origins) {
      for (const month of travelMonths) {
        for (const date of sampleDates(month, datesPerMonth)) {
          if (date < today) continue;               // nobody can book the past
          if (provider.budgetRemaining <= 0) {
            console.warn("intl-sweep: provider budget exhausted, stopping early");
            break outer;
          }
          try {
            calls++;
            const q = await provider.quote(origin, destination, date, bucket);
            if (!q) { misses++; continue; }
            await db.query(
              `insert into flight_prices
                 (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,source,fetched_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'serpapi_flights',now())
               on conflict (origin,destination,depart_date,trip_length) do update set
                 price_usd = excluded.price_usd, carrier = excluded.carrier,
                 stops = excluded.stops, deep_link = excluded.deep_link,
                 source = excluded.source, fetched_at = excluded.fetched_at`,
              [q.origin, q.destination, q.departDate, q.tripLength,
               q.priceUsd, q.carrier ?? null, q.stops, q.deepLink ?? null],
            );
            rows++;
          } catch (e) {
            errors++;
            console.error(`intl ${origin}->${destination} ${date}:`, (e as Error).message);
          }
        }
      }
    }
  }

  // The point of the whole job: without this the fares above cover only the
  // exact dates bought, and every other international date stays a gap.
  const baseline = opts.skipBaseline ? null : await runIntlBaseline(db, { destinations });

  await db.query(
    `update fetch_runs set finished_at = now(), calls = $2, rows_written = $3, errors = $4,
       note = note || ' · ' || $5 where id = $1`,
    [runId, calls, rows, errors,
     `${misses} with no fare, ${baseline ? baseline.written : 0} baselines`],
  );
  return { runId, calls, rows, errors, misses, baseline };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.SERPAPI_KEY) {
    console.log("intl-sweep: SERPAPI_KEY not set — nothing bought, nothing changed.");
    process.exit(0);
  }
  const db = await getDb();
  const res = await runIntlSweep(db);
  console.log(
    `intl sweep done: ${res.calls} lookups, ${res.rows} real fares, ` +
    `${res.misses} with no fare, ${res.errors} errors, ` +
    `${res.baseline ? res.baseline.written : 0} route/quarter baselines written`,
  );
  await db.close();
}
