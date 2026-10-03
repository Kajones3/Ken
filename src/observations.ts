/**
 * Every fare we are ever handed, kept with its source. Nothing is overwritten.
 *
 * THE GOVERNING RULE (owner, 2026-10-03, see the top of CLAUDE.md):
 * "Retrieving and keeping flight and hotel data across a diverse spectrum is
 * one of the primary functionalities of this app. Even the free flight data is
 * information. Nothing should be overwritten. It should all be added to the
 * database with the source. Then we can weight our formula based on the
 * sources instead of overwriting anything."
 *
 * Why this exists: flight_prices holds ONE row per route, date and trip
 * length, so every writer replaced whatever was there. Twice in two days that
 * silently threw away fares we had paid for (the free feed overwriting paid
 * fares; the paid job re-buying, and so overwriting, its own). 226 paid fares
 * became 19.
 *
 * So:
 *   - `flight_observations` is the record. Append-only: every writer inserts
 *     a row per fare, with its source and when we saw it, and nothing in this
 *     codebase updates or deletes it.
 *   - `flight_prices` stays as a working copy for the readers that want "the
 *     latest per date" (trend, coverage, scoreboard), and may be replaced.
 *     Losing a row there loses nothing, because the observation is kept.
 *   - Pricing (book.ts) reads the latest observation PER SOURCE for each
 *     date and blends them by owner-editable source weights (below), instead
 *     of one source replacing another.
 *
 * Hotels follow the same rule through `hotel_samples` (every off-property
 * pull as Google returned it, Disney's own hotels included, with a source),
 * which is likewise append-only.
 */
import type { Db } from "./db.js";
import type { FlightQuote } from "./providers/types.js";

export const SERPAPI_FLIGHTS = "serpapi_flights";

/** Owner-editable weight per flight source (Rates & settings, "Data sources"). */
export const FLIGHT_WEIGHT_KEYS = {
  serpapi: "sources.flight.serpapi",
  travelpayouts: "sources.flight.travelpayouts",
} as const;
export const DEFAULT_FLIGHT_WEIGHTS = { serpapi: 1, travelpayouts: 0 } as const;

/** Which weight a stored source label reads. The free feed is written as
 *  "travelpayouts" or the combined provider name "travelpayouts+serpapi"
 *  (whose flights come from Travelpayouts), so it matches on the prefix. */
export function flightSourceKind(source: string): keyof typeof FLIGHT_WEIGHT_KEYS | "other" {
  if (source === SERPAPI_FLIGHTS) return "serpapi";
  if (source.startsWith("travelpayouts")) return "travelpayouts";
  return "other";
}

export function flightSourceWeight(source: string, setting?: (key: string) => number | undefined): number {
  const kind = flightSourceKind(source);
  if (kind === "other") return 0;
  const w = setting?.(FLIGHT_WEIGHT_KEYS[kind]) ?? DEFAULT_FLIGHT_WEIGHTS[kind];
  return Number.isFinite(w) && w >= 0 ? w : DEFAULT_FLIGHT_WEIGHTS[kind];
}

export interface SourcedFare {
  source: string;
  price: number;
  carrier?: string;
  stops: number;
  deepLink?: string;
  at: Date | null;
}

/**
 * One date's fares from several sources, turned into the one fare pricing
 * uses. Pure.
 *
 * - Sources with a weight above 0 are averaged by weight.
 * - A source at weight 0 is a fallback: used only when it is the only kind of
 *   fare we hold for that date. "0" means "don't let it pull a better source's
 *   number around", not "throw it away". Owner sets the weights.
 * - Carrier, stops and the booking link come from the heaviest source, so the
 *   card names a real itinerary.
 */
export function blendFares(fares: SourcedFare[], weightOf: (source: string) => number):
  { price: number; carrier?: string; stops: number; deepLink?: string; sources: string[] } | null {
  const usable = fares.filter((f) => Number.isFinite(f.price) && f.price > 0);
  if (!usable.length) return null;
  const weighted = usable.map((f) => ({ f, w: weightOf(f.source) }));
  const positive = weighted.filter((x) => x.w > 0);
  // Fallback: nothing has weight, so take the most recent fare we hold.
  const pool = positive.length ? positive
    : [[...weighted].sort((a, b) => (b.f.at?.getTime() ?? 0) - (a.f.at?.getTime() ?? 0))[0]!].map((x) => ({ ...x, w: 1 }));
  const total = pool.reduce((s, x) => s + x.w, 0);
  const price = Math.round((pool.reduce((s, x) => s + x.f.price * x.w, 0) / total) * 100) / 100;
  const lead = [...pool].sort((a, b) => b.w - a.w || (b.f.at?.getTime() ?? 0) - (a.f.at?.getTime() ?? 0))[0]!.f;
  return {
    price, carrier: lead.carrier, stops: lead.stops, deepLink: lead.deepLink,
    sources: [...new Set(pool.map((x) => x.f.source))],
  };
}

/**
 * Append fares to the record. Every writer calls this BEFORE touching the
 * working copy, so a fare is kept even if the working-copy write later
 * replaces it. Throws on failure: losing the record should fail the job
 * loudly, not quietly (the daily intake check in dataIntake.ts is the second
 * line of defense).
 */
export async function recordFlightObservations(db: Db, rows: FlightQuote[], source: string): Promise<number> {
  const good = rows.filter((r) => r.priceUsd > 0);
  for (let i = 0; i < good.length; i += 500) {
    const chunk = good.slice(i, i + 500);
    const vals: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 9;
      vals.push(r.origin, r.destination, r.departDate, r.tripLength, r.priceUsd,
        r.carrier ?? null, r.stops ?? 0, r.deepLink ?? null, source);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    });
    await db.query(
      `insert into flight_observations
         (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,source)
       values ${tuples.join(",")}`,
      vals,
    );
  }
  return good.length;
}
