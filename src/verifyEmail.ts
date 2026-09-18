/**
 * Email verification — proving an address belongs to whoever typed it.
 *
 * The gap this closes has been in CLAUDE.md's "known gaps" since accounts
 * were built: a password protects an account that already exists, but
 * nothing stopped somebody claiming a fresh one on an address that was not
 * theirs, and nothing stopped the alert job emailing an address nobody had
 * confirmed.
 *
 * THE DECISION THAT SHAPES THIS FILE: verification does not block sign-in by
 * default.
 *
 * It is tempting to make it block — that is what "verify your email" usually
 * means. It would also, today, lock every single person out of this app
 * including its owner, because **no email has ever actually been delivered
 * from this project**: RESEND_API_KEY is unset, so the console sender prints
 * the link into a server log instead. Shipping a gate whose key is posted to
 * a log nobody reads is not security, it is a locked door with the key on
 * the outside.
 *
 * So the harm is cut where the harm actually is:
 *
 *   - **Unverified addresses are never emailed by the alert job.** That is
 *     the concrete damage an unconfirmed address does — mail sent to a
 *     stranger, in their name, about a trip they never saved. `findAlerts`
 *     now requires `email_verified_at`.
 *   - **Sign-in still works**, and the UI says plainly that the address is
 *     unconfirmed and what that costs.
 *   - **`REQUIRE_VERIFIED_EMAIL=true` turns the hard gate on** once mail
 *     genuinely delivers. One switch, deliberately manual, deliberately off
 *     until the owner can prove an email arrives. The owner's nightly job
 *     list says when it is safe to flip.
 *
 * Deliberately NOT done: no backfill marking existing accounts verified.
 * Claiming an address was confirmed when nobody ever checked is exactly the
 * kind of comfortable lie the rest of this project refuses to tell.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { EmailSender } from "./email/types.js";
import type { EmailMessage } from "./email/types.js";

/** How long a link is good for. Long enough to survive a spam folder and a
 *  night's sleep, short enough that an old forwarded email is not a key. */
export const VERIFY_TOKEN_HOURS = 48;

/** The hard gate. Off until mail genuinely delivers — see the file header. */
export function requireVerifiedEmail(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REQUIRE_VERIFIED_EMAIL === "true";
}

export function verifyToken(): string {
  return randomBytes(32).toString("hex");
}

/** Where the link points. Falls back to a relative path so a local dev loop
 *  still produces a usable link without configuring anything. */
export function verifyUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

export function buildVerifyEmail(to: string, url: string): EmailMessage {
  return {
    to,
    subject: "Confirm your email for Parkfare",
    text: [
      "Someone (hopefully you) created a Parkfare account with this address.",
      "",
      "Confirm it here:",
      url,
      "",
      `The link works for ${VERIFY_TOKEN_HOURS} hours. Asking for a new one cancels this link.`,
      "",
      "If this wasn't you, you can ignore this — nothing will be sent to this address unless it's confirmed.",
      "",
      "— Parkfare",
    ].join("\n"),
  };
}

/**
 * Issues a fresh link, replacing any outstanding one.
 *
 * Upserted on user_id rather than appended, so there is only ever one live
 * link per account: if a link went to the wrong person, the right person
 * asking for a new one takes the old one out of play.
 */
export async function issueVerification(db: Db, userId: string): Promise<string> {
  const token = verifyToken();
  await db.query(
    `insert into email_verifications (user_id, token, expires_at, sent_at)
     values ($1, $2, now() + ($3 || ' hours')::interval, now())
     on conflict (user_id) do update set
       token = excluded.token, expires_at = excluded.expires_at, sent_at = excluded.sent_at`,
    [userId, token, String(VERIFY_TOKEN_HOURS)],
  );
  return token;
}

/**
 * Sends the link, and never lets a send failure fail the sign-up that
 * triggered it — the account exists either way, and a second link is one
 * button away. Same rule as recordSearch: telemetry and follow-ups must not
 * take down the thing the user is actually waiting on.
 */
export async function sendVerification(
  db: Db, userId: string, email: string, sender: EmailSender,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const token = await issueVerification(db, userId);
    await sender.send(buildVerifyEmail(email, verifyUrl(token, env)));
    return true;
  } catch (e) {
    console.error(`verification email to ${email} failed (${sender.name}):`, (e as Error).message);
    return false;
  }
}

export type VerifyResult =
  | { ok: true; email: string; alreadyVerified: boolean }
  | { ok: false; reason: "unknown_token" | "expired" };

/**
 * Consumes a link.
 *
 * An unknown token and an expired one are reported separately on purpose:
 * this is a link someone clicked from their own inbox, not a login form, so
 * there is nothing to enumerate and "your link expired, here's a new one" is
 * the difference between a user succeeding and giving up.
 */
export async function verifyEmailToken(db: Db, token: string): Promise<VerifyResult> {
  const clean = String(token ?? "").trim();
  if (!clean) return { ok: false, reason: "unknown_token" };
  const { rows } = await db.query<{
    user_id: string; email: string; expired: boolean; email_verified_at: unknown;
  }>(
    `select v.user_id, u.email, (v.expires_at <= now()) as expired, u.email_verified_at
       from email_verifications v join users u on u.id = v.user_id
      where v.token = $1`,
    [clean],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown_token" };
  if (row.expired) return { ok: false, reason: "expired" };

  const alreadyVerified = row.email_verified_at != null;
  // Stamp only if it isn't already stamped, so re-clicking a link doesn't
  // rewrite the date to a later one and make the record look wrong.
  await db.query(
    `update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`,
    [row.user_id],
  );
  // The link is single-use: consumed on success, so a forwarded email or a
  // link sitting in a browser history can't be replayed later.
  await db.query(`delete from email_verifications where user_id = $1`, [row.user_id]);
  return { ok: true, email: row.email, alreadyVerified };
}

export async function isVerified(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ email_verified_at: unknown }>(
    `select email_verified_at from users where id = $1`, [userId],
  );
  return rows[0]?.email_verified_at != null;
}
