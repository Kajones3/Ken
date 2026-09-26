import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCap, suppressAnomalies, runAlerts, findAlerts, type Candidate } from "./alerts.js";
import { memoryDb, type Db } from "../db.js";
import type { EmailMessage, EmailSender } from "../email/types.js";

const c = (userId: string, dropPct: number): Candidate => ({
  userId, email: `${userId}@example.com`, resortId: "wdw",
  oldTotal: 0, newTotal: 0, dropPct, kind: "new_promo", detail: "",
});
const quiet: EmailSender = { name: "unused", async send() {} };

async function member(db: Db, email: string, opts: { plus?: string | null; verified?: boolean; created?: string } = {}) {
  const id = randomUUID();
  await db.query(
    `insert into users (id, email, plus_until, email_verified_at, created_at) values ($1,$2,$3,$4,$5)`,
    [id, email, opts.plus === undefined ? "2099-01-01" : opts.plus,
     opts.verified === false ? null : new Date(), opts.created ?? "2024-01-01T00:00:00Z"]);
  return id;
}
async function promo(db: Db, label: string, created = "2024-06-01T00:00:00Z", resortId: string | null = "wdw") {
  await db.query(
    `insert into promos (id,resort_id,label,effect_kind,effect_value,starts_on,ends_on,active,created_at)
     values ($1,$2,$3,'room_pct_off',20,'2026-01-01','2099-12-31',true,$4)`,
    [randomUUID(), resortId, label, created]);
}

test("a user is capped at three alerts a day", () => {
  const out = applyCap([c("u1", 0), c("u1", 0), c("u1", 0), c("u1", 0), c("u2", 0)], 3);
  assert.equal(out.filter((x) => x.userId === "u1").length, 3);
  assert.equal(out.filter((x) => x.userId === "u2").length, 1);
});

test("the anomaly rail still refuses a batch where everything moved wildly", () => {
  const { keep, reason } = suppressAnomalies(Array.from({ length: 10 }, (_, i) => c(`u${i}`, 60)), 10);
  assert.equal(keep.length, 0);
  assert.match(reason, /bad data/);
  assert.equal(suppressAnomalies([c("u1", 0)], 1).keep.length, 1, "a deal email (0% move) always passes");
});

test("a Plus member hears about a new deal once — no saved trip needed", async () => {
  const db = await memoryDb();
  await member(db, "plus@example.com");
  await promo(db, "Summer room discount");

  const first = await runAlerts(db, { sender: quiet });
  assert.equal(first.fired, 1);
  assert.equal(first.candidates[0]!.kind, "new_promo");
  assert.match(first.candidates[0]!.detail, /Walt Disney World: Summer room discount/);

  const second = await runAlerts(db, { sender: quiet });
  assert.equal(second.fired, 0, "the same deal is never sent twice");
  await db.close();
});

test("deal emails are Plus-only: a free or lapsed account gets none", async () => {
  const db = await memoryDb();
  await member(db, "free@example.com", { plus: null });
  await member(db, "lapsed@example.com", { plus: "2020-01-01" });
  await promo(db, "Room discount");
  assert.equal((await findAlerts(db)).checked, 0);
  assert.equal((await runAlerts(db, { sender: quiet })).fired, 0);
  await db.close();
});

test("an unconfirmed email address gets nothing, even with real Plus", async () => {
  const db = await memoryDb();
  await member(db, "unconfirmed@example.com", { verified: false });
  await promo(db, "Room discount");
  assert.equal((await findAlerts(db)).checked, 0);
  await db.close();
});

test("a deal that predates the account is not treated as new", async () => {
  const db = await memoryDb();
  await member(db, "late@example.com", { created: "2025-01-01T00:00:00Z" });
  await promo(db, "Old deal", "2024-06-01T00:00:00Z");
  assert.equal((await runAlerts(db, { sender: quiet })).fired, 0);
  await db.close();
});

test("price-drop monitoring is gone: a saved trip on its own fires nothing", async () => {
  const db = await memoryDb();
  const userId = await member(db, "saver@example.com");
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
     values ($1,$2,$3,'{}',100000,0)`,
    [randomUUID(), userId, JSON.stringify({ origin: "ATL", month: "2027-03", resortId: "wdw" })]);
  assert.equal((await runAlerts(db, { sender: quiet })).fired, 0);
  await db.close();
});

test("a failed send leaves the alert for next run to retry — it is not lost", async () => {
  const db = await memoryDb();
  await member(db, "flaky@example.com");
  await promo(db, "Deal");
  let calls = 0;
  const flaky: EmailSender = {
    name: "flaky",
    async send(_msg: EmailMessage) { calls++; if (calls === 1) throw new Error("simulated outage"); },
  };
  const first = await runAlerts(db, { sender: flaky });
  assert.equal(first.fired, 1);
  assert.equal(first.sent, 0);
  const second = await runAlerts(db, { sender: flaky });
  assert.equal(second.retried, 1);
  assert.equal(second.retriedSent, 1);
  assert.equal(second.fired, 0, "the unsent deal still counts as told — it is retried, not re-found");
  await db.close();
});

/* ------------------------------ unsubscribing ----------------------------- */

test("every deal email carries a working unsubscribe link, and using it stops the next one", async () => {
  const { setDealEmailsByToken } = await import("../dealEmails.js");
  const db = await memoryDb();
  await member(db, "plus@example.com");
  await promo(db, "Summer room discount");
  const sent: EmailMessage[] = [];
  const capture: EmailSender = { name: "capture", async send(m) { sent.push(m); } };

  await runAlerts(db, { sender: capture });
  assert.equal(sent.length, 1);
  const token = /unsubscribe\?t=([0-9a-f]+)/.exec(sent[0]!.text)?.[1];
  assert.ok(token, "the email names its own unsubscribe link");

  assert.equal(await setDealEmailsByToken(db, token!, false), "plus@example.com");
  await promo(db, "Another deal", new Date().toISOString());
  const after = await runAlerts(db, { sender: capture });
  assert.equal(after.fired, 0, "stopping means stopping");
  assert.equal(sent.length, 1);

  // And back on: the next new deal arrives again.
  await setDealEmailsByToken(db, token!, true);
  assert.equal((await runAlerts(db, { sender: capture })).fired, 1);
  await db.close();
});

test("a deal queued before someone unsubscribed is not retried after", async () => {
  const { setDealEmailsForUser } = await import("../dealEmails.js");
  const db = await memoryDb();
  const id = await member(db, "plus@example.com");
  await promo(db, "Summer room discount");
  const failing: EmailSender = { name: "down", async send() { throw new Error("provider down"); } };
  assert.equal((await runAlerts(db, { sender: failing })).sent, 0, "queued, unsent");

  await setDealEmailsForUser(db, id, false);
  const sent: EmailMessage[] = [];
  const r = await runAlerts(db, { sender: { name: "capture", async send(m) { sent.push(m); } } });
  assert.equal(r.retried, 0);
  assert.equal(sent.length, 0);
  await db.close();
});

test("the same person always gets the same link, and a made-up token changes nothing", async () => {
  const { unsubscribeToken, setDealEmailsByToken, dealEmailsOn } = await import("../dealEmails.js");
  const db = await memoryDb();
  const id = await member(db, "plus@example.com");
  const a = await unsubscribeToken(db, id);
  assert.equal(await unsubscribeToken(db, id), a, "an old email's link must keep working");
  assert.equal(await setDealEmailsByToken(db, "0".repeat(48), false), null);
  assert.equal(await setDealEmailsByToken(db, "not-hex'; drop table users;--", false), null);
  assert.equal(await dealEmailsOn(db, id), true);
  await db.close();
});

test("a real send is refused, and stays queued, when the unsubscribe link would be broken", async () => {
  const db = await memoryDb();
  await member(db, "plus@example.com");
  await promo(db, "Summer room discount");
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    let calls = 0;
    const resendLike: EmailSender = { name: "resend", async send() { calls++; } };
    const r = await runAlerts(db, { sender: resendLike });
    assert.equal(r.fired, 1);
    assert.equal(r.sent, 0);
    assert.equal(calls, 0, "never handed to the provider with a relative link");

    process.env.PUBLIC_BASE_URL = "https://pricingthemagic.com";
    const later = await runAlerts(db, { sender: resendLike });
    assert.equal(later.retriedSent, 1, "goes out once the setting is fixed");
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved;
  }
  await db.close();
});
