/**
 * The alert job — now only "a new Disney deal", for Plus members.
 *
 * Price-drop monitoring (re-pricing every saved trip and emailing when it got
 * cheaper, crossed your own number, or gas moved) was REMOVED on 2026-09-25,
 * the owner's call: the Plus trip price calendar is the way to watch a trip
 * now, and a promise to keep watching is one the site should not make. What
 * Plus promises instead is word about the latest official Disney deals, so
 * this job emails every Plus member with a confirmed address when the owner
 * adds a curated promo they have not been told about yet.
 *
 * It reads only the database, so it makes ZERO provider calls.
 *
 * Two safety rails, kept from the price-alert days because they are still
 * the right shape: a per-user daily cap, and anomaly suppression (a no-op for
 * deal emails, whose dropPct is always 0, but runAlerts stays the one path).
 */
import { randomUUID } from "node:crypto";
import { RESORT_BY_ID } from "../config.js";
import { getDb, type Db } from "../db.js";
import type { EmailSender } from "../email/types.js";
import { pickEmailSender } from "../email/pick.js";
import { buildAlertEmail } from "../email/message.js";

export interface Candidate {
  userId: string; email: string; resortId: string | null;
  oldTotal: number; newTotal: number; dropPct: number;
  kind: "new_promo"; detail: string;
}

const CAP = Number(process.env.ALERT_MAX_PER_USER_PER_DAY ?? 3);
const ANOMALY_SHARE = Number(process.env.ALERT_ANOMALY_SHARE ?? 0.4);
const ANOMALY_MOVE = Number(process.env.ALERT_ANOMALY_MOVE_PCT ?? 25);

export function suppressAnomalies(cands: Candidate[], total: number): { keep: Candidate[]; reason: string } {
  if (total === 0) return { keep: [], reason: "" };
  const wild = cands.filter((c) => c.dropPct >= ANOMALY_MOVE).length;
  if (wild / total >= ANOMALY_SHARE) {
    return { keep: [], reason: `suppressed: ${wild}/${total} trips moved >=${ANOMALY_MOVE}% — looks like bad data` };
  }
  return { keep: cands, reason: "" };
}

export function applyCap(cands: Candidate[], cap = CAP): Candidate[] {
  const byUser = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.dropPct - a.dropPct)) {
    const n = byUser.get(c.userId) ?? 0;
    if (n >= cap) continue;
    byUser.set(c.userId, n + 1);
    out.push(c);
  }
  return out;
}

function describePromoEffectForEmail(kind: string, value: number): string {
  switch (kind) {
    case "room_pct_off": return `${Math.round(value)}% off the room rate`;
    case "room_flat_off": return `$${Math.round(value)} off the room rate`;
    case "free_dining": return "free dining plan";
    case "ticket_pct_off": return `${Math.round(value)}% off tickets`;
    case "flat_off_total": return `$${Math.round(value)} off the total`;
    default: return "";
  }
}

/**
 * Every Plus member with a confirmed email, and the curated promos added since
 * they were last told about one (or since their account was created, so a
 * brand-new member is not sent the whole back catalog — the cap trims the
 * rest). Plus is checked against today, never just for non-null: a lapsed
 * member stops getting these the day it runs out.
 *
 * Emailing an unconfirmed address is the concrete harm an unverified account
 * does — mail to a stranger, in their name — so that stays a hard condition.
 */
export async function findAlerts(db: Db): Promise<{ candidates: Candidate[]; checked: number }> {
  const { rows: members } = await db.query(
    `select u.id, u.email,
            coalesce((select max(a.fired_at) from price_alerts a
                       where a.user_id = u.id and a.kind = 'new_promo'), u.created_at) as since
       from users u
      where u.email_verified_at is not null and u.plus_until >= current_date`,
  );

  const candidates: Candidate[] = [];
  for (const m of members) {
    const { rows: promos } = await db.query(
      `select resort_id, label, effect_kind, effect_value
         from promos
        where active and ends_on >= current_date and created_at > $1
        order by created_at desc limit 3`,
      [m.since],
    );
    for (const promo of promos) {
      const where = promo.resort_id ? RESORT_BY_ID.get(promo.resort_id)?.name ?? promo.resort_id : "Every resort";
      const effect = describePromoEffectForEmail(promo.effect_kind, Number(promo.effect_value));
      candidates.push({
        userId: m.id, email: m.email, resortId: promo.resort_id ?? null,
        oldTotal: 0, newTotal: 0, dropPct: 0, kind: "new_promo",
        detail: `${where}: ${promo.label}${effect ? ` (${effect})` : ""}`,
      });
    }
  }
  return { candidates, checked: members.length };
}

/**
 * Alerts inserted on a previous run whose send failed sit with notified_at
 * null — a durable retry queue that costs zero provider calls to drain,
 * same as everything else here.
 */
async function retryUnsent(db: Db, sender: EmailSender, limit = 50): Promise<{ retried: number; sent: number }> {
  const { rows } = await db.query(
    `select a.id, a.kind, a.detail, a.old_total, a.new_total, u.email
       from price_alerts a
       left join saved_trips t on t.id = a.trip_id
       join users u on u.id = coalesce(a.user_id, t.user_id)
      where a.notified_at is null
      order by a.fired_at
      limit $1`,
    [limit],
  );
  let sent = 0;
  for (const row of rows) {
    try {
      await sender.send(buildAlertEmail(
        { detail: row.detail, oldTotal: Number(row.old_total), newTotal: Number(row.new_total), kind: row.kind }, row.email));
      await db.query(`update price_alerts set notified_at = now() where id = $1`, [row.id]);
      sent++;
    } catch (e) {
      console.error(`retry send failed for alert ${row.id} (${sender.name}):`, (e as Error).message);
    }
  }
  return { retried: rows.length, sent };
}

export interface AlertsOptions { sender?: EmailSender }

export async function runAlerts(db: Db, opts: AlertsOptions = {}) {
  const sender = opts.sender ?? pickEmailSender();
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job) values ($1,'alerts')`, [runId]);

  const retry = await retryUnsent(db, sender);

  const { candidates, checked } = await findAlerts(db);
  const { keep, reason } = suppressAnomalies(candidates, checked);
  const final = applyCap(keep);

  let sent = 0;
  for (const c of final) {
    const id = randomUUID();
    // The row below is the durable record — insert it before sending, so a
    // send failure can be retried next run without losing the alert.
    await db.query(
      `insert into price_alerts (id, user_id, kind, resort_id, old_total, new_total, detail)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, c.userId, c.kind, c.resortId, c.oldTotal, c.newTotal, c.detail],
    );
    try {
      await sender.send(buildAlertEmail(c, c.email));
      await db.query(`update price_alerts set notified_at = now() where id = $1`, [id]);
      sent++;
    } catch (e) {
      console.error(`send failed for alert ${id} (${sender.name}):`, (e as Error).message);
    }
  }

  await db.query(
    `update fetch_runs set finished_at = now(), rows_written = $2, note = $3 where id = $1`,
    [runId, final.length, reason || `${checked} Plus members checked, ${sent}/${final.length} sent, ${retry.sent}/${retry.retried} retried`],
  );
  return { checked, fired: final.length, sent, retried: retry.retried, retriedSent: retry.sent, suppressed: reason, candidates: final };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const r = await runAlerts(db);
  console.log(`deal alerts: ${r.fired} fired for ${r.checked} Plus members (${r.sent} sent, ${r.retriedSent}/${r.retried} retried) ${r.suppressed}`);
  await db.close();
}
