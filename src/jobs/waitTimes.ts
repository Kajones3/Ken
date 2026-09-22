/**
 * Record posted wait times. Nothing reads this yet, and that is the point.
 *
 * The owner asked for an "average wait this month" card beside the weather
 * box and then withdrew it, on evidence rather than whim — see
 * db/schema.sql's note on wait_time_samples for why a posted-wait average
 * would have quietly biased the six-resort comparison. What survived is the
 * recording, because elapsed time is the one input that cannot be bought
 * later: Thrill Data has an archive going back to 2019 only because it
 * started in 2019.
 *
 * So this job starts the clock and stops there. No card, no /api/meta
 * wiring, no monthly aggregation. When there is a year of real data, the
 * decision about what to show gets made against it.
 *
 * THE AGGREGATION, WRITTEN DOWN BEFORE ANYONE NEEDS IT, because the obvious
 * way to do it is wrong. Whoever builds that card must:
 *
 *   - average by LOCAL HOUR first, then across hours. Runs fire on a UTC
 *     schedule and GitHub drops and delays them, so the samples are not
 *     evenly spread; averaging the raw rows would weight whichever local
 *     hours happened to get sampled most. `local_hour` exists for this.
 *   - require a real floor of distinct days per resort before a month counts
 *     at all. "Typically 28 minutes" from four days is a confident label on
 *     a guess.
 *   - show all six resorts or none. The owner's own bar, and the same
 *     argument that put weather on Open-Meteo rather than NOAA: a figure
 *     present for Orlando and absent for Shanghai biases the comparison this
 *     app exists to make.
 *   - carry a "Powered by Queue-Times.com" credit, which their terms ask for
 *     and which nothing owes yet because nothing is shown yet.
 */
import { QUEUE_TIMES_PARKS, WAIT_SAMPLE_FROM_HOUR, WAIT_SAMPLE_TO_HOUR } from "../config.js";
import type { Db } from "../db.js";

const BASE = "https://queue-times.com";

/** One ride as Queue-Times reports it. Only these three fields are read. */
interface Ride { name?: string; is_open?: boolean; wait_time?: number | null }
interface ParkPayload { lands?: { rides?: Ride[] }[]; rides?: Ride[] }

export interface ParkSummary {
  meanWait: number;
  maxWait: number;
  openRides: number;
}

/**
 * Every open ride's posted wait, summarised. Pure.
 *
 * Returns null when nothing is open — which is how park hours are handled
 * without an hours table. A shut park must record NOTHING rather than a row
 * of zeros, because a zero is a number and it would drag the month's mean
 * toward it forever.
 *
 * Both payload shapes are walked: most parks nest rides under `lands`, some
 * carry a top-level `rides` array, and a park can have both.
 */
export function summarise(payload: unknown): ParkSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ParkPayload;
  const rides: Ride[] = [
    ...(Array.isArray(p.rides) ? p.rides : []),
    ...(Array.isArray(p.lands) ? p.lands.flatMap((l) => (Array.isArray(l?.rides) ? l.rides : [])) : []),
  ];

  let sum = 0, n = 0, max = 0;
  for (const r of rides) {
    if (!r || r.is_open !== true) continue;
    const w = r.wait_time;
    // A null wait on an open ride is "not reported", not "no queue". Reading
    // it as zero is the same mistake the climate generator's null handling
    // exists to prevent.
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) continue;
    sum += w; n += 1;
    if (w > max) max = w;
  }
  if (!n) return null;
  return { meanWait: Math.round((sum / n) * 10) / 10, maxWait: max, openRides: n };
}

/**
 * The hour of the day at a park, in ITS timezone. Pure, no dependency —
 * Intl has had the whole IANA database for years.
 *
 * Returns null for a zone the runtime does not know, so an unrecognised
 * timezone drops one sample rather than silently recording a UTC hour and
 * poisoning the local-hour aggregation the whole design rests on.
 */
export function localHour(observedAt: Date, timeZone: string): number | null {
  try {
    const hh = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "2-digit", hour12: false,
    }).format(observedAt);
    const n = Number(hh);
    // "24" is a legal formatting of midnight in some runtimes.
    return Number.isFinite(n) ? (n === 24 ? 0 : n) : null;
  } catch {
    return null;
  }
}

/** Is this a time of day worth recording? See WAIT_SAMPLE_FROM_HOUR. */
export function withinSampleWindow(hour: number): boolean {
  return hour >= WAIT_SAMPLE_FROM_HOUR && hour < WAIT_SAMPLE_TO_HOUR;
}

/** Flattened list of every park we track, with the resort it belongs to. */
export function trackedParks(): { resortId: string; id: number; name: string }[] {
  return Object.entries(QUEUE_TIMES_PARKS)
    .flatMap(([resortId, parks]) => parks.map((p) => ({ resortId, ...p })));
}

/** Loose match: their punctuation and ours will not agree forever. */
export function namesAgree(expected: string, actual: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = norm(expected), b = norm(actual);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

export interface WaitTimesDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Swapped in tests so politeness pauses do not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
  dryRun?: boolean;
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WaitTimesResult {
  written: number;
  skippedClosed: number;
  skippedWindow: number;
  errors: number;
}

export async function runWaitTimes(db: Db, deps: WaitTimesDeps = {}): Promise<WaitTimesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? nap;
  const now = deps.now ?? new Date();
  const dryRun = deps.dryRun ?? process.env.WAIT_TIMES_DRY_RUN === "true";

  // One list, fetched once, for the timezone each park sits in. Their park
  // list carries it, so we never hard-code a zone that a park could change.
  let zones = new Map<number, string>();
  let parkNames = new Map<number, string>();
  try {
    const res = await fetchImpl(`${BASE}/parks.json`, {
      headers: { "user-agent": UA, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
    const groups = await res.json() as { parks?: { id: number; name: string; timezone?: string }[] }[];
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const park of g.parks ?? []) {
        if (park.timezone) zones.set(park.id, park.timezone);
        parkNames.set(park.id, park.name);
      }
    }
  } catch (e) {
    // Without timezones every sample would be judged against a UTC hour,
    // which is precisely the bias local_hour exists to remove. Better to
    // record nothing this run than to record rows that look fine and are
    // systematically wrong.
    console.error(`wait-times: could not read the park list — ${(e as Error).message}`);
    console.error("Nothing recorded. Timezones are required; a UTC hour would bias every later average.");
    return { written: 0, skippedClosed: 0, skippedWindow: 0, errors: 1 };
  }

  const result: WaitTimesResult = { written: 0, skippedClosed: 0, skippedWindow: 0, errors: 0 };

  for (const park of trackedParks()) {
    // Politeness, not rate-limit avoidance: their API is free and asks for
    // nothing, so the least we can do is not hammer it. Same instinct as the
    // Open-Meteo pacing.
    await sleep(1000);

    const zone = zones.get(park.id);
    if (!zone) {
      console.error(`  ${park.name} (${park.id}): not in their park list, or no timezone. Skipped.`);
      result.errors += 1;
      continue;
    }

    const theirName = parkNames.get(park.id) ?? "";
    if (!namesAgree(park.name, theirName)) {
      // A wrong id records the wrong park's waits under our resort, forever,
      // with nothing looking broken. The ids are a draft until the probe has
      // run, so this is the guard that makes a draft safe to ship.
      console.error(`  id ${park.id}: we expect "${park.name}", they say "${theirName}". Refusing.`);
      result.errors += 1;
      continue;
    }

    const hour = localHour(now, zone);
    if (hour === null) {
      console.error(`  ${park.name}: unknown timezone "${zone}". Skipped.`);
      result.errors += 1;
      continue;
    }
    if (!withinSampleWindow(hour)) {
      console.log(`  ${park.name}: ${hour}:00 local — outside ${WAIT_SAMPLE_FROM_HOUR}-${WAIT_SAMPLE_TO_HOUR}, skipped.`);
      result.skippedWindow += 1;
      continue;
    }

    let summary: ParkSummary | null;
    try {
      const res = await fetchImpl(`${BASE}/parks/${park.id}/queue_times.json`, {
        headers: { "user-agent": UA, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
      summary = summarise(await res.json());
    } catch (e) {
      // One park's failure must not cost the other ten their sample. This is
      // a cache being accumulated, not a table being replaced, so partial is
      // correct here — the opposite call from the climate generator, which
      // refuses to write an incomplete table.
      console.error(`  ${park.name}: ${(e as Error).message}`);
      result.errors += 1;
      continue;
    }

    if (!summary) {
      console.log(`  ${park.name}: nothing open at ${hour}:00 local — recorded nothing.`);
      result.skippedClosed += 1;
      continue;
    }

    console.log(`  ${park.name}: ${summary.meanWait} min mean, ${summary.maxWait} max, `
      + `${summary.openRides} open (${hour}:00 local)`);
    if (dryRun) continue;

    await db.query(
      `insert into wait_time_samples
         (park_id, observed_at, resort_id, local_hour, mean_wait_min, max_wait_min, open_rides, source)
       values ($1,$2,$3,$4,$5,$6,$7,'queue_times')
       on conflict (park_id, observed_at) do update set
         mean_wait_min = excluded.mean_wait_min, max_wait_min = excluded.max_wait_min,
         open_rides = excluded.open_rides, local_hour = excluded.local_hour`,
      [park.id, now.toISOString(), park.resortId, hour,
       summary.meanWait, summary.maxWait, summary.openRides],
    );
    result.written += 1;
  }

  console.log(`wait-times: ${result.written} recorded, ${result.skippedWindow} outside hours, `
    + `${result.skippedClosed} closed, ${result.errors} error(s)${dryRun ? " (dry run, nothing written)" : ""}`);
  return result;
}

const UA = "Parkfare/0.1 (+https://pricingthemagic.com)";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import("../db.js");
  const db = await getDb();
  await runWaitTimes(db);
  await db.close?.();
}
