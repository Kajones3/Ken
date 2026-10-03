/**
 * Google's own rates for Disney's hotels, used to keep on-property pricing
 * honest (owner, 2026-10-03: "make sure we do include Google's rates to keep
 * our Disney hotel pricing honest").
 *
 * Our on-property rates are the owner's base rate per hotel moved by a season
 * curve; no API sells Disney's own booking data. But Google's "hotels near
 * <resort>" search, which we already pay for nightly, returns some of
 * Disney's own hotels with a real nightly rate. Those land in hotel_samples
 * (the hotel record) and were only being used to GRADE our rate.
 *
 * Now each one is a data point exactly like an owner price check: Google's
 * rate for that hotel and night, over OUR rate for the same hotel and night,
 * is a ratio, and ratios nudge the hotel's price through checkFactors.ts
 * (median, shrunk toward "no change" by how much evidence there is, held
 * within 0.5x-2x). Nothing is overwritten: our base stays the owner's, the
 * Google rate stays in the record, and the weight is the owner's to set
 * (`sources.hotel.googleDisney`, 0 turns it off).
 *
 * One data point per hotel and night: if Google was asked about the same
 * night twice, the newer answer is the one that counts (the older stays in
 * the record).
 */
import type { Db } from "./db.js";
import type { CountedCheck } from "./checkFactors.js";
import { matchDisneyHotel } from "./disneyHotels.js";
import { dateStr } from "./book.js";

/** How far back a Google rate still counts. Disney reprices seasonally, so a
 *  rate from last spring says little about this one. */
export const GOOGLE_DISNEY_WINDOW_DAYS = 180;

export interface GoogleDisneyRate {
  resortId: string; hotelId: string; hotelName: string; googleName: string;
  night: string; google: number; ours: number | null; pulledAt: Date;
}

/** Every Google rate for a Disney hotel in the window, matched to our hotel
 *  and our raw rate for the same night (null when we hold none). */
export async function googleDisneyRates(db: Db, days = GOOGLE_DISNEY_WINDOW_DAYS): Promise<GoogleDisneyRate[]> {
  let rows: { resort_id: string; hotel_name: string; check_in: unknown; nightly_usd: string; pulled_at: unknown }[];
  try {
    rows = (await db.query<{ resort_id: string; hotel_name: string; check_in: unknown; nightly_usd: string; pulled_at: unknown }>(
      `select resort_id, hotel_name, check_in, nightly_usd, pulled_at
         from hotel_samples
        where pulled_at > now() - ($1 || ' days')::interval
        order by pulled_at`,
      [String(days)],
    )).rows;
  } catch {
    return []; // Not migrated yet: price exactly as before.
  }
  // Latest pull per hotel + night.
  const latest = new Map<string, GoogleDisneyRate>();
  for (const r of rows) {
    const hit = matchDisneyHotel(r.resort_id, r.hotel_name);
    const google = Number(r.nightly_usd);
    if (!hit || !(google > 0)) continue;
    const night = dateStr(r.check_in);
    latest.set(`${hit.id}|${night}`, {
      resortId: r.resort_id, hotelId: hit.id, hotelName: hit.name, googleName: r.hotel_name,
      night, google, ours: null,
      pulledAt: r.pulled_at instanceof Date ? r.pulled_at : new Date(String(r.pulled_at)),
    });
  }
  if (!latest.size) return [];
  const list = [...latest.values()];
  const ours = await db.query<{ hotel_id: string; stay_date: unknown; nightly_usd: string }>(
    `select hotel_id, stay_date, nightly_usd from hotel_rates
      where on_property and hotel_id = any($1) and stay_date = any($2::date[])`,
    [[...new Set(list.map((x) => x.hotelId))], [...new Set(list.map((x) => x.night))]],
  );
  const ourNight = new Map(ours.rows.map((r) => [`${r.hotel_id}|${dateStr(r.stay_date)}`, Number(r.nightly_usd)]));
  for (const x of list) x.ours = ourNight.get(`${x.hotelId}|${x.night}`) ?? null;
  return list;
}

/** The same rates as evidence for checkFactors.computeFactors. */
export function asEvidence(rates: GoogleDisneyRate[], weight: number): CountedCheck[] {
  if (!(weight > 0)) return [];
  return rates
    .filter((x) => x.ours !== null && x.ours > 0)
    .map((x) => ({
      category: "hotel" as const,
      matchKey: x.hotelId,
      unitUsd: x.google,
      modelUsd: x.ours!,
      // Our rate is read from hotel_rates as it stands now, which is already
      // on the current base, so no rescaling.
      modelBaseUsd: null,
      groupKey: `google|${x.hotelId}|${x.night}`,
      weight,
    }));
}

/* A book is loaded for every comparison and calendar read; the record holds
 * tens of thousands of hotel rows, so the matched evidence is kept for a few
 * minutes per database. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new WeakMap<object, { at: number; rates: GoogleDisneyRate[] }>();
export async function cachedGoogleDisneyRates(db: Db): Promise<GoogleDisneyRate[]> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rates;
  const rates = await googleDisneyRates(db);
  cache.set(db, { at: Date.now(), rates });
  return rates;
}
export function clearGoogleDisneyCache(db: Db): void { cache.delete(db); }
