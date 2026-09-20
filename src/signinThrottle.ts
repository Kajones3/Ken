/**
 * Make guessing a password cost time.
 *
 * Until now nothing slowed down an attacker at all: scrypt made each guess
 * expensive for US, but a script could keep asking forever. Five wrong answers
 * now buys a cooling-off period.
 *
 * TWO SCOPES, COUNTED SEPARATELY.
 *   email|someone@example.com — protects one account from a targeted guess
 *   ip|1.2.3.4               — stops one machine cycling through addresses
 * Either one tripping is enough to refuse. Without the IP scope, an attacker
 * just moves to the next email and never trips anything; without the email
 * scope, an attacker on a fresh IP per attempt never trips anything either.
 *
 * COUNTED FOR ADDRESSES WITH NO ACCOUNT TOO. This is the part that is easy to
 * get wrong: if only real accounts could be locked, then "too many attempts"
 * would mean "this address is registered" and the lockout would become the
 * account-enumeration oracle that sign-in's single error message exists to
 * prevent. So an unknown address is counted, locked and reported exactly like
 * a real one.
 *
 * THE TRADE-OFF, STATED RATHER THAN HIDDEN: locking by email means somebody
 * can deliberately lock a person out by guessing wrong five times. That is
 * real, and it is the accepted cost. Two things keep it small — the lock is
 * minutes rather than permanent, and a password reset still works while locked,
 * so the account holder always has a way back in that does not depend on
 * waiting.
 */
import type { Db } from "./db.js";

/** Wrong answers allowed before the door shuts. The owner asked for five. */
export const MAX_FAILS = Number(process.env.SIGNIN_MAX_FAILS ?? 5);
/**
 * The same limit for an IP would be wrong, and testing it against a live
 * server is what showed why: five typos from one household would lock out
 * everyone else behind that connection, because a home, an office and a
 * coffee shop all share one address. The IP scope is there to stop a script
 * working through a list of emails, which takes far more than five attempts,
 * so it gets a much higher ceiling and still catches the thing it is for.
 */
export const MAX_FAILS_IP = Number(process.env.SIGNIN_MAX_FAILS_IP ?? 25);
/** How long the door stays shut. Long enough to make a script pointless,
 *  short enough that a person who genuinely forgot can wait it out. */
export const LOCK_MINUTES = Number(process.env.SIGNIN_LOCK_MINUTES ?? 15);
/** Failures older than this stop counting, so a wrong guess in March plus one
 *  in June is not four-fifths of the way to a lockout. */
export const WINDOW_MINUTES = Number(process.env.SIGNIN_WINDOW_MINUTES ?? 15);

export type ThrottleCheck =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/** The scopes one sign-in attempt counts against. An absent IP is simply not
 *  counted rather than bucketed under "unknown", which would let one missing
 *  header lock out everybody who also lacks one. */
export function scopesFor(email: string, ip: string | null): string[] {
  const out = [`email|${email.trim().toLowerCase()}`];
  if (ip && ip.trim()) out.push(`ip|${ip.trim()}`);
  return out;
}

/**
 * Is this attempt allowed? Called BEFORE the password is checked, so a locked
 * scope never even reaches scrypt.
 */
export async function checkSigninAllowed(db: Db, scopes: string[]): Promise<ThrottleCheck> {
  if (!scopes.length) return { allowed: true };
  const { rows } = await db.query<{ locked_until: Date | null }>(
    `select locked_until from signin_attempts
      where scope = any($1) and locked_until is not null and locked_until > now()
      order by locked_until desc limit 1`,
    [scopes],
  );
  const until = rows[0]?.locked_until;
  if (!until) return { allowed: true };
  const seconds = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));
  return { allowed: false, retryAfterSeconds: seconds };
}

/**
 * Record a wrong answer, and lock the scope once it has had enough of them.
 *
 * The window is enforced here rather than by a cleanup job: if the last
 * failure was longer ago than WINDOW_MINUTES, the count starts again from one.
 */
export async function recordSigninFailure(db: Db, scopes: string[]): Promise<void> {
  for (const scope of scopes) {
    const limit = scope.startsWith("ip|") ? MAX_FAILS_IP : MAX_FAILS;
    await db.query(
      `insert into signin_attempts (scope, fails, first_fail_at, locked_until)
       values ($1, 1, now(), null)
       on conflict (scope) do update set
         fails = case
           when signin_attempts.first_fail_at < now() - ($2 || ' minutes')::interval then 1
           else signin_attempts.fails + 1 end,
         first_fail_at = case
           when signin_attempts.first_fail_at < now() - ($2 || ' minutes')::interval then now()
           else signin_attempts.first_fail_at end,
         locked_until = case
           when (case
                   when signin_attempts.first_fail_at < now() - ($2 || ' minutes')::interval then 1
                   else signin_attempts.fails + 1 end) >= $3
             then now() + ($4 || ' minutes')::interval
           else null end`,
      [scope, String(WINDOW_MINUTES), limit, String(LOCK_MINUTES)],
    );
  }
}

/** A correct password wipes the slate — for the email, and for the IP that
 *  supplied it, so a household sharing an address is not slowly locked out by
 *  one person's typos. */
export async function clearSigninFailures(db: Db, scopes: string[]): Promise<void> {
  if (!scopes.length) return;
  await db.query(`delete from signin_attempts where scope = any($1)`, [scopes]);
}

/** What the user is told. Deliberately identical whether or not the address
 *  has an account, and it names the way back in that does not involve
 *  waiting. */
export function lockoutMessage(retryAfterSeconds: number): string {
  const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}, `
    + `or use "Forgot your password?" to set a new one now.`;
}

/**
 * The caller's IP, from the proxy header Render sets, falling back to the
 * socket. Takes the FIRST entry of x-forwarded-for: later entries are added by
 * intermediaries and the client can prepend whatever it likes, so trusting the
 * last one would let an attacker rotate their own scope at will.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketIp?: string): string | null {
  const xff = headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const ip = (first ?? "").split(",")[0]?.trim();
  return ip || socketIp || null;
}
