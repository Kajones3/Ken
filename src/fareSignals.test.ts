import { test } from "node:test";
import assert from "node:assert/strict";
import { levelShares, resortForAirport } from "./fareSignals.js";

test("levelShares: one row per resort and month, shares of known levels only", () => {
  const rows = levelShares([
    { resortId: "wdw", month: 3, level: "high", n: 3 },
    { resortId: "wdw", month: 3, level: "typical", n: 1 },
    { resortId: "wdw", month: 3, level: null, n: 1 },
    { resortId: "dlp", month: 7, level: "low", n: 2 },
  ], { wdw: "Walt Disney World", dlp: "Disneyland Paris" });
  assert.equal(rows.length, 2);
  const wdw = rows.find((r) => r.resortId === "wdw")!;
  assert.equal(wdw.searches, 5);
  assert.equal(wdw.highPct, 60);
  assert.equal(wdw.typicalPct, 20);
  assert.equal(wdw.lowPct, 0);           // the unknown is not counted as anything
  assert.ok(wdw.crowd);                  // the crowd band rides alongside
  assert.equal(rows.find((r) => r.resortId === "dlp")!.lowPct, 100);
});

test("resortForAirport maps primary and alternate airports", () => {
  assert.equal(resortForAirport("MCO")?.id, "wdw");
  assert.equal(resortForAirport("HND")?.id, "tdr");
  assert.equal(resortForAirport("XXX"), undefined);
});
