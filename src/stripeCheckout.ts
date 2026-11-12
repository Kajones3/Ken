/**
 * Paying for Planner Pro with Stripe Checkout (owner, 2026-11-12: "go ahead
 * and build the checkout").
 *
 * One-time payments only (`mode=payment`): a pass is paid once and never
 * renews, so there is no Stripe subscription anywhere. The flow:
 *
 *   1. "Get Planner Pro" -> POST /api/pro/checkout {plan}. The SERVER works
 *      out the price (the pass, today's sale from /admin) and asks Stripe for
 *      a payment page. The page's own idea of the price is never used.
 *   2. Stripe's page takes the card. "No refunds" is shown above its Pay
 *      button (custom_text), and on our plans table before anyone gets there.
 *   3. Planner Pro is turned on by whichever arrives first, both safe to
 *      repeat: Stripe's webhook (POST /api/stripe/webhook, signed), or the
 *      traveler landing back on the site, where the page asks
 *      /api/pro/checkout/status and the server checks the session WITH
 *      STRIPE. Each paid session grants exactly once (`stripe_payments`).
 *
 * Off unless STRIPE_SECRET_KEY is set: without it the buttons keep sending the
 * owner the old "wants Planner Pro" email, so nothing breaks before the key
 * is in Render. Talks to Stripe's HTTP API with fetch (no SDK dependency).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { grantPro } from "./grantPro.js";
import type { PricedPass } from "./proSales.js";

export const STRIPE_API = "https://api.stripe.com/v1";
/** Shown on Stripe's page above the Pay button. Owner, 2026-10-29: no refunds. */
export const NO_REFUNDS_TEXT =
  "No refunds. This pass is paid once, starts today and never renews. It simply ends.";
/** How old a webhook's signature may be before it is refused (Stripe's own default). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function stripeKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.STRIPE_SECRET_KEY ?? "").trim();
  return k ? k : null;
}
/** "test" for sk_test_ keys, "live" for sk_live_, so the owner can see which is on. */
export function stripeMode(env: NodeJS.ProcessEnv = process.env): "test" | "live" | null {
  const k = stripeKey(env);
  return !k ? null : k.startsWith("sk_live_") ? "live" : "test";
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** The form fields for one Checkout Session. Pure, so it can be tested. */
export function checkoutFields(o: {
  pass: PricedPass; saleLabel: string | null; userId: string; email: string; baseUrl: string;
}): Record<string, string> {
  const cents = Math.round(o.pass.nowUsd * 100);
  return {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": `Planner Pro · ${o.pass.label}`,
    "line_items[0][price_data][product_data][description]":
      `${o.pass.days} days of Planner Pro on Pricing the Magic. Paid once, never renews.`
      + (o.saleLabel ? ` ${o.saleLabel} price.` : ""),
    customer_email: o.email,
    client_reference_id: o.userId,
    "metadata[user_id]": o.userId,
    "metadata[pass]": o.pass.id,
    "metadata[days]": String(o.pass.days),
    "metadata[price_cents]": String(cents),
    "payment_intent_data[metadata][user_id]": o.userId,
    "payment_intent_data[metadata][pass]": o.pass.id,
    "custom_text[submit][message]": NO_REFUNDS_TEXT,
    success_url: `${o.baseUrl}/?pro=thanks&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${o.baseUrl}/?pro=cancelled`,
  };
}

const form = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

export async function createCheckoutSession(key: string, fields: Record<string, string>, fetchFn: FetchLike = fetch as never):
  Promise<{ id: string; url: string }> {
  const res = await fetchFn(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(`Stripe answered ${res.status}: ${body?.error?.message ?? "no payment page"}`);
  return { id: body.id, url: body.url };
}

export async function retrieveSession(key: string, id: string, fetchFn: FetchLike = fetch as never): Promise<any> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error("not a Checkout Session id");
  const res = await fetchFn(`${STRIPE_API}/checkout/sessions/${id}`, { headers: { authorization: `Bearer ${key}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe answered ${res.status}: ${body?.error?.message ?? ""}`);
  return body;
}

/**
 * Checks a webhook's `Stripe-Signature` header (t=...,v1=...) against the raw
 * body and the endpoint's signing secret, the way Stripe documents it: an
 * HMAC-SHA256 of "<t>.<body>". A missing, wrong or stale signature = null.
 */
export function verifyWebhook(rawBody: string, header: string | undefined, secret: string, nowSeconds: number): any | null {
  if (!header || !secret) return null;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || !sigs.length) return null;
  if (Math.abs(nowSeconds - t) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const ok = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

export type GrantOutcome =
  | { status: "granted"; email: string; proUntil: string; pass: string }
  | { status: "already" }
  | { status: "unpaid" }
  | { status: "unknown_pass" | "no_user" };

/**
 * Turns on Planner Pro for one paid Checkout Session, once. Safe to call from
 * the webhook and from the traveler's return trip at the same time: the
 * session id is the key of `stripe_payments`, so only the first insert wins
 * and only it grants. Passes come from `days` stored on the session at
 * checkout, so a later change to a pass's length never changes what was sold.
 */
export async function grantPaidSession(db: Db, session: any): Promise<GrantOutcome> {
  if (!session || session.object !== "checkout.session") return { status: "unpaid" };
  if (session.payment_status !== "paid") return { status: "unpaid" };
  const userId = String(session.metadata?.user_id ?? session.client_reference_id ?? "");
  const pass = String(session.metadata?.pass ?? "");
  const days = Number(session.metadata?.days);
  if (!pass || !Number.isInteger(days) || days <= 0) return { status: "unknown_pass" };
  const ins = await db.query(
    `insert into stripe_payments (session_id, user_id, pass, days, amount_cents, currency, livemode)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (session_id) do nothing returning session_id`,
    [String(session.id), userId || null, pass, days, Number(session.amount_total) || 0,
      String(session.currency ?? "usd"), Boolean(session.livemode)],
  );
  if (!ins.rows.length) return { status: "already" };
  const u = await db.query<{ email: string }>(`select email from users where id = $1`, [userId]);
  if (!u.rows[0]) return { status: "no_user" };
  const g = await grantPro(db, u.rows[0].email, days, pass);
  await db.query(`update stripe_payments set granted_at = now() where session_id = $1`, [String(session.id)]);
  return { status: "granted", email: g.email, proUntil: g.proUntil, pass };
}
