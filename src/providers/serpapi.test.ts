import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SerpApiHotelProvider } from "./serpapi.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

let calls = 0;
function mockFetch(status = 200) {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ properties: [{ name: "Some Inn", rate_per_night: { extracted_lowest: 120 } }] }),
      { status },
    );
  }) as typeof fetch;
}

const RESORT = "wdw";

test("off-property stops calling once the budget is spent", async () => {
  // The gap this closes: the hourly limiter only *paces* spending, it never
  // stops it, so before this a loop bug or a long month list could run up an
  // unbounded bill. Every other paid path here already had a hard ceiling.
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 2); // budget of 2
  await p.hotelMonth(RESORT, "2027-03");
  await p.hotelMonth(RESORT, "2027-04");
  await p.hotelMonth(RESORT, "2027-05");
  assert.equal(calls, 2, "the third month must not reach the provider");
  assert.equal(p.budgetRemaining, 0);
});

test("on-property rates still come back after the budget is spent", async () => {
  // On-property is generated locally from config.ts and costs nothing, so an
  // exhausted budget must not take it down with off-property — the same
  // reasoning that made a 429 stop killing the whole resort/month.
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 0); // no budget at all
  const quotes = await p.hotelMonth(RESORT, "2027-03");
  assert.equal(calls, 0, "no budget means no paid call");
  assert.ok(quotes.length > 0, "on-property is local and must survive");
  assert.ok(quotes.every((q) => q.onProperty), "only the free on-property rows remain");
});

test("a failed lookup still counts against the budget", async () => {
  // SerpApi bills for a search that errors or finds nothing, so charging
  // only successes would make a failing resort a free infinite retry.
  mockFetch(429);
  const p = new SerpApiHotelProvider("key", 999, 5);
  await p.hotelMonth(RESORT, "2027-03");
  assert.equal(p.callsSpent, 1, "the errored call is still a paid search");
  assert.equal(p.budgetRemaining, 4);
});

test("an off-property failure never costs the on-property rates", async () => {
  mockFetch(500);
  const p = new SerpApiHotelProvider("key", 999, 5);
  const quotes = await p.hotelMonth(RESORT, "2027-03");
  assert.ok(quotes.length > 0);
  assert.ok(quotes.every((q) => q.onProperty));
});
