import { luckPoints } from "./userGrades.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseLean, adviseCandidate, adviseByGrade, ADVICE_MIN } from "./recommendations.js";
import type { GroupScore } from "./fareScoreboard.js";

const group = (n: number, now: number, byLean: [number, number][]): GroupScore => ({
  n, medianPct: 5, typicalOffPct: now, within15Pct: 50, bestLean: null,
  byLean: byLean.map(([lean, off]) => ({ lean, medianPct: 0, typicalOffPct: off })),
});
const g = (right: number, n: number) => ({ right, n, pct: n ? Math.round((right / n) * 100) : null, luck: luckPoints(right, n) });

test("lean: recommends the lean with the smallest typical miss, when it wins clearly", () => {
  const a = adviseLean("k", "US flight lean", 50, group(40, 16, [[0, 20], [25, 12], [50, 16], [75, 19], [100, 23]]));
  assert.equal(a.verdict, "change");
  assert.equal(a.suggest, "25");
});

test("lean: keeps it when no lean is clearly better, and says can't tell on too few fares", () => {
  assert.equal(adviseLean("k", "x", 50, group(40, 14, [[25, 13], [50, 14]])).verdict, "keep");
  assert.equal(adviseLean("k", "x", 50, group(ADVICE_MIN - 1, 14, [[25, 5]])).verdict, "can't tell");
});

test("candidate: switch on only when it is better on BOTH sides", () => {
  const better = adviseCandidate(false, [
    { name: "US", shown: g(5, 25), cand: g(10, 25) }, { name: "International", shown: g(8, 30), cand: g(12, 30) },
  ]);
  assert.equal(better.suggest, "On");
  const mixed = adviseCandidate(false, [
    { name: "US", shown: g(5, 25), cand: g(10, 25) }, { name: "International", shown: g(12, 30), cand: g(7, 30) },
  ]);
  assert.equal(mixed.verdict, "can't tell");
  assert.equal(adviseCandidate(false, [{ name: "US", shown: g(1, 5), cand: g(2, 5) }]).verdict, "can't tell");
});

test("weights: the best-graded value wins only by a clear margin", () => {
  const base = { key: "k", name: "x", does: "y", current: "1" };
  const a = adviseByGrade(base, 1, [{ value: 0, grade: g(10, 40) }, { value: 1, grade: g(16, 40) }, { value: 2, grade: g(24, 40) }], "months");
  assert.equal(a.suggest, "2");
  const b = adviseByGrade(base, 1, [{ value: 1, grade: g(16, 50) }, { value: 2, grade: g(17, 50) }], "months");
  assert.equal(b.verdict, "keep");
});

test("loader: an empty database gives advice with nothing invented", async () => {
  const { memoryDb } = await import("./db.js");
  const { loadRecommendations } = await import("./recommendations.js");
  const db = await memoryDb();
  const r = await loadRecommendations(db);
  assert.ok(r.advice.length >= 6);
  assert.ok(r.advice.every((a) => a.verdict === "can't tell" && a.suggest === null));
  await db.close();
});
