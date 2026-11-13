import { test } from "node:test";
import assert from "node:assert/strict";
import { cruiseWeather } from "./portWeather.js";

const row = (hi: number): [number, number, number][] => Array.from({ length: 12 }, (_, i) => [hi + i, hi - 10, 5] as [number, number, number]);

test("the sailing month at the home port, then each stop we hold weather for", () => {
  const w = cruiseWeather("2027-04-14", "galveston", ["Cozumel", "Nowhere"], { galveston: row(70), cozumel: row(80) });
  assert.deepEqual(w.map((x) => [x.name, x.stop, x.highF]), [["Galveston", false, 73], ["Cozumel", true, 83]]);
  assert.deepEqual(cruiseWeather("2027-04-14", "galveston", [], {}), [], "no rows = nothing, not a guess");
});

test("every port we can price has a write-up in our own words", async () => {
  const { cruisePorts } = await import("./portWeather.js");
  const { PORTS_OF_CALL, DRIVE_PORTS } = await import("./cruiseFacts.js");
  const { PORT_STORIES } = await import("./portInfo.js");
  for (const p of PORTS_OF_CALL) assert.ok(PORT_STORIES[p.id], p.id);
  for (const id of DRIVE_PORTS) assert.ok(PORT_STORIES[id], id);
  const w = cruisePorts("galveston", ["Cozumel", "Progreso"]);
  assert.deepEqual(w.map((x) => [x.name, x.stop]), [["Galveston", false], ["Cozumel", true], ["Progreso", true]]);
});
