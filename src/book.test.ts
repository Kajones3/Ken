import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryDb } from "./db.js";
import { loadBook } from "./book.js";

async function seedTrend(db: Awaited<ReturnType<typeof memoryDb>>) {
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter)
     values ($1, 1.2, 1.1, 1.3, 5, '2025Q2')`,
    [randomUUID()],
  );
}

test("flightEstimate: an alt airport with no direct BTS baseline falls back to its resort's primary airport", async () => {
  const db = await memoryDb();
  await seedTrend(db);
  // Shanghai: SHA (Hongqiao) is the alt airport, PVG the primary — only PVG has a baseline.
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "PVG", 2025, 2, 800],
  );
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["SHA"], resortIds: ["shdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "SHA");
  assert.ok(est, "expected a fallback estimate from the primary airport's baseline");
  assert.equal(est!.med, 800 * 1.2);
  await db.close();
});

test("flightEstimate: a direct baseline for the alt airport itself is used, not overridden by the primary", async () => {
  const db = await memoryDb();
  await seedTrend(db);
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "SHA", 2025, 2, 500],
  );
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "PVG", 2025, 2, 800],
  );
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["SHA"], resortIds: ["shdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "SHA");
  assert.ok(est);
  assert.equal(est!.med, 500 * 1.2); // direct SHA baseline, not PVG's
  await db.close();
});

test("flightEstimate: neither the alt airport nor its primary has a baseline stays undefined, not a fabricated number", async () => {
  const db = await memoryDb();
  await seedTrend(db);
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["SHA"], resortIds: ["shdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "SHA");
  assert.equal(est, undefined);
  await db.close();
});
