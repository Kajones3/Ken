import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sitePassword, gateToken, passwordMatches, isUnlocked, gateOpenPath, gateCookieHeader,
  safeNext, comingSoonHtml, gateLocked, recordGateFailure, clearGateFailures, MAX_TRIES, GATE_COOKIE,
} from "./siteGate.js";

test("no SITE_PASSWORD means no gate", () => {
  assert.equal(sitePassword({}), null);
  assert.equal(sitePassword({ SITE_PASSWORD: "   " }), null);
  assert.equal(sitePassword({ SITE_PASSWORD: " magic " }), "magic");
});

test("the cookie holds a hash, never the password", () => {
  const h = gateCookieHeader("magic-kingdom", true);
  assert.ok(!h.includes("magic-kingdom"));
  assert.ok(h.includes("HttpOnly") && h.includes("Secure") && h.includes("SameSite=Lax"));
  assert.ok(!gateCookieHeader("x", false).includes("Secure"));
});

test("only the right cookie unlocks, and a new password locks old cookies out", () => {
  const cookie = `other=1; ${GATE_COOKIE}=${gateToken("magic-kingdom")}; pf_session=abc`;
  assert.equal(isUnlocked(cookie, "magic-kingdom"), true);
  assert.equal(isUnlocked(cookie, "new-password"), false);
  assert.equal(isUnlocked(`${GATE_COOKIE}=nope`, "magic-kingdom"), false);
  assert.equal(isUnlocked(undefined, "magic-kingdom"), false);
});

test("the typed password is checked exactly, ignoring stray spaces", () => {
  assert.equal(passwordMatches(" magic-kingdom ", "magic-kingdom"), true);
  assert.equal(passwordMatches("Magic-Kingdom", "magic-kingdom"), false);
  assert.equal(passwordMatches("", "magic-kingdom"), false);
});

test("only unsubscribe, health, robots and the unlock form stay open", () => {
  for (const p of ["/unsubscribe", "/health", "/robots.txt", "/site-unlock"]) assert.equal(gateOpenPath(p), true, p);
  for (const p of ["/", "/admin", "/api/compare", "/api/meta", "/public/screenshot-reader.js", "/api/auth/verify"]) {
    assert.equal(gateOpenPath(p), false, p);
  }
});

test("after unlocking, a visitor goes back where they were — never off-site", () => {
  assert.equal(safeNext("/api/auth/reset?t=abc"), "/api/auth/reset?t=abc");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/\\evil.example"), "/");
  assert.equal(safeNext("/site-unlock"), "/");
  assert.equal(safeNext(undefined), "/");
});

test("ten wrong guesses from one connection lock it out; a right one clears the count", () => {
  const ip = "203.0.113.9", t0 = 1_000_000;
  for (let i = 0; i < MAX_TRIES; i++) recordGateFailure(ip, t0);
  assert.equal(gateLocked(ip, t0), true);
  assert.equal(gateLocked(ip, t0 + 16 * 60 * 1000), false, "the lock lasts 15 minutes");
  clearGateFailures(ip);
  assert.equal(gateLocked(ip, t0), false);
});

test("the coming-soon page says nothing about what the product is, and escapes what it echoes", () => {
  const html = comingSoonHtml({ next: '/x"><script>', error: "That isn't the password." });
  assert.ok(!/disney/i.test(html));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("noindex"));
  assert.ok(html.includes("That isn&#39;t the password."));
});
