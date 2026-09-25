/**
 * Regenerate src/climateData.ts from real daily weather observations.
 *
 * WHY A BUILD-TIME SCRIPT AND NOT A REQUEST PATH. Climate normals move once a
 * decade. Fetching them when somebody opens a board would spend a provider
 * call on data that is, by construction, stale-proof — exactly what the
 * cache-first invariant exists to prevent. This runs when a human asks it to,
 * writes a file, and the file is committed. Same shape as bts-baseline.
 *
 * WHY OPEN-METEO AND NOT NOAA. NOAA's NCEI publishes the authoritative US
 * Climate Normals, and for Orlando and Anaheim it would be the better source.
 * It covers no other resort. Four of the six parks are outside the United
 * States, and this app's single job is comparing all six side by side — so one
 * consistent method across every resort beats two better-but-different methods
 * for two of them. Same reasoning as re-baselining all six hotels together.
 * (api.weather.gov is neither: it serves forecasts and current observations,
 * not normals, and is US-only as well.)
 *
 * Open-Meteo's archive is free, needs no key, and covers the whole globe.
 * Validate the output against NCEI for Orlando and Anaheim if you want the
 * method checked against a primary source.
 *
 * WHAT IT COMPUTES, per resort per calendar month:
 *   - average daily high  (mean of every day's max over the whole window)
 *   - average daily low   (mean of every day's min)
 *   - rain days           (days with >= RAIN_DAY_INCHES precipitation, per year)
 *
 * IT REFUSES TO WRITE GARBAGE. Every resort must come back with twelve
 * complete, physically plausible months or nothing is written at all. A
 * half-fetched year overwriting a good table is worse than no run — the same
 * rule the refresh job follows by upserting only on success.
 */
import { writeFileSync } from "node:fs";
import { RESORTS } from "../config.js";

/**
 * Days with at least this much precipitation count as a rain day.
 *
 * 0.04in (1mm), NOT the 0.01in a rain gauge uses — and the difference is the
 * whole point. 0.01in is the US convention for "measurable" at a WEATHER
 * STATION, which is a single point. ERA5 is a reanalysis on a GRID, so the
 * figure for a cell is an average across tens of kilometres: an afternoon
 * shower that soaks one side of Orlando and misses the other still leaves the
 * whole cell showing a trace, and the day counts as wet.
 *
 * Measured, not assumed. The first run at 0.01in gave Orlando 27 wet days in
 * July against roughly 17 in NOAA's 1991-2020 normals, and Paris 12-17 every
 * month of the year. The temperatures agreed well over the same run, so it
 * was specifically this threshold and not the data source.
 *
 * 1mm is the standard "wet day" cut-off for gridded precipitation for exactly
 * this reason. It is a deliberate mismatch with the gauge convention, chosen
 * so the NUMBER means what a person reading "10 rainy days" thinks it means.
 * If this is ever revisited, check Orlando and Anaheim against NCEI first —
 * they are the two resorts with an authoritative source to check against.
 */
export const RAIN_DAY_INCHES = 0.04;

/** How many years of history to average. Twenty is long enough to wash out a
 *  freak year and short enough to still describe today's climate. */
const DEFAULT_YEARS = 20;

/** Open-Meteo's archive lags real time by about five days, so the window ends
 *  at the last complete calendar year rather than "today". */
const LAST_COMPLETE_YEAR = new Date().getUTCFullYear() - 1;

export interface DailyObservation {
  /** ISO date, used only to find the calendar month. */
  date: string;
  highF: number | null;
  lowF: number | null;
  precipIn: number | null;
}

export type NormalRow = [highF: number, lowF: number, rainDays: number];

/**
 * Twelve monthly rows from a pile of daily observations.
 *
 * Pure, so the arithmetic can be tested without the network — which matters
 * here more than usual, because the fetch itself cannot be exercised from the
 * sandbox this was written in.
 *
 * Null readings are skipped rather than counted as zero: a missing temperature
 * is not a cold day, and a missing precipitation reading is not a dry one.
 * Rain days are divided by the number of distinct YEARS actually seen for that
 * month, not by the number of days, so a partial fetch understates rather than
 * inventing a wet month — and the caller rejects partial fetches anyway.
 */
export function monthlyNormals(days: DailyObservation[]): (NormalRow | null)[] {
  const acc = Array.from({ length: 12 }, () => ({
    highSum: 0, highN: 0, lowSum: 0, lowN: 0, rainDays: 0, years: new Set<number>(),
  }));

  for (const d of days) {
    // ISO dates only; anything else is a bug upstream and must not be averaged.
    const m = Number(d.date.slice(5, 7));
    const y = Number(d.date.slice(0, 4));
    if (!(m >= 1 && m <= 12) || !Number.isFinite(y)) continue;
    const a = acc[m - 1]!;
    a.years.add(y);
    if (d.highF !== null && Number.isFinite(d.highF)) { a.highSum += d.highF; a.highN++; }
    if (d.lowF !== null && Number.isFinite(d.lowF)) { a.lowSum += d.lowF; a.lowN++; }
    if (d.precipIn !== null && Number.isFinite(d.precipIn) && d.precipIn >= RAIN_DAY_INCHES) {
      a.rainDays++;
    }
  }

  return acc.map((a) => {
    if (!a.highN || !a.lowN || !a.years.size) return null;
    return [
      Math.round(a.highSum / a.highN),
      Math.round(a.lowSum / a.lowN),
      Math.round(a.rainDays / a.years.size),
    ] as NormalRow;
  });
}

/** A month is only usable if it is physically possible. Catches a transposed
 *  high/low or a units mix-up before it reaches the table. */
export function rowIsPlausible(row: NormalRow): boolean {
  const [highF, lowF, rainDays] = row;
  return highF > lowF && lowF > -40 && highF < 130 && rainDays >= 0 && rainDays <= 31;
}

/** Twelve complete, plausible months, or an explanation of why not. */
export function validateYear(rows: (NormalRow | null)[]): { ok: true; rows: NormalRow[] } | { ok: false; reason: string } {
  if (rows.length !== 12) return { ok: false, reason: `got ${rows.length} months, need 12` };
  const missing = rows.map((r, i) => (r ? null : i + 1)).filter((m) => m !== null);
  if (missing.length) return { ok: false, reason: `no data for month(s) ${missing.join(", ")}` };
  const bad = (rows as NormalRow[]).findIndex((r) => !rowIsPlausible(r));
  if (bad >= 0) return { ok: false, reason: `month ${bad + 1} is not a real climate: ${JSON.stringify(rows[bad])}` };
  return { ok: true, rows: rows as NormalRow[] };
}

/* ---------------------------------------------------------------------------
 * Living inside Open-Meteo's free allowance.
 *
 * The first real run of this job died four resorts in, with
 *   "Minutely API request limit exceeded. Please try again in one minute."
 * Six resorts x twenty years is 120 requests, fired as fast as the network
 * allows, and Open-Meteo bills by how much data a request asks for rather than
 * by the request — so a year of three daily variables is worth many plain
 * calls and a burst of them empties the per-minute budget in seconds.
 *
 * Nothing was wrong with the code that fetched; what was missing was any
 * notion that the other end has a budget. So:
 *
 *   - THERE IS ALWAYS A PAUSE between requests, and hitting the ceiling
 *     doubles it for the rest of the run. One 429 means the pace was wrong,
 *     not that one call was unlucky, so slowing down permanently is the fix
 *     and retrying at the same speed is not.
 *   - A 429 IS WAITED OUT, for as long as the response asks (`Retry-After`,
 *     or the minute the message names).
 *   - EXCEPT WHEN WAITING CANNOT HELP. "Minutely" clears in a minute; hourly
 *     and daily do not, and spending eight retries discovering that produces
 *     the same failure half an hour later with no more information. Those say
 *     so, and say what to do instead.
 *
 * This job is a manual dispatch that runs once every few years. Taking ten
 * minutes is free; failing after four resorts is not.
 * ------------------------------------------------------------------------ */

/** How many times one request may be re-sent before the run gives up. Eight
 *  minute-long waits is longer than any minutely window, and short enough that
 *  a genuinely stuck run still ends. */
export const MAX_RETRIES = 8;
const FIRST_PAUSE_MS = 250;
const MAX_PAUSE_MS = 8_000;
const MINUTE_MS = 60_000;

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the response asked us to wait, if it said. Handles both forms of
 *  `Retry-After` — a number of seconds, or an HTTP date. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Is this a limit that waiting clears?
 *
 * Open-Meteo answers 429 for the minutely, hourly and daily budgets alike, and
 * the difference decides whether there is any point waiting: a minute-long
 * window is worth sitting out, a day-long one is not.
 */
export function limitClearsSoon(body: string): boolean {
  return !/\b(hourly|daily|monthly)\b/i.test(body);
}

export interface FetchTuning {
  /** Swapped in tests so a 429 path doesn't really sleep for a minute. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when the run is waiting, so a long pause isn't a silent one. */
  onWait?: (ms: number, why: string) => void;
}

/** One request, re-sent while the other end says it is busy. */
async function getJson(
  url: string, fetchImpl: typeof fetch, pace: { pauseMs: number }, tuning: FetchTuning,
): Promise<Response> {
  const sleep = tuning.sleep ?? nap;
  for (let attempt = 0; ; attempt++) {
    await sleep(pace.pauseMs);
    const res = await fetchImpl(url);
    if (res.ok) return res;

    const body = await res.text();
    const transient = res.status === 429 || res.status >= 500;
    // A 400 means we asked for something wrong. Retrying an argument error
    // just fails more slowly, so it goes straight back to the caller.
    if (!transient) throw new Error(`open-meteo ${res.status}: ${body}`);

    if (res.status === 429 && !limitClearsSoon(body)) {
      throw new Error(
        `open-meteo's longer-term request budget is used up, so waiting will not help today: ${body}\n`
        + "Run this again tomorrow, or with fewer years (the workflow takes a years input) — "
        + "ten years still averages out a freak year and costs half as much.");
    }
    if (attempt >= MAX_RETRIES) {
      throw new Error(`open-meteo ${res.status} after ${MAX_RETRIES} retries: ${body}`);
    }

    // Hitting the ceiling means the pace was wrong for the whole run, not just
    // for this call, so every later request slows down too.
    pace.pauseMs = Math.min(MAX_PAUSE_MS, Math.max(FIRST_PAUSE_MS, pace.pauseMs * 2));
    const wait = retryAfterMs(res.headers?.get?.("retry-after"))
      ?? (res.status === 429 ? MINUTE_MS : 2_000 * 2 ** attempt);
    tuning.onWait?.(wait, `${res.status} — ${body.slice(0, 120)}`);
    await sleep(wait);
  }
}

/** Daily history for one point. Split by year so one oversized response can't
 *  fail the whole window, and so a partial failure is visible per year. */
export async function fetchDaily(
  lat: number, lon: number, fromYear: number, toYear: number,
  fetchImpl: typeof fetch = fetch,
  tuning: FetchTuning = {},
  pace: { pauseMs: number } = { pauseMs: FIRST_PAUSE_MS },
): Promise<DailyObservation[]> {
  const out: DailyObservation[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const url = "https://archive-api.open-meteo.com/v1/archive"
      + `?latitude=${lat}&longitude=${lon}`
      + `&start_date=${y}-01-01&end_date=${y}-12-31`
      + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
      + "&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=UTC";
    const res = await getJson(url, fetchImpl, pace, tuning);
    const body = await res.json() as {
      daily?: {
        time?: string[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_sum?: (number | null)[];
      };
    };
    const d = body.daily;
    if (!d?.time?.length) throw new Error(`open-meteo returned no daily rows for ${lat},${lon} ${y}`);
    d.time.forEach((date, i) => {
      out.push({
        date,
        highF: d.temperature_2m_max?.[i] ?? null,
        lowF: d.temperature_2m_min?.[i] ?? null,
        precipIn: d.precipitation_sum?.[i] ?? null,
      });
    });
  }
  return out;
}

/** The generated file, rendered. Kept here so the format lives next to the
 *  code that produces it rather than in a template nobody updates. */
export function renderFile(byResort: Record<string, NormalRow[]>, source: string): string {
  const order = RESORTS.map((r) => r.id).filter((id) => byResort[id]);
  const body = order.map((id) => {
    const rows = byResort[id]!;
    const half = (a: NormalRow[]) => a.map((r) => `[${r[0]}, ${r[1]}, ${r[2]}]`).join(", ");
    return `  ${id}: [${half(rows.slice(0, 6))},\n        ${half(rows.slice(6))}]`;
  }).join(",\n");
  return `/**
 * GENERATED DATA — the numbers only. Do not hand-edit rows here.
 *
 * \`npm run climate-normals\` (or the "Parkfare climate normals" workflow)
 * rewrites this whole file from real daily observations. Anything you type in
 * it is lost on the next run.
 *
 * WHY THIS IS A SEPARATE FILE FROM config.ts. The season notes next to these
 * numbers in config.ts ("Atlantic hurricane season", "spring break is the
 * busiest week") are editorial judgment, not data — no API produces them, and
 * regenerating the numbers must never wipe them. Splitting generated data from
 * hand-written commentary is what makes the generator safe to re-run.
 *
 * Each row is [average daily high °F, average daily low °F, days with
 * measurable rain (>= ${RAIN_DAY_INCHES}in)], January first.
 */
export type ClimateRow = [highF: number, lowF: number, rainDays: number];

/** Where these numbers came from. Rewritten by the generator. */
export const CLIMATE_SOURCE = ${JSON.stringify(source)};

export const CLIMATE_ROWS: Record<string, ClimateRow[]> = {
${body},
};
`;
}

export interface ClimateNormalsOptions {
  years?: number;
  dryRun?: boolean;
  outPath?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: lets a 429 path be exercised without really sleeping. */
  tuning?: FetchTuning;
}

export async function runClimateNormals(opts: ClimateNormalsOptions = {}) {
  const years = opts.years ?? Number(process.env.CLIMATE_YEARS ?? DEFAULT_YEARS);
  const dryRun = opts.dryRun ?? process.env.CLIMATE_DRY_RUN === "true";
  const outPath = opts.outPath ?? new URL("../climateData.ts", import.meta.url).pathname;
  const fromYear = LAST_COMPLETE_YEAR - years + 1;

  // ONE pace for the whole run, shared by all six resorts. Per-resort pacing
  // would reset to full speed at every resort and walk into the same wall
  // again — which is exactly the shape of the failure this is fixing, since
  // the budget belongs to the account and not to the request.
  const pace = { pauseMs: FIRST_PAUSE_MS };
  const tuning: FetchTuning = {
    onWait: (ms, why) => console.log(
      `\n      waiting ${Math.round(ms / 1000)}s and slowing to ${pace.pauseMs}ms between requests (${why})`),
    ...opts.tuning,
  };

  console.log(`${RESORTS.length} resorts x ${years} years — this takes a few minutes, `
    + "because Open-Meteo's free allowance is per minute and we stay inside it.\n");

  const byResort: Record<string, NormalRow[]> = {};
  for (const resort of RESORTS) {
    process.stdout.write(`${resort.id.padEnd(5)} ${resort.city} … `);
    const days = await fetchDaily(
      resort.lat, resort.lon, fromYear, LAST_COMPLETE_YEAR, opts.fetchImpl, tuning, pace);
    const check = validateYear(monthlyNormals(days));
    if (!check.ok) {
      // Loud and fatal. A resort that cannot be computed must not quietly keep
      // its old hand-seeded row while the header claims the file is generated.
      throw new Error(`${resort.id}: ${check.reason} (from ${days.length} days)`);
    }
    byResort[resort.id] = check.rows;
    const jul = check.rows[6]!;
    console.log(`${days.length} days — July ${jul[0]}/${jul[1]}°F, ${jul[2]} rain days`);
  }

  const source = `Open-Meteo archive (ERA5), daily observations ${fromYear}-${LAST_COMPLETE_YEAR}, generated ${new Date().toISOString().slice(0, 10)}`;
  const file = renderFile(byResort, source);

  if (dryRun) {
    console.log(`\n--- dry run, nothing written ---\n${file}`);
  } else {
    writeFileSync(outPath, file, "utf8");
    console.log(`\nwrote ${outPath}`);
  }
  console.log(source);
  return { byResort, source, file, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runClimateNormals();
}
