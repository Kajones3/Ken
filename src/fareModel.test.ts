import { test } from "node:test";
import assert from "node:assert/strict";
import { fitFareModel, leaveOneOut, routeMiles, type ModelBaseline, type ModelFare, type ModelInputs } from "./fareModel.js";
import { memoryDb } from "./db.js";
import { loadBook } from "./book.js";
import { recordFlightObservations, SERPAPI_FLIGHTS } from "./observations.js";
import { quotedEstimate, ESTIMATE_LEAN_KEY } from "./pricing.js";
import { clearFareModelCache } from "./fareModelDb.js";
import { readInsights } from "./providers/serpapiFlights.js";

const now = new Date("2026-10-06T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
// 2027-03-10 is a Wednesday and not a holiday week.
const fare = (origin: string, destination: string, price: number, extra: Partial<ModelFare> = {}): ModelFare =>
  ({ origin, destination, departDate: "2027-03-10", price, observedAt: daysAgo(2), ...extra });
const bts = (origin: string, destination: string, med: number): ModelBaseline =>
  ({ origin, destination, quarter: 1, med, p25: med * 0.8, p75: med * 1.25, source: "bts_db1b" });
const inputs = (fares: ModelFare[], baselines: ModelBaseline[]): ModelInputs =>
  ({ fares, baselines, premiumPct: (_k, d) => d, now });

const US = ["ATL", "BOS", "ORD", "DEN", "DFW", "SEA", "PHX", "MSP"];

test("an unbought US route is its BTS median moved by what bought fares measured", () => {
  const m = fitFareModel(inputs(US.map((o) => fare(o, "MCO", 360)), [...US.map((o) => bts(o, "MCO", 300)), bts("RDU", "MCO", 250)]));
  // Bought fares run 1.2x their BTS medians, so RDU (never bought) reads 250 x 1.2.
  assert.equal(m.predict("RDU", "MCO", "2027-03-10")!.value, 300);
  assert.equal(m.predict("RDU", "MCO", "2027-03-10")!.parts.route, 1);
});

test("one odd fare moves its route only partway, and many can't move it past 1.5x", () => {
  const base = US.map((o) => bts(o, "MCO", 300));
  const one = fitFareModel(inputs([...US.map((o) => fare(o, "MCO", 300)), fare("RDU", "MCO", 600)], [...base, bts("RDU", "MCO", 300)]));
  const r = one.predict("RDU", "MCO", "2027-03-10")!;
  // One search saying 2x, shrunk by 1/(1+2): about 1.26x, nowhere near 2x.
  assert.ok(r.parts.route > 1.2 && r.parts.route < 1.3, `route ${r.parts.route}`);
  const many = fitFareModel(inputs(
    [...US.map((o) => fare(o, "MCO", 300)), ...[1, 2, 3, 4, 5, 6].map((i) => fare("RDU", "MCO", 900, { departDate: `2027-03-1${i}` }))],
    [...base, bts("RDU", "MCO", 300)]));
  assert.equal(many.predict("RDU", "MCO", "2027-03-10")!.parts.route, 1.5);
});

test("route evidence older than 45 days no longer counts for that route", () => {
  const base = [...US.map((o) => bts(o, "MCO", 300)), bts("RDU", "MCO", 300)];
  const m = fitFareModel(inputs([...US.map((o) => fare(o, "MCO", 300)), fare("RDU", "MCO", 600, { observedAt: daysAgo(60) })], base));
  assert.equal(m.predict("RDU", "MCO", "2027-03-10")!.parts.route, 1);
});

test("international prices follow distance, not one flat number per region", () => {
  const seed = (o: string): ModelBaseline => ({ origin: o, destination: "NRT", quarter: 1, med: 1000, p25: 900, p75: 1100, source: "seed_guess" });
  const origins = ["SEA", "SFO", "LAX", "DEN", "ORD", "ATL", "BOS", "MIA"];
  // Real fares that grow with distance.
  const fares = origins.map((o) => fare(o, "NRT", Math.round(2 * routeMiles(o, "NRT")! ** 0.8)));
  const m = fitFareModel(inputs(fares, [...origins, "PDX", "JFK"].map(seed)));
  const pdx = m.predict("PDX", "NRT", "2027-03-10")!.value;
  const jfk = m.predict("JFK", "NRT", "2027-03-10")!.value;
  assert.ok(jfk > pdx * 1.15, `JFK ${jfk} should cost more than PDX ${pdx}`);
  // And each lands near the true curve (within 10%).
  for (const [o, v] of [["PDX", pdx], ["JFK", jfk]] as const) {
    const truth = 2 * routeMiles(o, "NRT")! ** 0.8;
    assert.ok(Math.abs(v / truth - 1) < 0.1, `${o}: ${v} vs ${truth}`);
  }
});

test("Google's typical price is a second opinion on the route, put on our scale", () => {
  const base = [...US.map((o) => bts(o, "MCO", 300)), bts("RDU", "MCO", 300)];
  // Everywhere Google's midpoint sits at 0.9 of the fare we keep...
  const others = US.map((o) => fare(o, "MCO", 300, { insightMid: 333.33 }));
  // ...and on RDU our one fare looked high (450) while Google said typical.
  const m = fitFareModel(inputs([...others, fare("RDU", "MCO", 450, { insightMid: 333.33 })], base));
  const without = fitFareModel(inputs([...others, fare("RDU", "MCO", 450)], base));
  assert.ok(m.predict("RDU", "MCO", "2027-03-10")!.value < without.predict("RDU", "MCO", "2027-03-10")!.value);
});

test("grading leaves each fare (and any re-buy of the same date) out of its own estimate", () => {
  const base = [...US.map((o) => bts(o, "MCO", 300)), bts("RDU", "MCO", 300)];
  const fares = [...US.map((o) => fare(o, "MCO", 300)), fare("RDU", "MCO", 600), fare("RDU", "MCO", 600, { observedAt: daysAgo(1) })];
  const loo = leaveOneOut(inputs(fares, base), [fares.length - 1]);
  // Without its own two buys RDU has no route evidence: 300.
  assert.equal(loo.get(fares.length - 1), 300);
});

test("readInsights keeps Google's range and history, and drops shapes it doesn't know", () => {
  const i = readInsights({ price_insights: { typical_price_range: [420, 300], lowest_price: 280, price_level: "typical",
    price_history: [[1700000000, 310], ["x", 5], [1700086400, 0], [1700172800, 320]] } }, 24);
  assert.deepEqual(i, { typicalLow: 300, typicalHigh: 420, lowestPrice: 280, priceLevel: "typical",
    history: [[1700000000, 310], [1700172800, 320]], itineraries: 24 });
  assert.deepEqual(readInsights({}, 3), { typicalLow: undefined, typicalHigh: undefined, lowestPrice: undefined,
    priceLevel: undefined, history: undefined, itineraries: 3 });
});

test("the switch: off = live formula, on = the candidate, never leaned", async () => {
  const d = await memoryDb();
  for (const o of [...US, "RDU"]) {
    await d.query(`insert into historical_fares (origin, destination, year, quarter, avg_fare_usd, median_fare_usd, p25_fare_usd, p75_fare_usd, fetched_at)
                   values ($1,'MCO',2025,1,300,300,240,375,'2026-01-01')`, [o]);
  }
  await d.query(`insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, basis_quarter)
                 values ('00000000-0000-0000-0000-000000000001', 1, 1, 1, '2025Q1')`);
  await recordFlightObservations(d, US.map((o) => ({ origin: o, destination: "MCO", departDate: "2027-03-10", tripLength: 7,
    priceUsd: 360, stops: 0, insights: { typicalLow: 300, typicalHigh: 420, itineraries: 20 } })), SERPAPI_FLIGHTS);
  const kept = await d.query<{ n: string }>(`select count(*)::text as n from flight_insights`);
  assert.equal(kept.rows[0]!.n, String(US.length));
  await d.query(`insert into owner_settings (key, value) values ($1, $2::jsonb)`, [ESTIMATE_LEAN_KEY, "100"]);
  const req = { origin: "RDU", destinations: ["MCO"], resortIds: ["wdw"], from: "2027-03-10", to: "2027-03-10", tripLength: 7 };
  const live = await loadBook(d, req);
  // Live: BTS p75 (lean 100) x trend 1 = 375.
  assert.equal(quotedEstimate(live, "RDU", "MCO", "2027-03-10"), 375);
  await d.query(`insert into owner_settings (key, value) values ('flight.useCandidate', '1'::jsonb)`);
  clearFareModelCache(d);
  const cand = await loadBook(d, req);
  // Candidate: 300 x 1.2 measured, NOT pushed to the dear end by the lean.
  assert.equal(quotedEstimate(cand, "RDU", "MCO", "2027-03-10"), 360);
  assert.equal(cand.flightEstimate!("RDU", "MCO", "2027-03-10")!.candidate, true);
  // The scoreboard can still ask for the live formula with the switch on.
  const forced = await loadBook(d, req, { formula: "live" });
  assert.equal(quotedEstimate(forced, "RDU", "MCO", "2027-03-10"), 375);
  await d.close();
});
