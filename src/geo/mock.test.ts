import { test } from "node:test";
import assert from "node:assert/strict";
import { MockGeocodeProvider, MockIpLocateProvider } from "./mock.js";

test("MockGeocodeProvider is deterministic for the same query", async () => {
  const p = new MockGeocodeProvider();
  const a = await p.search("Chattanooga, Tennessee");
  const b = await p.search("chattanooga, tennessee");
  assert.equal(a.length, 1);
  // The label echoes back exactly what was typed; only the coordinates need
  // to be case-insensitively stable, since they're what pricing.ts actually uses.
  assert.deepEqual({ lat: a[0]!.lat, lon: a[0]!.lon }, { lat: b[0]!.lat, lon: b[0]!.lon });
});

test("MockGeocodeProvider returns nothing for an empty query", async () => {
  const p = new MockGeocodeProvider();
  assert.deepEqual(await p.search("   "), []);
});

test("MockGeocodeProvider stays inside a plausible continental-US box", async () => {
  const p = new MockGeocodeProvider();
  const [r] = await p.search("Anywhere, USA");
  assert.ok(r);
  assert.ok(r!.lat > 20 && r!.lat < 60);
  assert.ok(r!.lon > -130 && r!.lon < -60);
});

test("MockIpLocateProvider returns null for loopback-ish empty input", async () => {
  const p = new MockIpLocateProvider();
  assert.equal(await p.locate(""), null);
});

test("MockIpLocateProvider is deterministic for the same IP", async () => {
  const p = new MockIpLocateProvider();
  const a = await p.locate("203.0.113.7");
  const b = await p.locate("203.0.113.7");
  assert.deepEqual(a, b);
});
