import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "../db.js";
import { trimmedMultiplier, computeFareTrend } from "./fareTrend.js";

test("trimmedMultiplier: fewer than 3 ratios is too thin to trust", () => {
  assert.equal(trimmedMultiplier([]), null);
  assert.equal(trimmedMultiplier([1.1]), null);
  assert.equal(trimmedMultiplier([1.1, 1.2]), null);
});

test("trimmedMultiplier: 3-4 ratios use the plain mean and min/max, no trimming", () => {
  const r = trimmedMultiplier([1.0, 1.2, 1.4]);
  assert.ok(r);
  assert.equal(r!.multiplier, 1.2);
  assert.equal(r!.low, 1.0);
  assert.equal(r!.high, 1.4);
});

test("trimmedMultiplier: 5+ ratios drop one outlier from each end before averaging", () => {
  // Without trimming, the mean would be dragged toward 5.0 by one outlier.
  const r = trimmedMultiplier([1.0, 1.1, 1.2, 1.3, 5.0]);
  assert.ok(r);
  // trimmed set is [1.1, 1.2, 1.3] -> mean 1.2, spread 1.1-1.3
  assert.equal(r!.multiplier, 1.2);
  assert.equal(r!.low, 1.1);
  assert.equal(r!.high, 1.3);
});

test("trimmedMultiplier: identical ratios widen +-10% so Low/Med/High are never all equal", () => {
  const r = trimmedMultiplier([1.5, 1.5, 1.5]);
  assert.ok(r);
  assert.equal(r!.multiplier, 1.5);
  assert.equal(r!.low, 1.35);
  assert.equal(r!.high, 1.65);
});

test("computeFareTrend: skips writing a row when fewer than 3 routes overlap", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["ATL", "MCO", 2025, 2, 200],
  );
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source) values ($1,$2,$3,$4,$5,'serpapi_flights')`,
    ["ATL", "MCO", "2027-03-01", 4, 260],
  );
  const result = await computeFareTrend(db);
  assert.equal(result, null);
  const { rows } = await db.query(`select count(*)::int as n from fare_trend`);
  assert.equal(rows[0].n, 0);
  await db.close();
});

test("computeFareTrend: writes a plausible multiplier from real overlapping routes", async () => {
  const db = await memoryDb();
  const routes: [string, string, number, number][] = [
    ["ATL", "MCO", 200, 260], // ratio 1.30
    ["DEN", "MCO", 250, 300], // ratio 1.20
    ["RDU", "SNA", 300, 330], // ratio 1.10
  ];
  for (const [origin, destination, baseline, current] of routes) {
    // Quarter 1, to match the Q1 departure date below — the trend compares
    // like season with like season, so a baseline from another quarter is
    // deliberately not a match (see the next test).
    await db.query(
      `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd) values ($1,$2,$3,$4,$5,$5)`,
      [origin, destination, 2025, 1, baseline],
    );
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source) values ($1,$2,$3,$4,$5,'serpapi_flights')`,
      [origin, destination, "2027-03-01", 4, current],
    );
  }
  const result = await computeFareTrend(db);
  assert.ok(result);
  assert.equal(result!.sampleRoutes, 3);
  const { rows } = await db.query(`select multiplier, low_multiplier, high_multiplier, basis_quarter from fare_trend`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].multiplier), 1.2); // mean of 1.30, 1.20, 1.10
  assert.equal(rows[0].basis_quarter, "2025Q1");
  await db.close();
});

test("computeFareTrend: a baseline from a different quarter is not a match", async () => {
  // Seasonality is the whole reason the baseline is stored per quarter. A
  // March fare measured against a summer baseline would report the season
  // as a price rise, and then apply that invented "rise" to every estimated
  // route in the app.
  const db = await memoryDb();
  for (const [origin, destination] of [["ATL", "MCO"], ["DEN", "MCO"], ["RDU", "SNA"]]) {
    await db.query(
      `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd) values ($1,$2,2025,3,200,200)`,
      [origin, destination],
    );
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source) values ($1,$2,'2027-03-01',4,400,'serpapi_flights')`,
      [origin, destination],
    );
  }
  assert.equal(await computeFareTrend(db), null);
  const { rows } = await db.query(`select count(*)::int as n from fare_trend`);
  assert.equal(rows[0].n, 0);
  await db.close();
});

test("computeFareTrend: stale flight_prices rows (older than 21 days) are not treated as current", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["ATL", "MCO", 2025, 2, 200],
  );
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["DEN", "MCO", 2025, 2, 200],
  );
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd) values ($1,$2,$3,$4,$5)`,
    ["RDU", "SNA", 2025, 2, 200],
  );
  // All three flight_prices rows are stale.
  for (const [origin, destination] of [["ATL", "MCO"], ["DEN", "MCO"], ["RDU", "SNA"]] as const) {
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source,fetched_at)
       values ($1,$2,$3,$4,$5,'serpapi_flights', now() - interval '40 days')`,
      [origin, destination, "2027-03-01", 4, 260],
    );
  }
  const result = await computeFareTrend(db);
  assert.equal(result, null);
  await db.close();
});

test("computeFareTrend: fares from an untrusted source are not measured", async () => {
  // Travelpayouts' calendar rows are city-level, often the wrong trip
  // length, and skew cheap. This multiplier moves EVERY estimated route in
  // the app, so letting those in would drag every estimate down — the exact
  // "shown $200, click through to $700" failure this guards against.
  const db = await memoryDb();
  for (const [origin, destination] of [["ATL", "MCO"], ["DEN", "MCO"], ["RDU", "SNA"]] as const) {
    await db.query(
      `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd)
       values ($1,$2,2025,1,300,300)`,
      [origin, destination],
    );
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source)
       values ($1,$2,'2027-03-01',4,60,'travelpayouts')`,
      [origin, destination],
    );
  }
  // Three overlapping routes, but none from a trusted source: no trend is
  // written, and the previous good multiplier keeps serving.
  assert.equal(await computeFareTrend(db), null);
  await db.close();
});

test("computeFareTrend: unlabelled legacy rows are excluded too", async () => {
  const db = await memoryDb();
  for (const [origin, destination] of [["ATL", "MCO"], ["DEN", "MCO"], ["RDU", "SNA"]] as const) {
    await db.query(
      `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd)
       values ($1,$2,2025,1,300,300)`,
      [origin, destination],
    );
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd)
       values ($1,$2,'2027-03-01',4,60)`,
      [origin, destination],
    );
  }
  assert.equal(await computeFareTrend(db), null);
  await db.close();
});
