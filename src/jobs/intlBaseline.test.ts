import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "../db.js";
import { loadBook } from "../book.js";
import { computeFareTrend } from "./fareTrend.js";
import { internationalDestinations, runIntlBaseline, SAMPLED_LIVE } from "./intlBaseline.js";
import { runIntlSweep } from "./intlSweep.js";
import { RESORTS } from "../config.js";

test("BVA and SHA are gone as arrival airport options", () => {
  const all = RESORTS.flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]);
  assert.ok(!all.includes("BVA"), "Beauvais should no longer be offered");
  assert.ok(!all.includes("SHA"), "Hongqiao should no longer be offered");
  // The gateways people actually fly into must still be there.
  for (const iata of ["CDG", "NRT", "HND", "PVG", "HKG"]) {
    assert.ok(all.includes(iata), `${iata} should still be an option`);
  }
  assert.equal(internationalDestinations().length, 5);
});

async function seedIntlFares(db: Awaited<ReturnType<typeof memoryDb>>, prices: number[]) {
  for (const [i, p] of prices.entries()) {
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source)
       values ('JFK','CDG',$1,7,$2,'serpapi_flights')`,
      [`2027-02-${String(5 + i * 3).padStart(2, "0")}`, p],
    );
  }
}

test("bought international fares become that route's quarter baseline", async () => {
  const db = await memoryDb();
  await seedIntlFares(db, [800, 900, 1000, 1100, 1200]);
  const res = await runIntlBaseline(db);
  assert.equal(res.written, 1);

  const { rows } = await db.query(
    `select median_fare_usd, p25_fare_usd, p75_fare_usd, source, year, quarter, itin_count
       from historical_fares where origin='JFK' and destination='CDG'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].median_fare_usd), 1000);
  assert.equal(Number(rows[0].p25_fare_usd), 900);
  assert.equal(Number(rows[0].p75_fare_usd), 1100);
  assert.equal(rows[0].source, SAMPLED_LIVE);
  assert.equal(Number(rows[0].quarter), 1);         // February is Q1
  assert.equal(Number(rows[0].itin_count), 5);
  await db.close();
});

test("a route with too few real fares gets no baseline rather than a noisy one", async () => {
  const db = await memoryDb();
  await seedIntlFares(db, [800, 1200]);            // 2 samples, below the min of 3
  const res = await runIntlBaseline(db);
  assert.equal(res.written, 0);
  assert.equal(res.skipped, 1);
  const { rows } = await db.query(`select count(*)::int as n from historical_fares`);
  assert.equal(rows[0].n, 0);
  await db.close();
});

test("a live-sampled baseline is NOT inflated again by the trend", async () => {
  // The trap this whole design has to avoid. The trend multiplier exists to
  // carry an OLD survey baseline forward to today's prices. A baseline built
  // from fares sampled this month is already at today's prices — applying
  // the trend to it would add that percentage a second time, which is
  // exactly the "shown price is nowhere near the click-through" failure.
  const db = await memoryDb();
  await seedIntlFares(db, [800, 900, 1000, 1100, 1200]);
  await runIntlBaseline(db);
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.30, 1.1, 1.5, 9, '2026Q1')`,
  );

  const book = await loadBook(db, {
    origin: "JFK", destinations: ["CDG"], resortIds: ["dlp"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  const est = book.flightEstimate!("JFK", "CDG")!;
  assert.equal(est.med, 1000, "must be the sampled median itself, not 1000 x 1.30");
  assert.equal(est.low, 900);
  assert.equal(est.high, 1100);
  assert.equal(est.sampledLive, true);
  assert.equal(est.trendPct, undefined, "no trend was applied, so none should be claimed");
  await db.close();
});

test("a historical BTS baseline IS still moved by the trend", async () => {
  // The other half of the same rule — domestic behaviour must not change.
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,source)
     values ('ATL','MCO',2026,1,300,268,342,431,'bts_db1b')`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.10, 1.0, 1.2, 9, '2026Q1')`,
  );
  const book = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-08", tripLength: 7,
  });
  const est = book.flightEstimate!("ATL", "MCO")!;
  assert.equal(est.med, 376.2);                    // 342 x 1.10
  assert.equal(est.sampledLive, false);
  assert.equal(est.trendPct, 10);
  await db.close();
});

test("an international estimate works with no trend at all", async () => {
  // International routes must not be held hostage to the domestic trend
  // being computable — that is the point of sampling them directly.
  const db = await memoryDb();
  await seedIntlFares(db, [800, 900, 1000, 1100, 1200]);
  await runIntlBaseline(db);
  const book = await loadBook(db, {
    origin: "JFK", destinations: ["CDG"], resortIds: ["dlp"],
    from: "2027-02-01", to: "2027-02-28", tripLength: 7,
  });
  assert.equal(book.flightEstimate!("JFK", "CDG")!.med, 1000);
  await db.close();
});

test("a live-sampled baseline never overwrites a real BTS survey row", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,median_fare_usd,source)
     values ('JFK','CDG',2027,1,999,777,'bts_db1b')`,
  );
  await seedIntlFares(db, [100, 200, 300, 400, 500]);
  await runIntlBaseline(db);
  const { rows } = await db.query(
    `select median_fare_usd, source from historical_fares where origin='JFK' and destination='CDG'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].median_fare_usd), 777, "the survey must win");
  assert.equal(rows[0].source, "bts_db1b");
  await db.close();
});

test("live-sampled baselines are excluded from the trend calculation", async () => {
  // Measuring bought fares against a baseline built from those same fares
  // yields a ratio of ~1.0, which would quietly drag the real multiplier
  // toward "no change".
  const db = await memoryDb();
  for (const o of ["JFK", "BOS", "IAD"]) {
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source)
         values ($1,'CDG',$2,7,1000,'serpapi_flights')`,
        [o, `2027-02-${String(5 + i * 3).padStart(2, "0")}`],
      );
    }
  }
  await runIntlBaseline(db);
  // Three routes now have both a real fare and a (live-sampled) baseline —
  // but none is a survey, so there is nothing legitimate to measure.
  assert.equal(await computeFareTrend(db), null);
  await db.close();
});

test("intl sweep buys only international routes and stays inside its budget", async () => {
  const db = await memoryDb();
  let spent = 0;
  const provider = {
    get budgetRemaining() { return Math.max(0, 8 - spent); },
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      spent++;
      return { origin, destination, departDate, tripLength, priceUsd: 950, stops: 1, deepLink: "x" };
    },
  };
  const res = await runIntlSweep(db, {
    months: 3, datesPerMonth: 1, origins: ["JFK", "BOS"], bucket: 7,
    provider: provider as never,
  });
  assert.equal(res.calls, 8, "must stop the moment the budget is gone");

  const { rows } = await db.query(`select distinct destination from flight_prices order by destination`);
  const dests = rows.map((r: { destination: string }) => r.destination.trim());
  for (const d of dests) {
    assert.ok(internationalDestinations().includes(d), `${d} is not an international airport`);
  }
  await db.close();
});

test("the sweep's destination shard cannot be widened past the app's own list", async () => {
  // INTL_SWEEP_DESTINATIONS shards the monthly run one airport per job. It
  // must never become a way to point paid lookups at an arbitrary airport.
  const db = await memoryDb();
  await assert.rejects(
    () => runIntlSweep(db, { destinations: ["MCO"], months: 1, provider: {
      budgetRemaining: 10, async quote() { throw new Error("must not be called"); },
    } as never }),
    /no international destinations to sweep/,
  );
  // A domestic airport mixed in with a real one is dropped, not swept.
  let asked: string[] = [];
  const res = await runIntlSweep(db, {
    destinations: ["CDG", "MCO"], months: 1, datesPerMonth: 1, origins: ["JFK"],
    provider: {
      budgetRemaining: 10,
      async quote(o: string, d: string, date: string, len: number) {
        asked.push(d);
        return { origin: o, destination: d, departDate: date, tripLength: len, priceUsd: 900, stops: 1, deepLink: "x" };
      },
    } as never,
  });
  assert.ok(res.calls > 0);
  assert.deepEqual([...new Set(asked)], ["CDG"], "MCO must never be bought here");
  await db.close();
});
