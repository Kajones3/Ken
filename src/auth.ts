/**
 * Minimal real identity: an email, no password, no OAuth. Enough to make
 * "Plus" a real server-checked thing instead of a browser toggle, and to
 * have a real address for alert emails and saved trips to belong to.
 *
 * Explicitly not good enough for a public launch: anyone who knows a
 * friend's email can sign in as them. Right trade-off for a friends demo
 * where the owner is comping accounts by hand — cheap to upgrade later to
 * a one-time emailed link through the existing EmailSender interface.
 */
import { randomBytes } from "node:crypto";
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

export function sessionCookieHeader(token: string): string {
  // No `Secure` yet — this runs over plain http for the friends demo.
  // Add it before any deploy that serves over https.
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
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
