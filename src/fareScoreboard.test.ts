import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { scoreFares, loadScoreboard, type Baseline, type BoughtFare } from "./fareScoreboard.js";
import { recordSearch, loadRouteDemand } from "./routeDemand.js";

const at = new Date("2026-10-01T00:00:00Z");
const bts = (origin: string, destination: string, quarter: number, med: number, p25: number, p75: number): Baseline =>
  ({ origin, destination, year: 2025, quarter, med, p25, p75, source: "bts_db1b", fetchedAt: new Date("2026-09-29T00:00:00Z") });
const fare = (origin: string, destination: string, departDate: string, price: number, fetchedAt = at): BoughtFare =>
  ({ origin, destination, departDate, price, fetchedAt });
const flat = { premiumPct: (_k: string, d: number) => d };

test("the estimate is rebuilt blind: baseline x trend, leaned, against the real fare", () => {
  const b = scoreFares({
    fares: [fare("ATL", "MCO", "2027-03-10", 300)],
    baselines: [bts("ATL", "MCO", 1, 200, 150, 250)],
    trend: 1.2, lean: 50, ...flat,
  });
  // 200 x 1.2 = 240 at lean 50; 240 / 300 - 1 = -20%.
  assert.equal(b.tested, 1);
  assert.equal(b.domestic.medianPct, -20);
  assert.equal(b.domestic.typicalOffPct, 20);
  // At lean 100: 250 x 1.2 = 300, spot on.
  assert.equal(b.domestic.byLean.find((x) => x.lean === 100)!.typicalOffPct, 0);
  assert.equal(b.domestic.bestLean, 100);
  assert.equal(b.routes[0]!.estMedian, 240);
});

test("the matching quarter is used, the holiday premium is applied, and no trend means no test", () => {
  const baselines = [bts("ATL", "MCO", 4, 100, 100, 100), bts("ATL", "MCO", 1, 999, 999, 999)];
  const thanksgiving = scoreFares({ fares: [fare("ATL", "MCO", "2026-11-25", 155)], baselines, trend: 1, lean: 50, ...flat });
  // Q4 baseline 100, +55% Thanksgiving = 155.
  assert.equal(thanksgiving.all.typicalOffPct, 0);
  const none = scoreFares({ fares: [fare("ATL", "MCO", "2026-11-25", 155)], baselines, trend: null, lean: 50, ...flat });
  assert.equal(none.tested, 0);
  assert.equal(none.skipped.noTrend, 1);
});

test("an international fare only tests a sampled baseline built BEFORE it", () => {
  const sampled: Baseline = { origin: "ATL", destination: "NRT", year: 2026, quarter: 1, med: 1500, p25: 1400, p75: 1600,
    source: "sampled_live", fetchedAt: new Date("2026-09-20T00:00:00Z") };
  const b = scoreFares({
    fares: [fare("ATL", "NRT", "2027-02-01", 1500, new Date("2026-09-10T00:00:00Z")), fare("ATL", "NRT", "2027-02-02", 1250)],
    baselines: [sampled], trend: 2, lean: 50, ...flat,
  });
  assert.equal(b.skipped.builtFromIt, 1);
  assert.equal(b.international.n, 1);
  // Trend never touches a sampled baseline: 1500 / 1250 - 1 = +20%.
  assert.equal(b.international.medianPct, 20);
  assert.equal(b.domestic.n, 0);
});

test("an alternate airport falls back to its resort's main airport baseline", () => {
  const b = scoreFares({ fares: [fare("ATL", "TPA", "2027-03-10", 240)], baselines: [bts("ATL", "MCO", 1, 240, 240, 240)], trend: 1, lean: 50, ...flat });
  assert.equal(b.tested, 1);
  assert.equal(b.all.typicalOffPct, 0);
});

test("the scoreboard reads only bought SerpApi fares from the database", async () => {
  const d = await memoryDb();
  await d.query(`insert into historical_fares (origin, destination, year, quarter, avg_fare_usd, median_fare_usd, p25_fare_usd, p75_fare_usd)
                 values ('ATL','MCO',2025,1,200,200,150,250)`);
  await d.query(`insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, basis_quarter)
                 values ('00000000-0000-0000-0000-000000000001', 1.5, 1, 2, '2025Q1')`);
  await d.query(`insert into flight_prices (origin, destination, depart_date, trip_length, price_usd, source)
                 values ('ATL','MCO','2027-03-10',7,300,'serpapi_flights'), ('ATL','MCO','2027-03-11',7,99,'travelpayouts'),
                        ('ATL','MCO','2027-03-12',7,98,null)`);
  const b = await loadScoreboard(d, 30);
  assert.equal(b.tested, 1);
  // Shipped lean is 100: 250 x 1.5 = 375 against 300 = +25%.
  assert.equal(b.lean, 100);
  assert.equal(b.all.medianPct, 25);
  await d.close();
});

test("searches are counted per day by home airport and month, and the owner's are left out of the daily counts", async () => {
  const d = await memoryDb();
  await recordSearch(d, "RDU", ["MCO", "SNA", "CDG"], "2027-03");
  await recordSearch(d, "RDU", ["MCO", "SNA", "CDG"], "2027-03");
  await recordSearch(d, "ATL", ["MCO"], "2027-04");
  await recordSearch(d, "BNA", ["MCO"], "2027-04", false);
  const r = await loadRouteDemand(d, 30);
  assert.equal(r.total, 3, "one comparison counts once, not once per resort; the owner's isn't counted");
  assert.deepEqual(r.byOrigin.map((x) => [x.origin, x.searches]), [["RDU", 2], ["ATL", 1]]);
  assert.equal(r.byOrigin[0]!.city, "Raleigh–Durham");
  assert.deepEqual(r.byMonth, [{ month: "2027-03", searches: 2 }, { month: "2027-04", searches: 1 }]);
  // The running route totals still include the owner, since buying reads them.
  assert.ok(r.routes.some((x) => x.origin === "BNA"));
  const rdu = r.routes.find((x) => x.origin === "RDU")!;
  assert.equal(rdu.searches, 2, "one row per home airport and month, not one per resort");
  assert.equal(r.routes.filter((x) => x.origin === "RDU").length, 1);
  assert.deepEqual(Object.keys(rdu.fares).sort(), ["dlp", "dlr", "hkdl", "shdr", "tdr", "wdw"]);
  await d.close();
});

test("US and international fares are each graded at their own lean", () => {
  const seed: Baseline = { origin: "ATL", destination: "NRT", year: 2026, quarter: 1, med: 1000, p25: 800, p75: 1200,
    source: "seed_guess", fetchedAt: null };
  const b = scoreFares({
    fares: [fare("ATL", "MCO", "2027-03-10", 200), fare("ATL", "NRT", "2027-02-01", 800)],
    baselines: [bts("ATL", "MCO", 1, 200, 150, 250), seed],
    trend: 1, intlTrend: 1, lean: 50, leanIntl: 0, ...flat,
  });
  assert.equal(b.leanIntl, 0);
  assert.equal(b.domestic.typicalOffPct, 0);   // 200 at lean 50
  assert.equal(b.international.typicalOffPct, 0); // 800 at lean 0
  // Unset international lean = the US one.
  const same = scoreFares({ fares: [fare("ATL", "NRT", "2027-02-01", 800)], baselines: [seed], trend: 1, intlTrend: 1, lean: 50, ...flat });
  assert.equal(same.leanIntl, 50);
  assert.equal(same.international.medianPct, 25);
});

test("routes are ordered by how far off what travelers SEE now is", () => {
  const b = scoreFares({
    fares: [fare("ATL", "MCO", "2027-03-10", 200), fare("BOS", "MCO", "2027-03-10", 200)],
    baselines: [bts("ATL", "MCO", 1, 300, 300, 300), bts("BOS", "MCO", 1, 220, 220, 220)],
    trend: 1, lean: 50, ...flat,
    shownNow: new Map([["ATL|MCO|2027-03-10", 210], ["BOS|MCO|2027-03-10", 260]]),
  });
  // Blind: ATL +50%, BOS +10%. Shown now: ATL +5%, BOS +30%, so BOS leads.
  assert.deepEqual(b.routes.map((r) => [r.origin, r.shownPct]), [["BOS", 30], ["ATL", 5]]);
  assert.equal(b.shown.domestic.n, 2);
  assert.equal(b.shown.domestic.typicalOffPct, 17.5);
  assert.equal(b.shown.domestic.within15Pct, 50);
});

test("'shown now' includes what bought fares taught the route", async () => {
  const d = await memoryDb();
  await d.query(`insert into historical_fares (origin, destination, year, quarter, avg_fare_usd, median_fare_usd, p25_fare_usd, p75_fare_usd, fetched_at)
                 values ('ATL','MCO',2025,1,200,200,150,250, '2026-01-01')`);
  await d.query(`insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, basis_quarter)
                 values ('00000000-0000-0000-0000-000000000001', 1, 1, 1, '2025Q1')`);
  await d.query(`insert into flight_prices (origin, destination, depart_date, trip_length, price_usd, source)
                 values ('ATL','MCO','2027-03-10',7,300,'serpapi_flights')`);
  const b = await loadScoreboard(d, 30);
  // Blind at lean 100: 250 against 300 = -16.7%.
  assert.equal(b.all.medianPct, -16.7);
  // One bought fare moves the route a third of the way to 300/200: x1.1667,
  // so travelers now see 250 x 1.1667 = 291.67, -2.8%.
  assert.equal(b.shown.all.n, 1);
  assert.equal(b.shown.all.medianPct, -2.8);
  await d.close();
});
