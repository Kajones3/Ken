/**
 * BTS's MONTHLY fare survey (DB1C, "OD40"), which replaced the quarterly
 * DB1B survey after June 2025 (owner, 2026-10-10: "Use the new numbers ...
 * DONT DELETE THE DATA WE ALREADY HAVE ... make sure we are pulling from the
 * most recent month we can").
 *
 * What the file is (read off the real March 2026 file, run 38062772723):
 * one row per TICKET, 13 million rows a month, with
 *   AirportGroupString  the whole path, e.g. "BNA:SFO:BNA" or
 *                       "AVP:IAD:BNA:IAD:AVP"
 *   RoundTrip           1.00 for a round trip
 *   TotalAmount         the whole ticket per passenger, taxes included
 *   TaxAmount           the taxes inside it
 *   Passengers          the row's sample weight
 *   SchFlYear/Month     the month the travel happens (not when it was bought)
 *   PurchaseWindowGroup how far ahead it was bought, BTS's own groups
 *
 * So unlike DB1B's Market file (one leg each, which we had to double), the
 * fare here is already the whole round trip. Only round trips whose path
 * goes out and comes back the same way are kept, and the turnaround airport
 * is the destination: "AVP:IAD:BNA:IAD:AVP" is AVP to BNA. Open-jaw and
 * one-way tickets are left out rather than guessed at.
 *
 * Tickets under $50 for a whole round trip are dropped: the file carries
 * award and staff tickets (e.g. $5.60 for ABQ-DEN, taxes only), and they are
 * not prices anyone is quoted.
 *
 * Rows go into historical_fares_monthly, APPEND-ONLY. The quarterly table is
 * never touched.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { Db } from "../db.js";
import { parseCsvLine, weightedPercentile, originIatas, resortDestinations } from "./btsBaseline.js";

export const DB1C_MIN_ROUND_TRIP_USD = 50;

/** The destination of a round trip that goes out and back the same way, or
 *  null. "BNA:SFO:BNA" -> SFO; "AVP:IAD:BNA:IAD:AVP" -> BNA; an open jaw
 *  ("MCO:IAH:DEN") or a one-way path -> null. */
export function turnaround(path: string): { origin: string; destination: string } | null {
  const p = path.split(":").map((s) => s.trim()).filter(Boolean);
  if (p.length < 3 || p.length % 2 === 0) return null;
  for (let i = 0; i < p.length; i++) if (p[i] !== p[p.length - 1 - i]) return null;
  const destination = p[(p.length - 1) / 2]!;
  if (destination === p[0]) return null;
  return { origin: p[0]!, destination };
}

export interface MonthlyAggregate {
  year: number; month: number; origin: string; destination: string;
  avgFareUsd: number; p25FareUsd: number; medianFareUsd: number; p75FareUsd: number;
  passengersSampled: number; itinCount: number;
  purchaseWindow: Record<string, number>;
}

export async function aggregateDb1cFile(
  input: Readable,
  opts: { origins: Set<string>; destinations: Set<string> },
): Promise<MonthlyAggregate[]> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let cols: Record<string, number> | null = null;
  const acc = new Map<string, {
    year: number; month: number; origin: string; destination: string;
    fareWeighted: number; passengers: number; itinCount: number;
    samples: { fare: number; weight: number }[]; windows: Record<string, number>;
  }>();
  const col = (name: string) => {
    const i = cols![name];
    if (i === undefined) throw new Error(`DB1C file has no ${name} column; columns are: ${Object.keys(cols!).join(", ")}`);
    return i;
  };
  let iPath = 0, iRt = 0, iTotal = 0, iPax = 0, iYear = 0, iMonth = 0, iWin = -1;

  for await (const line of rl) {
    if (!line) continue;
    const f = parseCsvLine(line);
    if (!cols) {
      cols = {};
      f.forEach((name, i) => { cols![name.trim()] = i; });
      iPath = col("AirportGroupString"); iRt = col("RoundTrip"); iTotal = col("TotalAmount");
      iPax = col("Passengers"); iYear = col("SchFlYear"); iMonth = col("SchFlMonth");
      iWin = cols["PurchaseWindowGroup"] ?? -1;
      continue;
    }
    if (Number(f[iRt]) !== 1) continue;
    const route = turnaround(f[iPath] ?? "");
    if (!route || !opts.origins.has(route.origin) || !opts.destinations.has(route.destination)) continue;
    const fare = Number(f[iTotal]);
    if (!Number.isFinite(fare) || fare < DB1C_MIN_ROUND_TRIP_USD) continue;
    const year = Number(f[iYear]), month = Number(f[iMonth]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    const paxRaw = Number(f[iPax]);
    const pax = Number.isFinite(paxRaw) && paxRaw > 0 ? paxRaw : 1;

    const key = `${route.origin}|${route.destination}|${year}|${month}`;
    const a = acc.get(key) ?? {
      year, month, origin: route.origin, destination: route.destination,
      fareWeighted: 0, passengers: 0, itinCount: 0, samples: [], windows: {},
    };
    a.fareWeighted += fare * pax;
    a.passengers += pax;
    a.itinCount += 1;
    a.samples.push({ fare, weight: pax });
    if (iWin >= 0) {
      const w = (f[iWin] ?? "").trim() || "unknown";
      a.windows[w] = (a.windows[w] ?? 0) + pax;
    }
    acc.set(key, a);
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...acc.values()].map((a) => ({
    year: a.year, month: a.month, origin: a.origin, destination: a.destination,
    avgFareUsd: r2(a.fareWeighted / a.passengers),
    p25FareUsd: r2(weightedPercentile(a.samples, 0.25)),
    medianFareUsd: r2(weightedPercentile(a.samples, 0.5)),
    p75FareUsd: r2(weightedPercentile(a.samples, 0.75)),
    passengersSampled: Math.round(a.passengers),
    itinCount: a.itinCount,
    purchaseWindow: a.windows,
  }));
}

/** Appends. Never updates or deletes: a second load of the same month sits
 *  beside the first, and readers take the newest. */
export async function insertMonthly(db: Db, rows: MonthlyAggregate[], file: string): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const vals: unknown[] = [];
    const tuples = chunk.map((a, j) => {
      const b = j * 13;
      vals.push(a.origin, a.destination, a.year, a.month, a.avgFareUsd, a.p25FareUsd, a.medianFareUsd,
        a.p75FareUsd, a.passengersSampled, a.itinCount, JSON.stringify(a.purchaseWindow), "bts_db1c", file);
      return `(${Array.from({ length: 13 }, (_, k) => `$${b + k + 1}`).join(",")})`;
    });
    await db.query(
      `insert into historical_fares_monthly
         (origin,destination,year,month,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,
          passengers_sampled,itin_count,purchase_window,source,file)
       values ${tuples.join(",")}`,
      vals,
    );
    written += chunk.length;
  }
  return written;
}

export async function runDb1cBaseline(db: Db, opts: { csvPath: string; file: string }) {
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'bts_db1c',$2)`, [runId, opts.file]);
  let errors = 0;
  let rows: MonthlyAggregate[] = [];
  try {
    const { createReadStream } = await import("node:fs");
    rows = await aggregateDb1cFile(createReadStream(opts.csvPath), {
      origins: originIatas(), destinations: resortDestinations(),
    });
  } catch (e) {
    errors++;
    console.error(`DB1C parse failed for ${opts.file}:`, (e as Error).message);
  }
  const written = rows.length ? await insertMonthly(db, rows, opts.file) : 0;
  const months = [...new Set(rows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`))].sort();
  await db.query(
    `update fetch_runs set finished_at = now(), calls = 1, rows_written = $2, errors = $3,
       note = note || ' · travel months ' || $4 where id = $1`,
    [runId, written, errors, months.join(" ") || "none"],
  );
  return { runId, written, errors, months };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import("../db.js");
  const csvPath = process.env.DB1C_CSV_PATH;
  if (!csvPath) {
    console.error("usage: DB1C_CSV_PATH=<path> DB1C_FILE=<name> npm run bts-db1c");
    process.exit(1);
  }
  const db = await getDb();
  const res = await runDb1cBaseline(db, { csvPath, file: process.env.DB1C_FILE ?? csvPath });
  console.log(`DB1C done: ${res.written} route-months written for ${res.months.join(", ") || "no months"}, ${res.errors} errors`);
  await db.close();
}
