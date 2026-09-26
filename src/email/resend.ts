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
    // No default from-address. There used to be one — alerts@parkfare.app —
    // and a default here is worse than no default: Resend refuses to send
    // from a domain you have not verified, so an unset variable would fail
    // at the provider with an error about a domain nobody recognizes,
    // instead of naming the setting that is actually missing.
    const from = process.env.ALERT_FROM_EMAIL;
    if (!from) {
      throw new Error(
        "ALERT_FROM_EMAIL is not set. Resend will only send from an address on a domain "
        + "you have verified — use onboarding@resend.dev until you have verified one.",
      );
    }
    // A display name and a real reply-to. Both are deliverability, not
    // decoration: a bare address with no name and nowhere to reply is a
    // shape spam filters have learned to distrust, and a reply that
    // disappears is worse than no reply at all.
    const fromHeader = from.includes("<") ? from : `Parkfare <${from}>`;
    const replyTo = process.env.OWNER_EMAIL || undefined;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: fromHeader, to: msg.to, subject: msg.subject, text: msg.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(msg.headers ? { headers: msg.headers } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`resend ${res.status}: ${await res.text()}`);
    }
    /* Log the id Resend hands back, and say plainly what a success here does
     * and does not mean.
     *
     * This exists because of a real dead end: the owner didn't receive a
     * nightly digest, the job's log said "sent", and there was nothing else
     * to go on — the response body was read for errors and thrown away on
     * success, so a run that Resend accepted and a run that reached an inbox
     * left identical evidence. They are not the same thing. A 2xx here means
     * Resend took the message, not that it was delivered; bounces, blocks and
     * spam placement all happen afterwards and are only visible in Resend's
     * own dashboard, which is searchable BY THIS ID.
     *
     * Same shape as the PUBLIC_BASE_URL trap: the program can only ever
     * observe its own half of the exchange, so the honest move is to record
     * the handle that lets a human check the other half. */
    const id = await res.json().then((b) => (b as { id?: string }).id).catch(() => undefined);
    console.log(
      `[email:resend] accepted to=${msg.to} id=${id ?? "(none returned)"} subject="${msg.subject}"`
      + ` — accepted by Resend, which is not proof of delivery; look this id up in the Resend dashboard`
      + ` to see whether it was delivered, bounced or marked spam.`,
    );
  }
}
