/**
 * How far off are our flight estimates? (owner, 2026-10-02: flights are "our
 * Achilles heel ... the easiest thing for me to check". Owner's pick:
 * "Start with the scoreboard.")
 *
 * Every night popular-routes buys real Google Flights fares (SerpApi), each
 * the MIDDLE itinerary for one route and date. Each one is a free test: what
 * would our estimate have said for that same route and date, if we had not
 * bought it? This file answers that, read-only, from rows we already hold.
 * No provider calls.
 *
 * THE ESTIMATE IS RE-BUILT "BLIND": the route's baseline for that quarter,
 * times the global trend (BTS rows only), leaned, plus the holiday premium.
 * It deliberately leaves out the three things that would let a fare grade
 * itself: route-specific bought-fare corrections, the owner's fare
 * corrections, and the owner's price checks. So this measures the estimate a
 * traveler sees on a route we have NOT bought.
 *
 * Two honest limits, printed on the page too:
 *  - The global trend is itself the median of bought fares against their
 *    baselines, so the OVERALL high/low reading for domestic routes is pulled
 *    toward zero by construction. The SPREAD (how far a typical route is off)
 *    is the honest number.
 *  - International baselines are built from sampled fares, so a fare only
 *    counts as a test if it was bought AFTER its route's baseline was made.
 */
import type { Db } from "./db.js";
import { RESORTS } from "./config.js";
import { quarterOf, type ISODate } from "./dates.js";
import { dateStr } from "./book.js";
import { leanedFare, ESTIMATE_LEAN_KEY, DEFAULT_ESTIMATE_LEAN } from "./pricing.js";
import { holidayFlightPremium } from "./holidayWindows.js";
import { settingsMap } from "./settings.js";

const RESORT_OF_AIRPORT = new Map(
  RESORTS.flatMap((r) => [[r.iata, r] as const, ...r.altArrivalAirports.map((a) => [a.iata, r] as const)]),
);
const ALT_TO_PRIMARY = new Map(
  RESORTS.flatMap((r) => r.altArrivalAirports.map((a) => [a.iata, r.iata] as const)),
);

export const LEANS = [0, 25, 50, 75, 100] as const;

export interface BoughtFare {
  origin: string; destination: string; departDate: ISODate; price: number; fetchedAt: Date;
}
export interface Baseline {
  origin: string; destination: string; year: number; quarter: number;
  med: number; p25: number; p75: number; source: string; fetchedAt: Date | null;
}
export interface ScoreInputs {
  fares: BoughtFare[];
  baselines: Baseline[];
  trend: number | null;
  lean: number;
  /** Holiday premium percent by setting key (missing = the shipped default). */
  premiumPct: (key: string, fallback: number) => number;
}

export interface GroupScore {
  n: number;
  /** Median of (estimate / real - 1), in %. Positive = we read high. */
  medianPct: number | null;
  /** Median of |estimate / real - 1|, in %. How far off a typical fare is. */
  typicalOffPct: number | null;
  /** Share of fares the estimate landed within 15% of, in %. */
  within15Pct: number | null;
  /** The same two numbers at each lean, so the lean can be picked on evidence. */
  byLean: { lean: number; medianPct: number | null; typicalOffPct: number | null }[];
  /** The lean (of LEANS) with the smallest typical miss. */
  bestLean: number | null;
}

export interface RouteScore {
  origin: string; destination: string; resort: string; international: boolean;
  n: number; realMedian: number; estMedian: number; medianPct: number;
}

export interface Scoreboard {
  lean: number;
  trend: number | null;
  tested: number;
  skipped: { noBaseline: number; noTrend: number; builtFromIt: number };
  all: GroupScore; domestic: GroupScore; international: GroupScore;
  routes: RouteScore[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct1 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

/** The baseline loadBook would pick: same quarter (newest year), else the newest any quarter. */
function pickBaseline(list: Baseline[], quarter: number): Baseline | undefined {
  const same = list.filter((b) => b.quarter === quarter).sort((a, b) => b.year - a.year)[0];
  return same ?? [...list].sort((a, b) => b.year - a.year || b.quarter - a.quarter)[0];
}

/** Pure: score every bought fare against the blind estimate. */
export function scoreFares(inp: ScoreInputs): Scoreboard {
  const byRoute = new Map<string, Baseline[]>();
  for (const b of inp.baselines) {
    const k = `${b.origin}|${b.destination}`;
    byRoute.set(k, [...(byRoute.get(k) ?? []), b]);
  }
  const skipped = { noBaseline: 0, noTrend: 0, builtFromIt: 0 };
  type Test = { fare: BoughtFare; intl: boolean; resort: string; est: Record<number, number> };
  const tests: Test[] = [];

  for (const f of inp.fares) {
    const resort = RESORT_OF_AIRPORT.get(f.destination);
    if (!resort || !(f.price > 0)) continue;
    const q = quarterOf(f.departDate);
    const primary = ALT_TO_PRIMARY.get(f.destination);
    const list = byRoute.get(`${f.origin}|${f.destination}`)
      ?? (primary ? byRoute.get(`${f.origin}|${primary}`) : undefined);
    const h = list ? pickBaseline(list, q) : undefined;
    if (!h) { skipped.noBaseline++; continue; }
    const bts = h.source === "bts_db1b";
    if (bts && inp.trend === null) { skipped.noTrend++; continue; }
    // A baseline made from sampled fares can't be tested by a fare it was
    // made from, or bought before it.
    if (!bts && h.fetchedAt && f.fetchedAt <= h.fetchedAt) { skipped.builtFromIt++; continue; }
    const m = bts ? inp.trend! : 1;
    const hol = holidayFlightPremium(f.departDate);
    const prem = hol ? 1 + inp.premiumPct(hol.settingKey, hol.defaultPct) / 100 : 1;
    const band = { low: h.p25 * m, med: h.med * m, high: h.p75 * m };
    const est: Record<number, number> = {};
    for (const L of new Set([...LEANS, inp.lean])) est[L] = leanedFare(band, L) * prem;
    tests.push({ fare: f, intl: resort.region !== "dom", resort: resort.id, est });
  }

  const group = (ts: Test[]): GroupScore => {
    const errs = (L: number) => ts.map((t) => t.est[L]! / t.fare.price - 1);
    const at = (L: number) => {
      const e = errs(L);
      return { medianPct: pct1(median(e)), typicalOffPct: pct1(median(e.map(Math.abs))) };
    };
    const byLean = LEANS.map((lean) => ({ lean, ...at(lean) }));
    const cur = errs(inp.lean);
    const best = byLean.filter((b) => b.typicalOffPct !== null)
      .sort((a, b) => a.typicalOffPct! - b.typicalOffPct!)[0];
    return {
      n: ts.length,
      ...at(inp.lean),
      within15Pct: ts.length ? Math.round((cur.filter((e) => Math.abs(e) <= 0.15).length / ts.length) * 100) : null,
      byLean,
      bestLean: best?.lean ?? null,
    };
  };

  const routeMap = new Map<string, Test[]>();
  for (const t of tests) {
    const k = `${t.fare.origin}|${t.fare.destination}`;
    routeMap.set(k, [...(routeMap.get(k) ?? []), t]);
  }
  const routes: RouteScore[] = [...routeMap.values()].map((ts) => {
    const realMedian = median(ts.map((t) => t.fare.price))!;
    const estMedian = median(ts.map((t) => t.est[inp.lean]!))!;
    return {
      origin: ts[0]!.fare.origin, destination: ts[0]!.fare.destination, resort: ts[0]!.resort,
      international: ts[0]!.intl, n: ts.length,
      realMedian: Math.round(realMedian), estMedian: Math.round(estMedian),
      medianPct: pct1(median(ts.map((t) => t.est[inp.lean]! / t.fare.price - 1)))!,
    };
  }).sort((a, b) => Math.abs(b.medianPct) - Math.abs(a.medianPct) || b.n - a.n);

  return {
    lean: inp.lean, trend: inp.trend, tested: tests.length, skipped,
    all: group(tests), domestic: group(tests.filter((t) => !t.intl)),
    international: group(tests.filter((t) => t.intl)), routes,
  };
}

/** Loads the inputs and scores the last `days` days of bought fares. */
export async function loadScoreboard(db: Db, days = 30): Promise<Scoreboard & { days: number }> {
  const f = await db.query<{ origin: string; destination: string; depart_date: unknown; price_usd: string; fetched_at: unknown }>(
    `select origin, destination, depart_date, price_usd, fetched_at
       from flight_prices
      where source = 'serpapi_flights'
        and fetched_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const fares: BoughtFare[] = f.rows.map((r) => ({
    origin: r.origin.trim(), destination: r.destination.trim(), departDate: dateStr(r.depart_date),
    price: Number(r.price_usd), fetchedAt: r.fetched_at instanceof Date ? r.fetched_at : new Date(String(r.fetched_at)),
  }));
  const origins = [...new Set(fares.map((x) => x.origin))];
  const b = origins.length
    ? await db.query<{ origin: string; destination: string; year: number; quarter: number; median_fare_usd: string | null;
        avg_fare_usd: string; p25_fare_usd: string | null; p75_fare_usd: string | null; source: string | null; fetched_at: unknown }>(
        `select origin, destination, year, quarter, median_fare_usd, avg_fare_usd, p25_fare_usd, p75_fare_usd, source, fetched_at
           from historical_fares where origin = any($1)`,
        [origins],
      )
    : { rows: [] };
  const baselines: Baseline[] = [];
  for (const r of b.rows) {
    const med = Number(r.median_fare_usd ?? r.avg_fare_usd);
    if (!(med > 0)) continue;
    baselines.push({
      origin: r.origin.trim(), destination: r.destination.trim(), year: Number(r.year), quarter: Number(r.quarter),
      med, p25: Number(r.p25_fare_usd ?? med), p75: Number(r.p75_fare_usd ?? med),
      source: r.source ?? "bts_db1b",
      fetchedAt: r.fetched_at ? (r.fetched_at instanceof Date ? r.fetched_at : new Date(String(r.fetched_at))) : null,
    });
  }
  const t = await db.query<{ multiplier: string }>(`select multiplier from fare_trend order by computed_at desc limit 1`);
  const settings = await settingsMap(db);
  const board = scoreFares({
    fares, baselines,
    trend: t.rows[0] ? Number(t.rows[0].multiplier) : null,
    lean: settings.get(ESTIMATE_LEAN_KEY) ?? DEFAULT_ESTIMATE_LEAN,
    premiumPct: (key, fallback) => settings.get(key) ?? fallback,
  });
  return { ...board, days };
}
