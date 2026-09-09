/**
 * The estimate pipeline's arithmetic, end to end:
 *   BTS median (weighted percentile) -> trend multiplier -> shown estimate.
 *
 * Every one of these guards a way the shown number could be wrong while
 * every other test stays green.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Readable } from "node:stream";
import { aggregateDb1bFile, weightedPercentile } from "./btsBaseline.js";
import { trimmedMultiplier } from "./fareTrend.js";
import { sampleDates } from "./popularRoutes.js";
import { quarterOf } from "../dates.js";
import { memoryDb } from "../db.js";
import { loadBook } from "../book.js";

test("weightedPercentile respects passenger weights, not row counts", () => {
  // Nine rows standing for one passenger each at $100, one row standing for
  // 91 passengers at $500. By row count the median is $100; by passengers —
  // which is what BTS's Passengers column means — it is $500.
  const pairs = [
    ...Array.from({ length: 9 }, () => ({ fare: 100, weight: 1 })),
    { fare: 500, weight: 91 },
  ];
  assert.equal(weightedPercentile(pairs, 0.5), 500);
});

test("weightedPercentile returns the low and high ends for p25/p75", () => {
  const pairs = [
    { fare: 100, weight: 25 }, { fare: 200, weight: 25 },
    { fare: 300, weight: 25 }, { fare: 400, weight: 25 },
  ];
  assert.equal(weightedPercentile(pairs, 0.25), 100);
  assert.equal(weightedPercentile(pairs, 0.5), 200);
  assert.equal(weightedPercentile(pairs, 0.75), 300);
});

test("weightedPercentile handles an empty route without dividing by zero", () => {
  assert.equal(weightedPercentile([], 0.5), 0);
});

test("aggregateDb1bFile reports a median well above the mean when cheap fares are thin", () => {
  // One $20 partial itinerary among four real $400 ones. The mean is dragged
  // down to $324; the median stays at $400 — this is the exact shape of the
  // bug that made a $700 real fare show as $200.
  const csv = [
    '"Origin","Dest","Passengers","MktFare","Year","Quarter"',
    '"ATL","MCO","1","20","2026","1"',
    '"ATL","MCO","1","400","2026","1"',
    '"ATL","MCO","1","400","2026","1"',
    '"ATL","MCO","1","400","2026","1"',
    '"ATL","MCO","1","400","2026","1"',
  ].join("\n");
  return aggregateDb1bFile(Readable.from([csv]), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  }).then((agg) => {
    const r = agg.get("ATL|MCO")!;
    assert.equal(r.medianFareUsd, 400);
    assert.ok(r.avgFareUsd < r.medianFareUsd, `mean ${r.avgFareUsd} should sit below median ${r.medianFareUsd}`);
    assert.equal(r.p25FareUsd, 400);
    assert.equal(r.p75FareUsd, 400);
  });
});

test("quarterOf maps months to the quarter BTS publishes", () => {
  assert.equal(quarterOf("2027-01-15"), 1);
  assert.equal(quarterOf("2027-03-31"), 1);
  assert.equal(quarterOf("2027-04-01"), 2);
  assert.equal(quarterOf("2027-12-25"), 4);
});

test("trimmedMultiplier drops one outlier from each end", () => {
  // A single wild route (x9) must not drag the trend every other route is moved by.
  const r = trimmedMultiplier([1.1, 1.2, 1.25, 1.3, 9])!;
  assert.ok(r.multiplier > 1.1 && r.multiplier < 1.3, `got ${r.multiplier}`);
});

test("trimmedMultiplier refuses to guess from fewer than 3 routes", () => {
  assert.equal(trimmedMultiplier([1.4, 1.5]), null);
});

test("sampleDates stays inside the month and never repeats a day", () => {
  for (const month of ["2027-02", "2027-03", "2027-04"]) {
    const dates = sampleDates(month, 3);
    assert.equal(new Set(dates).size, dates.length, `${month} repeated a date`);
    for (const d of dates) {
      assert.ok(d.startsWith(month), `${d} escaped ${month}`);
      const day = Number(d.slice(8, 10));
      assert.ok(day >= 1, `${d} has a day below 1`);
    }
    // February has 28 days in 2027 — a naive fixed 7/14/21/28 schedule would
    // walk off the end of a short month.
    const last = Number(dates[dates.length - 1]!.slice(8, 10));
    assert.ok(last <= (month === "2027-02" ? 28 : 31), `${dates} ran past the month end`);
  }
});

test("flightEstimate builds on the same-quarter median, moved by the trend", async () => {
  const db = await memoryDb();
  // Two quarters for the same route, deliberately far apart, so picking the
  // wrong one is unmissable: Q1 is the cheap season, Q3 the expensive one.
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd)
     values ('ATL','MCO',2026,1,999,180,200,260),
            ('ATL','MCO',2026,3,999,700,800,900)`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.12, 1.0, 1.3, 8, '2026Q1')`,
  );

  // A March trip is Q1: it must use the 200 median, not the 800 one.
  const march = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-08", tripLength: 7,
  });
  const e = march.flightEstimate!("ATL", "MCO")!;
  assert.equal(e.med, 224);            // 200 x 1.12, the median not the mean
  assert.equal(e.low, 201.6);          // p25 x 1.12
  assert.equal(e.high, 291.2);         // p75 x 1.12
  assert.equal(e.basisQuarter, "2026Q1");
  assert.equal(e.seasonMatched, true);
  assert.equal(e.trendPct, 12);

  // An August trip is Q3 and must land on the expensive baseline instead.
  const august = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-08-01", to: "2027-08-08", tripLength: 7,
  });
  assert.equal(august.flightEstimate!("ATL", "MCO")!.med, 896);   // 800 x 1.12
  await db.close();
});

test("flightEstimate flags an estimate built on the wrong season", async () => {
  const db = await memoryDb();
  // Only a Q3 baseline exists; a Q1 search has to reach for it, and must say so.
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd)
     values ('ATL','MCO',2026,3,999,700,800,900)`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.0, 1.0, 1.0, 5, '2026Q3')`,
  );
  const book = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-01-05", to: "2027-01-12", tripLength: 7,
  });
  assert.equal(book.flightEstimate!("ATL", "MCO")!.seasonMatched, false);
  await db.close();
});

test("flightEstimate stays undefined with no trend, rather than showing a raw old fare", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd)
     values ('ATL','MCO',2026,1,300,280,300,340)`,
  );
  const book = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-08", tripLength: 7,
  });
  assert.equal(book.flightEstimate!("ATL", "MCO"), undefined);
  await db.close();
});
