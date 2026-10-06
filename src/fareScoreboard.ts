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
import { leanedFare, quotedEstimate, ESTIMATE_LEAN_KEY, INTL_ESTIMATE_LEAN_KEY, DEFAULT_ESTIMATE_LEAN } from "./pricing.js";
import { loadBook } from "./book.js";
import { leaveOneOut, USE_CANDIDATE_KEY, ZONE_PCT_KEY, DEFAULT_ZONE_PCT } from "./fareModel.js";
import { loadModelInputs } from "./fareModelDb.js";
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
  /** The international trend, for seeded guesses (seed_guess). Null = none yet, so 1. */
  intlTrend?: number | null;
  /** The US lean. */
  lean: number;
  /** The international lean (unset in settings = the US one). */
  leanIntl?: number;
  /**
   * What a traveler is shown TODAY for this route and date, if we had not
   * bought it: the estimate with every correction applied (bought fares on
   * the route, the owner's corrections, price checks), leaned and with the
   * holiday premium. Keyed `${origin}|${destination}|${departDate}`.
   */
  shownNow?: Map<string, number>;
  /** The candidate formula's estimate for each fare, fitted WITHOUT that
   *  fare (fareModel.leaveOneOut). Same keys as shownNow. */
  candidate?: Map<string, number>;
  /** "Accurate" = within this many percent either way. */
  zonePct?: number;
  /** Which formula travelers see now. */
  useCandidate?: boolean;
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
  /** What travelers see now (see ScoreInputs.shownNow), and its miss. */
  shownMedian: number | null; shownPct: number | null;
  /** The candidate formula, graded on fares it did not learn from. */
  candMedian: number | null; candPct: number | null;
  /** Travel months of the fares tested (YYYY-MM), for buying more there. */
  months: string[];
}

/**
 * The owner's yardstick (2026-10-06): within ±zone% is accurate, and a miss
 * is a miss in EITHER direction ("a $100 surprise either way is the same").
 */
export interface ZoneScore {
  n: number;
  inZonePct: number | null; within5Pct: number | null;
  /** Read low / high by more than the zone. */
  lowPct: number | null; highPct: number | null;
  typicalOffPct: number | null;
  /** Median signed miss: + = reads high. Should sit near 0. */
  medianPct: number | null;
}
export interface MethodScores { all: ZoneScore; domestic: ZoneScore; international: ZoneScore;
  /** US reading minus international reading, in points. Far from 0 = the
   *  comparison itself is tilted (e.g. Orlando reads low while Tokyo reads high). */
  tilt: number | null }

/** "Now that we've bought fares, how far off are the numbers we show?" */
export interface ShownScore {
  n: number; medianPct: number | null; typicalOffPct: number | null; within15Pct: number | null;
}

export interface Scoreboard {
  lean: number;
  leanIntl: number;
  trend: number | null;
  tested: number;
  skipped: { noBaseline: number; noTrend: number; builtFromIt: number };
  all: GroupScore; domestic: GroupScore; international: GroupScore;
  shown: { all: ShownScore; domestic: ShownScore; international: ShownScore };
  zonePct: number;
  useCandidate: boolean;
  /** Live (what travelers see with the switch off) vs the candidate vs blind. */
  compare: { live: MethodScores; candidate: MethodScores; blind: MethodScores };
  /** Last 14 days by the day fares were bought: share in the zone. */
  daily: { day: string; n: number; live: number | null; candidate: number | null }[];
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
  const leanIntl = inp.leanIntl ?? inp.lean;
  const zone = (inp.zonePct ?? DEFAULT_ZONE_PCT) / 100;
  type Test = { fare: BoughtFare; intl: boolean; resort: string; est: Record<number, number>; cur: number; shown?: number; cand?: number };
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
    const seed = h.source === "seed_guess";
    if (bts && inp.trend === null) { skipped.noTrend++; continue; }
    // A baseline made from sampled fares can't be tested by a fare it was
    // made from, or bought before it. (A seeded guess was made from none.)
    if (!bts && !seed && h.fetchedAt && f.fetchedAt <= h.fetchedAt) { skipped.builtFromIt++; continue; }
    const m = bts ? inp.trend! : seed ? (inp.intlTrend ?? 1) : 1;
    const hol = holidayFlightPremium(f.departDate);
    const prem = hol ? 1 + inp.premiumPct(hol.settingKey, hol.defaultPct) / 100 : 1;
    const band = { low: h.p25 * m, med: h.med * m, high: h.p75 * m };
    const est: Record<number, number> = {};
    for (const L of LEANS) est[L] = leanedFare(band, L) * prem;
    const intl = resort.region !== "dom";
    const cur = leanedFare(band, intl ? leanIntl : inp.lean) * prem;
    const key = `${f.origin}|${f.destination}|${f.departDate}`;
    const shown = inp.shownNow?.get(key);
    const cand = inp.candidate?.get(key);
    tests.push({ fare: f, intl, resort: resort.id, est, cur, shown, cand });
  }

  const group = (ts: Test[]): GroupScore => {
    const errs = (L: number) => ts.map((t) => t.est[L]! / t.fare.price - 1);
    const at = (L: number) => {
      const e = errs(L);
      return { medianPct: pct1(median(e)), typicalOffPct: pct1(median(e.map(Math.abs))) };
    };
    const byLean = LEANS.map((lean) => ({ lean, ...at(lean) }));
    const cur = ts.map((t) => t.cur / t.fare.price - 1);
    const best = byLean.filter((b) => b.typicalOffPct !== null)
      .sort((a, b) => a.typicalOffPct! - b.typicalOffPct!)[0];
    return {
      n: ts.length,
      medianPct: pct1(median(cur)),
      typicalOffPct: pct1(median(cur.map(Math.abs))),
      within15Pct: ts.length ? Math.round((cur.filter((e) => Math.abs(e) <= 0.15).length / ts.length) * 100) : null,
      byLean,
      bestLean: best?.lean ?? null,
    };
  };

  const shownGroup = (ts: Test[]): ShownScore => {
    const e = ts.filter((t) => t.shown !== undefined).map((t) => t.shown! / t.fare.price - 1);
    return {
      n: e.length,
      medianPct: pct1(median(e)),
      typicalOffPct: pct1(median(e.map(Math.abs))),
      within15Pct: e.length ? Math.round((e.filter((x) => Math.abs(x) <= 0.15).length / e.length) * 100) : null,
    };
  };

  const zoneScore = (errs: number[]): ZoneScore => {
    const share = (pred: (e: number) => boolean) =>
      errs.length ? Math.round((errs.filter(pred).length / errs.length) * 100) : null;
    return {
      n: errs.length,
      inZonePct: share((e) => Math.abs(e) <= zone + 1e-9),
      within5Pct: share((e) => Math.abs(e) <= 0.05 + 1e-9),
      lowPct: share((e) => e < -zone - 1e-9),
      highPct: share((e) => e > zone + 1e-9),
      typicalOffPct: errs.length ? pct1(median(errs.map(Math.abs))) : null,
      medianPct: errs.length ? pct1(median(errs)) : null,
    };
  };
  const method = (pick: (t: Test) => number | undefined): MethodScores => {
    const errs = (ts: Test[]) => ts.flatMap((t) => { const v = pick(t); return v === undefined ? [] : [v / t.fare.price - 1]; });
    const dom = zoneScore(errs(tests.filter((t) => !t.intl)));
    const intl = zoneScore(errs(tests.filter((t) => t.intl)));
    return {
      all: zoneScore(errs(tests)), domestic: dom, international: intl,
      tilt: dom.medianPct !== null && intl.medianPct !== null ? Math.round((dom.medianPct - intl.medianPct) * 10) / 10 : null,
    };
  };
  const compare = {
    live: method((t) => t.shown), candidate: method((t) => t.cand), blind: method((t) => t.cur),
  };
  const days = [...new Set(tests.map((t) => t.fare.fetchedAt.toISOString().slice(0, 10)))].sort().slice(-14);
  const inZone = (ts: Test[], pick: (t: Test) => number | undefined) => {
    const e = ts.flatMap((t) => { const v = pick(t); return v === undefined ? [] : [Math.abs(v / t.fare.price - 1)]; });
    return e.length ? Math.round((e.filter((x) => x <= zone + 1e-9).length / e.length) * 100) : null;
  };
  const daily = days.map((day) => {
    const ts = tests.filter((t) => t.fare.fetchedAt.toISOString().slice(0, 10) === day);
    return { day, n: ts.length, live: inZone(ts, (t) => t.shown), candidate: inZone(ts, (t) => t.cand) };
  });

  const routeMap = new Map<string, Test[]>();
  for (const t of tests) {
    const k = `${t.fare.origin}|${t.fare.destination}`;
    routeMap.set(k, [...(routeMap.get(k) ?? []), t]);
  }
  const routes: RouteScore[] = [...routeMap.values()].map((ts) => {
    const realMedian = median(ts.map((t) => t.fare.price))!;
    const estMedian = median(ts.map((t) => t.cur))!;
    const withShown = ts.filter((t) => t.shown !== undefined);
    const shownMedian = median(withShown.map((t) => t.shown!));
    const withCand = ts.filter((t) => t.cand !== undefined);
    const candMedian = median(withCand.map((t) => t.cand!));
    return {
      origin: ts[0]!.fare.origin, destination: ts[0]!.fare.destination, resort: ts[0]!.resort,
      international: ts[0]!.intl, n: ts.length,
      realMedian: Math.round(realMedian), estMedian: Math.round(estMedian),
      medianPct: pct1(median(ts.map((t) => t.cur / t.fare.price - 1)))!,
      shownMedian: shownMedian === null ? null : Math.round(shownMedian),
      shownPct: pct1(median(withShown.map((t) => t.shown! / t.fare.price - 1))),
      candMedian: candMedian === null ? null : Math.round(candMedian),
      candPct: pct1(median(withCand.map((t) => t.cand! / t.fare.price - 1))),
      months: [...new Set(ts.map((t) => t.fare.departDate.slice(0, 7)))].sort(),
    };
  })
    // Furthest off by what travelers SEE now (the candidate's number once the
    // owner has switched to it), where we know it; the blind number only
    // orders routes we couldn't rebuild.
    .sort((a, b) => {
      const seen = (r: RouteScore) => Math.abs((inp.useCandidate ? r.candPct : r.shownPct) ?? r.shownPct ?? r.medianPct);
      return seen(b) - seen(a) || b.n - a.n;
    });

  return {
    lean: inp.lean, leanIntl, trend: inp.trend, tested: tests.length, skipped,
    zonePct: Math.round(zone * 100), useCandidate: !!inp.useCandidate, compare, daily,
    all: group(tests), domestic: group(tests.filter((t) => !t.intl)),
    international: group(tests.filter((t) => t.intl)),
    shown: {
      all: shownGroup(tests), domestic: shownGroup(tests.filter((t) => !t.intl)),
      international: shownGroup(tests.filter((t) => t.intl)),
    },
    routes,
  };
}

/** Loads the inputs and scores the last `days` days of bought fares. */
export async function loadScoreboard(db: Db, days = 30): Promise<Scoreboard & { days: number }> {
  // Every paid fare in the record (flight_observations), not only the latest
  // per date in the working copy: a re-bought date is a second test.
  const inputs = await loadModelInputs(db, Math.max(days, 90));
  const since = Date.now() - days * 86_400_000;
  const testIdx = inputs.fares.flatMap((x, i) => (x.observedAt.getTime() > since ? [i] : []));
  const fares: BoughtFare[] = testIdx.map((i) => {
    const x = inputs.fares[i]!;
    return { origin: x.origin, destination: x.destination, departDate: x.departDate, price: x.price, fetchedAt: x.observedAt };
  });
  const loo = leaveOneOut(inputs, testIdx);
  const candidate = new Map<string, number>();
  for (const [i, v] of loo) {
    const x = inputs.fares[i]!;
    candidate.set(`${x.origin}|${x.destination}|${x.departDate}`, v);
  }
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
  const latest = async (kind: string) => {
    const t = await db.query<{ multiplier: string }>(
      `select multiplier from fare_trend where kind = $1 order by computed_at desc limit 1`, [kind]);
    return t.rows[0] ? Number(t.rows[0].multiplier) : null;
  };
  const settings = await settingsMap(db);
  const lean = settings.get(ESTIMATE_LEAN_KEY) ?? DEFAULT_ESTIMATE_LEAN;
  const board = scoreFares({
    fares, baselines,
    trend: await latest("domestic"),
    intlTrend: await latest("intl"),
    lean,
    leanIntl: settings.get(INTL_ESTIMATE_LEAN_KEY) ?? lean,
    shownNow: await shownNow(db, fares),
    candidate,
    zonePct: settings.get(ZONE_PCT_KEY) ?? DEFAULT_ZONE_PCT,
    useCandidate: settings.get(USE_CANDIDATE_KEY) === 1,
    premiumPct: (key, fallback) => settings.get(key) ?? fallback,
  });
  return { ...board, days };
}

/**
 * What a traveler sees today for each bought fare's route and date, had we
 * not bought that date: the same estimate the board shows (quotedEstimate),
 * from a fresh price book, so every correction counts — bought fares on the
 * route (ROUTE_CORRECTION in book.ts), the owner's fare corrections and price
 * checks. One book per origin and travel quarter, since a route correction
 * is per quarter. Partly graded by the same fares it learned from, so it
 * reads kinder than a fare we've never bought; the page says so.
 */
async function shownNow(db: Db, fares: BoughtFare[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const groups = new Map<string, BoughtFare[]>();
  for (const f of fares) {
    if (!RESORT_OF_AIRPORT.has(f.destination)) continue;
    const k = `${f.origin}|${f.departDate.slice(0, 4)}Q${quarterOf(f.departDate)}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const list of groups.values()) {
    const dests = [...new Set(list.map((f) => f.destination))];
    const day = list[0]!.departDate;
    try {
      const book = await loadBook(db, {
        origin: list[0]!.origin, destinations: dests,
        resortIds: [...new Set(dests.map((d) => RESORT_OF_AIRPORT.get(d)!.id))],
        from: day, to: day, tripLength: 7,
      }, { formula: "live" });
      for (const f of list) {
        const v = quotedEstimate(book, f.origin, f.destination, f.departDate);
        if (v !== undefined) out.set(`${f.origin}|${f.destination}|${f.departDate}`, v);
      }
    } catch (e) {
      // A book that won't load leaves those fares off this column only.
      console.warn(`scoreboard: shown-now skipped for ${list[0]!.origin}: ${(e as Error).message}`);
    }
  }
  return out;
}
