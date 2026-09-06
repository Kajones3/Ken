import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlertEmail } from "./message.js";

test("a price drop email names the resort, the amount saved, and both totals", () => {
  const msg = buildAlertEmail(
    { detail: "Walt Disney World fell to $5,577 for arrival 2027-03-01", oldTotal: 6076, newTotal: 5577 },
    "you@example.com",
  );
  assert.equal(msg.to, "you@example.com");
  assert.match(msg.subject, /\$499 cheaper/);
  assert.match(msg.text, /Walt Disney World fell to \$5,577/);
  assert.match(msg.text, /tracking \$6,076/);
  assert.match(msg.text, /now \$5,577/);
});

test("a non-drop still produces a sendable email instead of a nonsense subject", () => {
  const msg = buildAlertEmail({ detail: "your number was crossed", oldTotal: 100, newTotal: 100 }, "you@example.com");
  assert.doesNotMatch(msg.subject, /\$0/);
  assert.doesNotMatch(msg.subject, /-\$/);
});
