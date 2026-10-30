import { test } from "node:test";
import assert from "node:assert/strict";
import { learnHolidayPremium, HOLIDAY_SHRINK_K, type FareObs } from "./holidayLearning.js";

// Thanksgiving 2026 is Thursday November 26: the week runs the 24th-30th.
function route(origin: string, ordinary: number, holiday: number): FareObs[] {
  const out: FareObs[] = [];
  for (const d of [3, 5, 9, 12, 17, 20]) out.push({ origin, dest: "MCO", tripLength: 7, date: `2026-11-${String(d).padStart(2, "0")}`, price: ordinary });
  for (const d of [24, 25, 28]) out.push({ origin, dest: "MCO", tripLength: 7, date: `2026-11-${d}`, price: holiday });
  return out;
}

test("holiday bump: our fares say how much dearer the week is, moved from the study by how many routes back it", () => {
  const none = learnHolidayPremium([], "thanksgiving");
  assert.equal(none.pct, 55, "no routes: the study's figure");
  assert.equal(none.ourPct, null);
  const rows = ["ATL", "BOS", "CLT", "DEN", "DFW", "JFK", "ORD", "SEA"].flatMap((o) => route(o, 200, 260));
  const l = learnHolidayPremium(rows, "thanksgiving");
  assert.equal(l.routes, 8);
  assert.equal(l.ourPct, 30, "our fares: 30% dearer");
  // Halfway (8 routes, K = 8) between +30% and +55%, in log terms.
  const expect = (Math.exp(0.5 * Math.log(1.3) + 0.5 * Math.log(1.55)) - 1) * 100;
  assert.equal(HOLIDAY_SHRINK_K, 8);
  assert.ok(Math.abs(l.pct - expect) < 0.1, String(l.pct));
  // A route with only one holiday date teaches nothing.
  assert.equal(learnHolidayPremium(route("ATL", 200, 260).filter((r) => r.date !== "2026-11-24" && r.date !== "2026-11-25"), "thanksgiving").routes, 0);
});

test("holiday bump: Christmas week against December 1-20, not against the week before Christmas", () => {
  const rows: FareObs[] = [];
  for (const o of ["ATL", "BOS"]) {
    for (const d of [2, 6, 10, 15]) rows.push({ origin: o, dest: "LAX", tripLength: 7, date: `2026-12-${String(d).padStart(2, "0")}`, price: 300 });
    for (const d of [21, 22]) rows.push({ origin: o, dest: "LAX", tripLength: 7, date: `2026-12-${d}`, price: 900 });   // not ordinary
    for (const d of [26, 27]) rows.push({ origin: o, dest: "LAX", tripLength: 7, date: `2026-12-${d}`, price: 450 });
  }
  const l = learnHolidayPremium(rows, "christmas");
  assert.equal(l.routes, 2);
  assert.equal(l.ourPct, 50);
});
