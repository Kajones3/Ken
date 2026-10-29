import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { loadManualWork } from "./manualWork.js";

test("manual work: lists the hand-kept data with dates, most urgent first, on an empty database", async () => {
  const db = await memoryDb();
  const items = await loadManualWork(db, "2026-10-29");
  const ids = items.map((i) => i.id);
  for (const id of ["park-ratings", "ticket-calendar-wdw", "paris-tickets", "irs-mileage", "deals", "price-checks", "crowd-bands"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  const rank = { missing: 0, due: 1, ok: 2 } as const;
  for (let i = 1; i < items.length; i++) assert.ok(rank[items[i - 1]!.status] <= rank[items[i]!.status]);
  assert.equal(items.find((i) => i.id === "irs-mileage")!.action, "mileage-check");
  await db.close();
});
