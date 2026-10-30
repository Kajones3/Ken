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
import { EXCHANGE_RATES } from "./exchangeData.js";

/** The resorts with a ticket calendar to read. Disneyland's calendar is its
 *  1-DAY ticket only: its 2+ day tickets cost one price for any date
 *  (`flatMultiDay`, owner 2026-10-28), so a 2+ day Disneyland calendar is refused.
 *  Paris (2026-10-31) has dated calendars like Disney World's, in pounds on
 *  the UK site, plus undated tickets (see `validateUndated`). */
export const CALENDAR_RESORTS = ["wdw", "dlr", "dlp"] as const;

/** Currencies a screenshot may be priced in. Converted to dollars at the
 *  day's ECB rate (exchangeData.ts) when saved; the shown amount is kept too. */
export const TICKET_CURRENCIES = ["USD", "GBP", "EUR"] as const;
export type TicketCurrency = typeof TICKET_CURRENCIES[number];
/** The currency each resort's ticket page shows the owner by default. */
export const DEFAULT_TICKET_CURRENCY: Record<string, TicketCurrency> = { wdw: "USD", dlr: "USD", dlp: "GBP" };

export function toUsd(amount: number, currency: string): number {
  const rate = EXCHANGE_RATES[currency]?.perUsd ?? 1;
  return Math.round((amount / rate) * 100) / 100;
}

export interface CalendarPrice { date: string; perDay: number; currency?: string }
export interface CalendarImport {
  resortId: string; ticketDays: number; month: string; prices: CalendarPrice[];
  /** What the screenshot showed: its currency and the per-day amounts in it.
   *  `prices` are always dollars. */
  currency?: TicketCurrency; local?: CalendarPrice[];
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
    return { ok: false, reason: "Ticket calendars are read for Walt Disney World and Disneyland." };
  }
  const ticketDays = Math.round(Number(b.ticketDays));
  if (!(ticketDays >= 1 && ticketDays <= 10)) return { ok: false, reason: "How many days is the ticket? (1 to 10)" };
  if (ticketDays > 1 && RESORT_BY_ID.get(resortId)?.ticket.flatMultiDay) {
    return { ok: false, reason: `${RESORT_BY_ID.get(resortId)!.name}'s calendar is for its 1-day ticket: its 2-5 day tickets cost the same on any date. Set the ticket length to 1-day.` };
  }
  const month = String(b.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, reason: "Which month is the calendar?" };
  if (month < today.slice(0, 7)) return { ok: false, reason: "That month has already gone." };
  const currency = String(b.currency ?? "USD").toUpperCase();
  if (!(TICKET_CURRENCIES as readonly string[]).includes(currency)) return { ok: false, reason: "Prices in dollars, pounds or euros." };
  const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const list = Array.isArray(b.prices) ? b.prices : [];
  const seen = new Set<string>();
  const prices: CalendarPrice[] = [];
  const local: CalendarPrice[] = [];
  for (const p of list) {
    const date = String((p as Record<string, unknown>)?.date ?? "");
    const shown = Number((p as Record<string, unknown>)?.perDay);
    const perDay = toUsd(shown, currency);
    if (!date.startsWith(month + "-") || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, reason: `${date || "A date"} isn't in ${month}.` };
    }
    if (!Number.isFinite(perDay) || perDay < PER_DAY_MIN || perDay > PER_DAY_MAX) {
      return { ok: false, reason: `${date}: ${sym}${p && (p as Record<string, unknown>).perDay} a day doesn't look like a ticket price. Fix or clear that box.` };
    }
    if (seen.has(date)) return { ok: false, reason: `${date} is there twice.` };
    seen.add(date);
    prices.push({ date, perDay });
    local.push({ date, perDay: Math.round(shown * 100) / 100 });
  }
  if (prices.length < CALENDAR_MIN_DATES) {
    return { ok: false, reason: `Only ${prices.length} date${prices.length === 1 ? "" : "s"} read. A whole month's calendar is what's needed.` };
  }
  prices.sort((a, b2) => a.date < b2.date ? -1 : 1);
  local.sort((a, b2) => a.date < b2.date ? -1 : 1);
  return { ok: true, value: { resortId, ticketDays, month, prices, currency: currency as TicketCurrency, local } };
}

/** Keeps every price as shown. Never updates or deletes. */
export async function saveCalendar(db: Db, v: CalendarImport, by: string): Promise<number> {
  const vals: unknown[] = [];
  const localOf = new Map((v.local ?? []).map((p) => [p.date, p.perDay]));
  const tuples = v.prices.map((p, i) => {
    vals.push(v.resortId, v.ticketDays, p.date, p.perDay, by, v.currency ?? "USD", localOf.get(p.date) ?? p.perDay);
    const b = i * 7;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},'owner_screenshot',$${b + 5},$${b + 6},$${b + 7})`;
  });
  await db.query(
    `insert into ticket_calendar (resort_id, ticket_days, park_date, per_day_usd, source, entered_by, currency, per_day_local)
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

/* ----------------------------------------------------- undated tickets
 * Paris sells UNDATED tickets too (owner's screenshot, 2026-10-31: "Undated
 * Ticket 1 Day/1 Park, valid 1 year (excluding 31 Oct and 31 Dec)", Adult
 * (12+) £114.27, Child (3-11) £106.30). One price for any day, so it is a
 * real price a traveler can always pay. A date with no dated calendar is
 * priced from it instead of the curve (seedTickets, refresh.ts). */
export interface UndatedImport {
  resortId: string; ticketDays: number; parks: number; currency: TicketCurrency;
  adultLocal: number; childLocal: number | null; adultUsd: number; childUsd: number | null;
}

export function validateUndated(body: unknown):
  { ok: true; value: UndatedImport } | { ok: false; reason: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const resortId = String(b.resortId ?? "");
  if (!(CALENDAR_RESORTS as readonly string[]).includes(resortId)) {
    return { ok: false, reason: "Undated tickets are read for Walt Disney World, Disneyland and Disneyland Paris." };
  }
  const ticketDays = Math.round(Number(b.ticketDays));
  if (!(ticketDays >= 1 && ticketDays <= 10)) return { ok: false, reason: "How many days is the ticket? (1 to 10)" };
  const parks = Math.round(Number(b.parks ?? 1));
  if (parks !== 1 && parks !== 2) return { ok: false, reason: "1 park or 2 parks?" };
  const currency = String(b.currency ?? "USD").toUpperCase();
  if (!(TICKET_CURRENCIES as readonly string[]).includes(currency)) return { ok: false, reason: "Prices in dollars, pounds or euros." };
  const adultLocal = Number(b.adult);
  const childRaw = b.child === null || b.child === undefined || b.child === "" ? null : Number(b.child);
  const adultUsd = toUsd(adultLocal, currency);
  // A whole ticket, not per day: 1 to 10 days at PER_DAY_MIN..MAX a day.
  const ok = (usd: number) => Number.isFinite(usd) && usd >= PER_DAY_MIN && usd <= PER_DAY_MAX * ticketDays;
  if (!ok(adultUsd)) return { ok: false, reason: "The adult price doesn't look like a ticket price." };
  if (childRaw !== null && !ok(toUsd(childRaw, currency))) return { ok: false, reason: "The child price doesn't look like a ticket price." };
  if (childRaw !== null && childRaw > adultLocal) return { ok: false, reason: "The child price is above the adult price. Check which is which." };
  return { ok: true, value: {
    resortId, ticketDays, parks, currency: currency as TicketCurrency,
    adultLocal: Math.round(adultLocal * 100) / 100, childLocal: childRaw === null ? null : Math.round(childRaw * 100) / 100,
    adultUsd, childUsd: childRaw === null ? null : toUsd(childRaw, currency),
  } };
}

/** Keeps every price as shown. Never updates or deletes. */
export async function saveUndated(db: Db, v: UndatedImport, by: string): Promise<void> {
  await db.query(
    `insert into ticket_undated (resort_id, ticket_days, parks, currency, adult_local, child_local, adult_usd, child_usd, entered_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [v.resortId, v.ticketDays, v.parks, v.currency, v.adultLocal, v.childLocal, v.adultUsd, v.childUsd, by]);
}

export interface UndatedPrice {
  ticketDays: number; parks: number; adult: number; child: number | null;
  currency: string; adultLocal: number; childLocal: number | null; observedAt: string;
}
/** The newest undated price per resort, ticket length and parks. */
export async function latestUndated(db: Db): Promise<Map<string, UndatedPrice[]>> {
  const out = new Map<string, UndatedPrice[]>();
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (await db.query(
      `select distinct on (resort_id, ticket_days, parks) resort_id, ticket_days, parks, currency,
              adult_local, child_local, adult_usd, child_usd, observed_at
         from ticket_undated
        order by resort_id, ticket_days, parks, observed_at desc, id desc`)).rows as Array<Record<string, unknown>>;
  } catch { return out; }   // no table yet: nothing undated held
  for (const r of rows) {
    const list = out.get(String(r.resort_id)) ?? [];
    list.push({
      ticketDays: Number(r.ticket_days), parks: Number(r.parks),
      adult: Number(r.adult_usd), child: r.child_usd === null ? null : Number(r.child_usd),
      currency: String(r.currency), adultLocal: Number(r.adult_local),
      childLocal: r.child_local === null ? null : Number(r.child_local),
      observedAt: r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at),
    });
    out.set(String(r.resort_id), list);
  }
  return out;
}

/** The undated ticket that prices a date with no calendar: the 1-day,
 *  1-park ticket (the one a 1-day trip buys; longer trips are carried from
 *  it by the resort's length discount, or priced exactly from an undated
 *  ticket of their own length, see pricing.ts). */
export function undatedOneDay(list: UndatedPrice[] | undefined): UndatedPrice | null {
  return list?.find((u) => u.ticketDays === 1 && u.parks === 1) ?? null;
}

/** One saved calendar as /admin shows it again: the newest price per date
 *  for that resort, month and ticket length. */
export async function calendarMonth(db: Db, resortId: string, month: string, ticketDays: number): Promise<CalendarPrice[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  try {
    const r = await db.query(
      `select distinct on (park_date) park_date, per_day_usd, per_day_local, currency
         from ticket_calendar
        where resort_id = $1 and ticket_days = $2 and to_char(park_date, 'YYYY-MM') = $3
        order by park_date, observed_at desc, id desc`, [resortId, ticketDays, month]);
    // As the screenshot showed it, so a correction is typed in the same money.
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      date: x.park_date instanceof Date ? x.park_date.toISOString().slice(0, 10) : String(x.park_date).slice(0, 10),
      perDay: x.per_day_local === null || x.per_day_local === undefined ? Number(x.per_day_usd) : Number(x.per_day_local),
      currency: String(x.currency ?? "USD"),
    }));
  } catch { return []; }
}
