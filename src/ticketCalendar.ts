/**
 * Disney's own ticket calendars (owner, 2026-10-21: "Each time I pull ticket
 * prices from Disney World to compare, we are WAY off", then "build a screen
 * reader for the calendars so I can do it on the website").
 *
 * Disney's ticket page shows, for an N-day ticket, a month calendar with the
 * PER-DAY price of a ticket starting on each date ("$153+"). The owner drops a
 * screenshot of that calendar into /admin -> Ticket calendars; the reader in
 * public/screenshot-reader.js (`readTicketCalendar`) turns it into one price
 * per date, the owner checks every box, and this module stores it.
 *
 * Kept append-only in `ticket_calendar` (governing priority: keep everything
 * we were shown, with its source). The nightly ticket rows read the newest
 * price per date from here (`seedTickets` in jobs/refresh.ts), so a date with
 * a calendar price is priced from Disney's own number and every other date
 * still from the curve.
 *
 * Each ticket LENGTH is kept on its own (owner, 2026-10-21: "prices change
 * drastically based on how many days you select"). Disney's 2-day and 4-day
 * calendars for the same month are different prices, not one price shown
 * twice, so a 4-day import never replaces a 2-day one. A trip uses the
 * calendar for its own length when one is held, and otherwise the nearest
 * length held, carried by Disney's published length discounts
 * (`calendarPerDay` in pricing.ts).
 */
import type { Db } from "./db.js";
import { RESORT_BY_ID, SUGGESTED_PARK_DAYS, type Resort } from "./config.js";
import { ticketMultiDay, nearestLength, type CalendarByLength } from "./pricing.js";

/** The resorts whose ticket calendars are in US dollars and read today. */
export const CALENDAR_RESORTS = ["wdw", "dlr"] as const;

export interface CalendarPrice { date: string; perDay: number }
export interface CalendarImport {
  resortId: string; ticketDays: number; month: string; prices: CalendarPrice[];
}

/** Below and above this, a "per day" price is a misread digit, not a price. */
export const PER_DAY_MIN = 20;
export const PER_DAY_MAX = 1000;
/** Fewer than this many dates read is a crop, not a month. */
export const CALENDAR_MIN_DATES = 7;

export function validateCalendar(body: unknown, today: string):
  { ok: true; value: CalendarImport } | { ok: false; reason: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const resortId = String(b.resortId ?? "");
  if (!(CALENDAR_RESORTS as readonly string[]).includes(resortId)) {
    return { ok: false, reason: "Ticket calendars can be read for Walt Disney World and Disneyland." };
  }
  const ticketDays = Math.round(Number(b.ticketDays));
  if (!(ticketDays >= 1 && ticketDays <= 10)) return { ok: false, reason: "How many days is the ticket? (1 to 10)" };
  const month = String(b.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, reason: "Which month is the calendar?" };
  if (month < today.slice(0, 7)) return { ok: false, reason: "That month has already gone." };
  const list = Array.isArray(b.prices) ? b.prices : [];
  const seen = new Set<string>();
  const prices: CalendarPrice[] = [];
  for (const p of list) {
    const date = String((p as Record<string, unknown>)?.date ?? "");
    const perDay = Number((p as Record<string, unknown>)?.perDay);
    if (!date.startsWith(month + "-") || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, reason: `${date || "A date"} isn't in ${month}.` };
    }
    if (!Number.isFinite(perDay) || perDay < PER_DAY_MIN || perDay > PER_DAY_MAX) {
      return { ok: false, reason: `${date}: $${p && (p as Record<string, unknown>).perDay} a day doesn't look like a ticket price. Fix or clear that box.` };
    }
    if (seen.has(date)) return { ok: false, reason: `${date} is there twice.` };
    seen.add(date);
    prices.push({ date, perDay: Math.round(perDay * 100) / 100 });
  }
  if (prices.length < CALENDAR_MIN_DATES) {
    return { ok: false, reason: `Only ${prices.length} date${prices.length === 1 ? "" : "s"} read. A whole month's calendar is what's needed.` };
  }
  prices.sort((a, b2) => a.date < b2.date ? -1 : 1);
  return { ok: true, value: { resortId, ticketDays, month, prices } };
}

/** Keeps every price as shown. Never updates or deletes. */
export async function saveCalendar(db: Db, v: CalendarImport, by: string): Promise<number> {
  const vals: unknown[] = [];
  const tuples = v.prices.map((p, i) => {
    vals.push(v.resortId, v.ticketDays, p.date, p.perDay, by);
    const b = i * 5;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},'owner_screenshot',$${b + 5})`;
  });
  await db.query(
    `insert into ticket_calendar (resort_id, ticket_days, park_date, per_day_usd, source, entered_by)
     values ${tuples.join(",")}`, vals);
  return v.prices.length;
}

/**
 * The newest calendar price per resort, date AND ticket length.
 * Key: `${resortId}|${date}`.
 */
export async function latestCalendar(db: Db, from: string, to: string): Promise<Map<string, CalendarByLength>> {
  const out = new Map<string, CalendarByLength>();
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await db.query(
      `select distinct on (resort_id, park_date, ticket_days) resort_id, park_date, ticket_days, per_day_usd
         from ticket_calendar
        where park_date between $1 and $2
        order by resort_id, park_date, ticket_days, observed_at desc, id desc`, [from, to])).rows as Array<Record<string, unknown>>;
  } catch { return out; }   // no table yet: the curve prices everything, as before
  for (const r of rows) {
    const resort = RESORT_BY_ID.get(String(r.resort_id));
    if (!resort) continue;
    const date = r.park_date instanceof Date ? r.park_date.toISOString().slice(0, 10) : String(r.park_date).slice(0, 10);
    const key = `${resort.id}|${date}`;
    const byLength = out.get(key) ?? {};
    byLength[Number(r.ticket_days)] = Number(r.per_day_usd);
    out.set(key, byLength);
  }
  return out;
}

/**
 * The one-day figure the nightly ticket row holds for a calendar date (what
 * readers other than the trip price see): from the resort's suggested ticket
 * length if that calendar is held, else the nearest length held.
 */
export function calendarOneDay(resort: Resort, byLength: CalendarByLength): number | null {
  const days = nearestLength(byLength, SUGGESTED_PARK_DAYS[resort.id]?.days ?? 4);
  return days === null ? null : oneDayFigure(resort, byLength[days]!, days);
}

/**
 * The one-day figure that, priced as an N-day ticket, gives back N x the
 * calendar's per-day price: per-day / the resort's N-day shape factor.
 */
export function oneDayFigure(resort: Resort, perDay: number, ticketDays: number): number {
  const f = ticketMultiDay(resort, ticketDays);
  return Math.round((perDay / (f > 0 ? f : 1)) * 100) / 100;
}

/** What /admin lists: each resort's months and ticket lengths, how many dates, when. */
export async function calendarSummary(db: Db): Promise<Array<{
  resortId: string; month: string; ticketDays: number; dates: number; low: number; high: number; lastImported: string;
}>> {
  try {
    const r = await db.query(
      `with latest as (
         select distinct on (resort_id, park_date, ticket_days) resort_id, park_date, ticket_days, per_day_usd, observed_at
           from ticket_calendar order by resort_id, park_date, ticket_days, observed_at desc, id desc)
       select resort_id, to_char(park_date, 'YYYY-MM') as month, ticket_days,
              count(*)::int as dates, min(per_day_usd) as low, max(per_day_usd) as high,
              max(observed_at) as last
         from latest group by resort_id, to_char(park_date, 'YYYY-MM'), ticket_days
        order by resort_id, month, ticket_days`);
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      resortId: String(x.resort_id), month: String(x.month), ticketDays: Number(x.ticket_days),
      dates: Number(x.dates), low: Number(x.low), high: Number(x.high),
      lastImported: x.last instanceof Date ? x.last.toISOString() : String(x.last),
    }));
  } catch { return []; }
}

/** One saved calendar as /admin shows it again: the newest price per date
 *  for that resort, month and ticket length. */
export async function calendarMonth(db: Db, resortId: string, month: string, ticketDays: number): Promise<CalendarPrice[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  try {
    const r = await db.query(
      `select distinct on (park_date) park_date, per_day_usd
         from ticket_calendar
        where resort_id = $1 and ticket_days = $2 and to_char(park_date, 'YYYY-MM') = $3
        order by park_date, observed_at desc, id desc`, [resortId, ticketDays, month]);
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      date: x.park_date instanceof Date ? x.park_date.toISOString().slice(0, 10) : String(x.park_date).slice(0, 10),
      perDay: Number(x.per_day_usd),
    }));
  } catch { return []; }
}
