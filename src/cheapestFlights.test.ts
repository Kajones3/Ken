import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapestAndMiddle, learnCheapestRatios, buildCheapestListed, type CheapestSample } from "./cheapestFlights.js";
import { priceTrip, resortById, type PriceBook, type TripParams } from "./pricing.js";

const s = (destination: string, cheapest: number, middle: number, departDate = "2027-03-10"): CheapestSample =>
  ({ origin: "ATL", destination, departDate, nights: 7, cheapest, middle });

test("cheapest and middle come from the same pool the fetcher uses", () => {
  const json = { best_flights: [{ price: 300 }, { price: 210, type: "Round trip" }],
    other_flights: [{ price: 480 }, { price: 250 }, { price: 0 }, { price: 260, type: "One way" }] };
  // Round trips only (unlabeled count): 210, 250, 300, 480 -> middle is the lower of two middles.
  assert.deepEqual(cheapestAndMiddle(json), { cheapest: 210, middle: 250, n: 4 });
  assert.equal(cheapestAndMiddle({}), undefined);
});

test("each group learns its own ratio; a thin group borrows the pooled one; too few anywhere means none", () => {
  const us = [1, 2, 3, 4, 5].map(() => s("MCO", 80, 100));
  const asia = [s("HND", 90, 100), s("HND", 90, 100)];
  const r = learnCheapestRatios([...us, ...asia]);
  assert.equal(r.get("dom")!.ratio, 0.8);
  assert.equal(r.get("dom")!.from, "dom");
  assert.equal(r.get("asia")!.from, "pooled");
  assert.equal(r.get("asia")!.ratio, 0.8);
  assert.equal(learnCheapestRatios(asia).size, 0);
});

test("the exact cheapest listed wins for a date we bought; the newest answer counts", () => {
  const list = buildCheapestListed([s("MCO", 200, 300), s("MCO", 190, 290)]);
  assert.equal(list.exact("ATL", "MCO", "2027-03-10", 7), 190);
  assert.equal(list.exact("ATL", "MCO", "2027-03-11", 7), undefined);
});

function book(extra: Partial<PriceBook>): PriceBook {
  return {
    flight: () => undefined,
    flightEstimate: () => ({ low: 300, med: 400, high: 500, basisQuarter: "2027Q1" }),
    hotelNights: (_r, date) => [{ hotelId: "pop", name: "Pop", descriptor: "", nightly: 200, tier: "value", onProperty: true }]
      .map((h) => ({ ...h, date })),
    ticket: () => ({ adult: 100, child: 90 }),
    promosFor: () => [],
    gasPrice: () => undefined,
    setting: () => undefined,
    oldestFetchedAt: null,
    ...extra,
  } as PriceBook;
}
const params: TripParams = { origin: "ATL", adults: 1, childAges: [], nights: 4, stay: "on", tier: 0, food: "qs",
  hopper: false, transportMode: "fly" } as TripParams;

test("a typical trip prices the middle fare; the cheapest trip moves it by the learned ratio", () => {
  const wdw = resortById("wdw");
  const b = book({ cheapestRatio: () => 0.8 });
  const typical = priceTrip(b, wdw, params, {}, "2027-03-10");
  const cheap = priceTrip(b, wdw, { ...params, priceBasis: "cheapest" }, {}, "2027-03-10");
  assert.ok(typical.ok && cheap.ok);
  if (!typical.ok || !cheap.ok) return;
  assert.equal(typical.price.perSeatFare, 400);
  assert.equal(cheap.price.perSeatFare, 320);
  assert.deepEqual(cheap.price.flightPick?.cheapest, { how: "ratio", middle: 400, ratio: 0.8 });
  assert.equal(cheap.price.flightPick?.price, 320, "the card prints what the total was built from");
});

test("the cheapest trip uses the exact cheapest flight Google listed when we bought that date", () => {
  const wdw = resortById("wdw");
  const b = book({ cheapestRatio: () => 0.8, cheapestListed: () => 275 });
  const cheap = priceTrip(b, wdw, { ...params, priceBasis: "cheapest" }, {}, "2027-03-10");
  assert.ok(cheap.ok);
  if (!cheap.ok) return;
  assert.equal(cheap.price.perSeatFare, 275);
  assert.equal(cheap.price.flightPick?.cheapest?.how, "listed");
});

test("with no ratio learned the cheapest trip keeps the middle fare and says so", () => {
  const wdw = resortById("wdw");
  const cheap = priceTrip(book({}), wdw, { ...params, priceBasis: "cheapest" }, {}, "2027-03-10");
  assert.ok(cheap.ok);
  if (!cheap.ok) return;
  assert.equal(cheap.price.perSeatFare, 400);
  assert.equal(cheap.price.flightPick?.cheapest?.how, "none");
});
