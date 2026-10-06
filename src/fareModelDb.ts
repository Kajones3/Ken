/**
 * Loads what the candidate formula (fareModel.ts) learns from: every paid
 * Google Flights fare in the record (flight_observations) with Google's own
 * typical range from the same search (flight_insights), plus every route
 * baseline. Read-only.
 */
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { settingsMap } from "./settings.js";
import { fitFareModel, type FareModel, type ModelBaseline, type ModelFare, type ModelInputs } from "./fareModel.js";

/** How far back the candidate learns from. Route evidence is narrower (45 days). */
export const MODEL_TRAIN_DAYS = 90;

const ts = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function loadModelInputs(db: Db, days = MODEL_TRAIN_DAYS): Promise<ModelInputs> {
  const f = await db.query<{ origin: string; destination: string; depart_date: unknown; price_usd: string;
    observed_at: unknown; typical_low: string | null; typical_high: string | null }>(
    `select o.origin, o.destination, o.depart_date, o.price_usd, o.observed_at,
            i.typical_low, i.typical_high
       from flight_observations o
       left join lateral (
         select typical_low, typical_high from flight_insights i
          where i.origin = o.origin and i.destination = o.destination
            and i.depart_date = o.depart_date and i.trip_length = o.trip_length
            and i.observed_at between o.observed_at - interval '10 minutes' and o.observed_at + interval '10 minutes'
          order by i.observed_at desc limit 1) i on true
      where o.source = 'serpapi_flights'
        and o.observed_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const fares: ModelFare[] = f.rows.map((r) => {
    const lo = r.typical_low === null ? NaN : Number(r.typical_low);
    const hi = r.typical_high === null ? NaN : Number(r.typical_high);
    return {
      origin: r.origin.trim(), destination: r.destination.trim(), departDate: dateStr(r.depart_date),
      price: Number(r.price_usd), observedAt: ts(r.observed_at),
      insightMid: lo > 0 && hi > 0 ? (lo + hi) / 2 : undefined,
    };
  }).filter((x) => x.price > 0);

  // Newest year per route and quarter.
  const b = await db.query<{ origin: string; destination: string; quarter: number; median_fare_usd: string | null;
    avg_fare_usd: string; p25_fare_usd: string | null; p75_fare_usd: string | null; source: string | null }>(
    `select distinct on (origin, destination, quarter)
            origin, destination, quarter, median_fare_usd, avg_fare_usd, p25_fare_usd, p75_fare_usd, source
       from historical_fares
      order by origin, destination, quarter, year desc`,
  );
  const baselines: ModelBaseline[] = [];
  for (const r of b.rows) {
    const med = Number(r.median_fare_usd ?? r.avg_fare_usd);
    if (!(med > 0)) continue;
    baselines.push({
      origin: r.origin.trim(), destination: r.destination.trim(), quarter: Number(r.quarter), med,
      p25: Number(r.p25_fare_usd ?? med), p75: Number(r.p75_fare_usd ?? med), source: r.source ?? "bts_db1b",
    });
  }
  const settings = await settingsMap(db);
  return { fares, baselines, premiumPct: (k, d) => settings.get(k) ?? d, now: new Date() };
}

// Fitting reads a few thousand rows, so the live site keeps one fitted
// model per database for ten minutes rather than refitting per search.
const cache = new WeakMap<Db, { at: number; model: Promise<FareModel> }>();
export function loadFareModel(db: Db): Promise<FareModel> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.model;
  const model = loadModelInputs(db).then(fitFareModel);
  cache.set(db, { at: Date.now(), model });
  model.catch(() => cache.delete(db));
  return model;
}
export function clearFareModelCache(db: Db): void { cache.delete(db); }
