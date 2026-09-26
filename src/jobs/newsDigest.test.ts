import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "../db.js";
import { runNewsDigest } from "./newsDigest.js";
import type { EmailMessage, EmailSender } from "../email/types.js";
import { newestMileageRateYear, MILEAGE_RATE_CARRY_FORWARD_YEARS } from "../config.js";

const FEED_XML = `<rss><channel>
  <item><title>Test Closure</title><link>https://example.com/1</link><pubDate>Mon, 07 Sep 2026 00:00:00 +0000</pubDate></item>
  <item><title>Test Promo</title><link>https://example.com/2</link></item>
</channel></rss>`;

function fakeFetch(xmlByUrl: Record<string, string | null>): typeof fetch {
  return (async (url: any) => {
    const xml = xmlByUrl[String(url)];
    if (xml === null) return { ok: false, status: 500, text: async () => "" } as any;
    if (xml === undefined) return { ok: true, status: 200, text: async () => "<rss><channel></channel></rss>" } as any;
    return { ok: true, status: 200, text: async () => xml } as any;
  }) as any;
}

test("news digest: emails the owner about genuinely new items, and only once", async () => {
  const db = await memoryDb();
  const sent: EmailMessage[] = [];
  const sender: EmailSender = { name: "test", async send(msg) { sent.push(msg); } };
  const feeds = [{ url: "https://feed.example/a", label: "Feed A" }];

  const first = await runNewsDigest(db, {
    sender, ownerEmail: "owner@example.com",
    fetchImpl: fakeFetch({ "https://feed.example/a": FEED_XML }),
    feeds,
  });
  assert.equal(first.newItems, 2);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Test Closure/);
  assert.match(sent[0]!.text, /Test Promo/);

  // Same feed, same items, run again — nothing new, no second email.
  const second = await runNewsDigest(db, {
    sender, ownerEmail: "owner@example.com",
    fetchImpl: fakeFetch({ "https://feed.example/a": FEED_XML }),
    feeds,
  });
  assert.equal(second.newItems, 0);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1, "no duplicate email for items already seen");

  await db.close();
});

test("news digest: a dead feed doesn't stop the others, and errors are counted", async () => {
  const db = await memoryDb();
  const sender: EmailSender = { name: "test", async send() {} };
  const feeds = [
    { url: "https://feed.example/dead", label: "Dead feed" },
    { url: "https://feed.example/alive", label: "Alive feed" },
  ];
  const result = await runNewsDigest(db, {
    sender, ownerEmail: "owner@example.com",
    fetchImpl: fakeFetch({ "https://feed.example/dead": null, "https://feed.example/alive": FEED_XML }),
    feeds,
  });
  assert.equal(result.errors, 1);
  assert.equal(result.newItems, 2, "the alive feed's items still come through");

  await db.close();
});

test("news digest: new items are tracked as seen even when OWNER_EMAIL isn't set, so nothing dumps as a backlog once it is", async () => {
  const db = await memoryDb();
  const sender: EmailSender = { name: "test", async send() { throw new Error("should not be called"); } };
  const feeds = [{ url: "https://feed.example/a", label: "Feed A" }];

  const first = await runNewsDigest(db, {
    sender, ownerEmail: "",
    fetchImpl: fakeFetch({ "https://feed.example/a": FEED_XML }),
    feeds,
  });
  assert.equal(first.newItems, 2);
  assert.equal(first.sent, 0);
  assert.match(first.note, /OWNER_EMAIL/);

  const { rows } = await db.query(`select count(*) from news_seen`);
  assert.equal(Number(rows[0].count), 2, "items are marked seen even though nothing was emailed");

  await db.close();
});

/**
 * The IRS mileage rate is hand-entered, so the only thing standing between a
 * silently-stale number and the owner is this email. These pin that it
 * actually goes out, says which year is missing, and leads the message rather
 * than being buried under the news.
 */
test("news digest: tells the owner which year the IRS rate is missing for", async () => {
  const db = await memoryDb();
  const sent: EmailMessage[] = [];
  const sender: EmailSender = { name: "test", async send(msg) { sent.push(msg); } };
  const feeds = [{ url: "https://feed.example/a", label: "Feed A" }];

  // December 2026: the 365-day booking window reaches into 2027, which the
  // IRS hasn't published yet — and it's past the owner's snooze on this row
  // (until after Thanksgiving 2026, see SNOOZED in ownerTasks.ts).
  const r = await runNewsDigest(db, {
    sender, ownerEmail: "owner@example.com", todayISO: "2026-12-01",
    fetchImpl: fakeFetch({ "https://feed.example/a": FEED_XML }),
    feeds,
  });
  assert.equal(r.sent, 1);
  // The mileage rate is now one row in the owner's job list rather than its
  // own block. Same information, same placement, same repetition — the
  // subject still carries it so it cannot be announced once and lost.
  assert.match(sent[0]!.subject, /job/i);
  assert.match(sent[0]!.text, /IRS standard mileage rate for 2027/);
  assert.match(sent[0]!.text, /irs\.gov/);
  assert.match(sent[0]!.text, /IRS_MILEAGE_RATES/);
  assert.ok(
    sent[0]!.text.indexOf("Your manual jobs") < sent[0]!.text.indexOf("Test Closure"),
    "the job list leads the email — it must not be buried under the news",
  );
  assert.match(r.note, /IRS mileage rate missing for 2027/);

  await db.close();
});

test("news digest: a missing year that stops trips pricing earns an email with no news at all", async () => {
  const db = await memoryDb();
  const sent: EmailMessage[] = [];
  const sender: EmailSender = { name: "test", async send(msg) { sent.push(msg); } };

  // Far enough past the newest rate on file that carrying it forward is no
  // longer defensible, so priceTrip refuses — worth an email of its own.
  const broken = newestMileageRateYear() + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  const r = await runNewsDigest(db, {
    sender, ownerEmail: "owner@example.com", todayISO: `${broken}-07-01`,
    fetchImpl: fakeFetch({}), feeds: [],
  });
  assert.equal(r.newItems, 0, "no news this run");
  assert.equal(r.sent, 1, "the warning still goes out on its own");
  assert.match(sent[0]!.subject, /needs? you/i);
  assert.match(sent[0]!.text, /\[BLOCKING\]/);
  assert.match(sent[0]!.text, /will NOT price/);

  await db.close();
});
