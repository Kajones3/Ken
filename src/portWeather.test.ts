import { test } from "node:test";
import assert from "node:assert/strict";
import { cruiseWeather } from "./portWeather.js";

const row = (hi: number): [number, number, number][] => Array.from({ length: 12 }, (_, i) => [hi + i, hi - 10, 5] as [number, number, number]);

test("the sailing month at the home port, then each stop we hold weather for", () => {
  const w = cruiseWeather("2027-04-14", "galveston", ["Cozumel", "Nowhere"], { galveston: row(70), cozumel: row(80) });
  assert.deepEqual(w.map((x) => [x.name, x.stop, x.highF]), [["Galveston", false, 73], ["Cozumel", true, 83]]);
  assert.deepEqual(cruiseWeather("2027-04-14", "galveston", [], {}), [], "no rows = nothing, not a guess");
});
