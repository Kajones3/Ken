import { test } from "node:test";
import assert from "node:assert/strict";
import { MockProvider } from "./mock.js";

const provider = new MockProvider();

test("MockProvider.flightMonth: returns real quotes for a resort's primary airport", async () => {
  const quotes = await provider.flightMonth("ATL", "MCO", "2027-03", 7);
  assert.ok(quotes.length > 0);
  assert.equal(quotes[0]!.destination, "MCO");
});

test("MockProvider.flightMonth: returns real quotes for an alternate arrival airport too", async () => {
  // Regression test: flightMonth used to look up the resort by matching
  // r.iata === destination exactly, so any alternate airport (Tampa for
  // WDW) silently returned an empty array — no error, just a permanently
  // empty cache for that airport.
  const quotes = await provider.flightMonth("ATL", "TPA", "2027-03", 7);
  assert.ok(quotes.length > 0, "TPA should price against WDW's location, not return nothing");
  assert.equal(quotes[0]!.destination, "TPA");
});

test("MockProvider.flightMonth: an unrecognized destination returns nothing, not a guess", async () => {
  const quotes = await provider.flightMonth("ATL", "ZZZ", "2027-03", 7);
  assert.deepEqual(quotes, []);
});
