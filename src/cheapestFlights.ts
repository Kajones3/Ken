/**
 * "The cheapest flight on the cheapest day" (owner, 2026-10-15): when a
 * traveler asks for the cheapest trip, the flight line is the CHEAPEST
 * itinerary Google lists for that date, not the middle one we keep and
 * grade against everywhere else.
 *
 * Where it comes from, nothing invented:
 *  - For a date we bought, Google's whole answer is kept
 *    (provider_responses), so the cheapest itinerary it listed is known
 *    exactly.
 *  - Everywhere else the flight line is a middle-fare estimate, so it is
 *    moved by a LEARNED ratio: across every kept answer, the cheapest
 *    itinerary over the middle one, per group (US, Europe, Asia). Measured
 *    2026-10-12 at about 0.81 / 0.84 / 0.86. A group with too few answers
 *    borrows the pooled ratio; with too few anywhere, there is no ratio and
 *    the middle fare stands (said on the card, never guessed).
 *
 * Pure except the one cached loader at the bottom.
 */
import type { Db } from "./db.js";
import { unzipBody } from "./rawResponses.js";
import { groupOf, type FareGroup } from "./fareModel.js";
import { bucketFor } from "./config.js";

/** A group needs this many kept answers before its own ratio is used. */
export const CHEAPEST_MIN_ANSWERS = 5;
/** Only answers this recent teach the ratio or price a date. */
export const CHEAPEST_LOOKBACK_DAYS = 120;

interface Itinerary { price?: number; type?: string }
interface GoogleAnswer { best_flights?: Itinerary[]; other_flights?: Itinerary[]; error?: string }

/** The itineraries we price from, cheapest first: real round trips when
 *  Google labels them, else everything priced. The same rule the paid
 *  fetcher uses to pick its middle fare (serpapiFlights.ts). */
export function pricedPool(json: GoogleAnswer): number[] {
  const all = [...(json.best_flights ?? []), ...(json.other_flights ?? [])]
    .filter((f) => Number.isFinite(f.price) && (f.price as number) > 0);
  const roundTrips = all.filter((f) => !f.type || /round/i.test(f.type));
  return (roundTrips.length ? roundTrips : all).map((f) => f.price as number).sort((a, b) => a - b);
}

/** Cheapest and middle (the lower of two middles, as the fetcher picks). */
export function cheapestAndMiddle(json: GoogleAnswer): { cheapest: number; middle: number; n: number } | undefined {
  const p = pricedPool(json);
  if (!p.length) return undefined;
  return { cheapest: p[0]!, middle: p[Math.floor((p.length - 1) / 2)]!, n: p.length };
}

export interface CheapestSample { origin: string; destination: string; departDate: string; nights: number; cheapest: number; middle: number }
export interface CheapestRatio { ratio: number; n: number; from: FareGroup | "pooled" }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Per group: median of cheapest / middle. A group short of answers uses the
 *  pooled ratio; with too few answers anywhere there is none. Held 0.4-1. */
export function learnCheapestRatios(samples: CheapestSample[]): Map<FareGroup, CheapestRatio> {
  const ok = samples.filter((s) => s.cheapest > 0 && s.middle > 0);
  const ratioOf = (xs: CheapestSample[]) => Math.min(1, Math.max(0.4, median(xs.map((s) => s.cheapest / s.middle))));
  const out = new Map<FareGroup, CheapestRatio>();
  const pooled = ok.length >= CHEAPEST_MIN_ANSWERS ? ratioOf(ok) : undefined;
  for (const g of ["dom", "europe", "asia"] as FareGroup[]) {
    const own = ok.filter((s) => groupOf(s.destination) === g);
    if (own.length >= CHEAPEST_MIN_ANSWERS) out.set(g, { ratio: ratioOf(own), n: own.length, from: g });
    else if (pooled !== undefined) out.set(g, { ratio: pooled, n: ok.length, from: "pooled" });
  }
  return out;
}

export interface CheapestListed {
  /** The cheapest itinerary Google listed for a date we bought (newest answer). */
  exact(origin: string, destination: string, date: string, nights: number): number | undefined;
  ratio(destination: string): CheapestRatio | undefined;
}

export function buildCheapestListed(samples: CheapestSample[]): CheapestListed {
  const exact = new Map<string, number>();
  // Samples arrive oldest first; a later answer for the same date wins.
  for (const s of samples) exact.set(`${s.origin}|${s.destination}|${s.departDate}|${bucketFor(s.nights)}`, s.cheapest);
  const ratios = learnCheapestRatios(samples);
  return {
    exact: (o, d, date, nights) => exact.get(`${o}|${d}|${date}|${bucketFor(nights)}`),
    ratio: (d) => ratios.get(groupOf(d)),
  };
}

/** Every kept Google Flights answer in the lookback, as samples. */
export async function loadCheapestSamples(db: Db): Promise<CheapestSample[]> {
  const rows = (await db.query<{ request: unknown; body_gz: Uint8Array }>(
    `select request, body_gz from provider_responses
      where kind = 'google_flights' and status = 200
        and fetched_at > now() - make_interval(days => $1)
      order by fetched_at, id`, [CHEAPEST_LOOKBACK_DAYS],
  ).catch(() => ({ rows: [] as { request: unknown; body_gz: Uint8Array }[] }))).rows;
  const out: CheapestSample[] = [];
  for (const r of rows) {
    const req = (typeof r.request === "string" ? JSON.parse(r.request) : r.request) as Record<string, string>;
    const dep = req.outbound_date, ret = req.return_date;
    if (!req.departure_id || !req.arrival_id || !dep || !ret) continue;
    let json: GoogleAnswer;
    try { json = JSON.parse(unzipBody(r.body_gz)); } catch { continue; }
    const cm = cheapestAndMiddle(json);
    if (!cm) continue;
    const nights = Math.round((Date.parse(ret) - Date.parse(dep)) / 86_400_000);
    out.push({ origin: req.departure_id, destination: req.arrival_id, departDate: dep, nights,
      cheapest: cm.cheapest, middle: cm.middle });
  }
  return out;
}

// Reading every kept answer is the heavy part; the answers change once a
// night, so ten minutes is plenty fresh.
const cache = new WeakMap<Db, { at: number; v: Promise<CheapestListed> }>();
export function loadCheapestListed(db: Db): Promise<CheapestListed> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const v = loadCheapestSamples(db).then(buildCheapestListed);
  cache.set(db, { at: Date.now(), v });
  v.catch(() => cache.delete(db));
  return v;
}
