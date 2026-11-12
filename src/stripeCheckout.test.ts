import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memoryDb } from "./db.js";
import { signUp } from "./auth.js";
import { passesWithSale, type Sale } from "./proSales.js";
import {
  checkoutFields, verifyWebhook, grantPaidSession, createCheckoutSession, stripeMode, NO_REFUNDS_TEXT,
} from "./stripeCheckout.js";

const sale: Sale = { id: "s", label: "Launch sale", pctOff: 25, startsOn: "2026-11-01", endsOn: "2026-12-26",
  active: true, createdAt: "2026-11-01T00:00:00Z", status: "live" };

test("checkout charges the server's price for the pass, sale included, with No refunds above Pay", () => {
  const three = passesWithSale(sale).find((p) => p.id === "threeMonths")!;
  const f = checkoutFields({ pass: three, saleLabel: sale.label, userId: "u1", email: "a@b.test", baseUrl: "https://x.test" });
  assert.equal(f.mode, "payment", "paid once, never a subscription");
  assert.equal(f["line_items[0][price_data][unit_amount]"], "1125", "$15 less 25% = $11.25, in cents");
  assert.equal(f["line_items[0][price_data][currency]"], "usd");
  assert.equal(f["metadata[pass]"], "threeMonths");
  assert.equal(f["metadata[days]"], "91");
  assert.equal(f["custom_text[submit][message]"], NO_REFUNDS_TEXT);
  assert.match(f.success_url!, /^https:\/\/x\.test\/\?pro=thanks&session_id=\{CHECKOUT_SESSION_ID\}$/);
  const full = checkoutFields({ pass: passesWithSale(null).find((p) => p.id === "week")!, saleLabel: null,
    userId: "u1", email: "a@b.test", baseUrl: "https://x.test" });
  assert.equal(full["line_items[0][price_data][unit_amount]"], "900", "no sale: the regular $9");
});

test("payments are off without a key, and say test vs live", () => {
  assert.equal(stripeMode({} as NodeJS.ProcessEnv), null);
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: "sk_test_abc" } as NodeJS.ProcessEnv), "test");
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: "sk_live_abc" } as NodeJS.ProcessEnv), "live");
});

test("a checkout session is created with the key and the form, and a refusal throws", async () => {
  let seen: { url: string; init: any } | null = null;
  const ok = await createCheckoutSession("sk_test_1", { mode: "payment" }, async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/x" }) };
  });
  assert.equal(ok.url, "https://checkout.stripe.com/x");
  assert.equal(seen!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen!.init.headers.authorization, "Bearer sk_test_1");
  assert.equal(seen!.init.body, "mode=payment");
  await assert.rejects(createCheckoutSession("sk_test_1", {}, async () =>
    ({ ok: false, status: 400, json: async () => ({ error: { message: "bad" } }) })), /400: bad/);
});

const sign = (body: string, secret: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

test("a webhook counts only with a fresh, correct signature", () => {
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
  const now = 1_800_000_000;
  assert.equal(verifyWebhook(body, sign(body, "whsec_a", now), "whsec_a", now)?.type, "checkout.session.completed");
  assert.equal(verifyWebhook(body, sign(body, "whsec_b", now), "whsec_a", now), null, "wrong secret");
  assert.equal(verifyWebhook(body + " ", sign(body, "whsec_a", now), "whsec_a", now), null, "body changed");
  assert.equal(verifyWebhook(body, sign(body, "whsec_a", now - 600), "whsec_a", now), null, "too old");
  assert.equal(verifyWebhook(body, undefined, "whsec_a", now), null, "no header");
  assert.equal(verifyWebhook(body, sign(body, "", now), "", now), null, "no secret set = never trusted");
});

test("a paid session turns on its pass exactly once; unpaid does nothing", async () => {
  const db = await memoryDb();
  const user = await signUp(db, "buyer@example.test", "correcthorse");
  const session = { object: "checkout.session", id: "cs_test_9", payment_status: "paid", amount_total: 1125,
    currency: "usd", livemode: false, client_reference_id: user.id,
    metadata: { user_id: user.id, pass: "threeMonths", days: "91" } };
  assert.equal((await grantPaidSession(db, { ...session, payment_status: "unpaid" })).status, "unpaid");
  const g = await grantPaidSession(db, session);
  assert.equal(g.status, "granted");
  const row = (await db.query<{ pro_pass: string; pro_until: unknown }>(`select pro_pass, pro_until from users where id = $1`, [user.id])).rows[0]!;
  assert.equal(row.pro_pass, "threeMonths");
  assert.ok(row.pro_until);
  assert.equal((await grantPaidSession(db, session)).status, "already", "the webhook and the return trip can both arrive");
  const pay = (await db.query<{ amount_cents: number; granted_at: unknown }>(`select amount_cents, granted_at from stripe_payments`)).rows;
  assert.equal(pay.length, 1);
  assert.equal(pay[0]!.amount_cents, 1125);
  assert.ok(pay[0]!.granted_at);
  await db.close();
});
