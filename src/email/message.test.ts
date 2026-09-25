import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlertEmail } from "./message.js";

test("a deal email carries the deal and says why it was sent", () => {
  const msg = buildAlertEmail(
    { detail: "Walt Disney World: Summer room discount (20% off the room rate)", oldTotal: 0, newTotal: 0, kind: "new_promo" },
    "you@example.com",
  );
  assert.equal(msg.to, "you@example.com");
  assert.match(msg.subject, /new Disney deal/);
  assert.match(msg.text, /Summer room discount/);
  assert.match(msg.text, /Parkfare Plus/);
});

test("no alert email promises price monitoring any more — that feature was removed", () => {
  const msg = buildAlertEmail({ detail: "old queued row", oldTotal: 6076, newTotal: 5577 }, "you@example.com");
  assert.doesNotMatch(msg.subject + msg.text, /cheaper|tracking|watching/);
});
