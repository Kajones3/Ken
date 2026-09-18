import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, requiresPassword, isPlus, setHomeAirport, currentUser,
  createSession, sessionCookieHeader,
} from "./auth.js";
import { memoryDb, type Db } from "./db.js";
import { setPassword } from "./setPassword.js";
import { randomUUID } from "node:crypto";
import { defaultGettingThere } from "./gettingThere.js";

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

/* ---------------------------------------------------------------------------
 * Home airport — the first profile field. Free, per account, and "not set"
 * has to stay reachable.
 * ------------------------------------------------------------------------ */

async function makeUser(db: Db, email = "traveller@example.test"): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into users (id, email) values ($1,$2)`, [id, email]);
  return id;
}

/** Reads the user back the way the API does — through a real session. */
async function sessionUser(db: Db, userId: string) {
  const token = await createSession(db, userId);
  return currentUser(db, { headers: { cookie: `pf_session=${token}` } } as never);
}

test("a new account has no home airport, which is not the same as Atlanta", async () => {
  // The distinction the column is nullable for: "I haven't said" must not
  // silently become "I fly from Atlanta" for every account that already
  // exists, or the form starts lying about a choice nobody made.
  const db = await memoryDb();
  const id = await makeUser(db);
  assert.equal((await sessionUser(db, id))?.homeAirport, null);
  await db.close();
});

test("a saved home airport comes back with the session", async () => {
  const db = await memoryDb();
  const id = await makeUser(db);
  await setHomeAirport(db, id, "SEA");
  assert.equal((await sessionUser(db, id))?.homeAirport, "SEA");
  await db.close();
});

test("a lowercase airport is stored the way the rest of the app spells it", async () => {
  // Everything else in the app keys on an uppercase IATA code, so storing
  // "sea" would quietly fail to match any option in the form's dropdown.
  const db = await memoryDb();
  const id = await makeUser(db);
  assert.equal(await setHomeAirport(db, id, " sea "), "SEA");
  assert.equal((await sessionUser(db, id))?.homeAirport, "SEA");
  await db.close();
});

test("an airport we don't know is refused, not stored", async () => {
  // It comes back out as a pre-selected form value, so a junk code would be
  // a permanently broken form the traveller has no way to explain.
  const db = await memoryDb();
  const id = await makeUser(db);
  await assert.rejects(() => setHomeAirport(db, id, "ZZZ"), /unknown airport ZZZ/);
  assert.equal((await sessionUser(db, id))?.homeAirport, null, "nothing was written");
  await db.close();
});

test("a home airport can be cleared again", async () => {
  // A first save that could never be undone would be a trap.
  const db = await memoryDb();
  const id = await makeUser(db);
  await setHomeAirport(db, id, "DEN");
  assert.equal(await setHomeAirport(db, id, null), null);
  assert.equal((await sessionUser(db, id))?.homeAirport, null);
  await db.close();
});

test("a Plus airport can be saved by an account with no Plus", async () => {
  // Picking one is already a supported non-error case — resolveOrigin()
  // prices the nearest free metro and the board says so. Refusing to
  // REMEMBER a choice the form lets you MAKE would contradict that.
  const db = await memoryDb();
  const id = await makeUser(db);
  assert.equal(await setHomeAirport(db, id, "RDU"), "RDU");
  const user = await sessionUser(db, id);
  assert.equal(user?.homeAirport, "RDU");
  assert.equal(isPlus(user?.plusUntil ?? null), false, "still not Plus");
  await db.close();
});

test("one account's home airport is not another's", async () => {
  const db = await memoryDb();
  const a = await makeUser(db, "a@example.test");
  const b = await makeUser(db, "b@example.test");
  await setHomeAirport(db, a, "LAX");
  assert.equal((await sessionUser(db, a))?.homeAirport, "LAX");
  assert.equal((await sessionUser(db, b))?.homeAirport, null);
  await db.close();
});

test("a home airport of LAX lands the traveller on the drive-to-Disneyland preset", async () => {
  // The two features meeting: the saved airport is what the drive/fly
  // default reads, so an LA user opens the app already set up correctly
  // without touching anything.
  const db = await memoryDb();
  const id = await makeUser(db);
  await setHomeAirport(db, id, "LAX");
  const user = await sessionUser(db, id);
  assert.equal(defaultGettingThere(user!.homeAirport!), "driveDlr");
  await db.close();
});
