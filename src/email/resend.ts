import type { EmailMessage, EmailSender } from "./types.js";

/**
 * Resend: free to 3,000 emails/month (100/day cap), one verified sending
 * domain, plain REST API — no SDK needed for something this small. Picked
 * for the same reason as Travelpayouts: free, no account minimums, fits a
 * solo developer. Not verified against a live account in this session —
 * confirm the request shape against current docs before relying on it.
 */
export class ResendEmailSender implements EmailSender {
  readonly name = "resend";

  async send(msg: EmailMessage): Promise<void> {
    const from = process.env.ALERT_FROM_EMAIL ?? "alerts@parkfare.app";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: msg.to, subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      throw new Error(`resend ${res.status}: ${await res.text()}`);
    }
  }
}
