import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { memoryDb } from "./db.js";
import { AIRPORT_FARES_CSV, loadAirportFares, loadHomeFareLevels, parseAirportFareCsv } from "./airportFares.js";

test("the committed BTS airport CSV reads whole, with a code for every airport row", async () => {
  const rows = parseAirportFareCsv(await readFile(AIRPORT_FARES_CSV, "utf8"));
  assert.ok(rows.length > 400);
  assert.equal(rows.filter((r) => r.kind === "airport" && !r.code).length, 0);
  const rdu = rows.filter((r) => r.code === "RDU");
  assert.deepEqual(rdu.map((r) => `${r.year}Q${r.quarter} ${r.avgFareUsd}`).sort(), ["2025Q1 377.13", "2026Q2 407"]);
  assert.equal(rows.filter((r) => r.kind === "metro").length, 8);
});

test("loading is append-only: a second load of the same files writes nothing", async () => {
  const db = await memoryDb();
  const rows = parseAirportFareCsv(await readFile(AIRPORT_FARES_CSV, "utf8"));
  const first = await loadAirportFares(db, rows);
  assert.equal(first.written, rows.length);
  const again = await loadAirportFares(db, rows);
  assert.equal(again.written, 0);
  const n = (await db.query<{ n: string }>(`select count(*) as n from airport_fare_levels`)).rows[0]!.n;
  assert.equal(Number(n), rows.length);

  // Newest quarter wins; an older file's inflation-adjusted figure is used
  // where that's all there is.
  const levels = await loadHomeFareLevels(db);
  assert.equal(levels.get("RDU"), 407);
  assert.equal(levels.get("IAD"), 510.33);
  await db.close();
});

test("a row it can't read is refused, not half-stored", () => {
  const head = "year,quarter,kind,code,name,avg_fare_usd,adjusted_fare_usd,adjusted_base,passengers,passengers_note,rank,file";
  assert.throws(() => parseAirportFareCsv(`${head}\n2026,2,airport,RDU,Raleigh,abc,,,1,x,1,f.xlsx`));
});
