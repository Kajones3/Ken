/**
 * Which resort/months are worth paying SerpApi for tonight.
 *
 * The flight side already works this way (`rotationRoutes` in routeDemand.ts)
 * and the reasoning carries over exactly. Hotels did not, and it showed:
 * `runRefresh` walked months and resorts in config order and called the
 * provider for every pair, so the nightly budget was simply consumed by
 * whoever came first in the loop. Walt Disney World and Disneyland got real
 * off-property rates every single night — re-buying prices that had not moved
 * since yesterday — while Shanghai and Hong Kong, further down the list, went
 * from launch to now without a single real lookup. Order in an array decided
 * which resorts had real data, which is not a decision anybody made.
 *
 * Stalest-first fixes that on its own. A resort/month that has never been
 * bought sorts ahead of one bought last night, so the budget always lands
 * where it buys the most new information, and coverage widens instead of
 * deepening in the same three places.
 *
 * What that buys, concretely: six resorts across the twelve months the app
 * prices is ~72 slots. At eight lookups a night the rotation touches every
 * one of them in about nine days and then keeps each one roughly nine days
 * fresh — which is a fair cadence for a hotel rate, and a far better use of
 * the same 240 lookups a month than refreshing Orlando thirty times.
 *
 * Two rules added 2026-10-16 (owner: "we are wasting money"; the raw peek
 * found 40 hotel searches re-buying the same resort + the same 4 nights 5-6
 * days later):
 *  - A resort/month bought in the last HOTEL_REBUY_DAYS waits, whatever the
 *    budget says. At 6 searches a night the ~66 resort-months come around
 *    every ~11 nights anyway; the floor keeps it that way if the budget grows.
 *  - Each pass asks a different night (`pass`, the number of searches made
 *    for that resort+month so far; checkInDayFor in providers/serpapi.ts).
 *
 * Only off-property rows count as evidence of a pull. On-property Disney
 * rates are generated locally from config.ts and cost nothing, but they are
 * written with the same `serpapi_hotels` source tag as the rows the vendor
 * really returned (see the note in refresh.ts), so counting them would make
 * every resort/month look freshly bought the moment anything at all was
 * written for it — and the rotation would never move.
 */
import { addDaysISO, todayISO, type ISODate } from "../dates.js";
import type { Db } from "../db.js";
import { RESORTS } from "../config.js";
import { sampleCheckIn } from "../providers/serpapi.js";

/** A resort/month bought this recently is not bought again (owner: 10-14 days). */
export const HOTEL_REBUY_DAYS = 10;

/** One paid lookup: a resort and the month it prices. */
export interface HotelSlot {
  resortId: string;
  month: string;
  /** When this pair was last really bought, ms since epoch; 0 for never. */
  lastPulledAt: number;
  /** Searches made for this pair before tonight (picks tonight's night). */
  pass: number;
  /** The check-in night tonight's search will ask for. */
  checkIn: ISODate;
}

/** Matches `hotel_rates.source` for rows a real vendor returned. */
export const PAID_HOTEL_SOURCE = "serpapi_hotels";

export interface HotelRotationOptions {
  months: string[];
  resortIds?: string[];
  limit: number;
  today?: ISODate;
  /** Days a bought resort/month waits; 0 = no wait (the Data holes page
   *  uses 0 to show the whole queue in order). */
  rebuyDays?: number;
}

export async function rotateHotelSlots(
  db: Db, opts: HotelRotationOptions,
): Promise<HotelSlot[]> {
  const { months, limit } = opts;
  if (limit <= 0 || !months.length) return [];
  const today = opts.today ?? todayISO();
  const resortIds = opts.resortIds ?? RESORTS.map((r) => r.id);

  // `to_char` rather than reading stay_date back into JS and slicing it:
  // Postgres hands back a `date` column as a JS Date, and string-slicing
  // those is the bug that once made all six resorts silently unavailable
  // (see dateStr() in book.ts). Grouping by the month in SQL never gives
  // JavaScript the chance.
  const seen = await db.query<{ resort_id: string; month: string; last_pull: Date | null }>(
    `select resort_id, to_char(stay_date, 'YYYY-MM') as month, max(fetched_at) as last_pull
       from hotel_rates
      where source = $1 and on_property = false
      group by resort_id, to_char(stay_date, 'YYYY-MM')`,
    [PAID_HOTEL_SOURCE],
  );
  const lastPull = new Map(
    seen.rows.map((r) => [
      `${r.resort_id}|${r.month}`,
      r.last_pull ? new Date(r.last_pull).getTime() : 0,
    ]),
  );
  // A search that came back EMPTY still counts as made: it waits its turn
  // like any other instead of being re-bought every night as "never bought".
  const passes = new Map<string, number>();
  try {
    const searched = await db.query<{ resort_id: string; month: string; last: Date | null; n: string }>(
      `select resort_id, month, max(searched_at) as last, count(*) as n from hotel_searches group by resort_id, month`);
    for (const r of searched.rows) {
      const key = `${r.resort_id}|${r.month}`;
      const t = r.last ? new Date(r.last).getTime() : 0;
      if (t > (lastPull.get(key) ?? 0)) lastPull.set(key, t);
      passes.set(key, Number(r.n));
    }
  } catch { /* table not migrated yet: rotation works as before */ }
  const rebuyDays = opts.rebuyDays ?? HOTEL_REBUY_DAYS;
  // Compared by calendar day, not to the millisecond: the refresh runs at
  // roughly the same hour each night, and a pull at 10:05 must count as
  // "10 days ago" on the night ten days later, not as 9.99 days.
  const waitUntil = addDaysISO(today, -rebuyDays);

  const candidates: HotelSlot[] = [];
  for (const resortId of resortIds) {
    for (const month of months) {
      // A month with no bookable night left cannot be sampled at any price,
      // so it must not hold a slot. Same rule the provider applies, asked
      // one level earlier — otherwise the rotation hands out a slot that
      // comes back empty and the budget is wasted exactly as before.
      const key = `${resortId}|${month}`;
      const pass = passes.get(key) ?? 0;
      const checkIn = sampleCheckIn(month, today, pass);
      if (!checkIn) continue;
      const lastPulledAt = lastPull.get(key) ?? 0;
      if (rebuyDays > 0 && lastPulledAt > 0 && new Date(lastPulledAt).toISOString().slice(0, 10) > waitUntil) continue;
      candidates.push({ resortId, month, lastPulledAt, pass, checkIn });
    }
  }

  candidates.sort((a, b) =>
    a.lastPulledAt - b.lastPulledAt
    || a.month.localeCompare(b.month)
    || a.resortId.localeCompare(b.resortId));
  return candidates.slice(0, limit);
}

/** The `resortId|month` keys the provider checks against. */
export function slotKeys(slots: HotelSlot[]): Set<string> {
  return new Set(slots.map((s) => `${s.resortId}|${s.month}`));
}

/** How many searches each slot already had, for the provider's night pick. */
export function slotPasses(slots: HotelSlot[]): Map<string, number> {
  return new Map(slots.map((s) => [`${s.resortId}|${s.month}`, s.pass]));
}
