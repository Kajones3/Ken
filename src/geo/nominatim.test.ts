import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NominatimGeocodeProvider } from "./nominatim.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

let lastUrl: URL | undefined;
function mockFetch(rows: unknown[]) {
  lastUrl = undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    lastUrl = new URL(String(input));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

test("search: biases to the US, since driving mode only ever prices a domestic resort", async () => {
  mockFetch([{ display_name: "Raleigh, Wake County, North Carolina, United States", lat: "35.78", lon: "-78.64" }]);
  const p = new NominatimGeocodeProvider();
  await p.search("Raleigh, NC");
  assert.equal(lastUrl?.searchParams.get("countrycodes"), "us");
});

test("search: a ZIP code goes through the same freeform query Nominatim already matches postcodes with", async () => {
  mockFetch([{ display_name: "27601, Raleigh, Wake County, North Carolina, United States", lat: "35.78", lon: "-78.64" }]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27601");
  assert.equal(lastUrl?.searchParams.get("q"), "27601");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.label, "27601, Raleigh, Wake County, North Carolina, United States");
});

test("search: an empty query never calls fetch", async () => {
  mockFetch([]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("   ");
  assert.deepEqual(results, []);
  assert.equal(lastUrl, undefined);
});

test("search: a row with a non-numeric lat/lon is dropped, not kept as NaN", async () => {
  mockFetch([{ display_name: "Bad row", lat: "not-a-number", lon: "-78.64" }]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("anything");
  assert.deepEqual(results, []);
});

test("search: a non-ok response throws rather than returning a fabricated result", async () => {
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const p = new NominatimGeocodeProvider();
  await assert.rejects(() => p.search("Raleigh"), /nominatim 429/);
});
