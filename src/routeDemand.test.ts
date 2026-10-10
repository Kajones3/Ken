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

test("popularRoutes skips months now too close to plan, so no paid lookup is spent on them", async () => {
  const db = await memoryDb();
  await recordSearch(db, "ATL", ["MCO"], "2026-10");   // next month, as of the pinned today
  await recordSearch(db, "ATL", ["SNA"], "2026-11");   // two months out: the first one offered
  const rows = await popularRoutes(db, 10, 30, "2026-09-26");
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

test("rotationRoutes honors the exclude set, so demand routes aren't bought twice", async () => {
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

test("rotation never buys a route nobody flies", async () => {
  // LAX is a departure airport AND one of Disneyland's arrival airports, so
  // LAX->LAX and LAX->SNA are both in the 171-route pool. Neither can ever
  // return an itinerary, so neither can ever be recorded as bought — which
  // left them permanently at the FRONT of a stalest-first queue, re-bought
  // and re-paid-for every cycle, forever.
  const db = await memoryDb();
  const routes = await rotationRoutes(db, 400, "2027-03");
  const local = routes.filter((r) =>
    r.origin === r.destination || (r.origin === "LAX" && r.destination === "SNA"));
  assert.deepEqual(local, [], "local routes must never reach a paid lookup");
  assert.ok(routes.length > 100, "the rest of the rotation is untouched");
  assert.ok(routes.some((r) => r.origin === "LAX" && r.destination === "MCO"),
    "LAX still flies to Orlando");
  await db.close();
});

test("a route+month bought recently is not re-bought the next night; its slot goes to rotation", async () => {
  // 2026-10-03: demand filled all 18 slots with the same route+months every
  // night and each night's fares overwrote the last, so 226 paid lookups left
  // 19 fares. A second night must buy DIFFERENT routes.
  const db = await memoryDb();
  for (const d of ["MCO", "SNA"]) await recordSearch(db, "RDU", [d], "2027-03");
  const bought: string[] = [];
  const stub = {
    callsSpent: 0, budgetRemaining: 100,
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      bought.push(`${origin}|${destination}|${departDate.slice(0, 7)}`);
      return { origin, destination, departDate, tripLength, priceUsd: 400, stops: 0, deepLink: "x" };
    },
  };
  await runPopularRoutes(db, { limit: 4, datesPerMonth: 1, provider: stub as never });
  const night1 = new Set(bought);
  assert.ok(night1.has("RDU|MCO|2027-03") && night1.has("RDU|SNA|2027-03"), "demand is bought first");
  bought.length = 0;
  await runPopularRoutes(db, { limit: 4, datesPerMonth: 1, provider: stub as never });
  const repeats = bought.filter((k) => night1.has(k));
  assert.deepEqual(repeats, [], "nothing bought last night is bought again");
  assert.ok(bought.length >= 4, "the freed slots are still spent, on other routes");
  await db.close();
});

test("the furthest-off routes get buying slots, either direction, in a month that can still be picked", async () => {
  const { pickWorstRoutes } = await import("./jobs/popularRoutes.js");
  const r = (origin: string, shownPct: number, months: string[]) => ({
    origin, destination: "MCO", resort: "wdw", international: false, n: 1, realMedian: 300, estMedian: 300,
    medianPct: 0, shownMedian: 300, shownPct, candMedian: null, candPct: null, months,
  });
  const picked = pickWorstRoutes([
    r("ATL", 4, ["2027-03"]),          // inside the zone: left alone
    r("BOS", -30, ["2027-03"]),        // reads LOW by 30%
    r("ORD", 25, ["2027-03"]),         // reads HIGH by 25%
    r("DEN", 40, ["2026-11"]),         // worst, but Nov can't be picked; Dec can (same season)
  ], { useCandidate: false, zonePct: 10, n: 3, plannable: ["2026-12", "2027-01", "2027-02", "2027-03"],
       fresh: new Set(["ORD|MCO|2027-03"]) });
  assert.deepEqual(picked.map((p) => `${p.origin} ${p.departMonth}`), ["DEN 2026-12", "BOS 2027-03", "ORD 2027-01"]);
});

test("rotationRoutes spreads never-bought routes across home airports, not one airport's nine first", async () => {
  // Found 2026-10-10: 13 of the 19 big airports had never had a fare bought,
  // and alphabetical tie-breaking would have handed DFW all nine routes first.
  const db = await memoryDb();
  const picks = await rotationRoutes(db, 12, "2027-03");
  assert.equal(new Set(picks.map((p) => p.origin)).size, 12);
  assert.ok(new Set(picks.map((p) => p.destination)).size > 3, "and not all to the same airport either");
  await db.close();
});

test("runPopularRoutes keeps rotation slots even when demand could fill the whole night", async () => {
  // 2026-10-10: demand (mostly the owner's own test searches from a few
  // airports) took every slot, every night, and rotation never ran.
  const db = await memoryDb();
  const month = (await import("./config.js")).plannableMonths(new Date().toISOString().slice(0, 10))[2]!;
  for (const o of ["RDU", "BNA", "MCI", "STL", "CVG", "CLE"]) await recordSearch(db, o, ["MCO", "LAX", "SNA"], month);
  const asked: string[] = [];
  const stub = {
    callsSpent: 0, budgetRemaining: 100,
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      asked.push(`${origin}|${destination}`);
      return { origin, destination, departDate, tripLength, priceUsd: 400, stops: 0, deepLink: "x" };
    },
  };
  await runPopularRoutes(db, { limit: 8, datesPerMonth: 1, worstSlots: 0, rotationSlots: 3, provider: stub as never });
  const demanded = new Set(["RDU", "BNA", "MCI", "STL", "CVG", "CLE"].flatMap((o) => ["MCO", "LAX", "SNA"].map((d) => `${o}|${d}`)));
  const fromRotation = asked.filter((k) => !demanded.has(k));
  assert.ok(fromRotation.length >= 3, `rotation should get its 3 slots, got ${fromRotation.length}: ${asked.join(", ")}`);
  await db.close();
});

test("parseRouteList reads a named purchase and refuses anything it can't read", async () => {
  const { parseRouteList } = await import("./jobs/popularRoutes.js");
  assert.deepEqual(parseRouteList("iad-cdg-2027-03, IAD-NRT-2027-06"), [
    { origin: "IAD", destination: "CDG", departMonth: "2027-03", searches: 0 },
    { origin: "IAD", destination: "NRT", departMonth: "2027-06", searches: 0 },
  ]);
  assert.deepEqual(parseRouteList(""), []);
  assert.throws(() => parseRouteList("IAD to Paris"));
});
