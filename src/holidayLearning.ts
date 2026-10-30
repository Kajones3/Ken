/**
 * The holiday-week bump on flight ESTIMATES, learned from the fares we keep
 * (owner, 2026-10-31: "We have enough real data to estimate this bump").
 *
 * It used to be a fixed +55% Thanksgiving week / +58% Christmas week from a
 * third-party study of the 10 busiest US routes. Every fare any job is
 * handed is kept in `flight_observations`, and the free feed (Travelpayouts)
 * covers the next few months day by day, so the same route, same trip length
 * and same month can be compared: dates in the holiday week against the
 * other dates of that month. Day of the week barely matters on that feed
 * (2026-10-12: every weekday 0.98-1.01), so the gap is the holiday.
 *
 *  - Per route (origin, destination, trip length) and year: the median fare
 *    of the holiday week's dates over the median of the month's ordinary
 *    dates (Thanksgiving: the rest of November; Christmas: December 1-20,
 *    so the run-up to the week doesn't count as "ordinary").
 *    Each date is the median of what we saw for it. 2+ dates each side.
 *  - All routes pooled by their median, then shrunk toward the study's
 *    figure by n / (n + 8) routes (governing rule 2: learned, never a fixed
 *    hand-set number, but one odd week can't swing it). Held 0.8x-2.5x.
 *  - An owner value in /admin still wins over both.
 *
 * Only ESTIMATES use it: a real fare for a holiday date already carries the
 * holiday (pricing.ts). Bought (paid) fares never land in these weeks (we
 * buy the 8th-22nd), so the free feed is what teaches it.
 */
import type { Db } from "./db.js";
import { addDaysISO } from "./dates.js";
import {
  thanksgivingDate, THANKSGIVING_PREMIUM_KEY, CHRISTMAS_PREMIUM_KEY,
  DEFAULT_THANKSGIVING_PREMIUM_PCT, DEFAULT_CHRISTMAS_PREMIUM_PCT,
} from "./holidayWindows.js";

export interface FareObs { origin: string; dest: string; tripLength: number; date: string; price: number }
export interface HolidayLearned {
  key: string; label: string;
  /** What pricing uses: the study's figure moved toward ours by how many routes back it. */
  pct: number;
  /** What our own fares say on their own (null with no routes). */
  ourPct: number | null;
  studyPct: number;
  routes: number;
}

export const HOLIDAY_SHRINK_K = 8;
const MIN_DATES = 2;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

type Kind = "thanksgiving" | "christmas";
function windowOf(kind: Kind, year: number): { month: string; inWeek: (d: string) => boolean; ordinary: (d: string) => boolean } {
  if (kind === "thanksgiving") {
    const t = thanksgivingDate(year), from = addDaysISO(t, -2), to = addDaysISO(t, 4);
    const month = `${year}-11`;
    return { month, inWeek: (d) => d >= from && d <= to, ordinary: (d) => d.startsWith(month) && (d < from || d > to) };
  }
  const month = `${year}-12`;
  return { month, inWeek: (d) => d >= `${month}-24` && d <= `${month}-31`, ordinary: (d) => d >= `${month}-01` && d <= `${month}-20` };
}

/** Pure. One kind of holiday week, learned from every route that has both sides. */
export function learnHolidayPremium(rows: FareObs[], kind: Kind): HolidayLearned {
  const studyPct = kind === "thanksgiving" ? DEFAULT_THANKSGIVING_PREMIUM_PCT : DEFAULT_CHRISTMAS_PREMIUM_PCT;
  const key = kind === "thanksgiving" ? THANKSGIVING_PREMIUM_KEY : CHRISTMAS_PREMIUM_KEY;
  const label = kind === "thanksgiving" ? "Thanksgiving week" : "Christmas week";
  // route|year -> date -> prices
  const byRoute = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    const k = `${r.origin}|${r.dest}|${r.tripLength}|${r.date.slice(0, 4)}`;
    const dates = byRoute.get(k) ?? new Map<string, number[]>();
    dates.set(r.date, [...(dates.get(r.date) ?? []), r.price]);
    byRoute.set(k, dates);
  }
  const ratios: number[] = [];
  for (const [k, dates] of byRoute) {
    const w = windowOf(kind, Number(k.split("|")[3]));
    const hol: number[] = [], ord: number[] = [];
    for (const [d, ps] of dates) {
      if (w.inWeek(d)) hol.push(median(ps));
      else if (w.ordinary(d)) ord.push(median(ps));
    }
    if (hol.length >= MIN_DATES && ord.length >= MIN_DATES) ratios.push(median(hol) / median(ord));
  }
  if (!ratios.length) return { key, label, pct: studyPct, ourPct: null, studyPct, routes: 0 };
  const ours = Math.min(2.5, Math.max(0.8, median(ratios)));
  const w = ratios.length / (ratios.length + HOLIDAY_SHRINK_K);
  const blended = Math.exp(w * Math.log(ours) + (1 - w) * Math.log(1 + studyPct / 100));
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { key, label, pct: r1((blended - 1) * 100), ourPct: r1((ours - 1) * 100), studyPct, routes: ratios.length };
}

let cache: { at: number; db: Db; value: Map<string, HolidayLearned> } | null = null;
/** Both weeks, keyed by their settings key. Cached 10 minutes. */
export async function loadHolidayPremiums(db: Db): Promise<Map<string, HolidayLearned>> {
  if (cache && cache.db === db && Date.now() - cache.at < 10 * 60_000) return cache.value;
  let rows: FareObs[] = [];
  try {
    const r = await db.query(
      `select origin, destination, trip_length, depart_date, price_usd
         from flight_observations
        where extract(month from depart_date) in (11, 12)
          and observed_at > now() - interval '400 days'`);
    rows = (r.rows as Array<Record<string, unknown>>).map((x) => ({
      origin: String(x.origin).trim(), dest: String(x.destination).trim(), tripLength: Number(x.trip_length),
      // Postgres hands back a date at LOCAL midnight (see dateStr in book.ts).
      date: x.depart_date instanceof Date
        ? `${x.depart_date.getFullYear()}-${String(x.depart_date.getMonth() + 1).padStart(2, "0")}-${String(x.depart_date.getDate()).padStart(2, "0")}`
        : String(x.depart_date).slice(0, 10),
      price: Number(x.price_usd),
    }));
  } catch { rows = []; }
  const value = new Map<string, HolidayLearned>();
  for (const kind of ["thanksgiving", "christmas"] as const) {
    const l = learnHolidayPremium(rows, kind);
    value.set(l.key, l);
  }
  cache = { at: Date.now(), db, value };
  return value;
}
