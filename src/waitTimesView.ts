/**
 * The owner's window onto `wait_time_samples` — read-only, owner-only.
 *
 * The owner asked to be able to SEE what the wait-times job has been
 * recording. The table is still "shown to nobody" as far as travelers go
 * (see the decision note in CLAUDE.md: every automated source records POSTED
 * waits, and that bias isn't uniform across six operators), so this lives in
 * /admin, never on the board.
 *
 * Two views:
 *  - a per-park summary: how much has been recorded and whether it is still
 *    arriving. A park that stops recording is the failure worth spotting —
 *    five of twelve parks recorded nothing for their first weeks because of a
 *    wrong id or a spelling, and nothing but the job log said so.
 *  - raw rows as a spreadsheet, for anyone who wants to do their own sums.
 *
 * The averages here are deliberately simple (mean of reported waits for open
 * rides) and labelled as posted waits. The careful aggregation — by local
 * hour first, then across hours, with a floor of distinct days — is written
 * up in jobs/waitTimes.ts for the day a real card is built. This is a look
 * at the archive, not that card.
 */
import type { Db } from "./db.js";
import { QUEUE_TIMES_PARKS, RESORT_BY_ID } from "./config.js";

export interface ParkSummary {
  resortId: string;
  resortName: string;
  parkId: number;
  parkName: string;
  rows: number;
  days: number;
  rides: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Mean posted wait across every open-ride sample that reported one. */
  avgPostedWaitMin: number | null;
  /** The last 7 days, same statistic — enough to see a trend at a glance. */
  avgPostedWaitMin7d: number | null;
}

export interface RideSummary {
  rideName: string;
  samples: number;
  avgPostedWaitMin: number | null;
  maxPostedWaitMin: number | null;
}

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Every tracked park, including ones that have recorded nothing — an empty
 *  row is the whole point, since that's how a broken park shows up. */
export async function waitTimesSummary(db: Db, now = new Date()): Promise<ParkSummary[]> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { rows } = await db.query<{
    park_id: number; rows: string | number; days: string | number; rides: string | number;
    first_at: unknown; last_at: unknown; avg_wait: string | number | null; avg_wait_7d: string | number | null;
  }>(
    `select park_id,
            count(*) as rows,
            count(distinct (observed_at at time zone 'UTC')::date) as days,
            count(distinct ride_name) as rides,
            min(observed_at) as first_at,
            max(observed_at) as last_at,
            avg(wait_min) filter (where is_open and wait_min is not null) as avg_wait,
            avg(wait_min) filter (where is_open and wait_min is not null and observed_at >= $1) as avg_wait_7d
       from wait_time_samples
      group by park_id`,
    [weekAgo],
  );
  const byPark = new Map(rows.map((r) => [Number(r.park_id), r]));
  const round = (v: string | number | null) => (v == null ? null : Math.round(Number(v)));
  const out: ParkSummary[] = [];
  for (const [resortId, parks] of Object.entries(QUEUE_TIMES_PARKS)) {
    for (const park of parks) {
      const r = byPark.get(park.id);
      out.push({
        resortId,
        resortName: RESORT_BY_ID.get(resortId)?.name ?? resortId,
        parkId: park.id,
        parkName: park.name,
        rows: Number(r?.rows ?? 0),
        days: Number(r?.days ?? 0),
        rides: Number(r?.rides ?? 0),
        firstAt: iso(r?.first_at),
        lastAt: iso(r?.last_at),
        avgPostedWaitMin: round(r?.avg_wait ?? null),
        avgPostedWaitMin7d: round(r?.avg_wait_7d ?? null),
      });
    }
  }
  return out;
}

/** One park's rides, longest average posted wait first. */
export async function rideSummary(db: Db, parkId: number): Promise<RideSummary[]> {
  const { rows } = await db.query<{
    ride_name: string; samples: string | number; avg_wait: string | number | null; max_wait: number | null;
  }>(
    `select ride_name,
            count(*) filter (where is_open and wait_min is not null) as samples,
            avg(wait_min) filter (where is_open and wait_min is not null) as avg_wait,
            max(wait_min) filter (where is_open) as max_wait
       from wait_time_samples
      where park_id = $1
      group by ride_name
      order by avg_wait desc nulls last, ride_name`,
    [parkId],
  );
  return rows.map((r) => ({
    rideName: r.ride_name,
    samples: Number(r.samples),
    avgPostedWaitMin: r.avg_wait == null ? null : Math.round(Number(r.avg_wait)),
    maxPostedWaitMin: r.max_wait == null ? null : Number(r.max_wait),
  }));
}

/** Raw rows for the spreadsheet, newest first. Bounded by days and a hard row
 *  cap so one click can never try to stream the whole archive through a free
 *  Render instance. */
export const WAIT_CSV_MAX_ROWS = 50_000;
export async function waitTimeRows(db: Db, days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const { rows } = await db.query<{
    resort_id: string; park_id: number; ride_name: string; observed_at: unknown;
    local_hour: number; is_open: boolean; wait_min: number | null;
  }>(
    `select resort_id, park_id, ride_name, observed_at, local_hour, is_open, wait_min
       from wait_time_samples
      where observed_at >= $1
      order by observed_at desc, park_id, ride_name
      limit ${WAIT_CSV_MAX_ROWS}`,
    [since],
  );
  return rows.map((r) => ({ ...r, observed_at: iso(r.observed_at) }));
}
