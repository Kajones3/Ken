/**
 * The one mechanism for granting Planner Pro — comping a friend for the demo, or
 * the owner testing their own account. No coupon codes, no dev-only API
 * endpoint: just a command, same shape as `npm run migrate` / `npm run
 * refresh`. Upserts the user if they've never signed in before.
 *
 *   npm run grant-pro -- friend@example.com threeMonths   (a pass: week, threeMonths, nineMonths)
 *   npm run grant-pro -- friend@example.com 90            (plain days: keeps every perk, as hand-given Planner Pro always has)
 *
 * A new pass starts fresh from today (owner, 2026-10-29: "Keep it simple and
 * start fresh"): it replaces whatever was there, unused days included.
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { addDaysISO, todayISO } from "./dates.js";
import { dateStr } from "./book.js";
import { PRO_PASSES } from "./config.js";

export async function grantPro(db: Db, email: string, days = 90, pass: string | null = null):
  Promise<{ email: string; proUntil: string; pass: string | null }> {
  const proUntil = addDaysISO(todayISO(), days);
  const { rows } = await db.query(
    // Written to the old plus_* columns too until step 2 of the rename drops
    // them (db/schema.sql), so a server still on the old code reads it right.
    `insert into users (id, email, pro_until, pro_pass, plus_until, plus_pass) values ($1,$2,$3,$4,$3,$4)
     on conflict (email) do update set pro_until = excluded.pro_until, pro_pass = excluded.pro_pass,
       plus_until = excluded.pro_until, plus_pass = excluded.pro_pass
     returning email, pro_until, pro_pass`,
    [randomUUID(), email.trim().toLowerCase(), proUntil, pass],
  );
  return { email: rows[0].email, proUntil: dateStr(rows[0].pro_until), pass: rows[0].pro_pass ?? null };
}

/** "threeMonths" -> that pass; "90" -> 90 days, no pass. */
export function grantArgs(arg: string | undefined): { days: number; pass: string | null } | null {
  if (!arg) return { days: 90, pass: null };
  const p = PRO_PASSES.find((x) => x.id === arg);
  if (p) return { days: p.days, pass: p.id };
  const n = Number(arg);
  return Number.isInteger(n) && n > 0 ? { days: n, pass: null } : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  const args = grantArgs(process.argv[3]);
  if (!email || !args) {
    console.error(`usage: npm run grant-pro -- <email> [${PRO_PASSES.map((p) => p.id).join(" | ")} | days]`);
    process.exit(1);
  }
  const db = await getDb();
  const result = await grantPro(db, email, args.days, args.pass);
  console.log(`${result.email} is Planner Pro until ${result.proUntil}${result.pass ? ` (${result.pass} pass)` : ""}`);
  await db.close();
}
