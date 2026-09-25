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
  // The only alert left is a Plus member's deal email (price-drop monitoring
  // was removed 2026-09-25). A row from before then can still be sitting in
  // the retry queue, so it gets the same honest, total-free wording.
  const subject = "Parkfare: a new Disney deal";
  const text = [
    a.detail,
    "",
    "Open Parkfare to see what it does to your trip — deals can be applied to any resort's total.",
    "",
    "You get these because you have Parkfare Plus.",
    "",
    "— Parkfare",
  ].join("\n");
  return { to, subject, text };
}
