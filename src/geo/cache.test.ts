import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "../db.js";
import { cachedGeocode } from "./cache.js";
import type { GeocodeProvider, GeocodeResult } from "./types.js";

function countingProvider(): { provider: GeocodeProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: "counting",
      async search(query: string): Promise<GeocodeResult[]> {
        calls++;
        return [{ label: query, lat: 1, lon: 2 }];
      },
    },
  };
}

test("a repeated query is served from the cache, not the provider", async () => {
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  const first = await cachedGeocode(db, provider, "Atlanta");
  const second = await cachedGeocode(db, provider, "atlanta"); // same query, different case
  assert.deepEqual(first, second);
  assert.equal(calls(), 1, "the provider is only ever called once for the same normalized query");
  await db.close();
});

test("the provider receives what was actually typed, not the lowercased cache key", async () => {
  // Regression: the provider used to be called with the lowercased cache
  // key, so a mock/echo-style provider's own label came back permanently
  // lowercase ("Raleigh" typed, "raleigh" shown) even though nothing about
  // the real place name changed — the cache's own normalization is an
  // internal lookup detail, not something the provider should ever see.
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  const result = await cachedGeocode(db, provider, "Raleigh, NC");
  assert.equal(result[0]!.label, "Raleigh, NC");
  assert.equal(calls(), 1);
  await db.close();
});

test("an empty query never calls the provider", async () => {
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  const result = await cachedGeocode(db, provider, "   ");
  assert.deepEqual(result, []);
  assert.equal(calls(), 0);
  await db.close();
});

test("a cached result older than the TTL is re-fetched from the provider, not served stale", async () => {
  // Regression: geocode_cache had no expiry at all, so a bad row cached
  // during an earlier (now-fixed) broken filtering attempt kept getting
  // served forever, through every later deploy that fixed the filter.
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  await db.query(
    `insert into geocode_cache (query_text, results, cached_at)
     values ($1,$2, now() - interval '8 days')`,
    ["27540", JSON.stringify([{ label: "stale, wrong", lat: 0, lon: 0 }])],
  );
  const result = await cachedGeocode(db, provider, "27540");
  assert.equal(calls(), 1, "a TTL-expired row must not short-circuit the provider call");
  assert.equal(result[0]!.label, "27540");
  await db.close();
});

test("a cached result within the TTL is still served from the cache", async () => {
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  await db.query(
    `insert into geocode_cache (query_text, results, cached_at)
     values ($1,$2, now() - interval '6 days')`,
    ["27540", JSON.stringify([{ label: "still fresh", lat: 1, lon: 2 }])],
  );
  const result = await cachedGeocode(db, provider, "27540");
  assert.equal(calls(), 0, "a row inside the TTL window must still be served from cache");
  assert.equal(result[0]!.label, "still fresh");
  await db.close();
});
