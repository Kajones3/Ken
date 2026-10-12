import { test } from "node:test";
import assert from "node:assert/strict";
import { boardLine, carryFrom, levelAt, loadIndexSeries, shiftPeriod, summarize, yearOverYear, BLS_SERIES } from "./airfareIndex.js";
import { parseBls, runBlsAirfares } from "./jobs/blsAirfares.js";
import { memoryDb } from "./db.js";

const series = (from: string, to: string, f: (p: string) => number | undefined) => {
  const s = new Map<string, number>();
  for (let p = from; p <= to; p = shiftPeriod(p, 1)) { const v = f(p); if (v !== undefined) s.set(p, v); }
  return s;
};

test("periods step across years", () => {
  assert.equal(shiftPeriod("2026-01", -1), "2025-12");
  assert.equal(shiftPeriod("2025-11", 14), "2027-01");
});

test("year over year: compares the same month a year apart, and steps back past a hole", () => {
  const s = series("2025-01", "2026-10", (p) => p === "2025-10" ? undefined : p < "2026-01" ? 250 : 310);
  const y = yearOverYear(s)!;
  // October 2026 can't be compared (BLS skipped October 2025), so September.
  assert.equal(y.period, "2026-09");
  assert.equal(Math.round(y.pct), 24);
  assert.match(boardLine(y)!.headline, /^Airfares are up 24% from a year ago\.$/);
  assert.match(boardLine({ ...y, pct: -6.4 })!.headline, /down 6% from/);
  assert.match(boardLine({ ...y, pct: 0.4 })!.headline, /about the same as a year ago/);
});

test("carrying a price forward: newest level over the level then; a month BLS hasn't published uses the newest", () => {
  const s = series("2024-01", "2026-08", (p) => (p < "2025-07" ? 100 : 125));
  assert.equal(carryFrom(s, ["2024-01", "2024-02", "2024-03"]), 1.25);
  assert.equal(carryFrom(s, ["2026-10"]), 1);
  assert.equal(levelAt(s, "2026-12"), 125);
  // Nothing to compare = no movement claimed.
  assert.equal(carryFrom(new Map(), ["2024-01"]), 1);
  // A 3-month average needs all three months.
  assert.equal(levelAt(s, "2024-02", 3), undefined);
});

test("BLS's answer is read month by month; '-' and annual rows are skipped; preliminary is kept", () => {
  const r = parseBls({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "X", data: [
    { year: "2026", period: "M08", value: "280.4", footnotes: [{ code: "P" }] },
    { year: "2025", period: "M10", value: "-", footnotes: [{ code: "X" }] },
    { year: "2025", period: "M13", value: "250" },
  ] }] } });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.values, [{ seriesId: "X", period: "2026-08", value: 280.4, preliminary: true }]);
  assert.equal(parseBls({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold"] }).ok, false);
});

test("the job keeps everything: a revision is a NEW row, an unchanged month writes nothing", async () => {
  const db = await memoryDb();
  const answer = (v: string, prelim: boolean) => async () => ({ status: "REQUEST_SUCCEEDED", Results: { series:
    Object.values(BLS_SERIES).map((id) => ({ seriesID: id, data: [
      { year: "2026", period: "M08", value: v, footnotes: prelim ? [{ code: "P" }] : [{}] },
      { year: "2025", period: "M08", value: "250", footnotes: [{}] },
    ] })) } });
  assert.equal((await runBlsAirfares(db, answer("300", true) as never)).written, 8);
  assert.equal((await runBlsAirfares(db, answer("300", true) as never)).written, 0);
  assert.equal((await runBlsAirfares(db, answer("305", false) as never)).written, 4);
  const rows = await db.query(`select * from bls_series_values`);
  assert.equal(rows.rows.length, 12);
  // Readers take BLS's latest word.
  const s = await loadIndexSeries(db);
  assert.equal(s.cpiNsa!.get("2026-08"), 305);
  const sum = summarize(s);
  assert.equal(sum.board!.pct, 22);
  assert.match(sum.board!.detail, /August 2026 compared with August 2025/);
  await db.close();
});
