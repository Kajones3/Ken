import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { parseEvent, recordEvent, loadStats, eventRateLimiter } from "./siteEvents.js";

test("only the named actions, resorts and details are accepted", () => {
  assert.deepEqual(parseEvent({ kind: "book", resort: "tdr", detail: "flights" }),
    { kind: "book", resort: "tdr", detail: "flights" });
  assert.deepEqual(parseEvent({ kind: "compare" }), { kind: "compare", resort: "", detail: "" });
  assert.deepEqual(parseEvent({ kind: "plus", detail: "month" }), { kind: "plus", resort: "", detail: "month" });
  // Unknown kind, unknown resort, free text, a missing resort: all refused.
  assert.equal(parseEvent({ kind: "pageview" }), null);
  assert.equal(parseEvent({ kind: "detail", resort: "epcot" }), null);
  assert.equal(parseEvent({ kind: "book", resort: "wdw", detail: "someone@example.com" }), null);
  assert.equal(parseEvent({ kind: "detail" }), null);
  assert.equal(parseEvent({ kind: "plus", detail: "lifetime" }), null);
  assert.equal(parseEvent(null), null);
});

test("a resort is dropped for actions that aren't about one", () => {
  assert.deepEqual(parseEvent({ kind: "compare", resort: "wdw" }), { kind: "compare", resort: "", detail: "" });
});

test("the table holds counts and nothing that identifies a visitor", async () => {
  const db = await memoryDb();
  const cols = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'event_counts' order by column_name`,
  );
  assert.deepEqual(cols.rows.map((r) => r.column_name).sort(), ["day", "detail", "kind", "n", "resort_id"]);
  await db.close();
});

test("counts add up per day and roll into the stats", async () => {
  const db = await memoryDb();
  const ev = (o: object) => parseEvent(o)!;
  await recordEvent(db, ev({ kind: "compare" }), "2026-10-01");
  await recordEvent(db, ev({ kind: "detail", resort: "tdr" }), "2026-10-01");
  await recordEvent(db, ev({ kind: "detail", resort: "tdr" }), "2026-10-02");
  await recordEvent(db, ev({ kind: "detail", resort: "wdw" }), "2026-10-02");
  await recordEvent(db, ev({ kind: "detail", resort: "wdw" }), "2026-10-02");
  await recordEvent(db, ev({ kind: "book", resort: "tdr", detail: "flights" }), "2026-10-02");
  await recordEvent(db, ev({ kind: "plus", detail: "month" }), "2026-10-02");
  // Outside a 7-day window ending 2026-10-02.
  await recordEvent(db, ev({ kind: "compare" }), "2026-09-20");

  const s = await loadStats(db, 7, "2026-10-02");
  assert.equal(s.from, "2026-09-26");
  assert.equal(s.totals.compare, 1);
  assert.equal(s.totals.detail, 4);
  assert.equal(s.perHundredDetails.book, 25);
  assert.equal(s.perHundredDetails.plus, 25);
  assert.equal(s.byResort[0]!.resort, "tdr", "ties go alphabetically by name; both have 2 views");
  assert.equal(s.byResort.find((r) => r.resort === "tdr")!.book, 1);
  assert.equal(s.bookBy.find((b) => b.detail === "flights")!.n, 1);
  assert.equal(s.plusBy.find((p) => p.pass === "month")!.n, 1);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[0]!.day, "2026-10-02");
  assert.equal(s.daily[0]!.detail, 3);
  await db.close();
});

test("no detail views means no rate, not a divide-by-zero", async () => {
  const db = await memoryDb();
  const s = await loadStats(db, 30, "2026-10-02");
  assert.equal(s.perHundredDetails.book, null);
  await db.close();
});

test("the rate limiter lets normal use through and stops a flood", () => {
  const allow = eventRateLimiter(3, 1000);
  assert.ok(allow("a", 0) && allow("a", 1) && allow("a", 2));
  assert.equal(allow("a", 3), false);
  assert.ok(allow("b", 3), "another visitor is unaffected");
  assert.ok(allow("a", 2000), "and the window resets");
});
