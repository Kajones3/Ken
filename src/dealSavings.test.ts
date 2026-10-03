import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryDb } from "./db.js";
import { reseedOnProperty } from "./reseed.js";
import { seedTickets } from "./jobs/refresh.js";
import { firstPlannableMonth } from "./config.js";
import { addDaysISO, todayISO } from "./dates.js";
import { dealSaving, tripFromSaved, describeTrip, STANDARD_TRIP } from "./dealSavings.js";
import { buildAlertEmail } from "./email/message.js";

const today = todayISO();
const start = `${firstPlannableMonth(today)}-01`;

async function seeded() {
  const db = await memoryDb();
  await reseedOnProperty(db, "wdw");
  const months = [start.slice(0, 7), addDaysISO(start, 40).slice(0, 7), addDaysISO(start, 75).slice(0, 7)];
  await seedTickets(db, [...new Set(months)]);
  return db;
}
const deal = (over: object = {}) => ({
  id: randomUUID(), resortId: "wdw", effectKind: "room_pct_off",
  startsOn: start, endsOn: addDaysISO(start, 45), minNights: null, ...over,
});
async function insert(db: Awaited<ReturnType<typeof memoryDb>>, d: ReturnType<typeof deal>, value: number) {
  await db.query(
    `insert into promos (id,resort_id,label,effect_kind,effect_value,starts_on,ends_on,historical,active,min_nights)
     values ($1,$2,'Test deal',$3,$4,$5,$6,false,true,$7)`,
    [d.id, d.resortId, d.effectKind, value, d.startsOn, d.endsOn, d.minNights]);
}

test("a deal's saving is measured on a real trip inside its dates, with and without it", async () => {
  const db = await seeded();
  const d = deal();
  await insert(db, d, 25);
  const s = await dealSaving(db, d, null, { today });
  assert.ok(s, "a saving was measured");
  assert.equal(s!.resortId, "wdw");
  assert.ok(s!.date >= d.startsOn && s!.date <= d.endsOn);
  assert.equal(s!.saving, s!.without - s!.withDeal);
  assert.ok(s!.saving > 0);
  assert.match(s!.basis, /a standard trip \(6 nights, 2 adults, a Moderate Disney hotel\)/);
  // A bigger saving on a longer stay from the member's own saved search.
  const mine = await dealSaving(db, d, tripFromSaved({ adults: 4, nights: 9, stay: "on", tier: 1 }), { today });
  assert.ok(mine && mine.saving > s!.saving);
  assert.match(mine!.basis, /^your saved search \(9 nights, 4 adults/);
  await db.close();
});

test("a 4-night-minimum deal is measured on a stay that qualifies; no rates means no figure", async () => {
  const db = await seeded();
  const d = deal({ minNights: 8 });
  await insert(db, d, 20);
  const s = await dealSaving(db, d, { ...STANDARD_TRIP, nights: 4 }, { today });
  assert.ok(s && /8 nights/.test(s.basis));
  const empty = await memoryDb();
  assert.equal(await dealSaving(empty, d, null, { today }), null, "nothing cached, so no invented number");
  await db.close(); await empty.close();
});

test("the email leads with the owner's wording only when there is a measured saving", () => {
  const withX = buildAlertEmail({ detail: "Walt Disney World: Spring rooms", oldTotal: 5200, newTotal: 3960, kind: "new_promo" },
    "a@example.com", "https://pricingthemagic.com/unsubscribe?t=x");
  assert.equal(withX.subject, "A Deal May Save You $1,240 on your Disney Trip");
  assert.match(withX.text, /^A Deal May Save You \$1,240 on your Disney Trip\./);
  const plain = buildAlertEmail({ detail: "x", oldTotal: 0, newTotal: 0, kind: "new_promo" }, "a@example.com", "https://x/u");
  assert.equal(plain.subject, "Parkfare: a new Disney deal");
});

test("a saved search is read defensively", () => {
  assert.equal(tripFromSaved(null), null);
  const t = tripFromSaved({ adults: "99", childAges: [5, 40, "x"], nights: -3, tier: 7, food: "caviar" })!;
  assert.deepEqual([t.adults, t.childAges, t.nights, t.tier, t.food], [12, [5], 1, 2, "mix"]);
  assert.equal(describeTrip({ ...STANDARD_TRIP, childAges: [4] }), "6 nights, 2 adults, 1 child, a Moderate Disney hotel");
});
