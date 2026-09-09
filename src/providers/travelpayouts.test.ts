import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TravelpayoutsProvider } from "./travelpayouts.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(data: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch;
}

test("flightMonth: keeps a row within 1 night of the requested trip length", async () => {
  mockFetch({
    "2027-03-15": {
      price: 250, airline: "DL", transfers: 0,
      departure_at: "2027-03-15T10:00:00-04:00", return_at: "2027-03-22T10:00:00-04:00", // 7 nights
    },
  });
  const p = new TravelpayoutsProvider("t", "m", 240);
  const rows = await p.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.priceUsd, 250);
});

test("flightMonth: rejects a row for a genuinely shorter trip than requested (was ±3, now ±1)", async () => {
  mockFetch({
    "2027-03-15": {
      price: 98, airline: "DL", transfers: 0,
      // A real 4-night fare should not be shown as if it were a 7-night one.
      departure_at: "2027-03-15T10:00:00-04:00", return_at: "2027-03-19T10:00:00-04:00", // 4 nights
    },
  });
  const p = new TravelpayoutsProvider("t", "m", 240);
  const rows = await p.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.deepEqual(rows, []);
});

test("flightMonth: a row exactly 1 night off the requested length is still accepted", async () => {
  mockFetch({
    "2027-03-15": {
      price: 300, airline: "DL", transfers: 0,
      departure_at: "2027-03-15T10:00:00-04:00", return_at: "2027-03-23T10:00:00-04:00", // 8 nights, requesting 7
    },
  });
  const p = new TravelpayoutsProvider("t", "m", 240);
  const rows = await p.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.equal(rows.length, 1);
});

test("flightMonth: a row with no departure_at/return_at is dropped, not kept on faith", async () => {
  mockFetch({
    "2027-03-15": { price: 300, airline: "DL", transfers: 0 }, // no departure_at/return_at at all
  });
  const p = new TravelpayoutsProvider("t", "m", 240);
  const rows = await p.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.deepEqual(rows, []);
});

test("flightMonth: a row for a different month is dropped even if duration matches", async () => {
  mockFetch({
    "2027-04-01": {
      price: 300, airline: "DL", transfers: 0,
      departure_at: "2027-04-01T10:00:00-04:00", return_at: "2027-04-08T10:00:00-04:00",
    },
  });
  const p = new TravelpayoutsProvider("t", "m", 240);
  const rows = await p.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.deepEqual(rows, []);
});
