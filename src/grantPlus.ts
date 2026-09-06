/**
 * The one mechanism for granting Plus — comping a friend for the demo, or
 * the owner testing their own account. No coupon codes, no dev-only API
 * endpoint: just a command, same shape as `npm run migrate` / `npm run
 * refresh`. Upserts the user if they've never signed in before.
 *
 *   npm run grant-plus -- friend@example.com 90
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { addDaysISO, todayISO } from "./dates.js";
import { dateStr } from "./book.js";

export async function grantPlus(db: Db, email: string, days = 90): Promise<{ email: string; plusUntil: string }> {
  const plusUntil = addDaysISO(todayISO(), days);
  const { rows } = await db.query(
    `insert into users (id, email, plus_until) values ($1,$2,$3)
     on conflict (email) do update set plus_until = excluded.plus_until
     returning email, plus_until`,
    [randomUUID(), email.trim().toLowerCase(), plusUntil],
  );
  return { email: rows[0].email, plusUntil: dateStr(rows[0].plus_until) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  const days = process.argv[3] ? Number(process.argv[3]) : 90;
  if (!email) {
    console.error("usage: npm run grant-plus -- <email> [days=90]");
    process.exit(1);
  }
  const db = await getDb();
  const result = await grantPlus(db, email, days);
  console.log(`${result.email} is Plus until ${result.plusUntil}`);
  await db.close();
}
