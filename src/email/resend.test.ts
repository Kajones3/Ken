import { test } from "node:test";
import assert from "node:assert/strict";
import { ResendEmailSender } from "./resend.js";

/**
 * These pin the difference between "Resend accepted it" and "it arrived",
 * which is the distinction a missing nightly digest turned out to hinge on.
 * A send that the provider rejects MUST throw, because the callers all treat
 * a resolved promise as "sent" and stamp it into fetch_runs and price_alerts.
 */
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = real; });
}
function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  // Deleting, not assigning. Object.assign puts the STRING "undefined" into
  // process.env, which is truthy — so "unset this variable" would silently
  // set it instead, and a test for the unset case would test nothing.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}
const msg = { to: "you@example.com", subject: "hi", text: "body" };

test("a rejected send throws, so a caller can never record it as sent", async () => {
  await withEnv({ ALERT_FROM_EMAIL: "alerts@example.com", RESEND_API_KEY: "k" }, () =>
    withFetch(
      (async () => new Response("domain not verified", { status: 403 })) as typeof fetch,
      async () => {
        await assert.rejects(() => new ResendEmailSender().send(msg), /resend 403/);
      },
    ));
});

test("an accepted send resolves and surfaces the id a human can trace", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    await withEnv({ ALERT_FROM_EMAIL: "alerts@example.com", RESEND_API_KEY: "k" }, () =>
      withFetch(
        (async () => Response.json({ id: "abc-123" })) as typeof fetch,
        () => new ResendEmailSender().send(msg),
      ));
  } finally { console.log = log; }
  const line = lines.find((l) => l.includes("[email:resend]")) ?? "";
  assert.match(line, /id=abc-123/, "the id is what makes a delivery traceable at all");
  assert.match(line, /to=you@example\.com/);
  assert.match(line, /not proof of delivery/, "a 2xx must not be reported as arrival");
});

test("a missing from-address names the setting rather than failing at the provider", async () => {
  await withEnv({ ALERT_FROM_EMAIL: undefined, RESEND_API_KEY: "k" }, () =>
    // fetch stubbed to throw: reaching the network at all would mean the
    // guard didn't fire, and the test should fail on that rather than on
    // whatever the network happens to say.
    withFetch((() => { throw new Error("must not call the provider"); }) as unknown as typeof fetch,
      async () => {
        await assert.rejects(() => new ResendEmailSender().send(msg), /ALERT_FROM_EMAIL/);
      }));
});

test("an accepted send with no id in the body still resolves", async () => {
  // Never fail a send over a response shape. The mail is already gone.
  await withEnv({ ALERT_FROM_EMAIL: "alerts@example.com", RESEND_API_KEY: "k" }, () =>
    withFetch(
      (async () => new Response("not json", { status: 200 })) as typeof fetch,
      () => new ResendEmailSender().send(msg),
    ));
});
