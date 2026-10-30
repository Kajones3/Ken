import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ORIGINS, EXTRA_ORIGINS, ALL_ORIGINS, ORIGIN_BY_IATA, originIsExtra } from "./config.js";
import { originIatas } from "./jobs/btsBaseline.js";
import { haversineMiles } from "./geo.js";

test("the free and extra airport lists don't overlap", () => {
  const free = new Set(ORIGINS.map((o) => o.iata));
  for (const p of EXTRA_ORIGINS) {
    assert.ok(!free.has(p.iata), `${p.iata} is in both lists — pick one`);
  }
  assert.equal(ALL_ORIGINS.length, ORIGINS.length + EXTRA_ORIGINS.length);
});

test("Charlotte stays free and Raleigh is an extra airport", () => {
  // The owner's own example: today they'd search from CLT, three hours away.
  // Planner Pro is what makes RDU — their real airport — selectable.
  assert.equal(originIsExtra("CLT"), false);
  assert.equal(originIsExtra("RDU"), true);
});

test("every airport, free or extra, resolves to real coordinates", () => {
  for (const o of ALL_ORIGINS) {
    const found = ORIGIN_BY_IATA.get(o.iata);
    assert.ok(found, `${o.iata} is not resolvable`);
    assert.match(o.iata, /^[A-Z]{3}$/, `${o.iata} is not a 3-letter code`);
    // Continental US-ish bounds — a transposed lat/lon would sail past this.
    assert.ok(o.lat > 20 && o.lat < 50, `${o.iata} latitude ${o.lat} looks wrong`);
    assert.ok(o.lon < -65 && o.lon > -160, `${o.iata} longitude ${o.lon} looks wrong`);
  }
});

test("BTS ingests baselines for extra airports too, or they'd have no estimate", () => {
  // The survey is one file covering every US airport, so withholding a
  // baseline from a Planner Pro origin would cost nothing and buy nothing. What the
  // free/Planner Pro split governs is which airports can be PICKED, not which have data.
  const ingested = originIatas();
  for (const o of ALL_ORIGINS) {
    assert.ok(ingested.has(o.iata), `${o.iata} would have no BTS baseline`);
  }
});

test("a extra airport's nearest free fallback is genuinely the nearest", () => {
  // What a free user gets when they pick a extra airport. Spot-check the
  // owner's case and confirm the rule holds for every extra airport.
  const nearestFree = (iata: string) => {
    const w = ORIGIN_BY_IATA.get(iata)!;
    return ORIGINS.reduce((best, o) =>
      haversineMiles(w.lat, w.lon, o.lat, o.lon) < haversineMiles(w.lat, w.lon, best.lat, best.lon) ? o : best);
  };
  assert.equal(nearestFree("RDU").iata, "CLT", "Raleigh should fall back to Charlotte");

  for (const p of EXTRA_ORIGINS) {
    const pick = nearestFree(p.iata);
    const d = haversineMiles(p.lat, p.lon, pick.lat, pick.lon);
    for (const o of ORIGINS) {
      assert.ok(
        haversineMiles(p.lat, p.lon, o.lat, o.lon) >= d - 0.001,
        `${p.iata} fell back to ${pick.iata} but ${o.iata} is closer`,
      );
    }
  }
});
