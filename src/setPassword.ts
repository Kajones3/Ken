/**
 * Set (or clear) an account's password. Same shape as grant-plus: a command,
 * not a dev-only API endpoint, and it upserts the user if they've never
 * signed in before.
 *
 *   npm run set-password -- you@example.com 'your password'
 *   npm run set-password -- you@example.com --clear
 *
 * Deliberately a command rather than a value written into this repo: a
 * password committed to a git history is a password everyone with the
 * history has, forever, including after it's "changed".
 *
 * The password is read from argv, so it lands in the shell history of
 * whoever runs it. That's acceptable for a friends demo run by its owner;
 * it would not be for anything handling other people's accounts.
 *
 * IMPORTANT with the default embedded PGlite database: stop the server
 * first. See "PGlite is single-process" in CLAUDE.md — running this while
 * `npm start` is live doesn't reach the server's view of the data, and can
 * corrupt the store if both write at once. Not an issue against a real
 * Postgres (DATABASE_URL set), which is what production uses.
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";
import { hashPassword } from "./auth.js";

export async function setPassword(
  db: Db, email: string, password: string | null,
): Promise<{ email: string; hasPassword: boolean }> {
  const hash = password === null ? null : await hashPassword(password);
  const { rows } = await db.query(
    `insert into users (id, email, password_hash) values ($1,$2,$3)
     on conflict (email) do update set password_hash = excluded.password_hash
     returning email, password_hash`,
    [randomUUID(), email.trim().toLowerCase(), hash],
  );
  return { email: rows[0].email, hasPassword: Boolean(rows[0].password_hash) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  const secret = process.argv[3];
  if (!email || !secret) {
    console.error("usage: npm run set-password -- <email> <password|--clear>");
    process.exit(1);
  }
  const clearing = secret === "--clear";
  if (!clearing && secret.length < 3) {
    console.error("a password needs at least 3 characters");
    process.exit(1);
  }
  const db = await getDb();
  const r = await setPassword(db, email, clearing ? null : secret);
  // Never echo the password itself, not even into a local terminal — this
  // also runs in a GitHub Actions log.
  console.log(r.hasPassword
    ? `${r.email} now needs a password to sign in`
    : `${r.email} is back to email-only sign-in (no password)`);
  await db.close();
}
