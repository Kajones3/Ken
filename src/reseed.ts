/**
 * Make an owner's hotel correction visible now, instead of tomorrow morning.
 *
 * The admin page writes a number to `owner_settings`, but the rate a traveller
 * sees comes from `hotel_rates` — a cache the nightly refresh fills. Without
 * this, correcting a rate would appear to do nothing for up to a day, and the
 * owner would reasonably conclude the form was broken and type it again. So a
 * save regenerates that resort's on-property rows straight away.
 *
 * Three things that make this safe to run from a web request:
 *
 *   - IT CALLS NO PROVIDER. On-property rates are generated locally from the
 *     base rate and the season curve. Nothing here costs money or touches a
 *     vendor, which is what makes it acceptable on a user's own click — the
 *     same bar the rest of the app holds to.
 *   - IT ONLY TOUCHES `on_property = true` ROWS for the one resort. The
 *     off-property rates a vendor really returned are somebody else's data and
 *     are never rewritten from a guess.
 *   - IT IS AN UPSERT, so a failure leaves yesterday's rows in place. Same
 *     rule as the refresh job: a failed run never deletes.
 */
import type { Db } from "./db.js";
import { RESORT_BY_ID } from "./config.js";
import { onPropertyQuotes } from "./onProperty.js";
import { upsertHotels, allTierMonths } from "./jobs/refresh.js";
import { primeSettingsCache } from "./settings.js";

/** Which resort a settings key belongs to, or null if it isn't a hotel rate. */
export function resortOfHotelSetting(key: string): string | null {
  const m = /^hotel\.(.+)\.base$/.exec(key);
  if (!m) return null;
  const hotelId = m[1]!;
  for (const [id, resort] of RESORT_BY_ID) {
    if (resort.hotels.some((h) => h.id === hotelId)) return id;
  }
  return null;
}

/**
 * Rewrite one resort's on-property nightly rates across the whole window the
 * app prices, from the rates currently in force.
 *
 * The whole window, not just the months due tonight: the owner changed what a
 * room costs, and that is true in March as much as in the month the refresh
 * happens to be looking at. Returns how many rows were written, so the admin
 * page can say the change landed rather than just claiming it did.
 */
export async function reseedOnProperty(db: Db, resortId: string): Promise<number> {
  const resort = RESORT_BY_ID.get(resortId);
  if (!resort) return 0;
  await primeSettingsCache(db);
  let written = 0;
  for (const month of allTierMonths()) {
    const quotes = onPropertyQuotes(resort, month, "on");
    // The same source tag the generator has always used for these rows. It is
    // a known mislabelling (see CLAUDE.md on the hotel rotation) and worth
    // fixing, but inventing a second tag here would make this re-seed look
    // like a third kind of pull and confuse the rotation further.
    written += await upsertHotels(db, quotes, "serpapi_hotels");
  }
  return written;
}

/** Every resort touched by a batch of setting keys, in one pass. */
export async function reseedForKeys(db: Db, keys: string[]): Promise<{ resorts: string[]; rows: number }> {
  const resorts = [...new Set(keys.map(resortOfHotelSetting).filter((r): r is string => !!r))];
  let rows = 0;
  for (const id of resorts) rows += await reseedOnProperty(db, id);
  return { resorts, rows };
}
