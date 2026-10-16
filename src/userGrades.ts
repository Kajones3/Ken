/**
 * "What the user sees" (owner, 2026-10-15/16): how often the numbers on the
 * board are right, graded the way a traveler would judge them.
 *
 * FLIGHTS, from the numbers written down BEFORE each fare was bought
 * (`fare_forecasts`, governing rule 2) against Google's whole list for that
 * same search (`provider_responses`):
 *  - Typical trip: our typical fare lands inside the MIDDLE HALF of Google's
 *    list (drop the cheapest quarter and the dearest quarter). The owner's
 *    point: one $1,900 flight among mostly $1,200 ones is not the target.
 *  - Cheapest trip: our cheapest-trip fare within ±zone of the cheapest
 *    flight Google listed. Written down only since 2026-10-16, so it starts
 *    empty and fills nightly.
 *  - Overall: both combined into one "right" number (owner's pick "A").
 *
 * HOTELS, from every rate Google showed us (`hotel_samples`):
 *  - Disney's own hotels, typical: what travelers see (our rate x the
 *    learned correction) inside the middle half of Google's rates for that
 *    hotel and month. The correction is refitted WITHOUT that hotel and
 *    month's own Google rates, so Google never grades the price it set.
 *  - Disney cheapest: the cheapest hotel in the category the traveler picked
 *    (owner: "if they select moderate, it should be the cheapest moderate"),
 *    ours vs Google's, among the hotels Google priced that month.
 *  - Off property: what we showed between searches (the earlier search moved
 *    by the season curve) against the next search: typical inside its middle
 *    half; cheapest per price third (budget / mid-range / upscale, the way
 *    the site sorts off-property hotels) within ±zone.
 *  - When Google gave fewer than 4 prices, there is no real "middle half",
 *    so within ±zone of their middle counts instead (said on the page).
 *
 * Pure graders + one loader. Read-only: no price moves.
 */
import type { Db } from "./db.js";
import { RESORTS, RESORT_BY_ID } from "./config.js";
import { addDaysISO, type ISODate } from "./dates.js";
import { dateStr } from "./book.js";
import { pricedPool } from "./cheapestFlights.js";
import { unzipBody } from "./rawResponses.js";
import { isInternational, ZONE_PCT_KEY, DEFAULT_ZONE_PCT } from "./fareModel.js";
import { settingsMap } from "./settings.js";
import { computeFactors, countedChecks, CHECKS_USE_KEY, CHECKS_WEIGHT_KEY, DEFAULT_CHECKS_WEIGHT,
  GOOGLE_DISNEY_WEIGHT_KEY, DEFAULT_GOOGLE_DISNEY_WEIGHT, type CountedCheck } from "./checkFactors.js";
import { asEvidence, cachedGoogleDisneyRates, type GoogleDisneyRate } from "./disneyEvidence.js";
import { matchDisneyHotel } from "./disneyHotels.js";
import { isRental } from "./rentals.js";
import { hotelSeasonFactor } from "./seasonality.js";
import { leanWords } from "./fareForecasts.js";

/* ------------------------------ the arithmetic ------------------------------ */

/** Below this many prices there is no honest "middle half". */
export const MIDDLE_HALF_MIN = 4;
/** Each grade covers this many days (owner, 2026-10-16: a 2-week window
 *  with the luck margin shown; one week of ~60 fares is ±6 points of luck). */
export const GRADE_WINDOW_DAYS = 14;
/** A window needs this many graded numbers before it is compared with the one before. */
export const GRADE_MIN = 8;
/** The smallest change ever called better or worse, whatever the luck says. */
export const GRADE_NOISE_POINTS = 3;
const DAY = 86_400_000;

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Is `shown` a typical price for this list? Inside the middle half, or with
 *  fewer than MIDDLE_HALF_MIN prices, within ±zone of their middle. */
export function inTypical(shown: number, prices: number[], zone: number): boolean {
  const s = prices.filter((p) => p > 0).sort((a, b) => a - b);
  if (!s.length || !(shown > 0)) return false;
  if (s.length >= MIDDLE_HALF_MIN) return shown >= quantile(s, 0.25) - 0.005 && shown <= quantile(s, 0.75) + 0.005;
  return Math.abs(shown / quantile(s, 0.5) - 1) <= zone + 1e-9;
}
export const withinZone = (shown: number, real: number, zone: number) =>
  shown > 0 && real > 0 && Math.abs(shown / real - 1) <= zone + 1e-9;

/** `luck`: how many points `pct` can move by chance alone (one standard
 *  error of a share, ±). With 60 numbers at 50% that is about 6. */
export interface Grade { n: number; right: number; pct: number | null; luck: number | null }
export type Trend = "better" | "worse" | "about the same" | "too few";
/** `recent`: the last GRADE_WINDOW_DAYS; `before`: the window before that;
 *  `month`: the last 30 days. (Called "weekly" from when windows were 7 days.) */
export interface Weekly { recent: Grade; before: Grade; month: Grade; trend: Trend }

/** ± points of luck on a share: one standard error, with one right and one
 *  wrong added so 0 of 8 or 8 of 8 still shows a margin. */
export const luckPoints = (right: number, n: number): number | null => {
  if (!n) return null;
  const p = (right + 1) / (n + 2);
  return Math.max(1, Math.round(100 * Math.sqrt((p * (1 - p)) / n)));
};
export const grade = (xs: boolean[]): Grade => {
  const right = xs.filter(Boolean).length;
  return { n: xs.length, right, pct: xs.length ? Math.round((right / xs.length) * 100) : null, luck: luckPoints(right, xs.length) };
};
export interface Graded { at: Date; ok: boolean }
/** The last two weeks, the two weeks before, and the last 30 days. A change
 *  counts as better or worse only when it is bigger than the two windows'
 *  luck added together (and at least GRADE_NOISE_POINTS). */
export function weekly(items: Graded[], now: Date): Weekly {
  const age = (g: Graded) => (now.getTime() - g.at.getTime()) / DAY;
  const W = GRADE_WINDOW_DAYS;
  const recent = grade(items.filter((g) => age(g) <= W).map((g) => g.ok));
  const before = grade(items.filter((g) => age(g) > W && age(g) <= 2 * W).map((g) => g.ok));
  const month = grade(items.filter((g) => age(g) <= 30).map((g) => g.ok));
  let trend: Trend = "too few";
  if (recent.n >= GRADE_MIN && before.n >= GRADE_MIN) {
    const d = recent.pct! - before.pct!;
    const margin = Math.max(GRADE_NOISE_POINTS, (recent.luck ?? 0) + (before.luck ?? 0));
    trend = Math.abs(d) <= margin ? "about the same" : d > 0 ? "better" : "worse";
  }
  return { recent, before, month, trend };
}

/* --------------------------------- flights --------------------------------- */

export interface FlightGradeRow {
  intl: boolean; at: Date;
  shown?: number; shownCheapest?: number; candidate?: number;
  /** The fare we bought (Google's middle itinerary, as the paid job picked it). */
  bought?: number;
  /** Every itinerary Google listed for the search, cheapest first. */
  pool: number[];
}
export interface SideGrades { typical: Weekly; cheapest: Weekly; overall: Weekly }
export interface FlightSide extends SideGrades {
  /** Our typical fare vs the middle of Google's list, median signed % (+ = high). */
  leanPct: number | null;
  /** The candidate formula's typical-trip grade over the same 30 days. */
  candidateTypical: Grade;
}

export function gradeFlights(rows: FlightGradeRow[], zone: number, now: Date): { us: FlightSide; intl: FlightSide } {
  const side = (intl: boolean): FlightSide => {
    const mine = rows.filter((r) => r.intl === intl && r.pool.length);
    const typ: Graded[] = mine.filter((r) => r.shown).map((r) => ({ at: r.at, ok: inTypical(r.shown!, r.pool, zone) }));
    const chp: Graded[] = mine.filter((r) => r.shownCheapest).map((r) => ({ at: r.at, ok: withinZone(r.shownCheapest!, r.pool[0]!, zone) }));
    const recent = mine.filter((r) => (now.getTime() - r.at.getTime()) / DAY <= 30);
    const leans = recent.filter((r) => r.shown).map((r) => r.shown! / quantile(r.pool, 0.5) - 1);
    return {
      typical: weekly(typ, now), cheapest: weekly(chp, now), overall: weekly([...typ, ...chp], now),
      leanPct: leans.length ? Math.round(median(leans) * 1000) / 10 : null,
      candidateTypical: grade(recent.filter((r) => r.candidate).map((r) => inTypical(r.candidate!, r.pool, zone))),
    };
  };
  return { us: side(false), intl: side(true) };
}

/**
 * Old yardstick vs new, on the SAME fares (owner, 2026-10-16: "our accuracy
 * dropped when we expanded 'correct' to the IQR. How is that even possible?").
 * Old: within ±zone of the fare we bought. New: inside the middle half of
 * Google's list. The middle half is NOT always wider than ±zone: when
 * Google's list is bunched, its quartiles sit closer to the middle than 10%.
 */
export interface Yardsticks {
  n: number;
  /** Within ±zone of the fare we bought (the old fair test). */
  oldRight: number;
  /** Inside the middle half of Google's list (the new test). */
  newRight: number;
  /** Right on the old test only / the new test only. */
  oldOnly: number; newOnly: number;
  /** Median distance from the list's middle to its quartiles, in %. */
  lowEdgePct: number | null; highEdgePct: number | null;
  /** Lists whose upper quartile sits closer than +zone to the middle. */
  narrowHigh: number;
  /** Lists with fewer than MIDDLE_HALF_MIN prices (graded ±zone instead). */
  short: number;
  /** Our shown fare vs the list's middle, median signed %. */
  leanPct: number | null;
}
export function yardsticks(rows: FlightGradeRow[], zone: number): { us: Yardsticks; intl: Yardsticks } {
  const side = (intl: boolean): Yardsticks => {
    const rs = rows.filter((r) => r.intl === intl && r.shown && r.bought && r.pool.length);
    const oldOk = rs.map((r) => withinZone(r.shown!, r.bought!, zone));
    const newOk = rs.map((r) => inTypical(r.shown!, r.pool, zone));
    const full = rs.filter((r) => r.pool.length >= MIDDLE_HALF_MIN);
    const edge = (q: number) => full.map((r) => quantile(r.pool, q) / quantile(r.pool, 0.5) - 1);
    const pct = (xs: number[]) => (xs.length ? Math.round(median(xs) * 1000) / 10 : null);
    return {
      n: rs.length,
      oldRight: oldOk.filter(Boolean).length, newRight: newOk.filter(Boolean).length,
      oldOnly: oldOk.filter((o, i) => o && !newOk[i]).length, newOnly: newOk.filter((o, i) => o && !oldOk[i]).length,
      lowEdgePct: pct(edge(0.25)), highEdgePct: pct(edge(0.75)),
      narrowHigh: edge(0.75).filter((e) => e < zone).length,
      short: rs.length - full.length,
      leanPct: pct(rs.map((r) => r.shown! / quantile(r.pool, 0.5) - 1)),
    };
  };
  return { us: side(false), intl: side(true) };
}

/* ---------------------------------- hotels ---------------------------------- */

const HOTEL_TIER = new Map(RESORTS.flatMap((r) => r.hotels.map((h) => [h.id, h.tier] as const)));
const US_RESORT = (id: string) => RESORT_BY_ID.get(id)?.region === "dom";

export interface HotelGradeOpts {
  zone: number; now: Date;
  /** The owner's price checks (already filtered to counted ones). */
  checks: CountedCheck[];
  googleWeight: number; priorWeight: number;
  hotelBase: (id: string) => number | undefined;
  /** Only Google rates pulled this many days back are graded. */
  days?: number;
}
export interface HotelSide { typical: Weekly; cheapest: Weekly; overall: Weekly }

/** Disney's own hotels. `rates` = every Google rate in the evidence window
 *  (latest per hotel and night), each with our raw rate for that night. */
export function gradeDisney(rates: GoogleDisneyRate[], o: HotelGradeOpts): { us: HotelSide; intl: HotelSide } {
  const usable = rates.filter((r) => r.ours !== null && r.ours > 0 && r.google > 0);
  const graded = usable.filter((r) => (o.now.getTime() - r.pulledAt.getTime()) / DAY <= (o.days ?? 30));
  const factorsWithout = (leaveOut: (r: GoogleDisneyRate) => boolean) => computeFactors(
    o.checks.concat(asEvidence(usable.filter((r) => !leaveOut(r)), o.googleWeight)),
    { priorWeight: o.priorWeight, hotelBase: o.hotelBase },
  );
  const shownOf = (f: Map<string, { factor: number }>, r: GoogleDisneyRate) => r.ours! * (f.get(`hotel|${r.hotelId}`)?.factor ?? 1);
  const month = (r: GoogleDisneyRate) => r.night.slice(0, 7);
  const groupBy = (key: (r: GoogleDisneyRate) => string) => {
    const m = new Map<string, GoogleDisneyRate[]>();
    for (const r of graded) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const latest = (rs: GoogleDisneyRate[]) => new Date(Math.max(...rs.map((r) => r.pulledAt.getTime())));
  const typ: (Graded & { us: boolean })[] = [];
  for (const [k, rs] of groupBy((r) => `${r.hotelId}|${month(r)}`)) {
    const f = factorsWithout((r) => `${r.hotelId}|${month(r)}` === k);
    const shown = median(rs.map((r) => shownOf(f, r)));
    typ.push({ at: latest(rs), ok: inTypical(shown, rs.map((r) => r.google), o.zone), us: US_RESORT(rs[0]!.resortId) });
  }
  const chp: (Graded & { us: boolean })[] = [];
  for (const [k, rs] of groupBy((r) => `${r.resortId}|${month(r)}|${HOTEL_TIER.get(r.hotelId) ?? "?"}`)) {
    if (k.endsWith("|?")) continue;
    const hotels = new Set(rs.map((r) => r.hotelId));
    const f = factorsWithout((r) => hotels.has(r.hotelId) && `${r.resortId}|${month(r)}` === `${rs[0]!.resortId}|${month(rs[0]!)}`);
    const ours = Math.min(...rs.map((r) => shownOf(f, r)));
    const real = Math.min(...rs.map((r) => r.google));
    chp.push({ at: latest(rs), ok: withinZone(ours, real, o.zone), us: US_RESORT(rs[0]!.resortId) });
  }
  const side = (us: boolean): HotelSide => {
    const t = typ.filter((g) => g.us === us), c = chp.filter((g) => g.us === us);
    return { typical: weekly(t, o.now), cheapest: weekly(c, o.now), overall: weekly([...t, ...c], o.now) };
  };
  return { us: side(true), intl: side(false) };
}

export interface HotelPull { resort: string; month: string; checkIn: ISODate; pulledAt: Date; rates: number[] }

/** Off property: each search graded by what the search before it showed. */
export function gradeOffProperty(
  pulls: HotelPull[], zone: number, now: Date,
  season: (resort: string, date: ISODate) => number = hotelSeasonFactor,
): { us: HotelSide; intl: HotelSide } {
  const groups = new Map<string, HotelPull[]>();
  for (const p of pulls) groups.set(`${p.resort}|${p.month}`, [...(groups.get(`${p.resort}|${p.month}`) ?? []), p]);
  const typ: (Graded & { us: boolean })[] = [], chp: (Graded & { us: boolean })[] = [];
  const thirds = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b), n = s.length;
    return [s.slice(0, Math.ceil(n / 3)), s.slice(Math.ceil(n / 3), Math.ceil((2 * n) / 3)), s.slice(Math.ceil((2 * n) / 3))];
  };
  for (const list of groups.values()) {
    list.sort((a, b) => a.pulledAt.getTime() - b.pulledAt.getTime());
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      if (!a.rates.length || !b.rates.length) continue;
      const move = season(b.resort, b.checkIn) / season(a.resort, a.checkIn);
      const us = US_RESORT(a.resort);
      typ.push({ at: b.pulledAt, ok: inTypical(median(a.rates) * move, b.rates, zone), us });
      if (a.rates.length >= 3 && b.rates.length >= 3) {
        const ta = thirds(a.rates), tb = thirds(b.rates);
        for (let t = 0; t < 3; t++) {
          if (ta[t]!.length && tb[t]!.length) {
            chp.push({ at: b.pulledAt, ok: withinZone(ta[t]![0]! * move, tb[t]![0]!, zone), us });
          }
        }
      }
    }
  }
  const side = (us: boolean): HotelSide => {
    const t = typ.filter((g) => g.us === us), c = chp.filter((g) => g.us === us);
    return { typical: weekly(t, now), cheapest: weekly(c, now), overall: weekly([...t, ...c], now) };
  };
  return { us: side(true), intl: side(false) };
}

/* ---------------------------- the plain summary ---------------------------- */

const pctWords = (g: Grade) => (g.pct === null ? "no numbers yet"
  : `${g.pct}% (${g.right} of ${g.n}; ±${g.luck} by luck)`);
const trendWords = (w: Weekly) => w.trend === "too few" ? ""
  : w.trend === "about the same" ? `, about the same as the two weeks before (${w.before.pct}%, inside the luck)`
  : `, ${w.trend === "better" ? "up" : "down"} from ${w.before.pct}% the two weeks before`;
/** Grades from the last two weeks, else from the last 30 days, said so. */
const headline = (w: Weekly) => w.recent.n >= GRADE_MIN
  ? `${pctWords(w.recent)} over the last two weeks${trendWords(w)}`
  : `${pctWords(w.month)} over the last 30 days`;

/** A few sentences, each one backed by a number on the page. Nothing else. */
export function summaryLines(g: Pick<UserGrades, "flights" | "hotels">): string[] {
  const out: string[] = [];
  for (const [name, s] of [["US", g.flights.us], ["International", g.flights.intl]] as const) {
    if (s.typical.month.n) out.push(`${name} flights, typical trip: inside the middle of Google's list ${headline(s.typical)}.`);
    if (s.cheapest.month.n) out.push(`${name} flights, cheapest trip: within ±${g.flights.zonePct}% of the cheapest listed ${headline(s.cheapest)}.`);
    if (s.leanPct !== null && Math.abs(s.leanPct) >= 5) {
      out.push(`${name} typical fares lean ${leanWords(s.leanPct)} against the middle of Google's list.`);
      const c = s.candidateTypical, shown = s.typical.month;
      if (c.n >= 20 && shown.n >= 20 && c.pct! - shown.pct! >= 5) {
        out.push(`  The candidate formula lands in range more often on the same fares (${c.pct}% vs ${shown.pct}%). The switch is in Rates & settings.`);
      } else {
        out.push(`  Moving the ${name === "US" ? "US" : "international"} lean ${s.leanPct > 0 ? "down" : "up"} in Rates & settings may help; only estimates move with it.`);
      }
    }
  }
  if (!g.flights.us.cheapest.month.n && !g.flights.intl.cheapest.month.n) {
    out.push("Cheapest-trip flight grades start with the next nightly fares (written down before buying since 2026-10-16).");
  }
  for (const [name, s] of [["Disney's own hotels", g.hotels.disney], ["Off-property hotels", g.hotels.offProperty]] as const) {
    for (const [where, x] of [["US", s.us], ["international", s.intl]] as const) {
      if (x.typical.month.n) out.push(`${name} (${where}), typical: inside Google's range ${headline(x.typical)}.`);
    }
  }
  return out;
}

/* --------------------------------- the loader --------------------------------- */

export interface UserGrades {
  asOf: string;
  flights: { zonePct: number; us: FlightSide; intl: FlightSide;
    /** Forecasts with no Google list to grade against (searches before 10-06 or a failed match). */
    unmatched: number };
  hotels: { zonePct: number; disney: { us: HotelSide; intl: HotelSide }; offProperty: { us: HotelSide; intl: HotelSide } };
  summary: string[];
}

const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function flightRows(db: Db): Promise<{ rows: FlightGradeRow[]; unmatched: number }> {
  let fc: { origin: string; destination: string; depart_date: unknown; trip_length: number; bought_at: unknown;
    shown_usd: string | null; shown_cheapest_usd: string | null; candidate_usd: string | null; price_usd: string | null }[];
  try {
    fc = (await db.query<typeof fc[number]>(
      `select origin, destination, depart_date, trip_length, bought_at, shown_usd, shown_cheapest_usd, candidate_usd, price_usd
         from fare_forecasts where bought_at > now() - interval '30 days' and price_usd > 0`,
    )).rows;
  } catch { return { rows: [], unmatched: 0 }; }
  const ans = (await db.query<{ request: unknown; fetched_at: unknown; body_gz: Uint8Array }>(
    `select request, fetched_at, body_gz from provider_responses
      where kind = 'google_flights' and status = 200 and fetched_at > now() - interval '32 days'`,
  ).catch(() => ({ rows: [] as { request: unknown; fetched_at: unknown; body_gz: Uint8Array }[] }))).rows;
  const answers = new Map<string, { at: Date; pool: number[] }[]>();
  for (const a of ans) {
    const req = (typeof a.request === "string" ? JSON.parse(a.request) : a.request) as Record<string, string>;
    if (!req?.departure_id || !req.arrival_id || !req.outbound_date || !req.return_date) continue;
    let pool: number[];
    try { pool = pricedPool(JSON.parse(unzipBody(a.body_gz))); } catch { continue; }
    if (!pool.length) continue;
    const k = `${req.departure_id}|${req.arrival_id}|${req.outbound_date}|${req.return_date}`;
    answers.set(k, [...(answers.get(k) ?? []), { at: asDate(a.fetched_at), pool }]);
  }
  const n = (v: string | null) => (v === null ? undefined : Number(v));
  const rows: FlightGradeRow[] = [];
  let unmatched = 0;
  for (const f of fc) {
    const dep = dateStr(f.depart_date) as ISODate;
    const at = asDate(f.bought_at);
    const list = answers.get(`${f.origin.trim()}|${f.destination.trim()}|${dep}|${addDaysISO(dep, f.trip_length)}`) ?? [];
    // The answer bought alongside this forecast: the closest in time, within 2 days.
    const best = list.map((x) => ({ x, gap: Math.abs(x.at.getTime() - at.getTime()) }))
      .filter((y) => y.gap <= 2 * DAY).sort((p, q) => p.gap - q.gap)[0]?.x;
    if (!best) { unmatched++; continue; }
    rows.push({ intl: isInternational(f.destination.trim()), at, pool: best.pool,
      shown: n(f.shown_usd), shownCheapest: n(f.shown_cheapest_usd), candidate: n(f.candidate_usd), bought: n(f.price_usd) });
  }
  return { rows, unmatched };
}

async function offPropertyPulls(db: Db): Promise<HotelPull[]> {
  const s = await db.query<{ resort_id: string; month: string; check_in: unknown; pulled_at: unknown; hotel_name: string; nightly_usd: string; kind: string | null }>(
    `select resort_id, month, check_in, pulled_at, hotel_name, nightly_usd, kind from hotel_samples
      where pulled_at > now() - interval '45 days'`,
  ).catch(() => ({ rows: [] as never[] }));
  const m = new Map<string, HotelPull>();
  for (const r of s.rows) {
    if (matchDisneyHotel(r.resort_id, r.hotel_name) || isRental(r.hotel_name, r.kind)) continue;
    const at = asDate(r.pulled_at);
    const k = `${r.resort_id}|${r.month}|${at.toISOString()}`;
    const p = m.get(k) ?? { resort: r.resort_id, month: r.month, checkIn: dateStr(r.check_in) as ISODate, pulledAt: at, rates: [] };
    const v = Number(r.nightly_usd);
    if (v > 0) p.rates.push(v);
    m.set(k, p);
  }
  return [...m.values()];
}

/** Everything gradeDisney needs, with the owner's current settings. Shared
 *  with the Rates & settings advice, which re-grades at other weights. */
export async function loadDisneyInputs(db: Db, settings: Map<string, number>, zone: number, now: Date):
  Promise<{ rates: GoogleDisneyRate[]; opts: HotelGradeOpts }> {
  const checks = (settings.get(CHECKS_USE_KEY) ?? 1) >= 1 ? await countedChecks(db) : [];
  const bases = new Map(RESORTS.flatMap((r) => r.hotels.map((h) => [h.id, h.base] as const)));
  return {
    rates: await cachedGoogleDisneyRates(db).catch(() => []),
    opts: {
      zone, now, checks,
      googleWeight: settings.get(GOOGLE_DISNEY_WEIGHT_KEY) ?? DEFAULT_GOOGLE_DISNEY_WEIGHT,
      priorWeight: settings.get(CHECKS_WEIGHT_KEY) ?? DEFAULT_CHECKS_WEIGHT,
      hotelBase: (id) => settings.get(`hotel.${id}.base`) ?? bases.get(id),
    },
  };
}

export async function loadUserGrades(db: Db, now: Date = new Date()): Promise<UserGrades> {
  const settings = await settingsMap(db);
  const zone = (settings.get(ZONE_PCT_KEY) ?? DEFAULT_ZONE_PCT) / 100;
  const { rows, unmatched } = await flightRows(db);
  const flights = gradeFlights(rows, zone, now);
  const d = await loadDisneyInputs(db, settings, zone, now);
  const disney = gradeDisney(d.rates, d.opts);
  const offProperty = gradeOffProperty(await offPropertyPulls(db), zone, now);
  const zonePct = Math.round(zone * 100);
  const g = { flights: { zonePct, ...flights, unmatched }, hotels: { zonePct, disney, offProperty } };
  return { asOf: now.toISOString(), ...g, summary: summaryLines(g) };
}


