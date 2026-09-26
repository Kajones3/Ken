import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlertEmail } from "./message.js";

test("a deal email carries the deal and says why it was sent", () => {
  const msg = buildAlertEmail(
    { detail: "Walt Disney World: Summer room discount (20% off the room rate)", oldTotal: 0, newTotal: 0, kind: "new_promo" },
    "you@example.com", "https://pricingthemagic.com/unsubscribe?t=abc123",
  );
  assert.equal(msg.to, "you@example.com");
  assert.match(msg.subject, /new Disney deal/);
  assert.match(msg.text, /Summer room discount/);
  assert.match(msg.text, /Parkfare Plus/);
});

test("every deal email says how to stop them, and carries the one-click header", () => {
  const link = "https://pricingthemagic.com/unsubscribe?t=abc123";
  const msg = buildAlertEmail({ detail: "a deal", oldTotal: 0, newTotal: 0 }, "you@example.com", link);
  assert.match(msg.text, /Stop these emails: https:\/\/pricingthemagic\.com\/unsubscribe\?t=abc123/);
  assert.equal(msg.headers?.["List-Unsubscribe"], `<${link}>`);
  assert.equal(msg.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("a relative link (no PUBLIC_BASE_URL) stays in the body but not the header", () => {
  const msg = buildAlertEmail({ detail: "a deal", oldTotal: 0, newTotal: 0 }, "you@example.com", "/unsubscribe?t=abc");
  assert.match(msg.text, /\/unsubscribe\?t=abc/);
  assert.equal(msg.headers, undefined, "mail clients need an absolute https link for one-click");
});

test("no alert email promises price monitoring any more — that feature was removed", () => {
  const msg = buildAlertEmail({ detail: "old queued row", oldTotal: 6076, newTotal: 5577 }, "you@example.com", "/unsubscribe?t=x");
  assert.doesNotMatch(msg.subject + msg.text, /cheaper|tracking|watching/);
});
