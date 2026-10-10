/**
 * BTS's average fare per airport and per metro area, from the files the
 * owner downloaded (2026-10-10). Kept in airport_fare_levels, append-only,
 * one load per file; the originals sit in data/bts/raw/ and their rows in
 * data/bts/airport-fares.csv.
 *
 * What these numbers are, so nobody reads more into them: an airport's
 * average round-trip fare across EVERY domestic destination its passengers
 * flew to that quarter, taxes included, frequent-flyer tickets left out. A
 * long-haul-heavy airport (Dulles) reads dear partly because of where its
 * people fly. For a fare to one resort use the route surveys instead
 * (historical_fares, historical_fares_monthly). Used as one indicator in the
 * indicator study; never moves a price.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { parseCsvLine } from "./jobs/btsBaseline.js";

export const AIRPORT_FARES_CSV = "data/bts/airport-fares.csv";

export interface AirportFareRow {
  year: number; quarter: number; kind: "airport" | "metro"; code: string | null; name: string;
  avgFareUsd: number; adjustedFareUsd: number | null; adjustedBase: string | null;
  passengers: number | null; passengersNote: string | null; rank: number | null; file: string;
}

/** The committed CSV -> rows. Refuses a row it can't read rather than
 *  storing a half-read one. Pure. */
export function parseAirportFareCsv(text: string): AirportFareRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = parseCsvLine(lines[0]!).map((h) => h.trim());
  const at = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`airport fares CSV has no ${name} column`);
    return i;
  };
  const c = {
    year: at("year"), quarter: at("quarter"), kind: at("kind"), code: at("code"), name: at("name"),
    avg: at("avg_fare_usd"), adj: at("adjusted_fare_usd"), base: at("adjusted_base"),
    pax: at("passengers"), note: at("passengers_note"), rank: at("rank"), file: at("file"),
  };
  const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v));
  return lines.slice(1).map((line, i) => {
    const f = parseCsvLine(line);
    const kind = f[c.kind]?.trim();
    const avg = Number(f[c.avg]);
    const year = Number(f[c.year]), quarter = Number(f[c.quarter]);
    if ((kind !== "airport" && kind !== "metro") || !(avg > 0) || !Number.isInteger(year) || !(quarter >= 1 && quarter <= 4)) {
      throw new Error(`airport fares CSV row ${i + 2} can't be read: ${line}`);
    }
    const code = f[c.code]?.trim() || null;
    return {
      year, quarter, kind, code, name: f[c.name]!.trim(), avgFareUsd: avg,
      adjustedFareUsd: num(f[c.adj]), adjustedBase: f[c.base]?.trim() || null,
      passengers: num(f[c.pax]), passengersNote: f[c.note]?.trim() || null,
      rank: num(f[c.rank]), file: f[c.file]!.trim(),
    };
  });
}

/** Adds every file in the CSV that isn't loaded yet. Never updates or
 *  deletes: a file already loaded is skipped, whatever the CSV now says. */
export async function loadAirportFares(db: Db, rows: AirportFareRow[]) {
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'airport_fares','')`, [runId]);
  const have = new Set((await db.query<{ file: string }>(`select distinct file from airport_fare_levels`)).rows.map((r) => r.file));
  const fresh = rows.filter((r) => !have.has(r.file));
  for (const r of fresh) {
    await db.query(
      `insert into airport_fare_levels
         (year, quarter, kind, code, name, avg_fare_usd, adjusted_fare_usd, adjusted_base,
          passengers, passengers_note, rank, file)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.year, r.quarter, r.kind, r.code, r.name, r.avgFareUsd, r.adjustedFareUsd, r.adjustedBase,
        r.passengers, r.passengersNote, r.rank, r.file],
    );
  }
  const files = [...new Set(fresh.map((r) => r.file))];
  await db.query(
    `update fetch_runs set finished_at = now(), calls = 0, rows_written = $2, errors = 0, note = $3 where id = $1`,
    [runId, fresh.length, files.length ? `loaded ${files.join(", ")}` : "nothing new"],
  );
  return { written: fresh.length, files };
}

/** Each airport's general price level in today's dollars: its newest
 *  quarter, using BTS's own inflation-adjusted figure when the newest is an
 *  older file that carries one. Airports only, never metro areas. */
export async function loadHomeFareLevels(db: Db): Promise<Map<string, number>> {
  const rows = (await db.query<{ code: string; avg: string; adj: string | null }>(
    `select distinct on (code) code, avg_fare_usd as avg, adjusted_fare_usd as adj
       from airport_fare_levels
      where kind = 'airport' and code is not null
      order by code, year desc, quarter desc, loaded_at desc`,
  )).rows;
  return new Map(rows.map((r) => [r.code.trim(), Number(r.adj ?? r.avg)]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import("./db.js");
  const db = await getDb();
  const rows = parseAirportFareCsv(await readFile(AIRPORT_FARES_CSV, "utf8"));
  const res = await loadAirportFares(db, rows);
  console.log(`airport fares: ${res.written} rows written${res.files.length ? ` from ${res.files.join(", ")}` : " (every file already loaded)"}`);
  await db.close();
}
