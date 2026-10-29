import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryDb } from "./db.js";
import { addDaysISO, todayISO } from "./dates.js";
import { buildPlusReminder, reminderLeadDays, sendPlusReminders } from "./plusReminder.js";
import type { EmailMessage, EmailSender } from "./email/types.js";

const capture = (): EmailSender & { sent: EmailMessage[] } => {
  const sent: EmailMessage[] = [];
  return { name: "test", sent, async send(m) { sent.push(m); } };
};

test("the reminder says the date, that nothing renews, and what stays", () => {
  const m = buildPlusReminder("a@example.com", "threeMonths", "2027-01-31", { PUBLIC_BASE_URL: "https://x.test" } as never);
  assert.equal(m.subject, "Your Pricing the Magic Plus ends on January 31, 2027");
  assert.match(m.text, /Your 3 months Plus pass ends on January 31, 2027/);
  assert.match(m.text, /won't be charged/);
  assert.match(m.text, /https:\/\/x\.test/);
});

test("reminders go once per pass, three days ahead (one for a week pass), only to confirmed addresses", async () => {
  const db = await memoryDb();
  const today = todayISO();
  const add = async (email: string, pass: string | null, until: string, verified = true) =>
    db.query(`insert into users (id, email, plus_until, plus_pass, email_verified_at) values ($1,$2,$3,$4,$5)`,
      [randomUUID(), email, until, pass, verified ? new Date() : null]);
  await add("three@example.com", "threeMonths", addDaysISO(today, 3));
  await add("week2@example.com", "week", addDaysISO(today, 2));     // too early for a week pass
  await add("week1@example.com", "week", addDaysISO(today, 1));
  await add("far@example.com", "nineMonths", addDaysISO(today, 20));
  await add("unverified@example.com", "threeMonths", addDaysISO(today, 2), false);
  const s = capture();
  assert.deepEqual(await sendPlusReminders(db, s, today), { due: 2, sent: 2 });
  assert.deepEqual(s.sent.map((m) => m.to).sort(), ["three@example.com", "week1@example.com"]);
  // A second run the same day sends nothing new.
  const again = capture();
  assert.deepEqual(await sendPlusReminders(db, again, today), { due: 0, sent: 0 });
  assert.equal(reminderLeadDays("week"), 1);
  assert.equal(reminderLeadDays(null), 3);
  await db.close();
});
