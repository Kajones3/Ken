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
  // Tokyo: HND (Haneda) is the alt airport, NRT (Narita) the primary — only NRT has a baseline.
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "NRT", 2025, 2, 800],
  );
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["HND"], resortIds: ["tdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "HND");
  assert.ok(est, "expected a fallback estimate from the primary airport's baseline");
  assert.equal(est!.med, 800 * 1.2);
  await db.close();
});

test("flightEstimate: a direct baseline for the alt airport itself is used, not overridden by the primary", async () => {
  const db = await memoryDb();
  await seedTrend(db);
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "HND", 2025, 2, 500],
  );
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["MIA", "NRT", 2025, 2, 800],
  );
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["HND"], resortIds: ["tdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "HND");
  assert.ok(est);
  assert.equal(est!.med, 500 * 1.2); // direct HND baseline, not NRT's
  await db.close();
});

test("flightEstimate: neither the alt airport nor its primary has a baseline stays undefined, not a fabricated number", async () => {
  const db = await memoryDb();
  await seedTrend(db);
  const book = await loadBook(db, {
    origin: "MIA", destinations: ["HND"], resortIds: ["tdr"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate?.("MIA", "HND");
  assert.equal(est, undefined);
  await db.close();
});

test("an unlabeled flight row (the early placeholder prices) is never read as a real fare", async () => {
  // 2026-10-02: 153,562 rows with no source, made up by the mock provider
  // before any real feed was connected, were being priced as real fares
  // ($98 on almost every ATL-MCO date).
  const db = await memoryDb();
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
     values ('ATL','MCO','2027-03-10',7,98,0,null,now()),
            ('ATL','MCO','2027-03-11',7,312,0,'serpapi_flights',now())`,
  );
  const book = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-31", tripLength: 7,
  });
  assert.equal(book.flight("ATL", "MCO", "2027-03-10", 7), undefined, "the placeholder is ignored");
  assert.equal(book.flight("ATL", "MCO", "2027-03-11", 7)?.price, 312, "a real fare still counts");
  await db.close();
});
