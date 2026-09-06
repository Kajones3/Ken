import type { EmailSender } from "./types.js";
import { ConsoleEmailSender } from "./console.js";
import { ResendEmailSender } from "./resend.js";

export function pickEmailSender(): EmailSender {
  return process.env.RESEND_API_KEY ? new ResendEmailSender() : new ConsoleEmailSender();
}
