import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb, type Db } from "./db.js";
import { runPopularRoutes, sampleDates } from "./jobs/popularRoutes.js";
import { loadBook } from "./book.js";
import { quotedEstimate } from "./pricing.js";
import { loadForecastScores, scoreForecasts, type ForecastRow } from "./fareForecasts.js";
import { clearFareModelCache } from "./fareModelDb.js";

/** ATL->MCO with a Q1 BTS baseline and a domestic trend, nothing bought yet. */
async function seeded(): Promise<Db> {
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,passengers_sampled)
     values ('ATL','MCO',2025,1,300,250,300,360,50000)`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter,kind)
     values (gen_random_uuid(), 1.0, 1.0, 1.0, 9, '2025Q1', 'domestic')`,
  );
  clearFareModelCache(db);
  return db;
}
const stub = (price: number | null) => ({
  callsSpent: 0, budgetRemaining: 99,
  async quote(origin: string, destination: string, departDate: string, tripLength: number) {
    return price === null ? null : { origin, destination, departDate, tripLength, priceUsd: price, stops: 0, deepLink: "x" };
  },
});
const ROUTE = [{ origin: "ATL", destination: "MCO", departMonth: "2027-03", searches: 1 }];
// The day popular-routes buys for ATL-MCO in March (it rotates by route).
const DAY = sampleDates("2027-03", 1, "ATL-MCO")[0]!;
const BOOK = { origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"], from: DAY, to: DAY, tripLength: 7 };

test("the forecast is written down BEFORE the fare, so it never learns from the fare it is graded on", async () => {
  const db = await seeded();
  const before = quotedEstimate(await loadBook(db, BOOK, { formula: "live" }), "ATL", "MCO", DAY)!;
  assert.ok(before > 0);

  const res = await runPopularRoutes(db, { routes: ROUTE, datesPerMonth: 1, provider: stub(600) as never });
  assert.equal(res.rows, 1, "the fare is still bought");
  assert.equal(res.forecasts, 1);

  const f = (await db.query<{ shown_usd: string; shown_kind: string; live_estimate_usd: string; price_usd: string; formula: string }>(
    `select shown_usd, shown_kind, live_estimate_usd, price_usd, formula from fare_forecasts`)).rows;
  assert.equal(f.length, 1);
  assert.equal(Number(f[0]!.price_usd), 600);
  assert.equal(Number(f[0]!.shown_usd), before, "what travelers saw just before buying");
  assert.equal(f[0]!.shown_kind, "estimate");
  assert.equal(f[0]!.formula, "live");
  // The cheapest-trip number is written down too (2026-10-16). With no kept
  // Google answers there is no cheapest ratio yet, so it equals the typical.
  const c = (await db.query<{ shown_cheapest_usd: string | null }>(`select shown_cheapest_usd from fare_forecasts`)).rows;
  assert.equal(Number(c[0]!.shown_cheapest_usd), before);

  // The bought fare now pulls the route's estimate toward itself: grading
  // today's number against it would flatter us. The forecast doesn't.
  const after = quotedEstimate(await loadBook(db, BOOK, { formula: "live" }), "ATL", "MCO", DAY)!;
  assert.ok(after > before, `the estimate learned from the fare (${before} -> ${after})`);
  await db.close();
});

test("a night Google has no fare still keeps the forecast, ungraded", async () => {
  const db = await seeded();
  const res = await runPopularRoutes(db, { routes: ROUTE, datesPerMonth: 1, provider: stub(null) as never });
  assert.equal(res.misses, 1);
  const f = (await db.query<{ price_usd: string | null }>(`select price_usd from fare_forecasts`)).rows;
  assert.equal(f.length, 1);
  assert.equal(f[0]!.price_usd, null);
  const s = await loadForecastScores(db);
  assert.equal(s.n, 0);
  assert.equal(s.noFare, 1);
  await db.close();
});

test("a forecast that fails never stops the purchase", async () => {
  const db = await seeded();
  // No resort uses XXX, so the forecast throws; the fare must still be bought and kept.
  const res = await runPopularRoutes(db, {
    routes: [{ origin: "ATL", destination: "XXX", departMonth: "2027-03", searches: 1 }],
    datesPerMonth: 1, provider: stub(500) as never,
  });
  assert.equal(res.rows, 1);
  assert.equal(res.errors, 0);
  assert.equal(res.forecasts, 0);
  const kept = (await db.query(`select 1 from flight_observations where destination = 'XXX'`)).rows.length;
  assert.equal(kept, 1, "the fare is in the record");
  await db.close();
});

test("scoreForecasts grades a miss the same in either direction, split US / international", () => {
  const at = new Date("2026-10-08T11:00:00Z");
  const rows: ForecastRow[] = [
    { destination: "MCO", boughtAt: at, price: 100, shown: 108, shownKind: "estimate", live: 108, candidate: 95 },
    { destination: "MCO", boughtAt: at, price: 100, shown: 125, shownKind: "real_fare", live: 130, candidate: 100 },
    { destination: "SNA", boughtAt: at, price: 200, shown: 160, shownKind: "estimate", live: 160 },
    { destination: "NRT", boughtAt: new Date("2026-10-09T11:00:00Z"), price: 1000, shown: 1040, shownKind: "estimate", live: 1040, candidate: 1300 },
  ];
  const s = scoreForecasts(rows, 10, 2);
  assert.equal(s.n, 4);
  assert.equal(s.noFare, 2);
  assert.deepEqual(s.shownKinds, { realFare: 1, estimate: 3 });
  assert.equal(s.domestic.shown.n, 3);
  assert.equal(s.domestic.shown.inZonePct, 33);   // +8% in; +25% high; -20% low
  assert.equal(s.domestic.shown.highPct, 33);
  assert.equal(s.domestic.shown.lowPct, 33);
  assert.equal(s.domestic.candidate.n, 2, "a missing candidate is left out, not counted as a miss");
  assert.equal(s.international.shown.inZonePct, 100);
  assert.equal(s.international.candidate.highPct, 100);
  assert.deepEqual(s.daily.map((d) => [d.day, d.n]), [["2026-10-09", 1], ["2026-10-08", 3]], "newest night first");
  assert.equal(s.since, "2026-10-08");
});

test("progressOf: this week vs last week, before-buying grades, and where to look first", async () => {
  const { progressOf, progressReport } = await import("./fareForecasts.js");
  const now = new Date("2026-10-20T12:00:00Z");
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
  const rows = [
    // Last week: US shown off by 20%, candidate by 10%.
    ...Array.from({ length: 10 }, (_, i) => ({ destination: "MCO", boughtAt: at(8 + (i % 5)), price: 100, shown: 120, candidate: 110 })),
    // This week: shown 5% off (better), candidate 25% off (worse).
    ...Array.from({ length: 10 }, (_, i) => ({ destination: "MCO", boughtAt: at(1 + (i % 5)), price: 100, shown: 105, candidate: 75 })),
    // International: too few fares to judge.
    { destination: "NRT", boughtAt: at(2), price: 1000, shown: 900, candidate: 1000 },
  ];
  const p = progressOf(rows, 10, now);
  const line = (g: string, f: string) => p.lines.find((l) => l.group === g && l.formula === f)!;
  assert.equal(line("US", "shown").trend, "better");
  assert.equal(line("US", "candidate").trend, "worse");
  assert.equal(line("International", "shown").trend, "too few fares");
  assert.deepEqual(p.destinations.map((d) => d.destination), ["NRT", "MCO"]);  // furthest off first
  const r = progressReport(p);
  assert.equal(r.worse.length, 1);
  assert.ok(r.lines.some((l) => l.startsWith("US, candidate") && l.endsWith("WORSE")));
});

test("leanLines: says which way we lean in the owner's words, and how close separately", async () => {
  const { leanLines, leanWords } = await import("./fareForecasts.js");
  assert.equal(leanWords(15.8), "high by 16%");
  assert.equal(leanWords(-5.9), "low by 6%");
  assert.equal(leanWords(0.3), "even");
  const at = new Date("2026-10-10T10:00:00Z");
  // US: 2 far too low, 1 close, 2 far too high: the middle fare is +2%.
  const rows: ForecastRow[] = [70, 80, 102, 130, 140].map((c) =>
    ({ destination: "MCO", boughtAt: at, price: 100, shown: 116, candidate: c }));
  const s = { ...scoreForecasts(rows, 10), informedBy: { domestic: 120, international: 90, feed: 4000 } };
  const lines = leanLines(s);
  assert.ok(lines.includes("  Our shown fares lean high by 16% on average."));
  assert.ok(lines.includes("  Our candidate fares lean high by 2% on average."));
  assert.ok(lines.some((l) => l.includes("candidate: 20% within ±10%, 40% more than 10% too low, 40% more than 10% too high")),
    "the lean never stands alone: how close is said beside it");
  assert.ok(lines.some((l) => l.startsWith("We are using 210 fares to inform our guesses (120 US and 90 international")
    && l.includes("4,000 free-feed")));
  assert.ok(!lines.some((l) => l.startsWith("International")), "no international fares, no international lines");
});
