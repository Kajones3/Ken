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
import { decideFlightFare, quotedEstimate, cheapestBasisFare } from "./pricing.js";
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
  /** What "the cheapest trip" would have shown for the same date
   *  (since 2026-10-16), graded against the cheapest flight Google listed. */
  shownCheapestUsd?: number;
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
    const cheap = cheapestBasisFare(book, origin, destination, departDate, tripLength, d.modelFare).fare;
    return { usd: r2(d.modelFare), cheapest: r2(cheap), kind: d.useRow ? "real_fare" as const : "estimate" as const };
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
    shownUsd: shown?.usd, shownKind: shown?.kind, shownCheapestUsd: shown?.cheapest,
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
        live_estimate_usd, candidate_usd, price_usd, job, forecast_at, shown_cheapest_usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [f.origin, f.destination, f.departDate, f.tripLength, f.shownUsd ?? null, f.shownKind ?? null, f.formula,
     f.liveEstimateUsd ?? null, f.candidateUsd ?? null, priceUsd, job, f.forecastAt.toISOString(),
     f.shownCheapestUsd ?? null],
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
  /** The last two weeks vs the two before (needs days >= 28 to see both). */
  progress?: Progress;
  /** What the guesses are built from (the candidate's fit). */
  informedBy?: InformedBy;
  /** The plain-language lean summary (owner's wording), for /admin and the email. */
  lean?: string[];
}

export interface InformedBy { domestic: number; international: number; feed: number }

/* ------------- "Lean", not "reads" (owner, 2026-10-12) -------------
 * "Reads +2%" was taken to mean "2% of fares are too high". It is the miss on
 * the MIDDLE fare when every fare is lined up from most-too-low to
 * most-too-high: which way we tilt, not how close we are. So it is said as a
 * lean, in the owner's words, with how close we are said separately.
 */
/** "high by 16%", "low by 6%", or "even" within half a point. */
export function leanWords(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  const a = Math.round(Math.abs(pct));
  return a === 0 ? "even" : `${pct > 0 ? "high" : "low"} by ${a}%`;
}

export function leanLines(s: ForecastScores): string[] {
  const lines: string[] = [];
  const g = (name: string, x: ForecastGroup) => {
    if (!x.shown.n && !x.candidate.n) return;
    lines.push(`${name} (${x.shown.n || x.candidate.n} fares checked before buying${s.since ? `, since ${s.since}` : ""}):`);
    const lean = (who: string, z: ZoneScore) => z.n
      ? (leanWords(z.medianPct) === "even"
        ? `  Our ${who} fares don't lean high or low on average.`
        : `  Our ${who} fares lean ${leanWords(z.medianPct)} on average.`)
      : `  Our ${who} fares: none checked yet.`;
    lines.push(lean("shown", x.shown), lean("candidate", x.candidate));
    const close = (who: string, z: ZoneScore) => z.n
      ? `${who}: ${z.inZonePct}% within ±${s.zonePct}%, ${z.lowPct}% more than ${s.zonePct}% too low, `
        + `${z.highPct}% more than ${s.zonePct}% too high; a typical miss is ${z.typicalOffPct}% either way`
      : "";
    const c = [close("shown", x.shown), close("candidate", x.candidate)].filter(Boolean);
    if (c.length) lines.push(`  How close (a separate question from the lean): ${c.join(". ")}.`);
  };
  g("US", s.domestic);
  g("International", s.international);
  const i = s.informedBy;
  if (i) {
    lines.push(`We are using ${(i.domestic + i.international).toLocaleString("en-US")} fares to inform our guesses `
      + `(${i.domestic.toLocaleString("en-US")} US and ${i.international.toLocaleString("en-US")} international, bought from Google in the last 90 days)`
      + (i.feed ? `, plus ${i.feed.toLocaleString("en-US")} free-feed fares for day of the week.` : "."));
  }
  if (lines.length) {
    lines.push("\"On average\" means the middle fare: line every fare up from most too low to most too high and take the "
      + "one in the middle, so one wild fare can't swing it. A small lean does NOT mean most fares are close: misses "
      + "in both directions cancel out in the lean, which is why \"how close\" is shown beside it.");
  }
  return lines;
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

/* ------------- "Every single day our guesses should be getting better" -------------
 * Owner, 2026-10-11. The before-buying grades (the honest ones) for the last
 * PROGRESS_WINDOW_DAYS against the same span before, per group and per
 * formula, with the destinations reading furthest off in the recent window
 * as the first place to look for why. Pure.
 *
 * Since 2026-10-16 the windows are two weeks, and each "typically off"
 * carries its luck: how far it moves when the same fares are drawn again at
 * random (bootstrap). A change counts as better or worse only when it is
 * bigger than both windows' luck added together; one week of ~60 fares was
 * about ±6 points of luck, so "better than last week" was mostly noise.
 */
export type Trend = "better" | "worse" | "about the same" | "too few fares";
export interface ProgressLine {
  group: "US" | "International"; formula: "shown" | "candidate";
  recent: ZoneScore; before: ZoneScore; trend: Trend;
  /** ± points of luck on each window's "typically off". */
  luck: { recent: number | null; before: number | null };
}
export interface DestinationMiss { destination: string; n: number; shownReads: number | null; candidateReads: number | null }
export interface Progress { lines: ProgressLine[]; destinations: DestinationMiss[] }

/** Fewest fares per window in a group before a window is compared at all. */
export const PROGRESS_MIN_FARES = 8;
/** The smallest change in "typically off" ever called better or worse. */
export const PROGRESS_NOISE_POINTS = 1.5;
/** Each window's length in days. */
export const PROGRESS_WINDOW_DAYS = 14;

/** ± points of luck on the median miss (|e|, as %): the spread of that
 *  median over 300 random redraws of the same fares. Seeded, so the same
 *  fares always give the same answer. */
export function typicalOffLuck(errs: number[]): number | null {
  if (errs.length < 2) return null;
  let seed = errs.length * 2654435761 >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const abs = errs.map(Math.abs);
  const meds: number[] = [];
  for (let b = 0; b < 300; b++) {
    const draw = abs.map(() => abs[Math.floor(rnd() * abs.length)]!).sort((x, y) => x - y);
    const m = Math.floor(draw.length / 2);
    meds.push(draw.length % 2 ? draw[m]! : (draw[m - 1]! + draw[m]!) / 2);
  }
  const mean = meds.reduce((a, x) => a + x, 0) / meds.length;
  const sd = Math.sqrt(meds.reduce((a, x) => a + (x - mean) ** 2, 0) / (meds.length - 1));
  return Math.round(sd * 1000) / 10;
}

export function progressOf(rows: ForecastRow[], zonePct: number, now: Date = new Date()): Progress {
  const zone = zonePct / 100;
  const day = 86_400_000;
  const W = PROGRESS_WINDOW_DAYS;
  const inWeek = (r: ForecastRow, back: number) => {
    const age = (now.getTime() - r.boughtAt.getTime()) / day;
    return age >= back * W && age < (back + 1) * W;
  };
  const errs = (rs: ForecastRow[], pick: (r: ForecastRow) => number | undefined) =>
    rs.flatMap((r) => { const v = pick(r); return v === undefined || !(v > 0) ? [] : [v / r.price - 1]; });
  const lines: ProgressLine[] = [];
  for (const group of ["US", "International"] as const) {
    const gr = rows.filter((r) => isInternational(r.destination) === (group === "International"));
    for (const formula of ["shown", "candidate"] as const) {
      const pick = (r: ForecastRow) => (formula === "shown" ? r.shown : r.candidate);
      const eRecent = errs(gr.filter((r) => inWeek(r, 0)), pick), eBefore = errs(gr.filter((r) => inWeek(r, 1)), pick);
      const recent = scoreZone(eRecent, zone);
      const before = scoreZone(eBefore, zone);
      const luck = { recent: typicalOffLuck(eRecent), before: typicalOffLuck(eBefore) };
      let trend: Trend = "too few fares";
      if (recent.n >= PROGRESS_MIN_FARES && before.n >= PROGRESS_MIN_FARES
          && recent.typicalOffPct !== null && before.typicalOffPct !== null) {
        const d = recent.typicalOffPct - before.typicalOffPct;
        const margin = Math.max(PROGRESS_NOISE_POINTS, (luck.recent ?? 0) + (luck.before ?? 0));
        trend = d < -margin ? "better" : d > margin ? "worse" : "about the same";
      }
      lines.push({ group, formula, recent, before, trend, luck });
    }
  }
  const week = rows.filter((r) => inWeek(r, 0));
  const med = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 1000) / 10;
  };
  const destinations = [...new Set(week.map((r) => r.destination))].map((destination) => {
    const rs = week.filter((r) => r.destination === destination);
    return { destination, n: rs.length, shownReads: med(errs(rs, (r) => r.shown)), candidateReads: med(errs(rs, (r) => r.candidate)) };
  }).sort((a, b) => Math.abs(b.shownReads ?? 0) - Math.abs(a.shownReads ?? 0));
  return { lines, destinations };
}

/** Plain-language lines for the morning email, and a task when a group got worse. */
export function progressReport(p: Progress): { lines: string[]; worse: ProgressLine[] } {
  const name = (l: ProgressLine) => `${l.group}, ${l.formula === "shown" ? "what travelers see" : "candidate"}`;
  const off = (z: ZoneScore) => (z.typicalOffPct === null ? "—" : `${z.typicalOffPct}%`);
  const pm = (x: number | null) => (x === null ? "" : ` ±${x}`);
  const lines = p.lines.map((l) => `${name(l)}: typically off ${off(l.recent)}${pm(l.luck.recent)} over the last two weeks (${l.recent.n} fares, `
    + `${l.recent.inZonePct ?? "—"}% within the zone) vs ${off(l.before)}${pm(l.luck.before)} the two weeks before (${l.before.n}): ${l.trend.toUpperCase()}`);
  lines.push("  (± is luck: how far the number moves by chance on this many fares. A change inside both margins added together is \"about the same\".)");
  const far = p.destinations.filter((d) => d.n >= 3 && d.shownReads !== null && Math.abs(d.shownReads) >= 10);
  if (far.length) {
    lines.push("Furthest off over the last two weeks, where to look first (which way each destination leans):");
    for (const d of far.slice(0, 5)) {
      lines.push(`  ${d.destination}: shown fares lean ${leanWords(d.shownReads)}, candidate ${leanWords(d.candidateReads)} (${d.n} fares)`);
    }
  }
  return { lines, worse: p.lines.filter((l) => l.trend === "worse") };
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
  let informedBy: InformedBy | undefined;
  try {
    const m = await loadFareModel(db);
    const feed = m.levers.dayOfWeekFrom === "free feed"
      ? Object.values(m.levers.dayOfWeek).reduce((t, d) => t + d.fares, 0) : 0;
    informedBy = { domestic: m.fitted.domestic, international: m.fitted.international, feed };
  } catch { /* no model yet: the line is left out */ }
  const scores: ForecastScores = { ...scoreForecasts(rows, zonePct, noFare), progress: progressOf(rows, zonePct), informedBy };
  return { ...scores, lean: leanLines(scores) };
}
