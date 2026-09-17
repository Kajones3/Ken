import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { popularRoutes, recordSearch, rotationRoutes, trendAnchorRoutes } from "./routeDemand.js";
import { runPopularRoutes } from "./jobs/popularRoutes.js";
import { computeFareTrend } from "./jobs/fareTrend.js";
import { loadBook } from "./book.js";

test("recordSearch counts repeat searches per route and month", async () => {
  const db = await memoryDb();
  for (let i = 0; i < 3; i++) await recordSearch(db, "ATL", ["MCO", "TPA"], "2027-03");
  await recordSearch(db, "ATL", ["MCO"], "2027-04");
  const rows = await popularRoutes(db, 10);
  const mco3 = rows.find((r) => r.destination === "MCO" && r.departMonth === "2027-03");
  assert.equal(mco3?.searches, 3);
  assert.equal(rows.find((r) => r.destination === "TPA")?.searches, 3);
  assert.equal(rows.find((r) => r.departMonth === "2027-04")?.searches, 1);
  await db.close();
});

test("recordSearch never throws, so a logging failure can't fail a search", async () => {
  const broken = {
    kind: "pglite" as const,
    query: async () => { throw new Error("db is down"); },
    exec: async () => {}, close: async () => {},
  };
  await recordSearch(broken, "ATL", ["MCO"], "2027-03");   // must not reject
});

test("popularRoutes ignores months that have already been and gone", async () => {
  const db = await memoryDb();
  await recordSearch(db, "ATL", ["MCO"], "2020-01");
  await recordSearch(db, "ATL", ["SNA"], "2099-01");
  const rows = await popularRoutes(db, 10);
  assert.deepEqual(rows.map((r) => r.destination), ["SNA"]);
  await db.close();
});

test("trendAnchorRoutes prefers the routes with the biggest BTS sample", async () => {
  const db = await memoryDb();
  for (const [o, d, pax] of [["ATL", "MCO", 90000], ["ORD", "MCO", 70000], ["BWI", "MCO", 10]] as const) {
    await db.query(
      `insert into historical_fares
         (origin,destination,year,quarter,avg_fare_usd,median_fare_usd,passengers_sampled)
       values ($1,$2,2026,1,300,300,$3)`, [o, d, pax],
    );
  }
  const anchors = await trendAnchorRoutes(db, 1, "2027-03", 2);
  assert.equal(anchors.length, 2);
  for (const a of anchors) assert.equal(a.departMonth, "2027-03");
  // Assert WHICH routes, not just how many. This test asserted only the
  // count for a long time, which is exactly why the ordering bug survived:
  // the query read as "biggest sample first" but Postgres requires
  // `distinct on`'s leading ORDER BY to match its distinct columns, so it
  // actually sorted alphabetically and returned ATL + BWI — BWI being the
  // 10-passenger route, the least trustworthy baseline in the table.
  assert.deepEqual(
    anchors.map((a) => a.origin).sort(),
    ["ATL", "ORD"],
    "must pick the two biggest samples (90000, 70000), never the 10-passenger route",
  );
  await db.close();
});

test("rotationRoutes returns never-bought routes before ones already bought", async () => {
  const db = await memoryDb();
  // ATL-MCO has a real bought fare; nothing else does.
  await db.query(
    `insert into flight_prices
       (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
     values ('ATL','MCO','2027-03-15',7,400,0,'serpapi_flights',now())`,
  );
  const picks = await rotationRoutes(db, 5, "2027-03");
  assert.ok(picks.length > 0);
  assert.ok(
    !picks.some((p) => p.origin === "ATL" && p.destination === "MCO"),
    "a route bought just now must go to the back of the queue, not the front",
  );
  for (const p of picks) assert.equal(p.departMonth, "2027-03");
  await db.close();
});

test("rotationRoutes orders by staleness, oldest purchase first", async () => {
  const db = await memoryDb();
  // Give EVERY candidate route a fare so staleness is the only differentiator.
  const all = await rotationRoutes(db, 1000, "2027-03");
  for (const r of all) {
    await db.query(
      `insert into flight_prices
         (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
       values ($1,$2,'2027-03-15',7,400,0,'serpapi_flights', now() - ($3 || ' hours')::interval)`,
      [r.origin, r.destination, String(all.indexOf(r))],
    );
  }
  // index 0 is the freshest (now - 0h), the last is the stalest.
  const picks = await rotationRoutes(db, 3, "2027-03");
  const stalest = all.slice(-3).map((r) => `${r.origin}|${r.destination}`).sort();
  assert.deepEqual(picks.map((p) => `${p.origin}|${p.destination}`).sort(), stalest);
  await db.close();
});

test("rotationRoutes ignores estimates and Travelpayouts rows — only real bought fares count", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into flight_prices
       (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
     values ('ATL','MCO','2027-03-15',7,400,0,'travelpayouts',now())`,
  );
  const picks = await rotationRoutes(db, 1000, "2027-03");
  assert.ok(
    picks.some((p) => p.origin === "ATL" && p.destination === "MCO"),
    "a Travelpayouts row is not a real bought fare, so the route is still unvisited",
  );
  await db.close();
});

test("rotationRoutes honours the exclude set, so demand routes aren't bought twice", async () => {
  const db = await memoryDb();
  const first = await rotationRoutes(db, 1, "2027-03");
  const key = `${first[0]!.origin}|${first[0]!.destination}`;
  const second = await rotationRoutes(db, 1, "2027-03", new Set([key]));
  assert.notEqual(`${second[0]!.origin}|${second[0]!.destination}`, key);
  await db.close();
});

test("a day of only international searches still yields a usable trend", async () => {
  // BTS DB1B is a US-domestic survey, so a Tokyo route has no baseline to
  // measure against. Without anchor routes the trend would be uncomputable
  // and EVERY estimated route in the app would fall back to "no cached
  // price" — a total blackout caused by one popular international search.
  const db = await memoryDb();
  const medians: Record<string, number> = { ATL: 342, ORD: 380, JFK: 365, DEN: 395 };
  for (const [o, med] of Object.entries(medians)) {
    await db.query(
      `insert into historical_fares
         (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,passengers_sampled)
       values ($1,'MCO',2026,1,$2,$3,$2,$4,50000)`,
      [o, med, Math.round(med * 0.8), Math.round(med * 1.25)],
    );
  }
  for (let i = 0; i < 9; i++) await recordSearch(db, "SEA", ["NRT"], "2027-03");

  const stub = {
    callsSpent: 0, budgetRemaining: 99,
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      return {
        origin, destination, departDate, tripLength,
        priceUsd: Math.round((medians[origin] ?? 900) * 1.12), stops: 0, deepLink: "x",
      };
    },
  };
  await runPopularRoutes(db, { limit: 5, datesPerMonth: 2, provider: stub as never });

  const trend = await computeFareTrend(db);
  assert.ok(trend, "anchors should keep the trend computable");
  assert.ok(trend!.sampleRoutes >= 3);

  // And a route nobody searched is still estimable, from its own median.
  const book = await loadBook(db, {
    origin: "DEN", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-08", tripLength: 7,
  });
  const est = book.flightEstimate!("DEN", "MCO")!;
  assert.ok(Math.abs(est.med - 395 * 1.12) < 6, `expected ~442, got ${est.med}`);
  assert.ok(est.low < est.med && est.med < est.high, "low/med/high must be ordered");
  await db.close();
});

test("runPopularRoutes stops at its budget instead of spending without limit", async () => {
  const db = await memoryDb();
  for (let i = 0; i < 5; i++) await recordSearch(db, "ATL", ["MCO"], "2027-03");
  let spent = 0;
  const budgeted = {
    callsSpent: 0,
    get budgetRemaining() { return Math.max(0, 2 - spent); },
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      spent++;
      return { origin, destination, departDate, tripLength, priceUsd: 400, stops: 0, deepLink: "x" };
    },
  };
  const res = await runPopularRoutes(db, { limit: 10, datesPerMonth: 5, provider: budgeted as never });
  assert.equal(res.calls, 2, "must stop the moment the budget is gone");
  await db.close();
});
