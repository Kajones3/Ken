import type { EmailMessage } from "./types.js";

/** Just what an alert email needs — decoupled from Candidate so a retried
 *  row read back from price_alerts can build the same message a fresh one would. */
export interface AlertContent {
  detail: string;
  oldTotal: number;
  newTotal: number;
  kind?: string;
}

export function buildAlertEmail(a: AlertContent, to: string): EmailMessage {
  const saved = Math.round(a.oldTotal - a.newTotal);
  const subject = a.kind === "new_promo"
    ? "Parkfare: we found a new Disney deal"
    : saved > 0
    ? `Parkfare: your trip just got $${saved.toLocaleString()} cheaper`
    : "Parkfare: a price on your trip moved";
  const text = [
    a.detail,
    "",
    `You were tracking $${Math.round(a.oldTotal).toLocaleString()}. It's now $${Math.round(a.newTotal).toLocaleString()}.`,
    "",
    "Open Parkfare to see the full breakdown and book.",
    "",
    "— Parkfare",
  ].join("\n");
  return { to, subject, text };
}
