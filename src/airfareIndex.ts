/**
 * The government's airfare price indexes, from the Bureau of Labor Statistics
 * (owner, 2026-10-12: "We should be using BLS for international AND their CPI
 * index. We should report the CPI index on our board so users can know
 * airfares are up/down year over year").
 *
 * What each series is, so nobody reads more into it than it says:
 *  - CPI airline fares (CUUR0000SETG01): what US CONSUMERS paid for airline
 *    tickets, domestic and international together, US city average, not
 *    seasonally adjusted. The year-over-year line on the board.
 *  - The same, seasonally adjusted (CUSR0000SETG01): used to carry an OLD
 *    survey forward to today (BTS's route surveys are from 2024-2026), where
 *    a not-adjusted index would mix in the season.
 *  - PPI international scheduled passenger air (PCU4811114811112): what US
 *    airlines took in per unit of international passenger service. The
 *    nearest free government series to "international fares". Noisy month to
 *    month (230-308 within a year), so it is read as a 3-month average.
 *  - PPI domestic scheduled passenger air (PCU4811114811111): kept and
 *    reported beside the CPI.
 *
 * An index says how prices MOVED, never what one route costs. It moves the
 * candidate formula only through learned levers (fareModel.ts), and the board
 * only says it in words.
 *
 * Everything here is pure except the two loaders at the bottom.
 */
import type { Db } from "./db.js";

export const BLS_SERIES = {
  cpiNsa: "CUUR0000SETG01",
  cpiSa: "CUSR0000SETG01",
  ppiIntl: "PCU4811114811112",
  ppiDom: "PCU4811114811111",
} as const;
export type BlsKey = keyof typeof BLS_SERIES;

export const BLS_LABELS: Record<BlsKey, string> = {
  cpiNsa: "Airline fares, consumer price index (what travelers paid)",
  cpiSa: "Airline fares, consumer price index, seasonally adjusted",
  ppiIntl: "International airfares, producer price index (what airlines took in)",
  ppiDom: "Domestic airfares, producer price index (what airlines took in)",
};

/** How many months each series is averaged over before comparing. The
 *  international PPI jumps 10%+ from one month to the next, so one month
 *  of it says little; the CPI is steady and read as BLS publishes it. */
export const SMOOTH_MONTHS: Record<BlsKey, number> = { cpiNsa: 1, cpiSa: 1, ppiIntl: 3, ppiDom: 1 };

/** period "YYYY-MM" -> value */
export type IndexSeries = Map<string, number>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

export function shiftPeriod(period: string, months: number): string {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7)) - 1 + months;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}
export function periodName(period: string): string {
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}
export function latestPeriod(s: IndexSeries): string | undefined {
  return [...s.keys()].sort().at(-1);
}

/** The average of the `smooth` months ending at `period`, every one of
 *  them present; undefined otherwise (BLS skipped October 2025 during the
 *  shutdown, and a hole must not be read as a level). */
export function levelEnding(s: IndexSeries, period: string, smooth = 1): number | undefined {
  let sum = 0;
  for (let i = 0; i < smooth; i++) {
    const v = s.get(shiftPeriod(period, -i));
    if (!(v! > 0)) return undefined;
    sum += v!;
  }
  return sum / smooth;
}

/** The level a price observed in `period` was paid at: that month's level,
 *  or the newest published before it (BLS publishes ~6 weeks late, so this
 *  month has no figure yet), stepping back past holes. */
export function levelAt(s: IndexSeries, period: string, smooth = 1): number | undefined {
  const last = latestPeriod(s);
  if (!last) return undefined;
  let p = period > last ? last : period;
  for (let i = 0; i < 6; i++, p = shiftPeriod(p, -1)) {
    const v = levelEnding(s, p, smooth);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** How far prices have moved from the given months (averaged) to the
 *  newest published level: newest / then. 1 when either is unknown. */
export function carryFrom(s: IndexSeries, periods: string[], smooth = 1): number {
  const last = latestPeriod(s);
  if (!last || !periods.length) return 1;
  const now = levelAt(s, last, smooth);
  const then = periods.map((p) => levelAt(s, p, smooth)).filter((v): v is number => v !== undefined);
  if (!now || then.length !== periods.length) return 1;
  return now / (then.reduce((a, b) => a + b, 0) / then.length);
}

export interface YearOverYear { period: string; yearAgo: string; value: number; yearAgoValue: number; pct: number; smooth: number }

/** The newest month that can be compared with the same month a year
 *  earlier (stepping back up to 3 months past a hole). */
export function yearOverYear(s: IndexSeries, smooth = 1): YearOverYear | undefined {
  const last = latestPeriod(s);
  if (!last) return undefined;
  for (let i = 0, p = last; i < 4; i++, p = shiftPeriod(p, -1)) {
    const now = levelEnding(s, p, smooth);
    const ago = levelEnding(s, shiftPeriod(p, -12), smooth);
    if (now && ago) return { period: p, yearAgo: shiftPeriod(p, -12), value: now, yearAgoValue: ago, pct: (now / ago - 1) * 100, smooth };
  }
  return undefined;
}

/** "up 23%", "down 4%", "about the same as". Whole percent. */
export function upDown(pct: number): string {
  const r = Math.round(pct);
  if (Math.abs(pct) < 1) return "about the same as";
  return r > 0 ? `up ${r}% from` : `down ${-r}% from`;
}

/** The board's one line, or undefined with no data. */
export function boardLine(cpi: YearOverYear | undefined): { headline: string; detail: string } | undefined {
  if (!cpi) return undefined;
  return {
    headline: `Airfares are ${upDown(cpi.pct)} a year ago.`,
    detail: `The government's price index for airline tickets (Bureau of Labor Statistics), `
      + `${periodName(cpi.period)} compared with ${periodName(cpi.yearAgo)}. It follows what travelers paid `
      + `for all US airline tickets, not one route; the fares on this board are already today's prices.`,
  };
}

export interface AirfareIndexSummary {
  /** Per series: the newest year-over-year comparison, when there is one. */
  yoy: Partial<Record<BlsKey, YearOverYear>>;
  latest: Partial<Record<BlsKey, string>>;
  board?: { headline: string; detail: string; line: string; pct: number; period: string; yearAgo: string };
  lines: string[];
}

export function summarize(series: Partial<Record<BlsKey, IndexSeries>>): AirfareIndexSummary {
  const yoy: AirfareIndexSummary["yoy"] = {};
  const latest: AirfareIndexSummary["latest"] = {};
  const lines: string[] = [];
  for (const k of Object.keys(BLS_SERIES) as BlsKey[]) {
    const s = series[k];
    if (!s?.size) continue;
    latest[k] = latestPeriod(s);
    const y = yearOverYear(s, SMOOTH_MONTHS[k]);
    if (!y) continue;
    yoy[k] = y;
    const when = y.smooth > 1
      ? `the ${y.smooth} months to ${periodName(y.period)} vs the same months a year earlier`
      : `${periodName(y.period)} vs ${periodName(y.yearAgo)}`;
    lines.push(`${BLS_LABELS[k]}: ${upDown(y.pct)} a year earlier (${when}).`);
  }
  if (!lines.length) lines.push("No government airfare index stored yet (run the \"Pricing the Magic BLS airfare index\" workflow).");
  const line = boardLine(yoy.cpiNsa);
  return { yoy, latest, lines,
    board: line && yoy.cpiNsa ? { ...line, line: `${line.headline} ${line.detail}`, pct: Math.round(yoy.cpiNsa.pct),
      period: yoy.cpiNsa.period, yearAgo: yoy.cpiNsa.yearAgo } : undefined };
}

/** Every series as BLS last published it (newest fetch per month). */
export async function loadIndexSeries(db: Db): Promise<Partial<Record<BlsKey, IndexSeries>>> {
  const rows = (await db.query<{ series_id: string; period: string; value: string }>(
    `select distinct on (series_id, period) series_id, period, value
       from bls_series_values
      order by series_id, period, fetched_at desc, id desc`,
  ).catch(() => ({ rows: [] as never[] }))).rows;
  const byId = new Map<string, IndexSeries>();
  for (const r of rows) {
    const id = r.series_id.trim();
    if (!byId.has(id)) byId.set(id, new Map());
    byId.get(id)!.set(r.period.trim(), Number(r.value));
  }
  const out: Partial<Record<BlsKey, IndexSeries>> = {};
  for (const [k, id] of Object.entries(BLS_SERIES) as [BlsKey, string][]) {
    const s = byId.get(id);
    if (s?.size) out[k] = s;
  }
  return out;
}

// The board asks on every page load; the series changes once a month.
const cache = new WeakMap<Db, { at: number; v: Promise<AirfareIndexSummary> }>();
export function loadAirfareIndexSummary(db: Db): Promise<AirfareIndexSummary> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.v;
  const v = loadIndexSeries(db).then(summarize);
  cache.set(db, { at: Date.now(), v });
  v.catch(() => cache.delete(db));
  return v;
}
