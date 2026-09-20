/**
 * "Forgot your password?" — a one-time emailed link that sets a new one.
 *
 * Until now the only way to change a password was the owner running
 * `npm run set-password` by hand, which meant a locked-out friend had to ask a
 * human, and the owner had no self-serve way to cut off a password that had
 * been passed around. Both are fixed by the same flow.
 *
 * Deliberately the same shape as email verification — single-use token,
 * upserted per user, consumed on arrival — because that pattern is already
 * tested here and a second, subtly different one would be a second thing to
 * get wrong.
 *
 * FOUR RULES THAT ARE DECISIONS, NOT DEFAULTS:
 *
 * 1. ASKING NEVER REVEALS WHETHER AN ADDRESS IS REGISTERED. The route answers
 *    identically either way. Sign-in already refuses to leak that; a forgot
 *    form that says "no such account" would hand it straight back.
 *
 * 2. A RESET SIGNS OUT EVERY DEVICE. Whoever resets the password holds the
 *    inbox; everyone else currently signed in does not. This is what makes the
 *    flow a real answer to "someone shared their password" as well as to
 *    "I forgot mine" — it is the revoke button the app never had.
 *
 * 3. A RESET CONFIRMS THE EMAIL. Clicking a link proves control of the inbox,
 *    which is the entire thing email_verified_at records. Refusing to stamp it
 *    would mean holding evidence we had asked for and then ignoring it.
 *
 * 4. A RESET CLEARS THE SIGN-IN LOCKOUT. Otherwise the person who just proved
 *    they own the account still cannot get in, which would make the throttle a
 *    trap rather than a brake.
 *
 * SHORTER-LIVED THAN A CONFIRMATION LINK, because a confirmation link only
 * proves an address while a reset link hands over an account.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { EmailMessage, EmailSender } from "./email/types.js";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./auth.js";

export const RESET_TOKEN_HOURS = 2;

export function resetToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Where the link points.
 *
 * Same relative-path fallback as verifyUrl, and the same warning applies with
 * more force: the program only ever COMPOSES this URL and never fetches it, so
 * nothing here can tell you PUBLIC_BASE_URL points at a host that resolves.
 * Only a human clicking a link in a real inbox can. See the www trap in
 * CLAUDE.md — a reset link addressed to a dead hostname locks people out
 * rather than merely failing to confirm them.
 */
export function resetUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/auth/reset?token=${encodeURIComponent(token)}`;
}

export function buildResetEmail(to: string, url: string): EmailMessage {
  return {
    to,
    subject: "Reset your Parkfare password",
    text: [
      "Someone asked to reset the password for this Parkfare account.",
      "",
      "Set a new one here:",
      url,
      "",
      `The link works for ${RESET_TOKEN_HOURS} hours and can only be used once.`,
      "Asking for another link cancels this one.",
      "",
      "Setting a new password signs out every device that is currently signed in,",
      "including any you have shared this account with.",
      "",
      "If this wasn't you, you can ignore it — your password has not changed,",
      "and nobody can use this link without access to this inbox.",
      "",
      "— Parkfare",
    ].join("\n"),
  };
}

/** Issues a fresh link, replacing any outstanding one for that account. */
export async function issueReset(db: Db, userId: string): Promise<string> {
  const token = resetToken();
  await db.query(
    `insert into password_resets (user_id, token, expires_at, sent_at)
     values ($1, $2, now() + ($3 || ' hours')::interval, now())
     on conflict (user_id) do update set
       token = excluded.token, expires_at = excluded.expires_at, sent_at = excluded.sent_at`,
    [userId, token, String(RESET_TOKEN_HOURS)],
  );
  return token;
}

/**
 * Send a reset link if that address has an account, and say nothing either way.
 *
 * Returns whether a mail was sent, for logging only — the ROUTE must answer
 * identically regardless, or this becomes a way to ask the site which of your
 * friends has signed up.
 */
export async function requestReset(
  db: Db, rawEmail: unknown, sender: EmailSender, env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!email) return false;
  const { rows } = await db.query<{ id: string; email: string }>(
    `select id, email from users where email = $1`, [email],
  );
  const user = rows[0];
  if (!user) return false;
  try {
    const token = await issueReset(db, user.id);
    await sender.send(buildResetEmail(user.email, resetUrl(token, env)));
    return true;
  } catch (e) {
    // Never rethrow: the caller answers the same either way, and a provider
    // outage must not turn into a message that reveals the account exists.
    console.error(`reset email to ${email} failed (${sender.name}):`, (e as Error).message);
    return false;
  }
}

export type ResetLookup =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "unknown" | "expired" };

/** Is this token good? Used to decide whether to render the form at all, so
 *  nobody types a new password into a page that was never going to work. */
export async function lookupReset(db: Db, token: string): Promise<ResetLookup> {
  if (!token) return { ok: false, reason: "unknown" };
  const { rows } = await db.query<{ user_id: string; email: string; expired: boolean }>(
    `select r.user_id, u.email, (r.expires_at <= now()) as expired
       from password_resets r join users u on u.id = r.user_id
      where r.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (row.expired) return { ok: false, reason: "expired" };
  return { ok: true, userId: row.user_id, email: row.email };
}

export type ResetResult =
  | { ok: true; email: string; sessionsEnded: number }
  | { ok: false; reason: "unknown" | "expired" | "weak_password" };

/**
 * Consume the token and set the new password.
 *
 * Order matters. The token is deleted in the same breath as the password is
 * written, so a link cannot be replayed; sessions go last, after the new
 * password is definitely stored, so a failure part-way through never leaves an
 * account both signed out everywhere AND still on the old password.
 */
export async function consumeReset(db: Db, token: string, newPassword: unknown): Promise<ResetResult> {
  const found = await lookupReset(db, token);
  if (!found.ok) return { ok: false, reason: found.reason };
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "weak_password" };
  }

  const hash = await hashPassword(newPassword);
  // Single-use: deleting by token means a second click of the same link finds
  // nothing, rather than silently setting the password twice.
  const del = await db.query(`delete from password_resets where token = $1 returning user_id`, [token]);
  if (!del.rows.length) return { ok: false, reason: "unknown" };

  await db.query(
    `update users set password_hash = $2,
            email_verified_at = coalesce(email_verified_at, now())
      where id = $1`,
    [found.userId, hash],
  );

  const ended = await db.query(`delete from sessions where user_id = $1 returning token`, [found.userId]);
  // The throttle must not outlive the reset, or somebody who just proved they
  // own the account still cannot sign in.
  await db.query(`delete from signin_attempts where scope = $1`, [`email|${found.email}`]);

  return { ok: true, email: found.email, sessionsEnded: ended.rows.length };
}
