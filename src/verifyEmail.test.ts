import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { memoryDb, type Db } from "./db.js";
import {
  issueVerification, verifyEmailToken, isVerified, sendVerification,
  buildVerifyEmail, verifyUrl, requireVerifiedEmail, VERIFY_TOKEN_HOURS,
} from "./verifyEmail.js";
import { signUp, signIn, AuthError } from "./auth.js";
import type { EmailMessage, EmailSender } from "./email/types.js";

function recorder(opts: { throws?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    name: "test",
    async send(m) { if (opts.throws) throw new Error("smtp is down"); sent.push(m); },
  };
  return { sent, sender };
}

async function makeUser(db: Db, email = "traveller@example.test"): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into users (id, email) values ($1,$2)`, [id, email]);
  return id;
}

test("a new account starts unverified", async () => {
  const db = await memoryDb();
  const user = await signUp(db, "new@example.test", "correcthorse");
  assert.equal(user.emailVerified, false);
  assert.equal(await isVerified(db, user.id), false);
  await db.close();
});

test("clicking the link confirms the address", async () => {
  const db = await memoryDb();
  const id = await makeUser(db);
  const token = await issueVerification(db, id);
  const r = await verifyEmailToken(db, token);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.email, "traveller@example.test");
  assert.equal(r.ok && r.alreadyVerified, false);
  assert.equal(await isVerified(db, id), true);
  await db.close();
});

test("a link is single use", async () => {
  // A forwarded email, or one sitting in a browser history, must not be a
  // key that keeps working.
  const db = await memoryDb();
  const id = await makeUser(db);
  const token = await issueVerification(db, id);
  assert.equal((await verifyEmailToken(db, token)).ok, true);
  const again = await verifyEmailToken(db, token);
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, "unknown_token");
  assert.equal(await isVerified(db, id), true, "but the account stays verified");
  await db.close();
});

test("asking for a new link kills the old one", async () => {
  // So a link that went to the wrong person stops working the moment the
  // right person asks again.
  const db = await memoryDb();
  const id = await makeUser(db);
  const first = await issueVerification(db, id);
  const second = await issueVerification(db, id);
  assert.notEqual(first, second);
  assert.equal((await verifyEmailToken(db, first)).ok, false, "the old link is dead");
  assert.equal((await verifyEmailToken(db, second)).ok, true);
  await db.close();
});

test("an expired link is refused, and says so distinctly", async () => {
  // Reported separately from an unknown token on purpose: this is a link
  // from someone's own inbox, so there is nothing to enumerate, and "your
  // link expired" is the difference between succeeding and giving up.
  const db = await memoryDb();
  const id = await makeUser(db);
  await db.query(
    `insert into email_verifications (user_id, token, expires_at)
     values ($1,'stale', now() - interval '1 hour')`, [id],
  );
  const r = await verifyEmailToken(db, "stale");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "expired");
  assert.equal(await isVerified(db, id), false);
  await db.close();
});

test("an unknown or empty token is refused without throwing", async () => {
  const db = await memoryDb();
  for (const t of ["", "   ", "not-a-real-token"]) {
    const r = await verifyEmailToken(db, t);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "unknown_token");
  }
  await db.close();
});

test("re-clicking after verification reports it without moving the date", async () => {
  const db = await memoryDb();
  const id = await makeUser(db);
  await verifyEmailToken(db, await issueVerification(db, id));
  const { rows: first } = await db.query<{ t: string }>(
    `select email_verified_at as t from users where id = $1`, [id]);

  const r = await verifyEmailToken(db, await issueVerification(db, id));
  assert.equal(r.ok && r.alreadyVerified, true);
  const { rows: second } = await db.query<{ t: string }>(
    `select email_verified_at as t from users where id = $1`, [id]);
  assert.equal(String(first[0]!.t), String(second[0]!.t), "the original date stands");
  await db.close();
});

test("a send failure never loses the account or throws", async () => {
  // The account exists either way and another link is one button away —
  // same rule recordSearch follows: a follow-up must not take down the
  // thing the user is waiting on.
  const db = await memoryDb();
  const id = await makeUser(db);
  const { sender } = recorder({ throws: true });
  assert.equal(await sendVerification(db, id, "traveller@example.test", sender), false);
  await db.close();
});

test("the email carries a working link and says what it is for", async () => {
  const db = await memoryDb();
  const id = await makeUser(db);
  const { sent, sender } = recorder();
  assert.equal(await sendVerification(db, id, "traveller@example.test", sender, {} as NodeJS.ProcessEnv), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "traveller@example.test");

  const token = sent[0]!.text.match(/token=([a-f0-9]+)/)?.[1];
  assert.ok(token, "the email must contain the token");
  assert.equal((await verifyEmailToken(db, token!)).ok, true, "and it must actually work");
  assert.match(sent[0]!.text, new RegExp(String(VERIFY_TOKEN_HOURS)), "says how long it lasts");
  assert.match(sent[0]!.text, /ignore/i, "tells a stranger they can ignore it");
  await db.close();
});

test("the link uses PUBLIC_BASE_URL when set, with no doubled slash", () => {
  assert.equal(verifyUrl("abc", { PUBLIC_BASE_URL: "https://x.test" } as NodeJS.ProcessEnv),
    "https://x.test/api/auth/verify?token=abc");
  assert.equal(verifyUrl("abc", { PUBLIC_BASE_URL: "https://x.test/" } as NodeJS.ProcessEnv),
    "https://x.test/api/auth/verify?token=abc");
  assert.equal(verifyUrl("abc", {} as NodeJS.ProcessEnv), "/api/auth/verify?token=abc",
    "a relative link still works for a local dev loop");
});

test("a token with regex-special characters can't break the email match", () => {
  const msg = buildVerifyEmail("a@b.test", verifyUrl("a+b/c=d", {} as NodeJS.ProcessEnv));
  assert.match(msg.text, /token=a%2Bb%2Fc%3Dd/, "the token is url-encoded");
});

/* ---------------------------------------------------------------------------
 * The hard gate — off by default, because turning it on before email can
 * actually deliver would lock everyone out including the owner.
 * ------------------------------------------------------------------------ */

test("the sign-in gate is off unless explicitly switched on", () => {
  assert.equal(requireVerifiedEmail({} as NodeJS.ProcessEnv), false);
  assert.equal(requireVerifiedEmail({ REQUIRE_VERIFIED_EMAIL: "" } as NodeJS.ProcessEnv), false);
  assert.equal(requireVerifiedEmail({ REQUIRE_VERIFIED_EMAIL: "1" } as NodeJS.ProcessEnv), false,
    "only the exact string turns it on — a stray truthy value must not lock people out");
  assert.equal(requireVerifiedEmail({ REQUIRE_VERIFIED_EMAIL: "true" } as NodeJS.ProcessEnv), true);
});

test("with the gate off, an unverified account can still sign in", async () => {
  const db = await memoryDb();
  await signUp(db, "new@example.test", "correcthorse");
  const user = await signIn(db, "new@example.test", "correcthorse");
  assert.equal(user.emailVerified, false, "signed in, and honestly reported as unconfirmed");
  await db.close();
});

test("with the gate on, an unverified account is refused and a verified one is not", async () => {
  const db = await memoryDb();
  const user = await signUp(db, "new@example.test", "correcthorse");
  process.env.REQUIRE_VERIFIED_EMAIL = "true";
  try {
    await assert.rejects(() => signIn(db, "new@example.test", "correcthorse"),
      (e: AuthError) => e.reason === "unverified");
    await verifyEmailToken(db, await issueVerification(db, user.id));
    assert.equal((await signIn(db, "new@example.test", "correcthorse")).emailVerified, true);
  } finally {
    delete process.env.REQUIRE_VERIFIED_EMAIL;
  }
  await db.close();
});

test("with the gate on, a wrong password still fails as a wrong password", async () => {
  // The gate is checked AFTER the password, so an unverified account can't
  // be probed by someone who doesn't have its password.
  const db = await memoryDb();
  await signUp(db, "new@example.test", "correcthorse");
  process.env.REQUIRE_VERIFIED_EMAIL = "true";
  try {
    await assert.rejects(() => signIn(db, "new@example.test", "wrongpass"),
      (e: AuthError) => e.reason === "bad_credentials",
      "the unverified state must not leak to someone without the password");
  } finally {
    delete process.env.REQUIRE_VERIFIED_EMAIL;
  }
  await db.close();
});
