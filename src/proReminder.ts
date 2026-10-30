/**
 * "Your Plus ends soon" (owner, 2026-10-29: yes to a reminder before a pass
 * ends). Nothing renews, so this is a heads-up, not a bill: it says the date,
 * that nobody will be charged, what stays (saved searches, readable), and
 * where to pick a new pass. Sent once per pass: `users.pro_reminder_for`
 * holds the pro_until it was sent for, so a new pass gets its own reminder.
 * Only to confirmed addresses, like every email this app sends unprompted.
 */
import type { Db } from "./db.js";
import type { EmailMessage, EmailSender } from "./email/types.js";
import { PRO_PASSES, DISNEY_DISCLAIMER } from "./config.js";
import { dateStr } from "./book.js";
import { addDaysISO, todayISO, type ISODate } from "./dates.js";

const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const longDate = (d: ISODate) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

/** How many days ahead to remind: 3 for the longer passes, 1 for a week. */
export function reminderLeadDays(passId: string | null): number {
  const p = PRO_PASSES.find((x) => x.id === passId);
  return p && p.days < 30 ? 1 : 3;
}

export function buildProReminder(to: string, passId: string | null, proUntil: ISODate,
  env: NodeJS.ProcessEnv = process.env): EmailMessage {
  const p = PRO_PASSES.find((x) => x.id === passId);
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const what = p ? `Your ${p.label} Planner Pro pass` : "Your Pricing the Magic Planner Pro pass";
  return {
    to,
    subject: `Your Pricing the Magic Planner Pro pass ends on ${longDate(proUntil)}`,
    text: [
      `${what} ends on ${longDate(proUntil)}.`,
      "",
      "Nothing renews and you won't be charged. After it ends you can still sign in, compare all six resorts and read the searches you saved.",
      "",
      `To keep saving searches and planning with Planner Pro, pick a new pass at ${base || "pricingthemagic.com"}.`,
      "",
      "Pricing the Magic",
      "",
      DISNEY_DISCLAIMER,
    ].join("\n"),
  };
}

/** Sends every reminder due today; returns how many went out. A failed send
 *  is left unmarked, so tomorrow's run tries again while the pass lasts. */
export async function sendProReminders(db: Db, sender: EmailSender, today: ISODate = todayISO()):
  Promise<{ due: number; sent: number }> {
  const { rows } = await db.query(
    `select id, email, pro_pass, pro_until from users
      where email_verified_at is not null
        and pro_until >= $1 and pro_until <= $2
        and (pro_reminder_for is null or pro_reminder_for <> pro_until)`,
    [today, addDaysISO(today, 3)],
  );
  let due = 0, sent = 0;
  for (const r of rows) {
    const until = dateStr(r.pro_until);
    if (until > addDaysISO(today, reminderLeadDays(r.pro_pass ?? null))) continue;
    due++;
    try {
      await sender.send(buildProReminder(r.email, r.pro_pass ?? null, until));
      await db.query(`update users set pro_reminder_for = $2, plus_reminder_for = $2 where id = $1`, [r.id, until]);
      sent++;
    } catch (e) {
      console.error(`Planner Pro reminder failed for ${r.id} (${sender.name}):`, (e as Error).message);
    }
  }
  return { due, sent };
}
