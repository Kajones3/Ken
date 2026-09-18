/**
 * Minimal real identity: an email, and optionally a password. Enough to make
 * "Plus" a real server-checked thing instead of a browser toggle, and to
 * have a real address for alert emails and saved trips to belong to.
 *
 * A password is per account and opt-in. An account with no `password_hash`
 * signs in on its email alone, exactly as before; an account with one
 * requires it. That split is deliberate: the owner needed to lock down their
 * own account without invalidating every comped friend account in the same
 * change, and a demo nobody can get into is worse than a demo anyone can.
 *
 * Still not enough for a public launch: an account with no password is open
 * to anyone who knows the email, and nothing verifies that an address
 * belongs to whoever typed it. A one-time emailed link through the existing
 * EmailSender interface remains the real fix.
 */
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { todayISO, type ISODate } from "./dates.js";
import { ORIGIN_BY_IATA, originNeedsPlus } from "./config.js";

const COOKIE_NAME = "pf_session";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface SessionUser {
  id: string;
  email: string;
  plusUntil: ISODate | null;
  /** The airport this traveller flies out of, or null if they've never said.
   *  Null and "ATL" are different facts — see setHomeAirport. */
  homeAirport: string | null;
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function parseCookies(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * `Secure` is added whenever the app is actually served over https, which
 * on Render means DATABASE_URL is set (SECURE_COOKIES=false forces it off).
 * It can't be unconditional: a Secure cookie is never sent over plain http,
 * so hardcoding it would break the local dev loop entirely. It matters more
 * now that an account can carry a real password — a session cookie is the
 * credential once you're in, and one sent in the clear is worth stealing.
 */
export function secureCookies(): boolean {
  if (process.env.SECURE_COOKIES === "false") return false;
  return process.env.SECURE_COOKIES === "true" || Boolean(process.env.DATABASE_URL);
}

export function sessionCookieHeader(token: string): string {
  const secure = secureCookies() ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

export function clearCookieHeader(): string {
  // Must match sessionCookieHeader's attributes or the browser keeps the old
  // cookie and "sign out" silently does nothing.
  const secure = secureCookies() ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.query(`insert into sessions (token, user_id) values ($1,$2)`, [token, userId]);
  return token;
}

export function sessionTokenFrom(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.query(`delete from sessions where token = $1`, [token]);
}

export async function currentUser(db: Db, req: IncomingMessage): Promise<SessionUser | null> {
  const token = sessionTokenFrom(req);
  if (!token) return null;
  const { rows } = await db.query(
    `select u.id, u.email, u.plus_until, u.home_airport
       from sessions s join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, email: row.email,
    plusUntil: row.plus_until ? dateStr(row.plus_until) : null,
    homeAirport: row.home_airport ?? null,
  };
}

/**
 * Remembers (or forgets) the airport someone departs from.
 *
 * Validated against the app's own airport list rather than stored as typed:
 * a code we don't know would price nothing, and the value comes back out as
 * a pre-selected form field, so a junk code would be a permanently broken
 * form the traveller couldn't explain. `null` clears it — "I haven't said"
 * has to stay reachable, otherwise the first save is irreversible.
 *
 * Having one is free: an account is free, saving and watching a TRIP is Plus,
 * and remembering a dropdown is neither.
 *
 * But WHICH airports you may keep follows the same tiering as picking one.
 * The 22 smaller airports are Plus, and a non-Plus account cannot store one
 * even though the board will still price a trip from it (downgraded to the
 * nearest free metro, and said so). Owner's call, and the consistent one:
 * the split is what makes the free/Plus line mean something, and a free
 * account quietly holding a Plus airport forever would hollow it out.
 *
 * Plus is read from the database here, never passed in. A caller-supplied
 * "they're Plus" flag would be a way to grant the tier from the client, the
 * same rule exact-fare follows for the same reason.
 *
 * A lapsed account KEEPS whatever it saved while it was Plus. Deleting a
 * setting because a subscription ran out is a punishment nobody asked for,
 * and the trip still prices — resolveOrigin() downgrades it to the nearest
 * free metro and the board says which it used, exactly as if they had picked
 * it by hand. They just cannot move it to another Plus airport until they
 * renew.
 */
export class HomeAirportError extends Error {
  constructor(message: string, readonly reason: "unknown_airport" | "plus_required") {
    super(message);
  }
}

export async function setHomeAirport(
  db: Db, userId: string, iata: string | null,
): Promise<string | null> {
  const clean = iata ? iata.trim().toUpperCase() : null;
  if (clean && !ORIGIN_BY_IATA.has(clean)) {
    throw new HomeAirportError(`unknown airport ${clean}`, "unknown_airport");
  }
  if (clean && originNeedsPlus(clean)) {
    const { rows } = await db.query<{ plus_until: unknown }>(
      `select plus_until from users where id = $1`, [userId],
    );
    const plusUntil = rows[0]?.plus_until ? dateStr(rows[0].plus_until as never) : null;
    if (!isPlus(plusUntil)) {
      throw new HomeAirportError(
        `${clean} is a Plus airport — a free account can't save it as a home airport.`,
        "plus_required",
      );
    }
  }
  await db.query(`update users set home_airport = $2 where id = $1`, [userId, clean]);
  return clean;
}

/** Pure and exported so it's unit-testable without a database. */
export function isPlus(plusUntil: ISODate | null, today: ISODate = todayISO()): boolean {
  return plusUntil != null && plusUntil >= today;
}

// ------------------------------------------------------------- passwords

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;
const SCRYPT_KEY_BYTES = 64;
const SALT_BYTES = 16;

/**
 * scrypt from node:crypto — deliberately no new dependency. Deliberately not
 * a plain sha256 either: a fast hash is brute-forceable, and the whole point
 * of storing a hash rather than the password is that the database leaking
 * shouldn't hand over the password too.
 *
 * Format: `scrypt$<salt-hex>$<key-hex>`. The salt is per account and random,
 * so two accounts choosing the same password still store different hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEY_BYTES);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Constant-time compare, so the time this takes can't be measured to learn
 * how much of a guess was right. Returns false rather than throwing on a
 * malformed stored value — a corrupt row must lock the account, never crash
 * the sign-in route or (worse) fall through to "no password required".
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    if (!salt.length || expected.length !== SCRYPT_KEY_BYTES) return false;
    const actual = await scrypt(password, salt, SCRYPT_KEY_BYTES);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Whether this account has a password set yet. Every account NEEDS one now
 *  (see signUp/signIn); this only answers whether it has got there. */
export function hasPassword(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === "string" && passwordHash.length > 0;
}

/**
 * Short enough not to annoy a friend testing a demo, long enough that a
 * guess is not free. scrypt is what makes each guess expensive; this is
 * what stops the guess space being tiny.
 */
export const MIN_PASSWORD_LENGTH = 8;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: "bad_email" | "weak_password" | "already_registered" | "bad_credentials",
  ) { super(message); }
}

function cleanEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AuthError("Enter a valid email address.", "bad_email");
  }
  return email;
}

/**
 * Create an account, or finish one that predates passwords being required.
 *
 * Every account needs a password now — the owner's call, replacing the
 * opt-in scheme where an account with no hash signed in on its email alone.
 * That scheme existed so setting one password wouldn't lock out every
 * comped friend at once, and this is the migration it was waiting for: an
 * account that has no hash yet can still be claimed here by setting one,
 * rather than being bricked.
 *
 * The honest caveat, unchanged and now more consequential: **nothing
 * verifies that an address belongs to whoever typed it**, so claiming a
 * legacy account is first-come. That is not a regression — until today,
 * anyone who knew the address could simply sign in as them — but if an
 * account carries comped Plus, set its password with
 * `npm run set-password` before anyone else gets there. A one-time emailed
 * link through the existing EmailSender remains the real fix.
 */
export async function signUp(
  db: Db, rawEmail: unknown, password: string,
): Promise<SessionUser> {
  const email = cleanEmail(rawEmail);
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, "weak_password",
    );
  }
  const existing = await db.query<{ id: string; password_hash: string | null }>(
    `select id, password_hash from users where email = $1`, [email],
  );
  const row = existing.rows[0];
  // An email that already has a password belongs to somebody. Saying so
  // does leak that the account exists — unavoidable on any sign-up form
  // without email verification, and the alternative (a generic failure)
  // strands a returning user who forgot they had signed up.
  if (row && hasPassword(row.password_hash)) {
    throw new AuthError(
      "That email already has an account. Sign in instead.", "already_registered",
    );
  }
  const hash = await hashPassword(password);
  const { rows } = await db.query(
    `insert into users (id, email, password_hash) values ($1,$2,$3)
     on conflict (email) do update set password_hash = excluded.password_hash
     returning id, email, plus_until, home_airport`,
    [row?.id ?? randomUUID(), email, hash],
  );
  const u = rows[0];
  return {
    id: u.id, email: u.email,
    plusUntil: u.plus_until ? dateStr(u.plus_until) : null,
    homeAirport: u.home_airport ?? null,
  };
}

/**
 * Sign in to an existing account. Never creates one — that is signUp's job,
 * and the old route doing both is what allowed a typo'd address to silently
 * become a second empty account.
 *
 * One message for every failure: wrong password, unknown email, and an
 * account that has not set a password yet all answer the same thing, so
 * this form cannot be used to discover which addresses have accounts. (The
 * sign-up form necessarily does leak that; see signUp.)
 */
export async function signIn(
  db: Db, rawEmail: unknown, password: string,
): Promise<SessionUser> {
  const email = cleanEmail(rawEmail);
  const bad = new AuthError("That email and password don't match.", "bad_credentials");
  const { rows } = await db.query<{
    id: string; email: string; plus_until: unknown; home_airport: string | null; password_hash: string | null;
  }>(
    `select id, email, plus_until, home_airport, password_hash from users where email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row || !hasPassword(row.password_hash)) throw bad;
  if (!(await verifyPassword(password, row.password_hash))) throw bad;
  return {
    id: row.id, email: row.email,
    plusUntil: row.plus_until ? dateStr(row.plus_until as never) : null,
    homeAirport: row.home_airport ?? null,
  };
}
