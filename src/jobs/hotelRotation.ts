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
 * Only off-property rows count as evidence of a pull. On-property Disney
 * rates are generated locally from config.ts and cost nothing, but they are
 * written with the same `serpapi_hotels` source tag as the rows the vendor
 * really returned (see the note in refresh.ts), so counting them would make
 * every resort/month look freshly bought the moment anything at all was
 * written for it — and the rotation would never move.
 */
import { todayISO, type ISODate } from "../dates.js";
import type { Db } from "../db.js";
import { RESORTS } from "../config.js";
import { sampleCheckIn } from "../providers/serpapi.js";

/** One paid lookup: a resort and the month it prices. */
export interface HotelSlot {
  resortId: string;
  month: string;
  /** When this pair was last really bought, ms since epoch; 0 for never. */
  lastPulledAt: number;
}

/** Matches `hotel_rates.source` for rows a real vendor returned. */
export const PAID_HOTEL_SOURCE = "serpapi_hotels";

export interface HotelRotationOptions {
  months: string[];
  resortIds?: string[];
  limit: number;
  today?: ISODate;
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

  const candidates: HotelSlot[] = [];
  for (const resortId of resortIds) {
    for (const month of months) {
      // A month with no bookable night left cannot be sampled at any price,
      // so it must not hold a slot. Same rule the provider applies, asked
      // one level earlier — otherwise the rotation hands out a slot that
      // comes back empty and the budget is wasted exactly as before.
      if (!sampleCheckIn(month, today)) continue;
      const key = `${resortId}|${month}`;
      candidates.push({ resortId, month, lastPulledAt: lastPull.get(key) ?? 0 });
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
