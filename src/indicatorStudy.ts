/**
 * Indicator study (owner, 2026-10-10: "We need to find indicators that
 * actually move the price and use the data we have access to to inform that
 * ... give it its own tab on /admin so I know what to focus on").
 *
 * READ-ONLY. Fits a ridge regression on log(fare) over every paid fare in
 * the record (flight_observations, serpapi_flights) and reports, per
 * indicator, how much it moves the price, how sure we are, and whether the
 * model as a whole beats a plain one on fares it did NOT train on. Nothing
 * here changes a price; it tells the owner (and Claude) where to dig.
 *
 * Why log(price): effects on fares are multiplicative ("a summer trip costs
 * 20% more", not "$200 more" on both a $300 and a $1,500 fare), and on the
 * log scale every coefficient reads as a percentage.
 *
 * Why ridge and not a boosted tree yet: a few hundred fares. A tree that size
 * memorizes; ridge (a regression that is penalized for leaning hard on any
 * one indicator) stays honest at small sizes, and its numbers are readable.
 *
 * Honesty, built in:
 *  - Accuracy is measured by 5-fold cross-validation: each fare is predicted
 *    by a model that never saw it.
 *  - Each effect's confidence comes from 200 bootstrap refits (resample the
 *    fares, refit, see how much the effect wobbles). An effect whose sign
 *    flips across refits is "not yet", however big it looks.
 *  - An indicator that doesn't vary in our data (every paid fare departs on
 *    the 15th, so day of week barely varies) is reported as "can't tell yet",
 *    not as "no effect".
 */
import type { Db } from "./db.js";
import { loadHomeFareLevels } from "./airportFares.js";
import { ALL_ORIGINS, RESORTS } from "./config.js";
import { haversineMiles } from "./geo.js";
import { holidayFlightPremium } from "./holidayWindows.js";

/* ------------------------------ the maths ------------------------------ */

/** Solves A x = b by Gaussian elimination with partial pivoting. A is n x n. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-12) throw new Error("singular system");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      if (f) for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

export interface RidgeFit { intercept: number; beta: number[]; means: number[]; sds: number[] }

/** Ridge on standardized columns (intercept not penalized); coefficients are
 *  returned in the ORIGINAL units. Columns with no spread get beta 0. */
export function fitRidge(X: number[][], y: number[], lambda = 1): RidgeFit {
  const n = X.length, p = X[0]?.length ?? 0;
  const means = Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / n);
  const sds = Array.from({ length: p }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - means[j]!) ** 2, 0) / n));
  const live = sds.map((s) => s > 1e-9);
  const cols = live.map((l, j) => (l ? j : -1)).filter((j) => j >= 0);
  const Z = X.map((r) => cols.map((j) => (r[j]! - means[j]!) / sds[j]!));
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const k = cols.length;
  const A = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) =>
    Z.reduce((s, r) => s + r[a]! * r[b]!, 0) + (a === b ? lambda : 0)));
  const rhs = Array.from({ length: k }, (_, a) => Z.reduce((s, r, i) => s + r[a]! * (y[i]! - yMean), 0));
  const bStd = k ? solve(A, rhs) : [];
  const beta = new Array(p).fill(0);
  cols.forEach((j, a) => { beta[j] = bStd[a]! / sds[j]!; });
  const intercept = yMean - beta.reduce((s, b, j) => s + b * means[j]!, 0);
  return { intercept, beta, means, sds };
}

export const predictLog = (f: RidgeFit, x: number[]) => f.intercept + f.beta.reduce((s, b, j) => s + b * x[j]!, 0);

/** A tiny seeded random, so the study gives the same answer twice. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Median and share-within-10% of |predicted - real| / real, each fare
 *  predicted by a model fitted WITHOUT its fold. */
export function crossValidate(X: number[][], y: number[], folds = 5, lambda = 1, seed = 7) {
  const n = y.length;
  if (n < folds * 3) return null;
  const r = rng(seed);
  const order = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5);
  const errs: number[] = [];
  for (let f = 0; f < folds; f++) {
    const test = new Set(order.filter((_, i) => i % folds === f));
    const tr = order.filter((i) => !test.has(i));
    const fit = fitRidge(tr.map((i) => X[i]!), tr.map((i) => y[i]!), lambda);
    for (const i of test) {
      const pred = Math.exp(predictLog(fit, X[i]!)), real = Math.exp(y[i]!);
      errs.push(Math.abs(pred - real) / real);
    }
  }
  errs.sort((a, b) => a - b);
  return {
    medianOffPct: Math.round(errs[Math.floor(errs.length / 2)]! * 1000) / 10,
    within10Pct: Math.round((errs.filter((e) => e <= 0.10).length / errs.length) * 100),
  };
}

/* ---------------------------- the indicators ---------------------------- */

export interface Indicator {
  key: string;
  /** Plain-language name. */
  label: string;
  /** What one "unit" of it means, for the effect sentence. */
  unit: string;
  /** How big a step the effect is quoted for, in the column's own units. */
  step: number;
  /** Where the number comes from. */
  source: string;
}

export const INDICATORS: Indicator[] = [
  { key: "miles", label: "Flight distance", unit: "1,000 more miles", step: 1, source: "Airport locations" },
  { key: "europe", label: "Going to Europe (vs a US resort)", unit: "Europe instead of the US", step: 1, source: "Destination" },
  { key: "asia", label: "Going to Asia (vs a US resort)", unit: "Asia instead of the US", step: 1, source: "Destination" },
  { key: "q2", label: "Traveling April–June", unit: "April–June instead of January–March", step: 1, source: "Travel date" },
  { key: "q3", label: "Traveling July–September", unit: "July–September instead of January–March", step: 1, source: "Travel date" },
  { key: "q4", label: "Traveling October–December", unit: "October–December instead of January–March", step: 1, source: "Travel date" },
  { key: "weekend", label: "Leaving Friday–Sunday", unit: "a Friday–Sunday departure", step: 1, source: "Travel date" },
  { key: "holiday", label: "Thanksgiving or Christmas week", unit: "a holiday-week departure", step: 1, source: "Travel date" },
  { key: "lead", label: "How far ahead it was searched", unit: "30 more days ahead", step: 1, source: "Search date vs travel date" },
  { key: "hub", label: "Size of the home airport", unit: "a home airport 10 times busier", step: 1, source: "Government fare survey passengers" },
  // Owner, 2026-10-10: does a home airport that's dear in general mean dear
  // to Disney too? BTS's average fare per airport, all destinations
  // (airportFares.ts). 400 is roughly BTS's national average.
  { key: "homeLevel", label: "Home airport's general price level", unit: "a home airport whose average fare is 10% higher", step: Math.log(1.1), source: "Government average fare per airport (your BTS tables)" },
  { key: "googleTypical", label: "Google's typical price for the route", unit: "a Google typical price twice as high", step: Math.log(2), source: "Google's answer to the same search" },
];

export interface FareRow {
  origin: string; destination: string; departDate: string; observedAt: string; price: number;
  googleTypicalMid?: number | null;
}

const DEST_BY_IATA = new Map<string, { lat: number; lon: number; region: string }>();
for (const r of RESORTS) {
  for (const code of [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]) {
    DEST_BY_IATA.set(code, { lat: r.lat, lon: r.lon, region: r.region });
  }
}
const ORIGIN_BY = new Map(ALL_ORIGINS.map((o) => [o.iata, o]));

/** One fare's indicator values, in INDICATORS order (googleTypical last), or
 *  null when the fare can't be placed (unknown airport). */
export function featuresOf(
  row: FareRow, hubPax: Map<string, number>, withGoogle: boolean, homeFare: Map<string, number> = new Map(),
): number[] | null {
  const o = ORIGIN_BY.get(row.origin), d = DEST_BY_IATA.get(row.destination);
  if (!o || !d) return null;
  const month = Number(row.departDate.slice(5, 7));
  const q = Math.ceil(month / 3);
  const dow = new Date(row.departDate + "T00:00:00Z").getUTCDay();
  const leadDays = (Date.parse(row.departDate + "T00:00:00Z") - Date.parse(row.observedAt)) / 86_400_000;
  const x = [
    haversineMiles(o.lat, o.lon, d.lat, d.lon) / 1000,
    d.region === "atl" ? 1 : 0,
    d.region === "pac" ? 1 : 0,
    q === 2 ? 1 : 0, q === 3 ? 1 : 0, q === 4 ? 1 : 0,
    dow === 5 || dow === 6 || dow === 0 ? 1 : 0,
    holidayFlightPremium(row.departDate as never) ? 1 : 0,
    leadDays / 30,
    Math.log10((hubPax.get(row.origin) ?? 0) + 1),
    // No figure for an airport = the national average, so it moves nothing.
    Math.log((homeFare.get(row.origin) ?? 400) / 400),
  ];
  if (withGoogle) {
    if (!row.googleTypicalMid || row.googleTypicalMid <= 0) return null;
    x.push(Math.log(row.googleTypicalMid));
  }
  return x;
}

export interface Effect {
  key: string; label: string; unit: string; source: string;
  effectPct: number | null; lowPct: number | null; highPct: number | null;
  agreePct: number | null; verdict: "solid" | "maybe" | "not yet" | "can't tell yet";
  /** How much this indicator moves prices across the spread we actually see,
   *  as a percentage. The ranking for "what to focus on". */
  weightPct: number | null;
  sentence: string;
}

export interface StudyResult {
  model: "structure" | "withGoogle";
  fares: number;
  cv: { medianOffPct: number; within10Pct: number } | null;
  plainCv: { medianOffPct: number; within10Pct: number } | null;
  effects: Effect[];
}

const pct = (v: number) => (Math.round((Math.exp(v) - 1) * 1000) / 10) || 0;

/** The whole study for one set of rows. Pure; exported for its test. */
export function runStudy(rows: number[][], prices: number[], indicators: Indicator[], model: StudyResult["model"], boots = 200): StudyResult {
  const y = prices.map((p) => Math.log(p));
  const fit = fitRidge(rows, y);
  const cv = crossValidate(rows, y);
  // The "plain" comparison: region only (Europe, Asia), i.e. one price per
  // part of the world. If the full model can't beat this, nothing here is
  // pulling its weight yet.
  const plainCv = crossValidate(rows.map((r) => [r[1]!, r[2]!]), y);
  const r = rng(11);
  const n = rows.length;
  const draws: number[][] = indicators.map(() => []);
  for (let b = 0; b < boots && n >= 10; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(r() * n));
    try {
      const bf = fitRidge(idx.map((i) => rows[i]!), idx.map((i) => y[i]!));
      bf.beta.forEach((v, j) => draws[j]!.push(v));
    } catch { /* a degenerate resample; skip it */ }
  }
  const effects: Effect[] = indicators.map((ind, j) => {
    const sd = fit.sds[j]!;
    if (!(sd > 1e-9)) {
      return { key: ind.key, label: ind.label, unit: ind.unit, source: ind.source, effectPct: null, lowPct: null,
        highPct: null, agreePct: null, verdict: "can't tell yet", weightPct: null,
        sentence: `Our paid fares don't vary on this yet, so we can't measure it.` };
    }
    const beta = fit.beta[j]!;
    const d = [...draws[j]!].sort((a, b) => a - b);
    const lo = d.length ? d[Math.floor(d.length * 0.1)]! : beta;
    const hi = d.length ? d[Math.floor(d.length * 0.9)]! : beta;
    const agree = d.length ? Math.round((d.filter((v) => Math.sign(v) === Math.sign(beta)).length / d.length) * 100) : 0;
    const verdict: Effect["verdict"] = agree >= 90 && Math.sign(lo) === Math.sign(hi) ? "solid" : agree >= 75 ? "maybe" : "not yet";
    const e = pct(beta * ind.step);
    const sentence = verdict === "not yet"
      ? `No reliable effect yet: refits disagree on whether ${ind.unit} raises or lowers the fare.`
      : `${ind.unit[0]!.toUpperCase() + ind.unit.slice(1)} ${e >= 0 ? "raises" : "lowers"} the fare about ${Math.abs(e)}%`
        + ` (likely between ${pct(lo * ind.step)}% and ${pct(hi * ind.step)}%).`;
    return {
      key: ind.key, label: ind.label, unit: ind.unit, source: ind.source,
      effectPct: e, lowPct: pct(lo * ind.step), highPct: pct(hi * ind.step), agreePct: agree, verdict,
      weightPct: Math.round(Math.abs(pct(beta * sd))),
      sentence,
    };
  });
  effects.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1));
  return { model, fares: n, cv, plainCv, effects };
}

/* ------------------------------ the loader ------------------------------ */

export async function loadIndicatorStudy(db: Db) {
  const fares = (await db.query<{ origin: string; destination: string; depart_date: unknown; observed_at: unknown; price_usd: string; lo: string | null; hi: string | null }>(
    `select o.origin, o.destination, o.depart_date, o.observed_at, o.price_usd, i.typical_low as lo, i.typical_high as hi
       from flight_observations o
       left join lateral (
         select typical_low, typical_high from flight_insights i
          where i.origin = o.origin and i.destination = o.destination
            and i.depart_date = o.depart_date and i.trip_length = o.trip_length
            and abs(extract(epoch from (i.observed_at - o.observed_at))) < 3600
          order by i.observed_at desc limit 1
       ) i on true
      where o.source = 'serpapi_flights' and o.price_usd > 0`,
  )).rows;
  const hub = (await db.query<{ origin: string; pax: string }>(
    `select origin, sum(passengers_sampled) as pax from historical_fares
      where source like 'bts%' group by origin`,
  )).rows;
  const hubPax = new Map(hub.map((h) => [h.origin, Number(h.pax)]));
  const homeFare = await loadHomeFareLevels(db).catch(() => new Map<string, number>());
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  const rows: FareRow[] = fares.map((f) => ({
    origin: f.origin.trim(), destination: f.destination.trim(),
    departDate: iso(f.depart_date).slice(0, 10), observedAt: iso(f.observed_at),
    price: Number(f.price_usd),
    googleTypicalMid: f.lo != null && f.hi != null ? (Number(f.lo) + Number(f.hi)) / 2 : null,
  }));

  const build = (withGoogle: boolean) => {
    const X: number[][] = [], P: number[] = [];
    for (const r of rows) {
      const x = featuresOf(r, hubPax, withGoogle, homeFare);
      if (x) { X.push(x); P.push(r.price); }
    }
    return { X, P };
  };
  const a = build(false);
  const b = build(true);
  const structure = a.X.length >= 15 ? runStudy(a.X, a.P, INDICATORS.slice(0, -1), "structure") : null;
  const withGoogle = b.X.length >= 15 ? runStudy(b.X, b.P, INDICATORS, "withGoogle") : null;
  return { fares: rows.length, structure, withGoogle, ranAt: new Date().toISOString() };
}
