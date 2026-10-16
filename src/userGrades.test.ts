import { test } from "node:test";
import assert from "node:assert/strict";
import { inTypical, withinZone, weekly, gradeFlights, gradeDisney, gradeOffProperty, summaryLines, quantile, yardsticks, GRADE_MIN, GRADE_WINDOW_DAYS, luckPoints } from "./userGrades.js";
import type { GoogleDisneyRate } from "./disneyEvidence.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

test("the owner's case: seven $1,200 fares, one $1,900, two $3,000 — $1,900 is NOT typical, $1,200 is", () => {
  const list = [1200, 1200, 1200, 1200, 1200, 1200, 1200, 1900, 3000, 3000];
  assert.equal(inTypical(1200, list, 0.1), true);
  assert.equal(inTypical(1900, list, 0.1), false);
});

test("middle half: drop the cheapest and dearest quarters", () => {
  const list = [100, 200, 300, 400, 500];
  assert.equal(quantile(list, 0.25), 200);
  assert.equal(quantile(list, 0.75), 400);
  assert.equal(inTypical(199, list, 0.1), false);
  assert.equal(inTypical(350, list, 0.1), true);
  assert.equal(inTypical(401, list, 0.1), false);
});

test("with fewer than 4 prices there is no middle half: within ±zone of their middle", () => {
  assert.equal(inTypical(105, [100], 0.1), true);
  assert.equal(inTypical(115, [100, 100], 0.1), false);
});

test("cheapest: within ±zone of the cheapest listed, either direction", () => {
  assert.equal(withinZone(95, 100, 0.1), true);
  assert.equal(withinZone(111, 100, 0.1), false);
  assert.equal(withinZone(89, 100, 0.1), false);
});

test("weekly: the last two weeks vs the two before, a trend only past the luck (2026-10-16)", () => {
  const items = [
    ...Array.from({ length: GRADE_MIN }, (_, i) => ({ at: daysAgo(3), ok: i < 6 })),
    ...Array.from({ length: GRADE_MIN }, (_, i) => ({ at: daysAgo(10), ok: i < 6 })),   // still "recent": 14-day window
    ...Array.from({ length: GRADE_MIN }, (_, i) => ({ at: daysAgo(20), ok: i < 2 })),
  ];
  const w = weekly(items, NOW);
  assert.equal(GRADE_WINDOW_DAYS, 14);
  assert.equal(w.recent.n, 2 * GRADE_MIN);
  assert.equal(w.recent.pct, 75);
  assert.equal(w.before.pct, 25);
  assert.ok(w.recent.luck! > 0 && w.before.luck! > 0, "each grade carries its luck");
  // 50 points apart is far outside ±(10 + 13) of luck: a real change.
  assert.equal(w.trend, "better");
  assert.equal(weekly(items.slice(0, 3), NOW).trend, "too few");
  // 60% vs 50% on 20 numbers each is inside the luck: "about the same".
  const close = [
    ...Array.from({ length: 20 }, (_, i) => ({ at: daysAgo(2), ok: i < 12 })),
    ...Array.from({ length: 20 }, (_, i) => ({ at: daysAgo(18), ok: i < 10 })),
  ];
  assert.equal(weekly(close, NOW).trend, "about the same");
});

test("luckPoints: about ±6 points on 60 numbers at 50%, smaller with more", () => {
  assert.equal(luckPoints(30, 60), 6);
  assert.ok(luckPoints(120, 240)! <= 3);
  assert.equal(luckPoints(0, 0), null);
  assert.ok(luckPoints(8, 8)! >= 1, "8 of 8 still shows a margin");
});

test("flights: typical, cheapest and overall, split US / international", () => {
  const pool = [300, 350, 400, 450, 500];
  const g = gradeFlights([
    { intl: false, at: daysAgo(1), shown: 420, shownCheapest: 305, candidate: 600, pool },
    { intl: false, at: daysAgo(2), shown: 900, pool },
    { intl: true, at: daysAgo(1), shown: 400, pool },
  ], 0.1, NOW);
  assert.equal(g.us.typical.month.n, 2);
  assert.equal(g.us.typical.month.right, 1);
  assert.equal(g.us.cheapest.month.right, 1);
  assert.equal(g.us.overall.month.n, 3);
  assert.equal(g.us.overall.month.right, 2);
  assert.equal(g.us.candidateTypical.right, 0);
  assert.equal(g.intl.typical.month.right, 1);
  // Lean: our typical over the list's middle. 420/400 and 900/400 -> median of +5% and +125%.
  assert.equal(g.us.leanPct, 65);
});

const rate = (o: Partial<GoogleDisneyRate>): GoogleDisneyRate => ({
  resortId: "wdw", hotelId: "x", hotelName: "x", googleName: "x", night: "2027-03-15",
  google: 300, lead: 300, ours: 300, pulledAt: daysAgo(1), ...o,
});

test("Disney typical: Google's own rates for that hotel and month never grade the price they set", () => {
  // Ours reads 200 against Google's 300. Graded leave-one-out, no other evidence:
  // the correction is refitted without these rates, so we stay at 200 and miss.
  const hotelId = "wdw-pop";
  const rates = [rate({ hotelId, night: "2027-03-14", ours: 200 }), rate({ hotelId, night: "2027-03-15", ours: 200 })];
  const g = gradeDisney(rates, { zone: 0.1, now: NOW, checks: [], googleWeight: 1, priorWeight: 3, hotelBase: () => undefined });
  assert.equal(g.us.typical.month.n, 1);
  assert.equal(g.us.typical.month.right, 0);
});

test("Disney cheapest is graded within the category (Moderate against Moderate)", () => {
  const rates = [
    rate({ hotelId: "wdw-cbr", resortId: "wdw", google: 300, ours: 310 }),
    rate({ hotelId: "wdw-por", resortId: "wdw", google: 280, ours: 285, night: "2027-03-16" }),
  ];
  const g = gradeDisney(rates, { zone: 0.1, now: NOW, checks: [], googleWeight: 1, priorWeight: 3, hotelBase: () => undefined });
  // Both moderate: our cheapest 285 vs Google's cheapest 280 -> right.
  assert.equal(g.us.cheapest.month.n, 1);
  assert.equal(g.us.cheapest.month.right, 1);
});

test("off property: each search graded by the one before it", () => {
  const flat = () => 1;
  const pulls = [
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-15" as const, pulledAt: daysAgo(12), rates: [100, 150, 200, 250, 300, 350] },
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-15" as const, pulledAt: daysAgo(2), rates: [110, 160, 210, 260, 310, 360] },
  ];
  const g = gradeOffProperty(pulls, 0.1, NOW, flat);
  assert.equal(g.us.typical.month.n, 1);
  assert.equal(g.us.typical.month.right, 1);
  // Three price thirds, each cheapest within 10%: 100/110, 200/210, 300/310.
  assert.equal(g.us.cheapest.month.n, 3);
  assert.equal(g.us.cheapest.month.right, 3);
});

test("the summary only says what the numbers back", () => {
  const empty = gradeFlights([], 0.1, NOW);
  const none = { us: gradeOffProperty([], 0.1, NOW).us, intl: gradeOffProperty([], 0.1, NOW).intl };
  const lines = summaryLines({ flights: { zonePct: 10, unmatched: 0, ...empty }, hotels: { zonePct: 10, disney: none, offProperty: none } });
  assert.deepEqual(lines, ["Cheapest-trip flight grades start with the next nightly fares (written down before buying since 2026-10-16)."]);
});

test("loader: a forecast is matched to Google's list from the same search and graded", async () => {
  const { memoryDb } = await import("./db.js");
  const { gzipSync } = await import("node:zlib");
  const { loadUserGrades } = await import("./userGrades.js");
  const db = await memoryDb();
  const body = JSON.stringify({ best_flights: [300, 350, 400, 450, 500].map((price) => ({ price, type: "Round trip" })) });
  await db.query(
    `insert into provider_responses (source, kind, request, status, body_gz, bytes, fetched_at)
     values ('serpapi_flights','google_flights',$1,200,$2,10, now() - interval '1 day')`,
    [JSON.stringify({ departure_id: "ATL", arrival_id: "MCO", outbound_date: "2027-03-15", return_date: "2027-03-22" }), gzipSync(body)],
  );
  await db.query(
    `insert into fare_forecasts (origin, destination, depart_date, trip_length, shown_usd, shown_cheapest_usd,
       formula, price_usd, job, forecast_at, bought_at)
     values ('ATL','MCO','2027-03-15',7,420,310,'live',400,'popular_routes', now() - interval '1 day', now() - interval '1 day')`,
  );
  const g = await loadUserGrades(db);
  assert.equal(g.flights.unmatched, 0);
  assert.equal(g.flights.us.typical.month.right, 1);
  assert.equal(g.flights.us.cheapest.month.right, 1);
  assert.equal(g.flights.us.overall.month.n, 2);
  assert.ok(g.summary.some((l) => l.startsWith("US flights, typical trip")));
  await db.close();
});

test("yardsticks: a bunched Google list makes the middle half NARROWER than ±10%", () => {
  // Ten itineraries bunched near $400: the middle half is ~$395-$405.
  const pool = [380, 390, 395, 398, 400, 400, 402, 405, 410, 600];
  const y = yardsticks([{ intl: false, at: NOW, shown: 430, bought: 400, pool }], 0.1);
  assert.equal(y.us.oldRight, 1);  // $430 is within 10% of the $400 we bought
  assert.equal(y.us.newRight, 0);  // ...but above the list's upper quartile
  assert.equal(y.us.oldOnly, 1);
  assert.equal(y.us.narrowHigh, 1);
});
