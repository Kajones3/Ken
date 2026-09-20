import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, type Db } from "./db.js";
import { signUp, signIn, createSession, AuthError } from "./auth.js";
import {
  requestReset, lookupReset, consumeReset, issueReset, buildResetEmail, resetUrl, RESET_TOKEN_HOURS,
} from "./passwordReset.js";
import {
  scopesFor, checkSigninAllowed, recordSigninFailure, clearSigninFailures, clientIp,
  MAX_FAILS, MAX_FAILS_IP, lockoutMessage,
} from "./signinThrottle.js";
import type { EmailMessage, EmailSender } from "./email/types.js";

/** Captures what would have been sent, so a test can read the link. */
function capture(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { name: "capture", sent, async send(msg) { sent.push(msg); } };
}
const tokenFrom = (msg: EmailMessage) => msg.text.match(/token=([a-f0-9]+)/)![1]!;

async function withUser(db: Db, email = "friend@example.com", password = "correct-horse") {
  const user = await signUp(db, email, password);
  return { user, password };
}

/* ------------------------------ the throttle --------------------------- */

test("five wrong answers shut the door, and a right one reopens it", async () => {
  const db = await memoryDb();
  const scopes = scopesFor("someone@example.com", "1.2.3.4");

  for (let i = 0; i < MAX_FAILS - 1; i++) {
    await recordSigninFailure(db, scopes);
    assert.equal((await checkSigninAllowed(db, scopes)).allowed, true, `still open after ${i + 1}`);
  }
  await recordSigninFailure(db, scopes);
  const locked = await checkSigninAllowed(db, scopes);
  assert.equal(locked.allowed, false, `locked on attempt ${MAX_FAILS}`);
  if (locked.allowed === false) {
    assert.ok(locked.retryAfterSeconds > 0);
    assert.match(lockoutMessage(locked.retryAfterSeconds), /Forgot your password/,
      "the message has to name the way back in that doesn't involve waiting");
  }

  await clearSigninFailures(db, scopes);
  assert.equal((await checkSigninAllowed(db, scopes)).allowed, true);
});

test("an address with no account locks exactly like one that has an account", async () => {
  // The property that matters: if only real accounts could be locked, the
  // lockout itself would tell an attacker which addresses are registered.
  const db = await memoryDb();
  await withUser(db, "real@example.com");

  const real = scopesFor("real@example.com", null);
  const fake = scopesFor("nobody@example.com", null);
  for (let i = 0; i < MAX_FAILS; i++) {
    await recordSigninFailure(db, real);
    await recordSigninFailure(db, fake);
  }
  const a = await checkSigninAllowed(db, real);
  const b = await checkSigninAllowed(db, fake);
  assert.equal(a.allowed, false);
  assert.equal(b.allowed, false, "an unknown address must be indistinguishable");
});

test("the IP scope catches someone cycling through addresses", async () => {
  const db = await memoryDb();
  // A different email every time, so the email scope never trips — only the
  // shared IP does. Without this scope an attacker just moves down a list.
  //
  // It takes MAX_FAILS_IP rather than MAX_FAILS, deliberately: a home, an
  // office and a coffee shop all share one address, so five typos from one
  // person must not lock out everyone else behind that connection.
  for (let i = 0; i < MAX_FAILS_IP; i++) {
    await recordSigninFailure(db, scopesFor(`victim${i}@example.com`, "9.9.9.9"));
  }
  const fresh = await checkSigninAllowed(db, scopesFor("someone-else@example.com", "9.9.9.9"));
  assert.equal(fresh.allowed, false, "the machine is locked even though no single account was");
  const elsewhere = await checkSigninAllowed(db, scopesFor("someone-else@example.com", "8.8.8.8"));
  assert.equal(elsewhere.allowed, true, "and a different machine is unaffected");
});

test("clientIp takes the first x-forwarded-for entry, not the last", async () => {
  // Later entries are appended by intermediaries and a client can prepend
  // whatever it likes; trusting the last would let an attacker rotate scope.
  assert.equal(clientIp({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }), "203.0.113.9");
  assert.equal(clientIp({ "x-forwarded-for": ["198.51.100.7"] }), "198.51.100.7");
  assert.equal(clientIp({}, "127.0.0.1"), "127.0.0.1", "falls back to the socket");
  assert.equal(clientIp({}), null, "and an absent IP is not counted at all");
  assert.deepEqual(scopesFor("a@b.com", null), ["email|a@b.com"], "rather than bucketed as unknown");
});

/* --------------------------- the reset flow ---------------------------- */

test("asking for a reset says nothing about whether the address exists", async () => {
  const db = await memoryDb();
  await withUser(db, "real@example.com");
  const sender = capture();

  const real = await requestReset(db, "real@example.com", sender);
  const fake = await requestReset(db, "nobody@example.com", sender);
  assert.equal(real, true);
  assert.equal(fake, false);
  assert.equal(sender.sent.length, 1, "only the real one gets mail");
  // The route's job is to answer identically; this returns a boolean purely so
  // it can be logged. Pinned here so nobody starts surfacing it to the client.
  assert.equal(typeof real, "boolean");
});

test("the link sets a new password, and the old one stops working", async () => {
  const db = await memoryDb();
  const { user } = await withUser(db, "friend@example.com", "old-password-1");
  const sender = capture();
  await requestReset(db, "friend@example.com", sender);

  const token = tokenFrom(sender.sent[0]!);
  const r = await consumeReset(db, token, "brand-new-password");
  assert.equal(r.ok, true);

  await assert.rejects(() => signIn(db, "friend@example.com", "old-password-1"), AuthError,
    "the old password is gone");
  const back = await signIn(db, "friend@example.com", "brand-new-password");
  assert.equal(back.id, user.id, "and it is still the same account");
});

test("a reset signs out every device", async () => {
  const db = await memoryDb();
  const { user } = await withUser(db);
  const phone = await createSession(db, user.id);
  const laptop = await createSession(db, user.id);
  const stillValid = async (token: string) => (await db.query(
    `select 1 from sessions where token = $1 and expires_at > now()`, [token])).rows.length > 0;
  assert.ok(await stillValid(phone), "signed in before");

  const sender = capture();
  await requestReset(db, "friend@example.com", sender);
  const r = await consumeReset(db, tokenFrom(sender.sent[0]!), "a-new-password-entirely");
  assert.ok(r.ok && r.sessionsEnded >= 2, "both sessions ended");

  assert.equal(await stillValid(phone), false, "the phone is signed out");
  assert.equal(await stillValid(laptop), false, "and so is the laptop");
});

test("a reset link works only once", async () => {
  const db = await memoryDb();
  await withUser(db);
  const sender = capture();
  await requestReset(db, "friend@example.com", sender);
  const token = tokenFrom(sender.sent[0]!);

  assert.equal((await consumeReset(db, token, "first-new-password")).ok, true);
  const again = await consumeReset(db, token, "second-new-password");
  assert.equal(again.ok, false, "a replayed link must not set the password a second time");
  const signedIn = await signIn(db, "friend@example.com", "first-new-password");
  assert.ok(signedIn, "and the first reset still stands");
});

test("asking again cancels the previous link", async () => {
  const db = await memoryDb();
  await withUser(db);
  const sender = capture();
  await requestReset(db, "friend@example.com", sender);
  const first = tokenFrom(sender.sent[0]!);
  await requestReset(db, "friend@example.com", sender);
  const second = tokenFrom(sender.sent[1]!);

  assert.notEqual(first, second);
  assert.equal((await lookupReset(db, first)).ok, false,
    "a link that reached the wrong inbox stops working when the right person asks again");
  assert.equal((await lookupReset(db, second)).ok, true);
});

test("an expired link is refused, and says so distinctly from an invalid one", async () => {
  const db = await memoryDb();
  const { user } = await withUser(db);
  const token = await issueReset(db, user.id);
  await db.query(`update password_resets set expires_at = now() - interval '1 minute' where user_id = $1`, [user.id]);

  const look = await lookupReset(db, token);
  assert.equal(look.ok, false);
  assert.equal(look.ok === false && look.reason, "expired", "so the page can offer a fresh link");
  const bogus = await lookupReset(db, "not-a-real-token");
  assert.equal(bogus.ok, false);
  assert.equal(bogus.ok === false ? bogus.reason : "", "unknown");
  assert.equal((await consumeReset(db, token, "whatever-password")).ok, false);
});

test("a weak new password is refused without consuming the link", async () => {
  const db = await memoryDb();
  await withUser(db);
  const sender = capture();
  await requestReset(db, "friend@example.com", sender);
  const token = tokenFrom(sender.sent[0]!);

  const weak = await consumeReset(db, token, "short");
  assert.equal(weak.ok, false);
  assert.equal(weak.ok === false && weak.reason, "weak_password");
  assert.equal((await lookupReset(db, token)).ok, true,
    "the link survives, or one typo would force the whole flow to start again");
});

test("a reset confirms the email and clears any sign-in lockout", async () => {
  const db = await memoryDb();
  const { user } = await withUser(db, "locked@example.com");
  const scopes = scopesFor("locked@example.com", null);
  for (let i = 0; i < MAX_FAILS; i++) await recordSigninFailure(db, scopes);
  assert.equal((await checkSigninAllowed(db, scopes)).allowed, false, "locked out first");

  const sender = capture();
  await requestReset(db, "locked@example.com", sender);
  assert.equal((await consumeReset(db, tokenFrom(sender.sent[0]!), "recovered-password")).ok, true);

  assert.equal((await checkSigninAllowed(db, scopes)).allowed, true,
    "the throttle must be a brake, not a trap, for someone who just proved they own the account");
  const { rows } = await db.query<{ email_verified_at: unknown }>(
    `select email_verified_at from users where id = $1`, [user.id]);
  assert.ok(rows[0]!.email_verified_at, "clicking a link proves control of the inbox");
});

test("the email spells out what a reset does, including the sign-out", async () => {
  const msg = buildResetEmail("friend@example.com", resetUrl("abc123", { PUBLIC_BASE_URL: "https://example.com" } as never));
  assert.match(msg.text, /https:\/\/example\.com\/api\/auth\/reset\?token=abc123/);
  assert.match(msg.text, new RegExp(`${RESET_TOKEN_HOURS} hours`));
  assert.match(msg.text, /signs out every device/, "because it does, and that surprises people");
  assert.match(msg.text, /wasn't you/, "an unexpected reset email must not read as an accusation");
});

test("one person's typos do not lock out everyone sharing their connection", async () => {
  // The failure this prevents, found by testing against a live server rather
  // than by reasoning: with one shared limit, five wrong passwords from a
  // household locked every other person behind that address out too.
  const db = await memoryDb();
  const clumsy = scopesFor("clumsy@example.com", "192.0.2.50");
  for (let i = 0; i < MAX_FAILS; i++) await recordSigninFailure(db, clumsy);

  assert.equal((await checkSigninAllowed(db, clumsy)).allowed, false, "that account is locked");
  const housemate = scopesFor("housemate@example.com", "192.0.2.50");
  assert.equal((await checkSigninAllowed(db, housemate)).allowed, true,
    "but the rest of the house can still sign in");
});
