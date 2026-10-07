/**
 * "How far off are we RIGHT NOW?" (owner, 2026-10-07: "I need to know for
 * every day, how far are we off. Not just how far were we off last night
 * before the fare, but how far are we off right now?")
 *
 * Just before the nightly job buys a fare, this writes down what a traveler
 * would have been shown for that exact route and date at that moment: the
 * real cached fare or the leaned estimate, whichever the board picks, with
 * every correction the live formula has learned so far. Then the fare is
 * bought, and the two are kept side by side in `fare_forecasts`.
 *
 * Why this and not the scoreboard alone: the scoreboard rebuilds today's
 * estimate for fares we already bought, and those fares have already pulled
 * their own route's estimate toward themselves (book.ts route correction).
 * That is tasting the soup where the salt went in. A number written down
 * BEFORE the fare exists cannot have learned from it, so this is the one
 * honest measure of the number on screen. It also cannot be rebuilt later,
 * which is why it is recorded nightly rather than computed on demand.
 *
 * Read-only toward pricing: nothing here changes a price or which fares are
 * bought. A failure to forecast is logged and skipped, never allowed to stop
 * a purchase (governing rule: the fare matters more than the forecast).
 */
import type { Db } from "./db.js";
import { RESORTS } from "./config.js";
import { loadBook } from "./book.js";
import { decideFlightFare, quotedEstimate } from "./pricing.js";
import { loadFareModel } from "./fareModelDb.js";
import { holidayMultiplier, isInternational, USE_CANDIDATE_KEY, ZONE_PCT_KEY, DEFAULT_ZONE_PCT } from "./fareModel.js";
import { scoreZone, type ZoneScore } from "./fareScoreboard.js";
import { settingsMap } from "./settings.js";
import type { ISODate } from "./dates.js";

const RESORT_OF_AIRPORT = new Map(
  RESORTS.flatMap((r) => [[r.iata, r] as const, ...r.altArrivalAirports.map((a) => [a.iata, r] as const)]),
);

export interface Forecast {
  origin: string; destination: string; departDate: ISODate; tripLength: number;
  /** Per-seat fare the board showed; undefined when it had nothing to show. */
  shownUsd?: number;
  shownKind?: "real_fare" | "estimate";
  formula: "live" | "candidate";
  /** The live formula's estimate alone (leaned, holiday included). */
  liveEstimateUsd?: number;
  /** The candidate formula's estimate (holiday included). */
  candidateUsd?: number;
  forecastAt: Date;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** What travelers were shown for this route and date, right now. */
export async function forecastFare(
  db: Db, origin: string, destination: string, departDate: ISODate, tripLength: number,
): Promise<Forecast> {
  const forecastAt = new Date();
  const resort = RESORT_OF_AIRPORT.get(destination);
  if (!resort) throw new Error(`no resort for ${destination}`);
  const req = { origin, destinations: [destination], resortIds: [resort.id], from: departDate, to: departDate, tripLength };
  const intl = resort.region !== "dom";

  const shownOf = (book: Awaited<ReturnType<typeof loadBook>>) => {
    const row = book.flight(origin, destination, departDate, tripLength);
    const est = book.flightEstimate?.(origin, destination, departDate);
    if (!row && !est) return undefined;
    const d = decideFlightFare(book, row, est, departDate, intl);
    return { usd: r2(d.modelFare), kind: d.useRow ? "real_fare" as const : "estimate" as const };
  };

  const live = await loadBook(db, req, { formula: "live" });
  const useCandidate = live.setting?.(USE_CANDIDATE_KEY) === 1;
  // With the switch on, travelers see the candidate, so "shown" follows it.
  const shown = useCandidate ? shownOf(await loadBook(db, req)) : shownOf(live);

  let candidateUsd: number | undefined;
  try {
    const p = (await loadFareModel(db)).predict(origin, destination, departDate);
    if (p) candidateUsd = r2(p.value * holidayMultiplier(departDate, (k, d) => live.setting?.(k) ?? d));
  } catch (e) {
    console.warn(`forecast: candidate unavailable for ${origin}->${destination}: ${(e as Error).message}`);
  }

  return {
    origin, destination, departDate, tripLength,
    shownUsd: shown?.usd, shownKind: shown?.kind,
    formula: useCandidate ? "candidate" : "live",
    liveEstimateUsd: quotedEstimate(live, origin, destination, departDate),
    candidateUsd, forecastAt,
  };
}

/** Append one forecast with the fare it was graded against (null = none found). */
export async function recordForecast(db: Db, f: Forecast, priceUsd: number | null, job: string): Promise<void> {
  await db.query(
    `insert into fare_forecasts
       (origin, destination, depart_date, trip_length, shown_usd, shown_kind, formula,
        live_estimate_usd, candidate_usd, price_usd, job, forecast_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [f.origin, f.destination, f.departDate, f.tripLength, f.shownUsd ?? null, f.shownKind ?? null, f.formula,
     f.liveEstimateUsd ?? null, f.candidateUsd ?? null, priceUsd, job, f.forecastAt.toISOString()],
  );
}

export interface ForecastRow {
  destination: string; boughtAt: Date; price: number;
  shown?: number; shownKind?: string; live?: number; candidate?: number;
}
export interface ForecastGroup { shown: ZoneScore; live: ZoneScore; candidate: ZoneScore }
export interface ForecastScores {
  zonePct: number;
  /** Forecasts with a real fare to grade against. */
  n: number;
  /** Forecasts where Google had no fare (kept, not graded). */
  noFare: number;
  /** How many shown numbers were a real cached fare vs an estimate. */
  shownKinds: { realFare: number; estimate: number };
  all: ForecastGroup; domestic: ForecastGroup; international: ForecastGroup;
  /** Newest day first: what travelers saw that day, graded. */
  daily: { day: string; n: number; shown: ZoneScore; candidate: ZoneScore }[];
  since: string | null;
}

/** Pure: grade forecasts against the fares bought straight after them. */
export function scoreForecasts(rows: ForecastRow[], zonePct: number, noFare = 0): ForecastScores {
  const zone = zonePct / 100;
  const errs = (rs: ForecastRow[], pick: (r: ForecastRow) => number | undefined) =>
    rs.flatMap((r) => { const v = pick(r); return v === undefined || !(v > 0) ? [] : [v / r.price - 1]; });
  const group = (rs: ForecastRow[]): ForecastGroup => ({
    shown: scoreZone(errs(rs, (r) => r.shown), zone),
    live: scoreZone(errs(rs, (r) => r.live), zone),
    candidate: scoreZone(errs(rs, (r) => r.candidate), zone),
  });
  const intl = (r: ForecastRow) => isInternational(r.destination);
  const days = [...new Set(rows.map((r) => r.boughtAt.toISOString().slice(0, 10)))].sort().reverse();
  return {
    zonePct, n: rows.length, noFare,
    shownKinds: {
      realFare: rows.filter((r) => r.shownKind === "real_fare").length,
      estimate: rows.filter((r) => r.shownKind === "estimate").length,
    },
    all: group(rows),
    domestic: group(rows.filter((r) => !intl(r))),
    international: group(rows.filter(intl)),
    daily: days.map((day) => {
      const rs = rows.filter((r) => r.boughtAt.toISOString().slice(0, 10) === day);
      return { day, n: rs.length, shown: scoreZone(errs(rs, (r) => r.shown), zone),
               candidate: scoreZone(errs(rs, (r) => r.candidate), zone) };
    }),
    since: days.length ? days[days.length - 1]! : null,
  };
}

/** The last `days` days of forecasts, graded. Read-only. */
export async function loadForecastScores(db: Db, days = 30): Promise<ForecastScores> {
  const settings = await settingsMap(db);
  const zonePct = settings.get(ZONE_PCT_KEY) ?? DEFAULT_ZONE_PCT;
  let res;
  try {
    res = await db.query<{ destination: string; bought_at: unknown; price_usd: string | null; shown_usd: string | null;
      shown_kind: string | null; live_estimate_usd: string | null; candidate_usd: string | null }>(
      `select destination, bought_at, price_usd, shown_usd, shown_kind, live_estimate_usd, candidate_usd
         from fare_forecasts where bought_at > now() - ($1 || ' days')::interval`,
      [String(days)],
    );
  } catch {
    // Table not there yet (site not migrated): an empty report, not an error page.
    return scoreForecasts([], zonePct);
  }
  const n = (v: string | null) => (v === null ? undefined : Number(v));
  const rows: ForecastRow[] = [];
  let noFare = 0;
  for (const r of res.rows) {
    const price = n(r.price_usd);
    if (!(price && price > 0)) { noFare++; continue; }
    rows.push({
      destination: r.destination.trim(),
      boughtAt: r.bought_at instanceof Date ? r.bought_at : new Date(String(r.bought_at)),
      price, shown: n(r.shown_usd), shownKind: r.shown_kind ?? undefined,
      live: n(r.live_estimate_usd), candidate: n(r.candidate_usd),
    });
  }
  return scoreForecasts(rows, zonePct, noFare);
}
