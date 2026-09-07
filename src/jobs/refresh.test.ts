import { test } from "node:test";
import assert from "node:assert/strict";
import { dueMonths, allTierMonths } from "./refresh.js";

test("dueMonths: on a day divisible by every tier's cadence, all three tiers contribute", () => {
  // day 21 is divisible by 1 (near), 3 (mid), and 7 (far)
  const months = dueMonths("2026-09-07", 21);
  assert.ok(months.includes("2026-09")); // near tier, day 0
  assert.ok(months.includes("2027-03")); // far tier, day ~181-365
});

test("dueMonths: on a day only divisible by the near tier's cadence, far months are absent", () => {
  // day 1 is divisible by 1 (near) but not 3 (mid) or 7 (far)
  const months = dueMonths("2026-09-07", 1);
  assert.ok(months.includes("2026-09"));
  assert.ok(!months.includes("2027-03"));
});

test("allTierMonths: covers the full year regardless of which day it is", () => {
  const months = allTierMonths("2026-09-07");
  assert.ok(months.includes("2026-09")); // near tier start
  assert.ok(months.includes("2027-03")); // far tier middle
  assert.ok(months.includes("2027-09")); // far tier end, ~365 days out
});

test("allTierMonths is a superset of dueMonths on any given day", () => {
  const all = new Set(allTierMonths("2026-09-07"));
  for (const dayOfYear of [1, 2, 3, 7, 21, 100]) {
    for (const m of dueMonths("2026-09-07", dayOfYear)) {
      assert.ok(all.has(m), `${m} (due on day ${dayOfYear}) missing from allTierMonths`);
    }
  }
});
