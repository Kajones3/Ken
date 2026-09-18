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
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { todayISO, type ISODate } from "./dates.js";

const COOKIE_NAME = "pf_session";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface SessionUser { id: string; email: string; plusUntil: ISODate | null }

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
    `select u.id, u.email, u.plus_until
       from sessions s join users u on u.id = s.user_id
      where s.token = $1 and s.expires_at > now()`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, plusUntil: row.plus_until ? dateStr(row.plus_until) : null };
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

/** Whether this account requires a password. Null hash = email-only, as before. */
export function requiresPassword(passwordHash: string | null | undefined): boolean {
  return typeof passwordHash === "string" && passwordHash.length > 0;
}
