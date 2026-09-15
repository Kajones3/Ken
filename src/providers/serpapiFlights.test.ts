import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SerpApiFlightProvider } from "./serpapiFlights.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(body: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

function flight(price: number, airline = "Delta") {
  return { price, type: "Round trip", flights: [{ airline }] };
}

test("roundTrip: picks the MEDIAN itinerary, not the cheapest, from a spread of real options", async () => {
  // Five itineraries, deliberately out of order — median by price is 300.
  mockFetch({ best_flights: [flight(500), flight(150)], other_flights: [flight(300), flight(220), flight(900)] });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(f);
  assert.equal(f!.priceUsd, 300, "the floor ($150) is a real fare, but not what most travellers see");
});

test("roundTrip: an even count of itineraries picks the lower of the two middle ones, never an averaged number", async () => {
  mockFetch({ best_flights: [flight(100), flight(400), flight(200), flight(300)] });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(f);
  // sorted: 100,200,300,400 -> lower-middle index floor((4-1)/2)=1 -> 200
  assert.equal(f!.priceUsd, 200);
});

test("roundTrip: a single itinerary is trivially its own median", async () => {
  mockFetch({ best_flights: [flight(275, "United")] });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(f);
  assert.equal(f!.priceUsd, 275);
  assert.equal(f!.carrier, "United");
});

test("roundTrip: non-round-trip itineraries are excluded from the pool before taking the median", async () => {
  mockFetch({
    best_flights: [
      { price: 50, type: "One way", flights: [{ airline: "Spirit" }] }, // excluded
      flight(300),
    ],
    other_flights: [flight(320)],
  });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(f);
  // Pool is just [300, 320] once the one-way $50 is filtered out -> median (lower-middle) is 300.
  assert.equal(f!.priceUsd, 300);
});

test("roundTrip: falls back to the whole pool (including non-round-trip) only when nothing round-trip exists", async () => {
  mockFetch({
    best_flights: [{ price: 50, type: "One way", flights: [{ airline: "Spirit" }] }],
  });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(f);
  assert.equal(f!.priceUsd, 50);
});

test("roundTrip: no itineraries at all returns null, not a fabricated number", async () => {
  mockFetch({ best_flights: [], other_flights: [] });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.equal(f, null);
});

test("roundTrip: an error response returns null instead of throwing", async () => {
  mockFetch({ error: "no flights found" });
  const p = new SerpApiFlightProvider("key", 999, 999);
  const f = await p.roundTrip("ATL", "ZZZ", "2027-03-15", 7);
  assert.equal(f, null);
});

test("roundTrip: respects its own spend budget instead of an unbounded number of calls", async () => {
  mockFetch({ best_flights: [flight(300)] });
  const p = new SerpApiFlightProvider("key", 999, 1); // budget of 1
  const first = await p.roundTrip("ATL", "MCO", "2027-03-15", 7);
  assert.ok(first);
  const second = await p.roundTrip("ATL", "MCO", "2027-03-16", 7);
  assert.equal(second, null, "budget exhausted after one call");
});
