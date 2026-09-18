import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, requiresPassword, isPlus,
} from "./auth.js";
import { memoryDb } from "./db.js";
import { setPassword } from "./setPassword.js";

/**
 * Sign-in is the one place where getting it subtly wrong hands someone else
 * an account. These pin the parts that could silently degrade: that the
 * stored value is a hash and not the password, that a wrong guess is
 * rejected, and — most important — that a broken or missing hash fails
 * CLOSED rather than falling through to "no password needed".
 */

test("a stored password is a salted hash, never the password itself", async () => {
  const stored = await hashPassword("hunter2");
  assert.ok(!stored.includes("hunter2"), "the password must not survive in the stored value");
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);

  // Same password, different account: different stored value, or one leaked
  // hash would identify every account sharing that password.
  const again = await hashPassword("hunter2");
  assert.notEqual(stored, again, "each account must get its own random salt");
});

test("the right password verifies and a wrong one does not", async () => {
  const stored = await hashPassword("hunter2");
  assert.equal(await verifyPassword("hunter2", stored), true);
  assert.equal(await verifyPassword("hunter3", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword("HUNTER2", stored), false, "passwords are case sensitive");
});

test("a missing or malformed hash fails closed, never open", async () => {
  // The dangerous bug would be any of these returning true, or throwing in a
  // way the sign-in route treats as "no password set".
  for (const bad of [null, "", "not-a-hash", "scrypt$", "scrypt$zz$zz", "sha256$a$b", "scrypt$aa$bb"]) {
    assert.equal(await verifyPassword("anything", bad), false, `${JSON.stringify(bad)} must not verify`);
  }
});

test("only an account with a stored hash requires a password", () => {
  assert.equal(requiresPassword(null), false, "an account with no password keeps email-only sign-in");
  assert.equal(requiresPassword(undefined), false);
  assert.equal(requiresPassword(""), false);
  assert.equal(requiresPassword("scrypt$aa$bb"), true);
});

test("set-password stores a hash, and --clear returns the account to email-only", async () => {
  const db = await memoryDb();

  const set = await setPassword(db, "Owner@Example.com ", "letmein");
  assert.equal(set.email, "owner@example.com", "email is normalised, so case can't create a second account");
  assert.equal(set.hasPassword, true);

  const { rows } = await db.query<{ password_hash: string }>(
    `select password_hash from users where email = $1`, ["owner@example.com"],
  );
  assert.ok(!rows[0]!.password_hash.includes("letmein"), "the database must not hold the password");
  assert.equal(await verifyPassword("letmein", rows[0]!.password_hash), true);

  const cleared = await setPassword(db, "owner@example.com", null);
  assert.equal(cleared.hasPassword, false);
  const after = await db.query<{ password_hash: string | null }>(
    `select password_hash from users where email = $1`, ["owner@example.com"],
  );
  assert.equal(after.rows[0]!.password_hash, null);

  await db.close();
});

test("setting a password does not disturb the account's Plus status", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into users (id, email, plus_until) values (gen_random_uuid(), $1, $2)`,
    ["owner@example.com", "2099-01-01"],
  );
  await setPassword(db, "owner@example.com", "letmein");

  const { rows } = await db.query<{ plus_until: unknown }>(
    `select plus_until from users where email = $1`, ["owner@example.com"],
  );
  assert.ok(rows[0]!.plus_until, "a password change must never cost someone their Plus");
  assert.equal(isPlus("2099-01-01"), true);

  await db.close();
});
