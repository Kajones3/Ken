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

test("one odd fare moves its route only partway; more searches take it as far as the evidence says", () => {
  const base = US.map((o) => bts(o, "MCO", 300));
  const one = fitFareModel(inputs([...US.map((o) => fare(o, "MCO", 300)), fare("RDU", "MCO", 600)], [...base, bts("RDU", "MCO", 300)]));
  const r = one.predict("RDU", "MCO", "2027-03-10")!;
  // One search saying 2x, shrunk by 1/(1+2): about 1.26x, nowhere near 2x.
  assert.ok(r.parts.route > 1.2 && r.parts.route < 1.3, `route ${r.parts.route}`);
  const many = fitFareModel(inputs(
    [...US.map((o) => fare(o, "MCO", 300)), ...[1, 2, 3, 4, 5, 6].map((i) => fare("RDU", "MCO", 900, { observedAt: daysAgo(i) }))],
    [...base, bts("RDU", "MCO", 300)]));
  // Six searches saying 3x: n/(n+2) = 3/4 of the way (in proportion), about 2.28x.
  // No cap: if the first guess was far off, enough evidence moves it far.
  const r6 = many.predict("RDU", "MCO", "2027-03-10")!.parts.route;
  assert.ok(Math.abs(r6 - 3 ** 0.75) < 0.01, `route ${r6}`);
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

test("each destination learns its own lever: Orlando reading low no longer drags Los Angeles", () => {
  // Orlando fares run 1.3x their BTS median, LAX fares right on it. One
  // shared US calibration would read Orlando low and LAX high.
  const fares = [...US.map((o) => fare(o, "MCO", 390)), ...US.map((o) => fare(o, "LAX", 400))];
  const base = [...US.map((o) => bts(o, "MCO", 300)), ...US.map((o) => bts(o, "LAX", 400)), bts("RDU", "MCO", 300), bts("RDU", "LAX", 400)];
  const m = fitFareModel(inputs(fares, base));
  const mco = m.predict("RDU", "MCO", "2027-03-10")!.value;
  const lax = m.predict("RDU", "LAX", "2027-03-10")!.value;
  // Shrunk by 8/(8+4): most of the way to each truth, far closer than a shared number.
  assert.ok(Math.abs(mco / 390 - 1) < 0.06, `MCO ${mco}`);
  assert.ok(Math.abs(lax / 400 - 1) < 0.06, `LAX ${lax}`);
  assert.ok(m.levers.destination.MCO!.factor > m.levers.destination.LAX!.factor);
});

test("Europe and Asia each get their own calibration", () => {
  const seed = (o: string, d: string): ModelBaseline => ({ origin: o, destination: d, quarter: 1, med: 1000, p25: 900, p75: 1100, source: "seed_guess" });
  const origins = ["SEA", "SFO", "LAX", "DEN", "ORD", "ATL", "BOS", "MIA"];
  // Same distance curve, but Asia fares sit 30% above Europe's.
  const fares = [
    ...origins.map((o) => fare(o, "CDG", Math.round(1.5 * routeMiles(o, "CDG")! ** 0.8))),
    ...origins.map((o) => fare(o, "NRT", Math.round(1.95 * routeMiles(o, "NRT")! ** 0.8))),
  ];
  const m = fitFareModel(inputs(fares, origins.flatMap((o) => [seed(o, "CDG"), seed(o, "NRT")])));
  assert.ok(m.levers.calibration.asia > m.levers.calibration.europe * 1.15,
    `asia ${m.levers.calibration.asia} vs europe ${m.levers.calibration.europe}`);
  assert.equal(m.predict("ATL", "CDG", "2027-03-10")!.parts.group, "europe");
});

test("a learned season replaces a wrong guessed one, and the monthly survey is preferred for US routes", () => {
  // Summer fares sit right on the BTS quarter, but our fares say otherwise
  // in Q3: six Q3 fares at 0.8x. The season lever learns most of that.
  const q3 = (o: string, price: number) => fare(o, "MCO", price, { departDate: "2027-07-14" });
  const btsQ3 = (o: string): ModelBaseline => ({ ...bts(o, "MCO", 300), quarter: 3 });
  const fares = [...US.map((o) => fare(o, "MCO", 300)), ...US.slice(0, 6).map((o) => q3(o, 240))];
  const m = fitFareModel(inputs(fares, [...US.map((o) => bts(o, "MCO", 300)), ...US.map(btsQ3), btsQ3("RDU"), bts("RDU", "MCO", 300)]));
  const s = m.predict("RDU", "MCO", "2027-07-14")!.parts.season;
  assert.ok(s < 0.92 && s > 0.8, `season ${s}`);

  const mm = fitFareModel({ ...inputs(US.map((o) => fare(o, "MCO", 300)), [...US.map((o) => bts(o, "MCO", 300)), bts("RDU", "MCO", 300)]),
    monthly: [{ origin: "RDU", destination: "MCO", month: 3, med: 280, p25: 200, p75: 400 }] });
  const p = mm.predict("RDU", "MCO", "2027-03-10")!;
  assert.equal(p.parts.priorKind, "bts_monthly");
  assert.equal(p.parts.prior, 280);
});

test("day of week comes from the free feed; paid fares' 'weekday' goes to the month it really was", () => {
  // Paid fares: every March fare on a Monday (Mar 15 2027), every April fare
  // on a Thursday (Apr 15). March really is 20% dearer than April.
  const paid = US.flatMap((o) => [
    fare(o, "MCO", 360, { departDate: "2027-03-15" }),
    fare(o, "MCO", 300, { departDate: "2027-04-15" }),
  ]);
  const base = US.flatMap((o) => [bts(o, "MCO", 300), { ...bts(o, "MCO", 300), quarter: 2 }]);
  // The free feed: the same route and month on every weekday, all priced
  // the same, so day of week doesn't move fares.
  const feed = US.flatMap((o) => ["03", "04"].flatMap((mm) =>
    Array.from({ length: 28 }, (_, i) => ({ origin: o, destination: "MCO",
      departDate: `2027-${mm}-${String(i + 1).padStart(2, "0")}`, tripLength: 7, price: 200 }))));
  const m = fitFareModel({ ...inputs(paid, base), feed });
  assert.equal(m.levers.dayOfWeekFrom, "free feed");
  for (const v of Object.values(m.levers.dayOfWeek)) assert.equal(v.factor, 1);
  const mar = m.predict("ATL", "MCO", "2027-03-15")!, apr = m.predict("ATL", "MCO", "2027-04-15")!;
  assert.ok(mar.parts.month > apr.parts.month, `month: Mar ${mar.parts.month} vs Apr ${apr.parts.month}`);
  // Another March date on a Thursday is priced like March, not like "Thursday".
  const marThu = m.predict("ATL", "MCO", "2027-03-18")!;
  assert.equal(marThu.parts.month, mar.parts.month);
  assert.equal(marThu.parts.dayOfWeek, 1);

  // Without the feed, the paid fares still set day of week, as before.
  const noFeed = fitFareModel(inputs(paid, base));
  assert.equal(noFeed.levers.dayOfWeekFrom, "paid fares");
});

test("budget airlines: routes they crowd are learned to price lower, from US fares only", () => {
  // Same BTS median everywhere; the budget-heavy routes really cost 30% less.
  const heavy = new Set(["ATL", "BOS", "ORD", "DEN"]);
  const fares = US.flatMap((o) => [1, 2, 3].map((i) => fare(o, "MCO", heavy.has(o) ? 280 : 400, { observedAt: daysAgo(60 + i) })));
  const monthly = US.map((o) => ({ origin: o, destination: "MCO", month: 3, med: 400, p25: 320, p75: 500, budgetShare: heavy.has(o) ? 0.4 : 0 }));
  const m = fitFareModel({ ...inputs(fares, US.map((o) => bts(o, "MCO", 400))), monthly });
  assert.ok(m.levers.budget.slope < 0, `slope ${m.levers.budget.slope}`);
  const atl = m.predict("ATL", "MCO", "2027-03-10")!, sea = m.predict("SEA", "MCO", "2027-03-10")!;
  assert.ok(atl.value < sea.value * 0.85, `ATL ${atl.value} vs SEA ${sea.value}`);
  // A route with no survey share gets no budget lever at all.
  assert.equal(m.predict("RDU", "MCO", "2027-03-10")?.parts.budget ?? 1, 1);
});

test("government airfare index: an old route survey is carried to today as far as the fares show", async () => {
  const { shiftPeriod } = await import("./airfareIndex.js");
  // Airline fares (CPI) sat at 100 through June 2025, then 125.
  const cpiSa = new Map<string, number>();
  for (let p = "2024-01"; p <= "2026-08"; p = shiftPeriod(p, 1)) cpiSa.set(p, p < "2025-07" ? 100 : 125);
  const OLD = US, NEW = ["CLT", "LAS", "SFO", "IAH", "DTW", "PHL", "BWI", "MIA"];
  const baselines = [...OLD.map((o) => ({ ...bts(o, "MCO", 300), year: 2024 })), ...NEW.map((o) => ({ ...bts(o, "MCO", 300), year: 2026 })),
    { ...bts("RDU", "MCO", 300), year: 2024 }, { ...bts("SAN", "MCO", 300), year: 2026 }];
  // Routes surveyed in 2024 really cost 25% more than their survey says; 2026 ones don't.
  const fares = [...OLD.map((o) => fare(o, "MCO", 375)), ...NEW.map((o) => fare(o, "MCO", 300))];
  const without = fitFareModel(inputs(fares, baselines));
  const withIdx = fitFareModel({ ...inputs(fares, baselines), index: { cpiSa } });
  assert.equal(without.levers.index.surveyAge.weight, 0);
  // Learned, not assumed: the fares say "fully", shrunk by 16 / (16 + 20).
  const w = withIdx.levers.index.surveyAge.weight;
  assert.ok(w > 0.4 && w < 0.5, `weight ${w}`);
  // An unbought 2024-surveyed route now reads above an unbought 2026 one.
  const old = withIdx.predict("RDU", "MCO", "2027-03-10")!, fresh = withIdx.predict("SAN", "MCO", "2027-03-10")!;
  assert.ok(old.value > fresh.value * 1.08, `${old.value} vs ${fresh.value}`);
  assert.ok(old.parts.index > 1.08 && fresh.parts.index === 1);
  // Without the index both read the same.
  assert.equal(without.predict("RDU", "MCO", "2027-03-10")!.value, without.predict("SAN", "MCO", "2027-03-10")!.value);
});

test("government airfare index: when the fares don't follow it, it teaches nothing", async () => {
  const { shiftPeriod } = await import("./airfareIndex.js");
  const cpiSa = new Map<string, number>();
  for (let p = "2024-01"; p <= "2026-08"; p = shiftPeriod(p, 1)) cpiSa.set(p, p < "2025-07" ? 100 : 125);
  const NEW = ["CLT", "LAS", "SFO", "IAH", "DTW", "PHL", "BWI", "MIA"];
  const baselines = [...US.map((o) => ({ ...bts(o, "MCO", 300), year: 2024 })), ...NEW.map((o) => ({ ...bts(o, "MCO", 300), year: 2026 }))];
  const fares = [...US, ...NEW].map((o) => fare(o, "MCO", 330));
  const m = fitFareModel({ ...inputs(fares, baselines), index: { cpiSa } });
  assert.equal(m.levers.index.surveyAge.weight, 0);
  // And every bought fare is from the same month, so fare age learns nothing either.
  assert.equal(m.levers.index.fareAge.dom.weight, 0);
});
