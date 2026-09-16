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

function usRow(display_name: string, lat = "35.78", lon = "-78.64") {
  return { display_name, lat, lon, address: { country_code: "us" } };
}

test("search: asks Nominatim for the US and structured addresses, but doesn't trust the request-side filter alone", async () => {
  mockFetch([usRow("Raleigh, Wake County, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  await p.search("Raleigh, NC");
  assert.equal(lastUrl?.searchParams.get("countrycodes"), "us");
  assert.equal(lastUrl?.searchParams.get("addressdetails"), "1");
});

test("search: a non-US result is dropped even when Nominatim returns it anyway", async () => {
  // Found live 2026-09-16: a real "27540" postalcode search with
  // countrycodes=us set still came back with matches in Ukraine, Spain, and
  // France alongside the real Holly Springs, NC result -- the request-side
  // restriction is not reliable for a bare postal-code search. This is the
  // real guarantee: every row is checked against its OWN address.country_code.
  mockFetch([
    { display_name: "27540, Світловодськ, Кіровоградська область, Україна", lat: "48.9", lon: "33.2", address: { country_code: "ua" } },
    { display_name: "27540, Córdoba, Argentina", lat: "-31.4", lon: "-64.2", address: { country_code: "ar" } },
    usRow("27540, Holly Springs, Wake County, North Carolina, United States"),
    { display_name: "27540, Ivry-la-Bataille, Évreux, Eure, Normandie, France métropolitaine", lat: "48.9", lon: "1.5", address: { country_code: "fr" } },
  ]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27540");
  assert.equal(results.length, 1, "only the real US match should survive");
  assert.match(results[0]!.label, /Holly Springs/);
});

test("search: a row missing address entirely is dropped, not assumed US", async () => {
  mockFetch([{ display_name: "Some place with no address block", lat: "1", lon: "2" }]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27540");
  assert.deepEqual(results, []);
});

test("search: a 5-digit ZIP uses Nominatim's structured postalcode search, not freeform q", async () => {
  mockFetch([usRow("27601, Raleigh, Wake County, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27601");
  assert.equal(lastUrl?.searchParams.get("postalcode"), "27601");
  assert.equal(lastUrl?.searchParams.get("q"), null, "postalcode and q are mutually exclusive in one request");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.label, "27601, Raleigh, Wake County, North Carolina, United States");
});

test("search: a ZIP+4 uses just the 5-digit part for postalcode", async () => {
  mockFetch([usRow("27601, Raleigh, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  await p.search("27601-1234");
  assert.equal(lastUrl?.searchParams.get("postalcode"), "27601");
});

test("search: anything not shaped like a ZIP still falls back to freeform q", async () => {
  mockFetch([usRow("Raleigh, Wake County, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  await p.search("Raleigh");
  assert.equal(lastUrl?.searchParams.get("q"), "Raleigh");
  assert.equal(lastUrl?.searchParams.get("postalcode"), null);
});

test("search: an empty query never calls fetch", async () => {
  mockFetch([]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("   ");
  assert.deepEqual(results, []);
  assert.equal(lastUrl, undefined);
});

test("search: a row with a non-numeric lat/lon is dropped, not kept as NaN", async () => {
  mockFetch([{ display_name: "Bad row", lat: "not-a-number", lon: "-78.64", address: { country_code: "us" } }]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("anything");
  assert.deepEqual(results, []);
});

test("search: a non-ok response throws rather than returning a fabricated result", async () => {
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const p = new NominatimGeocodeProvider();
  await assert.rejects(() => p.search("Raleigh"), /nominatim 429/);
});
