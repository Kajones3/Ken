/**
 * A private digest, not a customer-facing feature. Reads a handful of
 * Disney-fan-news RSS feeds (NEWS_FEEDS in config.ts — closures, official
 * Disneyland Paris announcements, deals), tracks what's already been sent
 * in news_seen, and emails the owner whatever's new. Nothing here ever
 * reaches an end user automatically — reviewing an item and deciding
 * whether it's worth hand-adding to a resort's goodToKnow is a human step,
 * same discipline as every other hand-maintained fact in this project.
 *
 * Same "never let one failure take the whole job down" shape as refresh.ts:
 * one feed erroring (a dead URL, a timeout) doesn't stop the others.
 */
import { randomUUID } from "node:crypto";
import { NEWS_FEEDS } from "../config.js";
import { getDb, type Db } from "../db.js";
import type { EmailSender } from "../email/types.js";
import { pickEmailSender } from "../email/pick.js";
import { parseRssItems } from "../rss.js";

export interface NewsDigestOptions {
  sender?: EmailSender;
  ownerEmail?: string;
  fetchImpl?: typeof fetch;
  feeds?: typeof NEWS_FEEDS;
}

export async function runNewsDigest(db: Db, opts: NewsDigestOptions = {}) {
  const sender = opts.sender ?? pickEmailSender();
  const ownerEmail = opts.ownerEmail ?? process.env.OWNER_EMAIL ?? "";
  const doFetch = opts.fetchImpl ?? fetch;
  const feeds = opts.feeds ?? NEWS_FEEDS;

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job) values ($1,'news_digest')`, [runId]);

  const newItems: { feed: string; title: string; link: string }[] = [];
  let errors = 0;

  for (const feed of feeds) {
    try {
      const res = await doFetch(feed.url);
      if (!res.ok) throw new Error(`${feed.url} -> ${res.status}`);
      const xml = await res.text();
      // Only the most recent handful — a feed's full history isn't news.
      const items = parseRssItems(xml).slice(0, 15);
      for (const item of items) {
        const { rows } = await db.query(`select 1 from news_seen where url = $1`, [item.link]);
        if (rows.length) continue;
        await db.query(`insert into news_seen (url) values ($1) on conflict (url) do nothing`, [item.link]);
        newItems.push({ feed: feed.label, title: item.title, link: item.link });
      }
    } catch (e) {
      errors++;
      console.error(`news feed ${feed.url}:`, (e as Error).message);
    }
  }

  let sent = 0;
  if (newItems.length && ownerEmail) {
    const text = newItems.map((i) => `[${i.feed}]\n${i.title}\n${i.link}`).join("\n\n")
      + "\n\n— Review and hand-add anything worth surfacing to a resort's goodToKnow in config.ts.";
    try {
      await sender.send({
        to: ownerEmail,
        subject: `Parkfare: ${newItems.length} new Disney news item${newItems.length === 1 ? "" : "s"}`,
        text,
      });
      sent = 1;
    } catch (e) {
      console.error(`news digest send failed (${sender.name}):`, (e as Error).message);
    }
  }

  const note = !newItems.length ? "nothing new"
    : !ownerEmail ? `${newItems.length} new item(s) found but OWNER_EMAIL is not set — not sent`
    : `${newItems.length} new item(s), ${sent ? "sent" : "send failed"}`;
  await db.query(
    `update fetch_runs set finished_at = now(), rows_written = $2, errors = $3, note = $4 where id = $1`,
    [runId, newItems.length, errors, note],
  );
  return { newItems: newItems.length, sent, errors, note };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const r = await runNewsDigest(db);
  console.log(`news digest: ${r.newItems} new item(s), ${r.sent} email(s) sent, ${r.errors} feed error(s) — ${r.note}`);
  await db.close();
}
