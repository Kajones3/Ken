/**
 * Turning deal emails off (and back on).
 *
 * Deal emails are marketing mail, so US law (CAN-SPAM) requires a working
 * way to stop them in every message, honored without making anyone sign in.
 * Gmail and Yahoo also want the RFC 8058 "one-click" header on bulk mail.
 * Both use the same link:
 *
 *   {PUBLIC_BASE_URL}/unsubscribe?t=<token>
 *
 * - A person clicking it gets a page with one button, not an instant
 *   unsubscribe. Mail scanners and link previews open links on their own,
 *   and a plain GET that unsubscribed would quietly switch people off.
 * - The mail client's one-click button POSTs to the same address, which
 *   unsubscribes straight away. That's what the header is for.
 *
 * The token is random and stored per user rather than signed with a secret,
 * so there is no new environment variable to forget, and it never expires:
 * an old email's link still has to work years later. It only unlocks this
 * one switch for this one person, never a sign-in.
 *
 * Off is stored as a timestamp, not a boolean. "Never said" and "said stop
 * on this date" are different facts, and the date is what you'd want in
 * hand if anyone ever asked when they opted out.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export async function unsubscribeToken(db: Db, userId: string): Promise<string> {
  const existing = await db.query(`select unsubscribe_token from users where id = $1`, [userId]);
  const have = existing.rows[0]?.unsubscribe_token as string | null | undefined;
  if (have) return have;
  const token = randomBytes(24).toString("hex");
  // `where ... is null` so two sends racing for one user can't hand out two
  // different links; whoever loses reads back the winner's.
  await db.query(`update users set unsubscribe_token = $2 where id = $1 and unsubscribe_token is null`, [userId, token]);
  const again = await db.query(`select unsubscribe_token from users where id = $1`, [userId]);
  return again.rows[0]?.unsubscribe_token ?? token;
}

/** Same relative-path fallback and the same warning as verifyUrl/resetUrl:
 *  nothing here can tell whether PUBLIC_BASE_URL points at a real host. */
export function unsubscribeUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** Flip the switch for whoever holds this token. Returns their email, or null
 *  for a token nobody holds, so the page can say which address it changed. */
export async function setDealEmailsByToken(db: Db, token: string, on: boolean): Promise<string | null> {
  if (!/^[0-9a-f]{16,128}$/.test(token)) return null;
  const { rows } = await db.query(
    `update users set deal_emails_off_at = ${on ? "null" : "coalesce(deal_emails_off_at, now())"}
      where unsubscribe_token = $1 returning email`,
    [token],
  );
  return rows[0]?.email ?? null;
}

export async function setDealEmailsForUser(db: Db, userId: string, on: boolean): Promise<void> {
  await db.query(
    `update users set deal_emails_off_at = ${on ? "null" : "coalesce(deal_emails_off_at, now())"} where id = $1`,
    [userId],
  );
}

export async function dealEmailsOn(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(`select deal_emails_off_at from users where id = $1`, [userId]);
  return rows[0]?.deal_emails_off_at == null;
}
