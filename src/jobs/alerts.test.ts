import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCap, suppressAnomalies, type Candidate } from "./alerts.js";

const c = (userId: string, dropPct: number): Candidate => ({
  tripId: crypto.randomUUID(), userId, resortId: "wdw",
  oldTotal: 6000, newTotal: 6000 * (1 - dropPct / 100), dropPct,
  kind: "total_drop", detail: "",
});

test("a user is capped at three alerts a day, keeping the biggest drops", () => {
  const out = applyCap([c("u1", 5), c("u1", 30), c("u1", 12), c("u1", 8), c("u2", 6)], 3);
  assert.equal(out.filter((x) => x.userId === "u1").length, 3);
  assert.equal(out.filter((x) => x.userId === "u2").length, 1);
  assert.deepEqual(out.filter((x) => x.userId === "u1").map((x) => x.dropPct), [30, 12, 8]);
});

test("a provider glitch that moves everything is suppressed, not emailed", () => {
  const wild = Array.from({ length: 10 }, (_, i) => c(`u${i}`, 60));
  const { keep, reason } = suppressAnomalies(wild, 10);
  assert.equal(keep.length, 0);
  assert.match(reason, /bad data/);
});

test("a normal day passes through", () => {
  const normal = [c("u1", 7), c("u2", 9)];
  const { keep, reason } = suppressAnomalies(normal, 40);
  assert.equal(keep.length, 2);
  assert.equal(reason, "");
});
