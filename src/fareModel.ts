/**
 * The CANDIDATE flight-estimate formula (owner, 2026-10-06).
 *
 * It runs beside the live formula in book.ts and is graded every day on the
 * Flights scoreboard against fares it did NOT learn from. Travelers only see
 * it when the owner flips `flight.useCandidate` in /admin. The owner's goal:
 * within 5-10% of the real fare, and "a $100 surprise EITHER WAY" is equally
 * wrong, because reading low on Orlando and high on Tokyo makes the
 * comparison useless. So this formula aims at the real middle fare, with no
 * deliberate lean in either direction.
 *
 * One estimate = prior x group calibration x day-of-week x route factor
 * (x the holiday premium, which pricing.ts adds, as it does today).
 *
 *  - Prior. US routes: the route's own BTS median for that quarter.
 *    International (or a US route with no BTS row): a price-by-distance line
 *    fitted on every bought fare in that group (idea 4), times the season
 *    shape of the old seeded guess. One line fitted on all fares, so one odd
 *    fare cannot swing it.
 *  - Group calibration: the median of real / prior across the group. This is
 *    what the nightly trend does today, measured fresh.
 *  - Day of week (idea 5): pooled across ALL bought fares, held near 1 until
 *    a weekday has many fares, and kept within 0.85-1.2.
 *  - Route factor: this route's own searches in the last 45 days, each one
 *    counted with Google's "typical price" from the same search (idea 2) as
 *    a second opinion. Shrunk toward 1 (n / (n + 2)) and kept within
 *    0.67-1.5, so a route with one odd fare moves only partway.
 *
 * Pure: no I/O. The caller loads inputs (loadModelInputs in fareModelDb.ts).
 */
import { RESORTS, ORIGIN_BY_IATA } from "./config.js";
import { haversineMiles } from "./geo.js";
import { quarterOf, type ISODate } from "./dates.js";
import { holidayFlightPremium } from "./holidayWindows.js";

export const USE_CANDIDATE_KEY = "flight.useCandidate";
export const ZONE_PCT_KEY = "flight.zonePct";
export const DEFAULT_ZONE_PCT = 10;

/** How recent a route's own searches must be to count for that route. */
export const ROUTE_EVIDENCE_DAYS = 45;
/** Route shrink: n / (n + K). Two searches = halfway to what they say. */
export const ROUTE_SHRINK_K = 2;
export const ROUTE_FACTOR_MIN = 0.67;
export const ROUTE_FACTOR_MAX = 1.5;
const DOW_SHRINK_K = 8;
const DOW_MIN = 0.85, DOW_MAX = 1.2;

const RESORT_OF_AIRPORT = new Map(
  RESORTS.flatMap((r) => [[r.iata, r] as const, ...r.altArrivalAirports.map((a) => [a.iata, r] as const)]),
);
const ALT_TO_PRIMARY = new Map(
  RESORTS.flatMap((r) => r.altArrivalAirports.map((a) => [a.iata, r.iata] as const)),
);

export interface ModelFare {
  origin: string; destination: string; departDate: ISODate; price: number; observedAt: Date;
  /** Midpoint of Google's typical price range from the same search, if it gave one. */
  insightMid?: number;
}
export interface ModelBaseline {
  origin: string; destination: string; quarter: number; med: number; p25: number; p75: number;
  /** bts_db1b | seed_guess | sampled_live */
  source: string;
}
export interface ModelInputs {
  fares: ModelFare[];
  baselines: ModelBaseline[];
  premiumPct: (key: string, fallback: number) => number;
  now: Date;
}
export interface Prediction {
  /** Without the holiday premium (pricing.ts adds it, as for every estimate). */
  value: number;
  /** p25/p75 shape to show a range around it. */
  lowRatio: number; highRatio: number;
  parts: { prior: number; calibration: number; dayOfWeek: number; route: number; routeSearches: number;
           priorKind: "bts" | "distance" };
}
export interface FareModel {
  predict(origin: string, destination: string, date: ISODate): Prediction | undefined;
  /** For the scoreboard: how many fares each group was fitted on. */
  fitted: { domestic: number; international: number };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const dowOf = (d: ISODate) => new Date(d + "T00:00:00Z").getUTCDay();

export function isInternational(destination: string): boolean {
  const r = RESORT_OF_AIRPORT.get(destination);
  return !!r && r.region !== "dom";
}

export function routeMiles(origin: string, destination: string): number | undefined {
  const o = ORIGIN_BY_IATA.get(origin);
  const r = RESORT_OF_AIRPORT.get(destination);
  if (!o || !r) return undefined;
  return haversineMiles(o.lat, o.lon, r.lat, r.lon);
}

/** Fit the candidate formula on these fares. */
export function fitFareModel(inp: ModelInputs): FareModel {
  const hol = (d: ISODate) => {
    const h = holidayFlightPremium(d);
    return h ? 1 + inp.premiumPct(h.settingKey, h.defaultPct) / 100 : 1;
  };

  // Baselines by route and quarter; an alternate airport falls back to its
  // resort's main airport, as book.ts does.
  const bl = new Map<string, ModelBaseline[]>();
  for (const b of inp.baselines) {
    const k = `${b.origin}|${b.destination}`;
    bl.set(k, [...(bl.get(k) ?? []), b]);
  }
  const listFor = (o: string, d: string) =>
    bl.get(`${o}|${d}`) ?? (ALT_TO_PRIMARY.has(d) ? bl.get(`${o}|${ALT_TO_PRIMARY.get(d)}`) : undefined);
  const btsFor = (o: string, d: string, q: number) => {
    const list = (listFor(o, d) ?? []).filter((b) => b.source === "bts_db1b");
    return list.find((b) => b.quarter === q) ?? list[0];
  };
  // The seeded guess's season shape (its quarter over its own average).
  const seedSeason = (o: string, d: string, q: number) => {
    const list = (listFor(o, d) ?? []).filter((b) => b.source !== "bts_db1b");
    const here = list.find((b) => b.quarter === q);
    if (!here || !list.length) return 1;
    return here.med / (list.reduce((s, b) => s + b.med, 0) / list.length);
  };

  // Price-by-distance line per group: log(price) = a + b log(miles).
  const fitDistance = (intl: boolean) => {
    const pts = inp.fares.flatMap((f) => {
      if (isInternational(f.destination) !== intl) return [];
      const miles = routeMiles(f.origin, f.destination);
      if (!miles || miles < 50) return [];
      const adj = f.price / hol(f.departDate) / (intl ? seedSeason(f.origin, f.destination, quarterOf(f.departDate)) : 1);
      return [{ x: Math.log(miles), y: Math.log(adj) }];
    });
    if (!pts.length) return undefined;
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    // Few points or one distance: assume fares grow with the square root of
    // distance (a GUESS, used only until the data can say otherwise).
    const b = pts.length >= 6 && sxx > 0.05 ? clamp(sxy / sxx, 0.3, 1.0) : 0.5;
    return { a: my - b * mx, b, n: pts.length };
  };
  const dist = { dom: fitDistance(false), intl: fitDistance(true) };

  const prior = (o: string, d: string, date: ISODate): { v: number; kind: "bts" | "distance"; shape?: ModelBaseline } | undefined => {
    const intl = isInternational(d);
    const q = quarterOf(date);
    if (!intl) {
      const b = btsFor(o, d, q);
      if (b) return { v: b.med, kind: "bts", shape: b };
    }
    const line = intl ? dist.intl : dist.dom;
    const miles = routeMiles(o, d);
    if (!line || !miles) return undefined;
    const v = Math.exp(line.a + line.b * Math.log(miles)) * (intl ? seedSeason(o, d, q) : 1);
    return { v, kind: "distance" };
  };

  // Each fare's prior, once.
  const rows = inp.fares.flatMap((f) => {
    const p = prior(f.origin, f.destination, f.departDate);
    if (!p) return [];
    return [{ f, p: p.v, intl: isInternational(f.destination), h: hol(f.departDate) }];
  });

  // Group calibration.
  const calib = (intl: boolean) => {
    const r = rows.filter((x) => x.intl === intl).map((x) => x.f.price / (x.p * x.h));
    return r.length ? median(r) : 1;
  };
  const cal = { dom: calib(false), intl: calib(true) };

  // Day of week, pooled.
  const byDow = new Map<number, number[]>();
  for (const x of rows) {
    const e = x.f.price / (x.p * x.h * (x.intl ? cal.intl : cal.dom));
    const k = dowOf(x.f.departDate);
    byDow.set(k, [...(byDow.get(k) ?? []), Math.log(e)]);
  }
  const dow = new Map<number, number>();
  for (const [k, logs] of byDow) {
    const w = logs.length / (logs.length + DOW_SHRINK_K);
    dow.set(k, clamp(Math.exp(median(logs) * w), DOW_MIN, DOW_MAX));
  }

  // Google's typical midpoint, put on the same footing as the fares we keep
  // (we keep the middle itinerary; Google's "typical" may sit a bit apart).
  const pairs = inp.fares.filter((f) => f.insightMid && f.insightMid > 0).map((f) => f.price / f.insightMid!);
  const insightScale = pairs.length >= 5 ? median(pairs) : 1;

  // Route evidence: each recent search, measured against everything above.
  const cutoff = inp.now.getTime() - ROUTE_EVIDENCE_DAYS * 86_400_000;
  const routeLogs = new Map<string, number[]>();
  for (const x of rows) {
    if (x.f.observedAt.getTime() < cutoff) continue;
    const base = x.p * x.h * (x.intl ? cal.intl : cal.dom) * (dow.get(dowOf(x.f.departDate)) ?? 1);
    let r = x.f.price / base;
    if (x.f.insightMid) r = Math.sqrt(r * ((x.f.insightMid * insightScale) / base));
    const k = `${x.f.origin}|${x.f.destination}`;
    routeLogs.set(k, [...(routeLogs.get(k) ?? []), Math.log(r)]);
  }

  return {
    fitted: { domestic: rows.filter((x) => !x.intl).length, international: rows.filter((x) => x.intl).length },
    predict(o, d, date) {
      const p = prior(o, d, date);
      if (!p) return undefined;
      const intl = isInternational(d);
      const c = intl ? cal.intl : cal.dom;
      const w = dow.get(dowOf(date)) ?? 1;
      const logs = routeLogs.get(`${o}|${d}`) ?? [];
      const route = logs.length
        ? clamp(Math.exp(median(logs) * (logs.length / (logs.length + ROUTE_SHRINK_K))), ROUTE_FACTOR_MIN, ROUTE_FACTOR_MAX)
        : 1;
      const shape = p.shape && p.shape.med > 0 ? p.shape : undefined;
      return {
        value: Math.round(p.v * c * w * route * 100) / 100,
        lowRatio: shape ? Math.min(1, shape.p25 / shape.med) : 0.85,
        highRatio: shape ? Math.max(1, shape.p75 / shape.med) : 1.2,
        parts: { prior: Math.round(p.v), calibration: c, dayOfWeek: w, route, routeSearches: logs.length, priorKind: p.kind },
      };
    },
  };
}

/** The holiday premium for a date, as pricing.ts applies it to estimates. */
export function holidayMultiplier(date: ISODate, premiumPct: ModelInputs["premiumPct"]): number {
  const h = holidayFlightPremium(date);
  return h ? 1 + premiumPct(h.settingKey, h.defaultPct) / 100 : 1;
}

/**
 * Grade the candidate fairly: each fare is predicted by a formula fitted on
 * every OTHER search (leave one out, and any re-buy of the same route and
 * date is left out with it), so it never grades its own homework.
 * Returns the prediction (holiday premium included) per fare index.
 */
export function leaveOneOut(inp: ModelInputs, testIdx: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const i of testIdx) {
    const f = inp.fares[i]!;
    const model = fitFareModel({ ...inp, fares: inp.fares.filter((g) =>
      !(g.origin === f.origin && g.destination === f.destination && g.departDate === f.departDate)) });
    const p = model.predict(f.origin, f.destination, f.departDate);
    if (p) out.set(i, p.value * holidayMultiplier(f.departDate, inp.premiumPct));
  }
  return out;
}
