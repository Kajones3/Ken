import type { EmailMessage, EmailSender } from "./types.js";

/**
 * Prints the email instead of sending it. Works today with no account, same as
 * MockProvider for flights and hotels — so the alert job runs end to end
 * (including a "send") with nothing configured.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly name = "console";

  async send(msg: EmailMessage): Promise<void> {
    console.log(`[email:console] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
  }
}
