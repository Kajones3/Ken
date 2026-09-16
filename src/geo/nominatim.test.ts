import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NominatimGeocodeProvider, isUsResult } from "./nominatim.js";

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

function row(display_name: string, lat = "35.78", lon = "-78.64") {
  return { display_name, lat, lon };
}

// isUsResult() directly: real display_name strings from live 27540 searches,
// including the exact ones that leaked through two earlier (wrong) attempts
// at filtering — see the function's own comment in nominatim.ts.
test("isUsResult: the real Holly Springs, NC match", () => {
  assert.ok(isUsResult("27540, Holly Springs, Wake County, North Carolina, United States"));
});

test("isUsResult: France does not match, despite ending in a country name", () => {
  assert.ok(!isUsResult("27540, Ivry-la-Bataille, Évreux, Eure, Normandie, France métropolitaine, France"));
});

test("isUsResult: Poland does not match", () => {
  assert.ok(!isUsResult("27-540, Lipnik, gmina Lipnik, powiat opatowski, województwo świętokrzyskie, Polska"));
});

test("isUsResult: Ukraine and Argentina (the first report's leaks) do not match", () => {
  assert.ok(!isUsResult("27540, Світловодськ, Кіровоградська область, Україна"));
  assert.ok(!isUsResult("27540, Córdoba, Argentina"));
});

test("isUsResult: trailing whitespace and case don't matter", () => {
  assert.ok(isUsResult("Somewhere, UNITED STATES   "));
  assert.ok(isUsResult("Somewhere, United States of America"));
});

test("search: biases to the US on the request too, even though it isn't trusted alone", async () => {
  mockFetch([row("Raleigh, Wake County, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  await p.search("Raleigh, NC");
  assert.equal(lastUrl?.searchParams.get("countrycodes"), "us");
});

test("search: a non-US result is dropped even when Nominatim returns it anyway", async () => {
  // The exact live scenario reported by the owner (2026-09-16): a real
  // "27540" postalcode search returned Holly Springs, NC mixed in with
  // France and Poland, despite countrycodes=us on the request.
  mockFetch([
    row("27540, Ivry-la-Bataille, Évreux, Eure, Normandie, France métropolitaine, France"),
    row("27540, Holly Springs, Wake County, North Carolina, United States"),
    row("27-540, Lipnik, gmina Lipnik, powiat opatowski, województwo świętokrzyskie, Polska"),
  ]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27540");
  assert.equal(results.length, 1, "only the real US match should survive");
  assert.match(results[0]!.label, /Holly Springs/);
});

test("search: a 5-digit ZIP uses Nominatim's structured postalcode search, not freeform q", async () => {
  mockFetch([row("27601, Raleigh, Wake County, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("27601");
  assert.equal(lastUrl?.searchParams.get("postalcode"), "27601");
  assert.equal(lastUrl?.searchParams.get("q"), null, "postalcode and q are mutually exclusive in one request");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.label, "27601, Raleigh, Wake County, North Carolina, United States");
});

test("search: a ZIP+4 uses just the 5-digit part for postalcode", async () => {
  mockFetch([row("27601, Raleigh, North Carolina, United States")]);
  const p = new NominatimGeocodeProvider();
  await p.search("27601-1234");
  assert.equal(lastUrl?.searchParams.get("postalcode"), "27601");
});

test("search: anything not shaped like a ZIP still falls back to freeform q", async () => {
  mockFetch([row("Raleigh, Wake County, North Carolina, United States")]);
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
  mockFetch([row("Bad row, United States", "not-a-number", "-78.64")]);
  const p = new NominatimGeocodeProvider();
  const results = await p.search("anything");
  assert.deepEqual(results, []);
});

test("search: a non-ok response throws rather than returning a fabricated result", async () => {
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const p = new NominatimGeocodeProvider();
  await assert.rejects(() => p.search("Raleigh"), /nominatim 429/);
});
