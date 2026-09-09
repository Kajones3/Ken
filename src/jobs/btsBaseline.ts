/**
 * Historical baseline fares from the BTS DB1B Market survey — real, free,
 * no API key, but also no live download endpoint: a GitHub Actions
 * workflow downloads and unzips the quarterly file (see
 * .github/workflows/bts-baseline.yml), and this module only ever touches
 * the already-extracted CSV.
 *
 * Confirmed against a real downloaded 2024 Q4 file (2026-09-08): the
 * header includes Origin, Dest, Passengers, MktFare, Year, Quarter, and
 * MktFare is the full round-trip fare per itinerary — each direction of a
 * round trip is a separate row sharing the same ItinID and the same
 * MktFare value, not half of it — so a route average is a straight
 * passenger-weighted average of MktFare, no halving/doubling needed. One
 * quarter's file is ~8.5 million rows, so this streams the CSV line by
 * line rather than ever loading it into memory.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { RESORTS, ORIGINS } from "../config.js";
import type { Db } from "../db.js";

export interface RouteAggregate {
  avgFareUsd: number;
  /** Passenger-weighted percentiles of the real fare distribution on this
   *  route. The shown estimate is built on `medianFareUsd`; p25/p75 are the
   *  Low/High band. The mean is kept alongside because it is what the
   *  original baseline used, but it is not what gets displayed: a mean is
   *  pulled down by deep-discount and partial itineraries that nobody
   *  pricing a family trip will actually be quoted. */
  p25FareUsd: number;
  medianFareUsd: number;
  p75FareUsd: number;
  passengersSampled: number;
  itinCount: number;
}

/**
 * Passenger-weighted percentile over (fare, weight) pairs, using the
 * "smallest fare whose cumulative weight reaches p of the total" rule —
 * the same definition Postgres's `percentile_disc` uses. Weighted because
 * BTS's Passengers column is a sample weight: one row standing for 40
 * passengers must count 40 times as much as a row standing for 1, or a
 * handful of odd single-passenger itineraries drag the median around.
 *
 * Exported for its own test — percentile code is exactly the kind of thing
 * that looks right and is off by one.
 */
export function weightedPercentile(pairs: { fare: number; weight: number }[], p: number): number {
  if (!pairs.length) return 0;
  const sorted = [...pairs].sort((a, b) => a.fare - b.fare);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return sorted[Math.floor((sorted.length - 1) * p)]!.fare;
  const target = total * p;
  let cum = 0;
  for (const x of sorted) {
    cum += x.weight;
    if (cum >= target) return x.fare;
  }
  return sorted[sorted.length - 1]!.fare;
}

/**
 * Quote-aware split of one CSV line. Every field in the real BTS file is
 * double-quoted and comma-separated with no embedded commas seen inside a
 * quoted field in a real sample — simple enough to not need a dependency.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

export interface AggregateOptions { origins: Set<string>; destinations: Set<string> }

/**
 * Streams a DB1B Market CSV, filtering to routes we actually care about
 * (both origin and destination), and returns a passenger-weighted average
 * fare per "origin|destination". Column positions are read from the
 * file's own header row rather than hardcoded, in case BTS reorders them.
 */
export async function aggregateDb1bFile(
  input: Readable,
  opts: AggregateOptions,
): Promise<Map<string, RouteAggregate>> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let cols: Record<string, number> | null = null;
  // Each route keeps its own fare samples so a real percentile can be taken
  // at the end. Bounded by construction: only the ~19 origins x ~11 resort
  // airports we actually price are kept, so this is a couple hundred routes,
  // not the file's 8.5 million rows.
  const sums = new Map<string, {
    fareWeighted: number; passengers: number; itinCount: number;
    samples: { fare: number; weight: number }[];
  }>();

  for await (const line of rl) {
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (!cols) {
      cols = {};
      fields.forEach((name, i) => { cols![name] = i; });
      continue;
    }
    const origin = fields[cols["Origin"]!];
    const dest = fields[cols["Dest"]!];
    if (!origin || !dest || !opts.origins.has(origin) || !opts.destinations.has(dest)) continue;

    const fare = Number(fields[cols["MktFare"]!]);
    if (!Number.isFinite(fare) || fare <= 0) continue; // never write junk into the baseline
    // Passengers is BTS's own per-row sample weight; guard the rare
    // zero/missing case as weight 1 rather than dividing by zero.
    const passengersRaw = Number(fields[cols["Passengers"]!]);
    const passengers = Number.isFinite(passengersRaw) && passengersRaw > 0 ? passengersRaw : 1;

    const key = `${origin}|${dest}`;
    const acc = sums.get(key) ?? { fareWeighted: 0, passengers: 0, itinCount: 0, samples: [] };
    acc.fareWeighted += fare * passengers;
    acc.passengers += passengers;
    acc.itinCount += 1;
    acc.samples.push({ fare, weight: passengers });
    sums.set(key, acc);
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const out = new Map<string, RouteAggregate>();
  for (const [key, acc] of sums) {
    out.set(key, {
      avgFareUsd: r2(acc.fareWeighted / acc.passengers),
      p25FareUsd: r2(weightedPercentile(acc.samples, 0.25)),
      medianFareUsd: r2(weightedPercentile(acc.samples, 0.5)),
      p75FareUsd: r2(weightedPercentile(acc.samples, 0.75)),
      passengersSampled: Math.round(acc.passengers),
      itinCount: acc.itinCount,
    });
  }
  return out;
}

export async function upsertHistoricalFares(
  db: Db, year: number, quarter: number, agg: Map<string, RouteAggregate>,
): Promise<number> {
  const entries = [...agg.entries()];
  if (!entries.length) return 0;
  let written = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const vals: unknown[] = [];
    const tuples = chunk.map(([key, a], j) => {
      const [origin, destination] = key.split("|");
      const b = j * 10;
      vals.push(origin, destination, year, quarter, a.avgFareUsd,
        a.p25FareUsd, a.medianFareUsd, a.p75FareUsd, a.passengersSampled, a.itinCount);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},now())`;
    });
    await db.query(
      `insert into historical_fares
         (origin,destination,year,quarter,avg_fare_usd,
          p25_fare_usd,median_fare_usd,p75_fare_usd,passengers_sampled,itin_count,fetched_at)
       values ${tuples.join(",")}
       on conflict (origin,destination,year,quarter) do update set
         avg_fare_usd = excluded.avg_fare_usd,
         p25_fare_usd = excluded.p25_fare_usd,
         median_fare_usd = excluded.median_fare_usd,
         p75_fare_usd = excluded.p75_fare_usd,
         passengers_sampled = excluded.passengers_sampled,
         itin_count = excluded.itin_count, fetched_at = excluded.fetched_at`,
      vals,
    );
    written += chunk.length;
  }
  return written;
}

/** Every airport a saved trip could actually be priced into. */
export function resortDestinations(): Set<string> {
  return new Set(RESORTS.flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]));
}
/** Every departure city this app supports. */
export function originIatas(): Set<string> {
  return new Set(ORIGINS.map((o) => o.iata));
}

export interface BtsBaselineOptions { csvPath: string; year: number; quarter: number }

export async function runBtsBaseline(db: Db, opts: BtsBaselineOptions) {
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'bts_baseline',$2)`,
    [runId, `${opts.year} Q${opts.quarter}`]);

  let errors = 0;
  let agg: Map<string, RouteAggregate>;
  try {
    const { createReadStream } = await import("node:fs");
    agg = await aggregateDb1bFile(createReadStream(opts.csvPath), {
      origins: originIatas(), destinations: resortDestinations(),
    });
  } catch (e) {
    errors++;
    agg = new Map();
    console.error(`bts baseline parse failed for ${opts.year} Q${opts.quarter}:`, (e as Error).message);
  }
  const rows = await upsertHistoricalFares(db, opts.year, opts.quarter, agg);

  await db.query(
    `update fetch_runs set finished_at = now(), calls = 1, rows_written = $2, errors = $3 where id = $1`,
    [runId, rows, errors],
  );
  return { runId, routesWritten: rows, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import("../db.js");
  const csvPath = process.env.BTS_CSV_PATH;
  const year = Number(process.env.BTS_YEAR);
  const quarter = Number(process.env.BTS_QUARTER);
  if (!csvPath || !year || !quarter) {
    console.error("usage: BTS_CSV_PATH=<path> BTS_YEAR=2025 BTS_QUARTER=2 npm run bts-baseline");
    process.exit(1);
  }
  const db = await getDb();
  const res = await runBtsBaseline(db, { csvPath, year, quarter });
  console.log(`bts baseline done: ${res.routesWritten} routes written, ${res.errors} errors`);
  await db.close();
}
