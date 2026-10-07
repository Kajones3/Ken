import type { EmailMessage } from "./types.js";

/** Just what an alert email needs — decoupled from Candidate so a retried
 *  row read back from price_alerts can build the same message a fresh one would. */
export interface AlertContent {
  detail: string;
  oldTotal: number;
  newTotal: number;
  kind?: string;
}

/** `unsubscribeLink` is required on purpose: a deal email with no way out
 *  is exactly what CAN-SPAM forbids, so the type won't let one be built. */
export function buildAlertEmail(a: AlertContent, to: string, unsubscribeLink: string): EmailMessage {
  // The only alert left is a Plus member's deal email (price-drop monitoring
  // was removed 2026-09-25). When the job could measure what the deal is
  // worth on a real trip, the subject says so in the owner's words
  // (2026-10-03): "A Deal May Save You $X on your Disney Trip". A row it
  // couldn't measure (or one from before then, in the retry queue) keeps the
  // plain wording rather than inventing a figure.
  const saving = Math.round(a.oldTotal - a.newTotal);
  const subject = saving > 0
    ? `A Deal May Save You $${saving.toLocaleString("en-US")} on your Disney Trip`
    : "Pricing the Magic: a new Disney deal";
  const text = [
    ...(saving > 0 ? [subject + ".", ""] : []),
    a.detail,
    "",
    "Open Pricing the Magic: any search whose arrival date falls in the deal's dates already has it taken off, marked \"Includes a deal\".",
    "",
    "— Pricing the Magic",
    "",
    "You get these because you have Pricing the Magic Plus.",
    `Stop these emails: ${unsubscribeLink}`,
  ].join("\n");
  // RFC 8058 one-click: Gmail and Yahoo show their own "Unsubscribe" button
  // for mail carrying both headers, and POST to the link when it's pressed.
  // Only an absolute https link qualifies — a relative one (PUBLIC_BASE_URL
  // unset, i.e. local dev) is left in the body and out of the header.
  const headers = /^https:\/\//.test(unsubscribeLink)
    ? { "List-Unsubscribe": `<${unsubscribeLink}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return { to, subject, text, ...(headers ? { headers } : {}) };
}
