import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { validateDeal, saveDeal, listDeals, setDealActive, deleteDeal } from "./adminPromos.js";

const TODAY = "2026-10-03";
const good = { resortId: "wdw", label: "Save up to 25% on rooms", effectKind: "room_pct_off", effectValue: "25%",
  startsOn: "2027-02-22", endsOn: "2027-04-30", sourceNote: "Screenshot" };

test("a deal must make sense before it is stored", () => {
  assert.ok(validateDeal(good, TODAY).ok);
  const bad = (patch: object, why: RegExp) => {
    const v = validateDeal({ ...good, ...patch }, TODAY);
    assert.ok(!v.ok && why.test(v.reason), JSON.stringify(patch));
  };
  bad({ label: " " }, /name/);
  bad({ effectValue: "140" }, /between 1 and 100/);
  bad({ effectKind: "bogus" }, /Pick what/);
  bad({ endsOn: "2027-01-01" }, /before the first/);
  bad({ startsOn: "2026-01-01", endsOn: "2026-02-01" }, /already ended/);
  bad({ resortId: "epcot" }, /resort/);
  // Free dining has no amount; "All resorts" is stored as no resort.
  const fd = validateDeal({ ...good, resortId: "all", effectKind: "free_dining", effectValue: "" }, TODAY);
  assert.ok(fd.ok && fd.value.effectValue === 0 && fd.value.resortId === null);
});

test("added, listed live/upcoming, turned off and back, edited, deleted", async () => {
  const d = await memoryDb();
  const r = await saveDeal(d, good, TODAY);
  assert.ok(r.ok);
  let list = await listDeals(d, TODAY);
  assert.equal(list[0]!.status, "upcoming");
  assert.equal(list[0]!.effectValue, 25);
  // Travelers' list reads the same table: only active, current deals.
  const live = await d.query(`select count(*)::int as n from promos where active and historical = false`);
  assert.equal(live.rows[0]!.n, 1);
  assert.ok(await setDealActive(d, r.ok ? r.id : "", false));
  assert.equal((await listDeals(d, TODAY))[0]!.status, "off");
  await setDealActive(d, r.ok ? r.id : "", true);
  assert.ok((await saveDeal(d, { ...good, effectValue: 30 }, TODAY, r.ok ? r.id : "")).ok);
  list = await listDeals(d, TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.effectValue, 30);
  assert.ok(await deleteDeal(d, list[0]!.id));
  assert.equal((await listDeals(d, TODAY)).length, 0);
  await d.close();
});
