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

test("an empty query never calls the provider", async () => {
  const db = await memoryDb();
  const { provider, calls } = countingProvider();
  const result = await cachedGeocode(db, provider, "   ");
  assert.deepEqual(result, []);
  assert.equal(calls(), 0);
  await db.close();
});
