/**
 * The one mechanism for granting Plus — comping a friend for the demo, or
 * the owner testing their own account. No coupon codes, no dev-only API
 * endpoint: just a command, same shape as `npm run migrate` / `npm run
 * refresh`. Upserts the user if they've never signed in before.
 *
 *   npm run grant-plus -- friend@example.com threeMonths   (a pass: week, threeMonths, nineMonths)
 *   npm run grant-plus -- friend@example.com 90            (plain days: keeps every perk, as hand-given Plus always has)
 *
 * A new pass starts fresh from today (owner, 2026-10-29: "Keep it simple and
 * start fresh"): it replaces whatever was there, unused days included.
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { addDaysISO, todayISO } from "./dates.js";
import { dateStr } from "./book.js";
import { PLUS_PASSES } from "./config.js";

export async function grantPlus(db: Db, email: string, days = 90, pass: string | null = null):
  Promise<{ email: string; plusUntil: string; pass: string | null }> {
  const plusUntil = addDaysISO(todayISO(), days);
  const { rows } = await db.query(
    `insert into users (id, email, plus_until, plus_pass) values ($1,$2,$3,$4)
     on conflict (email) do update set plus_until = excluded.plus_until, plus_pass = excluded.plus_pass
     returning email, plus_until, plus_pass`,
    [randomUUID(), email.trim().toLowerCase(), plusUntil, pass],
  );
  return { email: rows[0].email, plusUntil: dateStr(rows[0].plus_until), pass: rows[0].plus_pass ?? null };
}

/** "threeMonths" -> that pass; "90" -> 90 days, no pass. */
export function grantArgs(arg: string | undefined): { days: number; pass: string | null } | null {
  if (!arg) return { days: 90, pass: null };
  const p = PLUS_PASSES.find((x) => x.id === arg);
  if (p) return { days: p.days, pass: p.id };
  const n = Number(arg);
  return Number.isInteger(n) && n > 0 ? { days: n, pass: null } : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  const args = grantArgs(process.argv[3]);
  if (!email || !args) {
    console.error(`usage: npm run grant-plus -- <email> [${PLUS_PASSES.map((p) => p.id).join(" | ")} | days]`);
    process.exit(1);
  }
  const db = await getDb();
  const result = await grantPlus(db, email, args.days, args.pass);
  console.log(`${result.email} is Planner Pro until ${result.plusUntil}${result.pass ? ` (${result.pass} pass)` : ""}`);
  await db.close();
}
