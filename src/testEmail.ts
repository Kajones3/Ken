/**
 * Send one email and say exactly what happened.
 *
 *   npm run test-email -- you@example.com
 *
 * Why this exists: `email/resend.ts` was written to Resend's documented
 * shape and has never run against a live account, and every email job in
 * this project is built to fail quietly — a missing address is treated as
 * "nothing to send", so the workflow goes green and the mail never goes.
 * That combination means the obvious way to test a new API key (set the
 * secret, wait for tonight's cron, read a log) can report success while
 * nothing arrives.
 *
 * So this does the opposite of the rest of the project: it is loud, it is
 * immediate, and a failure is an error with the provider's own words in it.
 */
import { pickEmailSender } from "./email/pick.js";

const to = process.argv[2];
if (!to || !to.includes("@")) {
  console.error("usage: npm run test-email -- you@example.com");
  process.exit(2);
}

const sender = pickEmailSender();
const from = process.env.ALERT_FROM_EMAIL ?? "(unset — resend.ts falls back to alerts@parkfare.app)";

console.log(`sender:  ${sender.name}`);
console.log(`from:    ${from}`);
console.log(`to:      ${to}`);

if (sender.name === "console") {
  console.error(
    "\nRESEND_API_KEY is not set in this environment, so nothing was sent — the console\n"
    + "sender just prints. Set it and run this again.",
  );
  process.exit(1);
}

try {
  await sender.send({
    to,
    subject: "Parkfare: email is working",
    text: [
      "If you're reading this, Parkfare can send email.",
      "",
      "That turns on four things that were built and reaching nobody:",
      "  - price-drop and deal alerts for Plus users",
      "  - the nightly Disney news digest and your manual job list",
      "  - the daily real-pulls digest",
      "  - sign-up confirmation links",
      "",
      "Next: set PUBLIC_BASE_URL so confirmation links point at the real site,",
      "then REQUIRE_VERIFIED_EMAIL=true once you've confirmed a link arrives.",
      "",
      "— Parkfare",
    ].join("\n"),
  });
  console.log("\nSent. Check that inbox (and the spam folder) before trusting it.");
} catch (e) {
  const message = (e as Error).message;
  console.error(`\nFAILED: ${message}\n`);
  // Matched on Resend's own wording, never on a bare status code: a 403 from
  // a corporate proxy or an egress allowlist is not a Resend account limit,
  // and diagnosing it as one sends you to fix the wrong thing. (That is not
  // hypothetical — it is what this script did the first time it ran.)
  if (/not in allowlist|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) {
    console.error(
      "That is a NETWORK failure, not a Resend one — this machine could not reach\n"
      + "api.resend.com at all. Your key and from-address may be perfectly fine. Try from\n"
      + "somewhere with open outbound HTTPS, or run the \"Parkfare test email\" workflow,\n"
      + "which runs on GitHub's runners.",
    );
  } else if (/not verified|verify a domain/i.test(message)) {
    console.error(
      "Resend will not send FROM that address yet. Until you verify a sending domain the\n"
      + "only from-address that works is onboarding@resend.dev — set\n"
      + "ALERT_FROM_EMAIL=onboarding@resend.dev and try again.",
    );
  } else if (/testing emails|your own email address/i.test(message)) {
    console.error(
      "An unverified Resend account can only send TO the address you signed up with.\n"
      + "Send it there first; reaching anyone else needs a verified sending domain.",
    );
  } else if (/API key is invalid|unauthorized|missing api key/i.test(message)) {
    console.error("The API key was rejected — check it was copied whole, including the re_ prefix.");
  }
  process.exit(1);
}
