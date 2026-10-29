/**
 * "Your Plus ends soon" (owner, 2026-10-29: yes to a reminder before a pass
 * ends). Nothing renews, so this is a heads-up, not a bill: it says the date,
 * that nobody will be charged, what stays (saved searches, readable), and
 * where to pick a new pass. Sent once per pass: `users.plus_reminder_for`
 * holds the plus_until it was sent for, so a new pass gets its own reminder.
 * Only to confirmed addresses, like every email this app sends unprompted.
 */
import type { Db } from "./db.js";
import type { EmailMessage, EmailSender } from "./email/types.js";
import { PLUS_PASSES } from "./config.js";
import { dateStr } from "./book.js";
import { addDaysISO, todayISO, type ISODate } from "./dates.js";

const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const longDate = (d: ISODate) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

/** How many days ahead to remind: 3 for the longer passes, 1 for a week. */
export function reminderLeadDays(passId: string | null): number {
  const p = PLUS_PASSES.find((x) => x.id === passId);
  return p && p.days < 30 ? 1 : 3;
}

export function buildPlusReminder(to: string, passId: string | null, plusUntil: ISODate,
  env: NodeJS.ProcessEnv = process.env): EmailMessage {
  const p = PLUS_PASSES.find((x) => x.id === passId);
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const what = p ? `Your ${p.label} Plus pass` : "Your Pricing the Magic Plus";
  return {
    to,
    subject: `Your Pricing the Magic Plus ends on ${longDate(plusUntil)}`,
    text: [
      `${what} ends on ${longDate(plusUntil)}.`,
      "",
      "Nothing renews and you won't be charged. After it ends you can still sign in, compare all six resorts and read the searches you saved.",
      "",
      `To keep saving searches and planning with Plus, pick a new pass at ${base || "pricingthemagic.com"}.`,
      "",
      "Pricing the Magic",
    ].join("\n"),
  };
}

/** Sends every reminder due today; returns how many went out. A failed send
 *  is left unmarked, so tomorrow's run tries again while the pass lasts. */
export async function sendPlusReminders(db: Db, sender: EmailSender, today: ISODate = todayISO()):
  Promise<{ due: number; sent: number }> {
  const { rows } = await db.query(
    `select id, email, plus_pass, plus_until from users
      where email_verified_at is not null
        and plus_until >= $1 and plus_until <= $2
        and (plus_reminder_for is null or plus_reminder_for <> plus_until)`,
    [today, addDaysISO(today, 3)],
  );
  let due = 0, sent = 0;
  for (const r of rows) {
    const until = dateStr(r.plus_until);
    if (until > addDaysISO(today, reminderLeadDays(r.plus_pass ?? null))) continue;
    due++;
    try {
      await sender.send(buildPlusReminder(r.email, r.plus_pass ?? null, until));
      await db.query(`update users set plus_reminder_for = $2 where id = $1`, [r.id, until]);
      sent++;
    } catch (e) {
      console.error(`plus reminder failed for ${r.id} (${sender.name}):`, (e as Error).message);
    }
  }
  return { due, sent };
}
