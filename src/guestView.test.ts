import { test } from "node:test";
import assert from "node:assert/strict";
import { guestQuery, isSampleTrip, lockForGuests } from "./guestView.js";

const row = (resortId: string, total: number | null) => total === null
  ? { resortId, name: resortId, iata: "X", ok: false }
  : { resortId, name: resortId, iata: "X", ok: true, price: { total } };

test("a guest sees the cheapest US and the cheapest international resort; the rest carry no price", () => {
  const out = lockForGuests([row("wdw", 4000), row("dlr", 4500), row("dlp", 5200), row("tdr", 5100), row("shdr", 6000), row("hkdl", 5900)]);
  assert.deepEqual(out.slice(0, 2).map((r) => r.resortId), ["wdw", "tdr"]);
  const locked = out.slice(2);
  assert.equal(locked.length, 4);
  for (const r of locked) {
    assert.equal((r as { locked?: boolean }).locked, true);
    assert.equal("price" in r, false, `${r.resortId} must not carry a price`);
  }
  // Locked rows follow the resorts' usual order, not price order.
  assert.deepEqual(locked.map((r) => r.resortId), ["dlr", "dlp", "shdr", "hkdl"]);
});

test("an unpriced resort is never one of the two shown", () => {
  const out = lockForGuests([row("wdw", null), row("dlr", 4500), row("dlp", null), row("tdr", 5100), row("shdr", 6000), row("hkdl", 5900)]);
  assert.deepEqual(out.slice(0, 2).map((r) => r.resortId), ["dlr", "tdr"]);
});

test("the sample PDF's trip is the only one a guest may price in full", () => {
  assert.equal(isSampleTrip({ origin: "SFO", adults: 2, childAges: [11, 8], nights: 6 }), true);
  assert.equal(isSampleTrip({ origin: "ATL", adults: 2, childAges: [11, 8], nights: 6 }), false);
  assert.equal(isSampleTrip({ origin: "SFO", adults: 2, childAges: [], nights: 6 }), false);
});

test("grant-plus takes a pass name or plain days, and a new pass starts fresh", async () => {
  const { grantArgs, grantPlus } = await import("./grantPlus.js");
  const { memoryDb } = await import("./db.js");
  const { addDaysISO, todayISO } = await import("./dates.js");
  assert.deepEqual(grantArgs("week"), { days: 7, pass: "week" });
  assert.deepEqual(grantArgs("nineMonths"), { days: 274, pass: "nineMonths" });
  assert.deepEqual(grantArgs("30"), { days: 30, pass: null });
  assert.equal(grantArgs("forever"), null);
  const db = await memoryDb();
  await grantPlus(db, "f@example.com", 274, "nineMonths");
  const r = await grantPlus(db, "f@example.com", 7, "week");
  assert.deepEqual(r, { email: "f@example.com", plusUntil: addDaysISO(todayISO(), 7), pass: "week" });
  await db.close();
});

test("a guest's query keeps only the month, the party and the home airport", () => {
  const q = new URLSearchParams({
    month: "2027-03", origin: "RDU", adults: "2", seniors: "1", childAges: "4,9",
    nights: "3", stay: "off", tier: "0", food: "grocery", basis: "cheapest", parkDays: "1",
    window: "thanksgiving", rooms: "2", hopper: "1", overrides: JSON.stringify({ wdw: { nightly: 50 } }),
    passes: "wdw:pixie:2", dvcPoints: "200", gettingThere: "flyMiles", milesPct: "100",
  });
  assert.deepEqual(Object.fromEntries(guestQuery(q)),
    { month: "2027-03", origin: "RDU", adults: "2", seniors: "1", childAges: "4,9" });
});
