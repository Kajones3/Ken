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
import { NEWS_FEEDS, mileageRateStatus } from "../config.js";
import { getDb, type Db } from "../db.js";
import type { EmailSender } from "../email/types.js";
import { pickEmailSender } from "../email/pick.js";
import { parseRssItems } from "../rss.js";
import { todayISO } from "../dates.js";
import { ownerTasks, renderOwnerTasks, type OwnerTask } from "../ownerTasks.js";

export interface NewsDigestOptions {
  sender?: EmailSender;
  ownerEmail?: string;
  fetchImpl?: typeof fetch;
  feeds?: typeof NEWS_FEEDS;
  /** Overridable so a test can ask "what would this say next January?". */
  todayISO?: string;
  /** Injected by tests so the chore list can be exercised without staging a
   *  whole database's worth of stale rows. */
  tasks?: OwnerTask[];
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

  // Same "tell the owner something hand-maintained has gone stale" job, so it
  // rides the digest's existing cron rather than needing a workflow of its own.
  // IRS mileage rates are hand-entered in config.ts and the IRS publishes the
  // next year's around mid-December; without this, a year with no rate on file
  // would just quietly reuse an old one and nobody would ever find out.
  const mileage = mileageRateStatus(opts.todayISO ?? todayISO());
  const years = mileage.uncoveredYears;

  // Every hand-maintained thing in this project can go stale silently, and
  // this is the only message that reliably reaches a human — so the whole
  // chore list rides here rather than becoming a fourth email nobody reads.
  // It supersedes the standalone IRS note that used to live in this function:
  // the mileage rate is now just one task among several, with the same
  // urgency marker and the same irs.gov instruction.
  const tasks = opts.tasks ?? await ownerTasks(db, { today: opts.todayISO ?? todayISO() });
  const taskNote = renderOwnerTasks(tasks);

  // A blocking task is worth an email on a week with no news — that was
  // already true of an unpriceable mileage year and is just as true of
  // anything else that is actually broken. The email-secrets task is the one
  // exception, and only because it is circular: if OWNER_EMAIL is unset
  // there is nowhere to send the warning that OWNER_EMAIL is unset.
  const blocking = tasks.filter((t) => t.blocking && t.id !== "email-secrets");
  const tasksForceSend = blocking.length > 0;

  let sent = 0;
  const shouldSend = Boolean(ownerEmail) && (newItems.length > 0 || tasksForceSend);
  if (shouldSend) {
    const parts: string[] = [taskNote];
    if (newItems.length) {
      parts.push(newItems.map((i) => `[${i.feed}]\n${i.title}\n${i.link}`).join("\n\n")
        + "\n\n— Review and hand-add anything worth surfacing to a resort's goodToKnow in config.ts.");
    }
    // The job count belongs in the SUBJECT, not just the body. That was the
    // original reasoning for putting the mileage warning there — something
    // merely getting worse should be repeated until it is dealt with, rather
    // than announced once and lost under a pile of news links — and it
    // generalises to every chore now that they live in one list.
    const jobTag = blocking.length
      ? ` + ${blocking.length} blocking job${blocking.length === 1 ? "" : "s"}`
      : tasks.length ? ` + ${tasks.length} job${tasks.length === 1 ? "" : "s"} for you` : "";
    const subject = newItems.length
      ? `Parkfare: ${newItems.length} new Disney news item${newItems.length === 1 ? "" : "s"}${jobTag}`
      : `Parkfare: ${blocking.length} job${blocking.length === 1 ? "" : "s"} need${blocking.length === 1 ? "s" : ""} you`;
    try {
      await sender.send({ to: ownerEmail, subject, text: parts.join("\n\n———\n\n") });
      sent = 1;
    } catch (e) {
      console.error(`news digest send failed (${sender.name}):`, (e as Error).message);
    }
  }

  const mileageSuffix = (years.length ? `; IRS mileage rate missing for ${years.join(", ")}` : "")
    + `; ${tasks.length} manual job(s) outstanding`;
  const note = (!newItems.length && !tasksForceSend) ? `nothing new${mileageSuffix}`
    : !ownerEmail ? `${newItems.length} new item(s) found but OWNER_EMAIL is not set — not sent${mileageSuffix}`
    : `${newItems.length} new item(s), ${sent ? "sent" : "send failed"}${mileageSuffix}`;
  await db.query(
    `update fetch_runs set finished_at = now(), rows_written = $2, errors = $3, note = $4 where id = $1`,
    [runId, newItems.length, errors, note],
  );
  return { newItems: newItems.length, sent, errors, note, tasks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const r = await runNewsDigest(db);
  console.log(`news digest: ${r.newItems} new item(s), ${r.sent} email(s) sent, ${r.errors} feed error(s) — ${r.note}`);
  await db.close();
}
