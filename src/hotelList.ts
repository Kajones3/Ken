/**
 * Every off-property hotel we hold, per resort, for /admin (owner,
 * 2026-10-03: "I don't see any off property hotels in my hotel stuff").
 *
 * Two places hold them:
 *   - hotel_samples, the record: every Google search as it came back, one row
 *     per hotel per search, with the night searched. Started 2026-10-03.
 *   - hotel_rates, the working copy the board prices from: the latest search
 *     per hotel, stretched across its month by a season curve. Holds hotels
 *     bought before the record existed.
 * A hotel in the record is shown from the record (the real night and rate);
 * one only in the working copy is shown from there and marked as older.
 * Read-only; no provider calls.
 */
import type { Db } from "./db.js";
import { RESORTS } from "./config.js";
import { matchDisneyHotel } from "./disneyHotels.js";
import { dateStr } from "./book.js";

export interface HeldHotel {
  name: string;
  disney: boolean;
  /** Latest rate Google gave (record), or the middle of the cached month (older). */
  nightly: number;
  /** The night that rate is for, when known. */
  night: string | null;
  seenAt: string;
  /** Searches this hotel appeared in (record only). */
  searches: number;
  low: number;
  high: number;
  basis: "record" | "older";
}

export interface ResortHotels { resort: string; name: string; hotels: HeldHotel[]; searches: number }

const toISO = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export async function loadHotelList(db: Db): Promise<ResortHotels[]> {
  const rec = await db.query<{ resort_id: string; hotel_name: string; nightly_usd: string; check_in: unknown;
    pulled_at: unknown; seen: string; low: string; high: string }>(
    `select distinct on (resort_id, hotel_name)
            resort_id, hotel_name, nightly_usd, check_in, pulled_at,
            count(*) over (partition by resort_id, hotel_name) as seen,
            min(nightly_usd) over (partition by resort_id, hotel_name) as low,
            max(nightly_usd) over (partition by resort_id, hotel_name) as high
       from hotel_samples
      order by resort_id, hotel_name, pulled_at desc`,
  );
  const pulls = await db.query<{ resort_id: string; n: string }>(
    `select resort_id, count(distinct (month, pulled_at)) as n from hotel_samples group by resort_id`,
  );
  const old = await db.query<{ resort_id: string; hotel_name: string; med: string; low: string; high: string; at: unknown }>(
    `select resort_id, hotel_name,
            percentile_cont(0.5) within group (order by nightly_usd) as med,
            min(nightly_usd) as low, max(nightly_usd) as high, max(fetched_at) as at
       from hotel_rates
      where not on_property and source is not null
      group by resort_id, hotel_name`,
  );

  const byResort = new Map<string, Map<string, HeldHotel>>();
  const put = (resort: string, h: HeldHotel) => {
    const m = byResort.get(resort) ?? new Map<string, HeldHotel>();
    if (!m.has(h.name)) m.set(h.name, h);
    byResort.set(resort, m);
  };
  for (const r of rec.rows) {
    put(r.resort_id, {
      name: r.hotel_name, disney: matchDisneyHotel(r.resort_id, r.hotel_name) !== null,
      nightly: Math.round(Number(r.nightly_usd)), night: dateStr(r.check_in), seenAt: toISO(r.pulled_at),
      searches: Number(r.seen), low: Math.round(Number(r.low)), high: Math.round(Number(r.high)), basis: "record",
    });
  }
  for (const r of old.rows) {
    put(r.resort_id, {
      name: r.hotel_name, disney: matchDisneyHotel(r.resort_id, r.hotel_name) !== null,
      nightly: Math.round(Number(r.med)), night: null, seenAt: toISO(r.at),
      searches: 0, low: Math.round(Number(r.low)), high: Math.round(Number(r.high)), basis: "older",
    });
  }
  const pullCount = new Map(pulls.rows.map((r) => [r.resort_id, Number(r.n)]));
  return RESORTS.map((res) => ({
    resort: res.id, name: res.name, searches: pullCount.get(res.id) ?? 0,
    hotels: [...(byResort.get(res.id)?.values() ?? [])]
      .sort((a, b) => Number(a.disney) - Number(b.disney) || a.nightly - b.nightly),
  }));
}
