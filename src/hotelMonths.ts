/**
 * Each Disney hotel learns its own price BY MONTH from Google's nightly
 * rates (owner, 2026-11-02: "Build hotel option 1 now").
 *
 * WHY. A Disney hotel's price here is the owner's base rate x one season
 * curve per resort, then nudged by ONE factor per hotel (checkFactors.ts:
 * the owner's price checks + Google's rates for that hotel). One factor per
 * hotel can't follow a hotel whose months move differently from the curve:
 * Pop Century read +53% in March, Tokyo Disneyland Hotel -31% to -54% in some
 * months, Hong Kong +22% high (2026-10-14). Google's "hotels near <resort>"
 * searches, already bought nightly, keep returning Disney's own hotels with
 * a real nightly rate; they sit in hotel_samples. This reads them by month.
 *
 * HOW. After the hotel's own factor, what's left over (Google's rate over
 * ours x that factor) is read in two steps, each a median shrunk toward
 * "no change" by n / (n + MONTH_SHRINK_K), like every other lever here:
 *  1. resort x calendar month: what all of that resort's Disney hotels say
 *     about, say, March (so a hotel with no March rates still moves with its
 *     neighbors);
 *  2. hotel x calendar month: what's left for that one hotel.
 * The two multiply, held within 0.5x-2x. A month with no Google rates at all
 * stays exactly as before.
 *
 * GRADED BEFORE IT SHIPS (governing rule 2). `gradeMonthLevers` re-prices
 * every hotel + month we hold Google rates for, with that hotel + month's
 * own rates LEFT OUT of everything it learns from, with and without the
 * month levers. The levers reach travelers only when they make our Disney
 * hotel prices typically closer to Google's (by MONTH_MARGIN points) on at
 * least MONTH_MIN_GROUPS hotel-months. The owner can turn them off
 * (`sources.hotel.monthLever` = 0). Nothing is overwritten: the base stays
 * the owner's and every Google rate stays in the record.
 */
import type { Db } from "./db.js";
import { HOTEL_MONTH_KEY, DEFAULT_HOTEL_MONTH, computeFactors, shrink, usableRatio, FACTOR_MIN, FACTOR_MAX, type CountedCheck } from "./checkFactors.js";
import { asEvidence, cachedGoogleDisneyRates, type GoogleDisneyRate } from "./disneyEvidence.js";
import { median } from "./fareCorrections.js";
import { RESORT_BY_ID } from "./config.js";

export { HOTEL_MONTH_KEY, DEFAULT_HOTEL_MONTH };
/** How many Google rates a month needs to move halfway. */
export const MONTH_SHRINK_K = 6;
/** The levers must beat the old way by this many points of "typically off". */
export const MONTH_MARGIN = 0.5;
/** ...on at least this many hotel-months. */
export const MONTH_MIN_GROUPS = 20;

export interface MonthLever { factor: number; n: number; medianRatio: number }
export interface MonthLevers {
  /** `${resortId}|${MM}` */
  resort: Map<string, MonthLever>;
  /** `${hotelId}|${MM}` */
  hotel: Map<string, MonthLever>;
}

const mm = (night: string) => night.slice(5, 7);
const clamp = (f: number) => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The month levers from Google's rates. `hotelFactor` is the hotel's own
 * all-months factor (price checks + Google), so the levers only learn what
 * that factor can't.
 */
export function fitMonthLevers(
  rates: GoogleDisneyRate[], hotelFactor: (hotelId: string) => number, k = MONTH_SHRINK_K,
): MonthLevers {
  const left = rates
    .filter((r) => r.ours !== null && r.ours > 0 && r.google > 0)
    .map((r) => ({ r, ratio: r.google / (r.ours! * hotelFactor(r.hotelId)) }))
    .filter((x) => usableRatio(x.ratio));
  const group = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return m;
  };
  const lever = (ratios: number[]): MonthLever => {
    const med = median(ratios)!;
    return { factor: r4(shrink(med, ratios.length, k)), n: ratios.length, medianRatio: r4(med) };
  };
  const resort = new Map<string, MonthLever>();
  for (const [key, xs] of group(left, (x) => `${x.r.resortId}|${mm(x.r.night)}`)) resort.set(key, lever(xs.map((x) => x.ratio)));
  const hotel = new Map<string, MonthLever>();
  for (const [key, xs] of group(left, (x) => `${x.r.hotelId}|${mm(x.r.night)}`)) {
    const rf = resort.get(`${xs[0]!.r.resortId}|${mm(xs[0]!.r.night)}`)?.factor ?? 1;
    hotel.set(key, lever(xs.map((x) => x.ratio / rf)));
  }
  return { resort, hotel };
}

/** The month factor for one Disney hotel on one night (1 = no change). */
export function monthFactor(levers: MonthLevers, resortId: string, hotelId: string, night: string): number {
  const m = mm(night);
  return clamp((levers.resort.get(`${resortId}|${m}`)?.factor ?? 1) * (levers.hotel.get(`${hotelId}|${m}`)?.factor ?? 1));
}

export interface MonthSide { groups: number; withinPct: number | null; typicalOffPct: number | null }
export interface MonthGrade {
  /** One hotel + month = one graded number. */
  groups: number;
  without: MonthSide; with: MonthSide;
  us: { without: MonthSide; with: MonthSide };
  intl: { without: MonthSide; with: MonthSide };
  /** Per resort, "typically off" without -> with. */
  byResort: { resortId: string; groups: number; without: number | null; with: number | null }[];
  /** True when the levers earn their place (see the top of the file). */
  better: boolean;
}

export interface MonthGradeOpts {
  checks: CountedCheck[]; googleWeight: number; priorWeight: number;
  hotelBase: (id: string) => number | undefined;
  zone: number; k?: number;
}

/**
 * Leave-one-out: for every hotel + travel month we hold Google rates for,
 * fit everything (hotel factors AND month levers) without that hotel +
 * month's rates, then compare our price with the median of Google's.
 */
export function gradeMonthLevers(rates: GoogleDisneyRate[], o: MonthGradeOpts): MonthGrade {
  const usable = rates.filter((r) => r.ours !== null && r.ours > 0 && r.google > 0);
  const groups = new Map<string, GoogleDisneyRate[]>();
  for (const r of usable) {
    const key = `${r.hotelId}|${r.night.slice(0, 7)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  type Row = { resortId: string; us: boolean; off0: number; off1: number };
  const rows: Row[] = [];
  for (const [key, rs] of groups) {
    const rest = usable.filter((r) => `${r.hotelId}|${r.night.slice(0, 7)}` !== key);
    const factors = computeFactors(o.checks.concat(asEvidence(rest, o.googleWeight)),
      { priorWeight: o.priorWeight, hotelBase: o.hotelBase });
    const hf = (id: string) => factors.get(`hotel|${id}`)?.factor ?? 1;
    const levers = fitMonthLevers(rest, hf, o.k);
    const real = median(rs.map((r) => r.google))!;
    const shown0 = median(rs.map((r) => r.ours! * hf(r.hotelId)))!;
    const shown1 = median(rs.map((r) => r.ours! * hf(r.hotelId) * monthFactor(levers, r.resortId, r.hotelId, r.night)))!;
    rows.push({ resortId: rs[0]!.resortId, us: RESORT_BY_ID.get(rs[0]!.resortId)?.region === "dom",
      off0: Math.abs(shown0 / real - 1), off1: Math.abs(shown1 / real - 1) });
  }
  const side = (xs: Row[], pick: (r: Row) => number): MonthSide => ({
    groups: xs.length,
    withinPct: xs.length ? Math.round((xs.filter((r) => pick(r) <= o.zone + 1e-9).length / xs.length) * 100) : null,
    typicalOffPct: xs.length ? Math.round(median(xs.map(pick))! * 1000) / 10 : null,
  });
  const pair = (xs: Row[]) => ({ without: side(xs, (r) => r.off0), with: side(xs, (r) => r.off1) });
  const all = pair(rows);
  const resorts = [...new Set(rows.map((r) => r.resortId))].sort();
  const byResort = resorts.map((id) => {
    const xs = rows.filter((r) => r.resortId === id), p = pair(xs);
    return { resortId: id, groups: xs.length, without: p.without.typicalOffPct, with: p.with.typicalOffPct };
  });
  const better = rows.length >= MONTH_MIN_GROUPS
    && all.with.typicalOffPct !== null && all.without.typicalOffPct !== null
    && all.with.typicalOffPct <= all.without.typicalOffPct - MONTH_MARGIN;
  return { groups: rows.length, ...all, us: pair(rows.filter((r) => r.us)), intl: pair(rows.filter((r) => !r.us)), byResort, better };
}

export interface LoadedMonthLevers { levers: MonthLevers; grade: MonthGrade; use: boolean; setting: number }

/* Grading refits once per hotel-month, so the GRADE is kept for a few
 * minutes per database. The levers themselves are cheap and fitted fresh on
 * every call, against the caller's own hotel factors. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new WeakMap<object, { at: number; key: string; grade: MonthGrade }>();

/**
 * The levers as travelers get them. `hotelFactor` is the book's own factor
 * per hotel (what loadCheckFactors produced); `opts` is what the grade
 * refits with. Any failure leaves Disney hotels priced exactly as before.
 */
export async function loadMonthLevers(
  db: Db, settings: Map<string, number>, hotelFactor: (id: string) => number, opts: Omit<MonthGradeOpts, "zone"> & { zone?: number },
): Promise<LoadedMonthLevers | null> {
  const setting = settings.get(HOTEL_MONTH_KEY) ?? DEFAULT_HOTEL_MONTH;
  try {
    const rates = await cachedGoogleDisneyRates(db);
    const key = JSON.stringify([opts.googleWeight, opts.priorWeight, opts.checks.length, opts.zone ?? 0.1, rates.length]);
    const hit = cache.get(db);
    let grade: MonthGrade;
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) grade = hit.grade;
    else {
      grade = gradeMonthLevers(rates, { ...opts, zone: opts.zone ?? 0.1 });
      cache.set(db, { at: Date.now(), key, grade });
    }
    return { levers: fitMonthLevers(rates, hotelFactor, opts.k), grade, use: setting >= 1 && grade.better, setting };
  } catch {
    return null;
  }
}
export function clearMonthLeverCache(db: Db): void { cache.delete(db); }

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Plain lines for the coverage report and /admin. */
export function monthLeverLines(m: LoadedMonthLevers): string[] {
  const g = m.grade;
  const side = (name: string, s: { without: MonthSide; with: MonthSide }) => s.without.groups
    ? `${name} (${s.without.groups} hotel-months): old way ${s.without.withinPct}% within ±10% / typically off ${s.without.typicalOffPct}%; by month ${s.with.withinPct}% / ${s.with.typicalOffPct}%`
    : `${name}: no Google rates for Disney hotels yet`;
  const status = m.setting < 1 ? "OFF (the owner's switch in Rates & settings)"
    : g.better ? "IN USE: it tests closer to Google than the old way"
    : g.groups < MONTH_MIN_GROUPS ? `not used yet: ${g.groups} hotel-months graded, needs ${MONTH_MIN_GROUPS}`
    : `not used: it does not test at least ${MONTH_MARGIN} points closer than the old way`;
  const moves = [...m.levers.resort.entries()].filter(([, v]) => v.n >= 3)
    .sort((a, b) => Math.abs(Math.log(b[1].factor)) - Math.abs(Math.log(a[1].factor))).slice(0, 8)
    .map(([k, v]) => { const [r, mo] = k.split("|"); return `${r} ${MONTH_NAMES[Number(mo)]} x${v.factor.toFixed(2)} (${v.n})`; });
  return [
    `Status: ${status}`,
    side("All Disney hotels", g),
    side("US", g.us),
    side("International", g.intl),
    `By resort, typically off old -> by month: ${g.byResort.map((r) => `${r.resortId} ${r.without}% -> ${r.with}% (${r.groups})`).join(" · ") || "none"}`,
    `Biggest resort-month moves (Google rates behind each): ${moves.join(" · ") || "none yet"}`,
  ];
}
