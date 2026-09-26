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
  // was removed 2026-09-25). A row from before then can still be sitting in
  // the retry queue, so it gets the same honest, total-free wording.
  const subject = "Parkfare: a new Disney deal";
  const text = [
    a.detail,
    "",
    "Open Parkfare to see what it does to your trip — deals can be applied to any resort's total.",
    "",
    "— Parkfare",
    "",
    "You get these because you have Parkfare Plus.",
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
