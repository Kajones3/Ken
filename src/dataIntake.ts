/**
 * Did the data stick? A daily check, in the owner's morning email.
 *
 * Born of 2026-10-02/03: every paid job logged "18 real fares written" every
 * night, which was true, while the fares were being overwritten as fast as
 * they were bought. 226 paid fares became 19 and nothing said so, because
 * nothing ever compared what a job WROTE with what the database still HELD.
 * This does, every day, for flights and hotels, and says it in plain words.
 *
 * Read-only. Never calls a provider. A missing table (a deploy whose
 * migration hasn't run) is itself reported, not swallowed.
 */
import type { Db } from "./db.js";
import type { OwnerTask } from "./ownerTasks.js";
import { matchDisneyHotel } from "./disneyHotels.js";
import { SERPAPI_FLIGHTS } from "./observations.js";

export interface IntakeReport {
  /** Plain-language lines for the email, always included. */
  lines: string[];
  /** Anything wrong, as owner tasks. */
  problems: Omit<OwnerTask, "source">[];
}

const n = (x: unknown) => Number(x ?? 0);
const fmt = (x: number) => x.toLocaleString("en-US");

export async function dataIntake(db: Db, opts: { days?: number } = {}): Promise<IntakeReport> {
  const days = opts.days ?? 7;
  const lines: string[] = [];
  const problems: Omit<OwnerTask, "source">[] = [];

  try {
    // --- Flights: what came in over the last day, by source ---------------
    const day = await db.query<{ source: string; fares: string; routes: string }>(
      `select source, count(*) as fares, count(distinct origin || destination) as routes
         from flight_observations where observed_at > now() - interval '1 day'
        group by source order by count(*) desc`,
    );
    const total = await db.query<{ source: string; fares: string }>(
      `select source, count(*) as fares from flight_observations group by source order by count(*) desc`,
    );
    lines.push("FLIGHTS (every fare is kept, with its source)");
    lines.push(day.rows.length
      ? "  Last 24 hours: " + day.rows.map((r) => `${fmt(n(r.fares))} from ${label(r.source)} (${fmt(n(r.routes))} routes)`).join("; ")
      : "  Last 24 hours: NO fares came in from any source.");
    lines.push("  Kept in total: " + (total.rows.length
      ? total.rows.map((r) => `${fmt(n(r.fares))} ${label(r.source)}`).join("; ")
      : "none yet"));
    if (!day.rows.length) {
      problems.push({
        id: "intake-no-flights",
        title: "No flight prices came in yesterday, from any source",
        why: "The nightly jobs fetch fares every night, so a day with none means a job failed or a key stopped working. Check the 'Parkfare refresh' and 'Parkfare popular routes' runs in GitHub Actions.",
        side: "both", blocking: true,
      });
    }

    // --- Paid fares: did every fare a paid job wrote actually stay? -------
    const runs = await db.query<{ job: string; started_at: unknown; finished_at: unknown; rows_written: number; kept: string }>(
      `select r.job, r.started_at, r.finished_at, r.rows_written,
              (select count(*) from flight_observations o
                where o.source = $2 and o.observed_at >= r.started_at
                  and o.observed_at <= coalesce(r.finished_at, now()) + interval '1 minute') as kept
         from fetch_runs r
        where r.job in ('popular_routes', 'intl_sweep')
          and r.started_at > now() - ($1 || ' days')::interval
          and r.started_at >= coalesce((select done_at from schema_marks where name = 'flight_observations_backfill'), '-infinity')
          and r.finished_at is not null`,
      [String(days), SERPAPI_FLIGHTS],
    );
    // Runs from before the record existed (before 2026-10-04's migration)
    // never wrote to it, so their fares can't be "kept" there. That loss is
    // the known 2026-10-03 one (226 bought, 19 survived), not a new one, and
    // counting it here raised a false blocking alarm every morning for a week.
    const before = await db.query<{ runs: string; written: string }>(
      `select count(*) as runs, coalesce(sum(r.rows_written), 0) as written
         from fetch_runs r
        where r.job in ('popular_routes', 'intl_sweep')
          and r.started_at > now() - ($1 || ' days')::interval
          and r.started_at < coalesce((select done_at from schema_marks where name = 'flight_observations_backfill'), '-infinity')
          and r.finished_at is not null`,
      [String(days)],
    );
    const bought = runs.rows.reduce((s, r) => s + n(r.rows_written), 0);
    const kept = runs.rows.reduce((s, r) => s + Math.min(n(r.kept), n(r.rows_written)), 0);
    lines.push(`  Paid fares, last ${days} days: ${fmt(bought)} bought, ${fmt(kept)} kept`
      + (bought === kept ? " (all of them)." : `. ${fmt(bought - kept)} MISSING.`));
    const oldRuns = n(before.rows[0]?.runs);
    if (oldRuns) {
      lines.push(`  (Not counted: ${fmt(oldRuns)} paid run(s), ${fmt(n(before.rows[0]?.written))} fares, from before the record existed. Those are the known 2026-10-03 loss, not a new one.)`);
    }
    if (kept < bought) {
      problems.push({
        id: "intake-paid-fares-lost",
        title: `${fmt(bought - kept)} paid fares from the last ${days} days are not in the record`,
        why: "A paid job reported writing fares that were never kept. That is money spent on data we no longer have, the exact failure of 2026-10-03. Tell Claude: the writer is skipping recordFlightObservations().",
        side: "both", blocking: true,
      });
    }
    if (!runs.rows.length && !oldRuns) {
      problems.push({
        id: "intake-no-paid-runs",
        title: `The paid flight job hasn't finished a run in ${days} days`,
        why: "Nightly real fares are what keep every flight estimate honest. Check the 'Parkfare popular routes' workflow in GitHub Actions.",
        side: "both", blocking: true,
      });
    }

    // --- Hotels: did every paid hotel search land in the record? ----------
    // Only runs since the record began (same marker as flights): before it,
    // hotel_samples didn't exist in production, so those searches were
    // never going to be "kept" there.
    const refreshes = await db.query<{ started_at: unknown; finished_at: unknown; note: string; pulls: string; empty: string; failed: string }>(
      `select r.started_at, r.finished_at, r.note,
              (select count(distinct (s.resort_id, s.month, s.pulled_at)) from hotel_samples s
                where s.pulled_at >= r.started_at
                  and s.pulled_at <= coalesce(r.finished_at, now()) + interval '1 minute') as pulls,
              (select count(*) from hotel_searches h
                where h.status = 'ok' and h.priced = 0 and h.searched_at >= r.started_at
                  and h.searched_at <= coalesce(r.finished_at, now()) + interval '1 minute') as empty,
              (select count(*) from hotel_searches h
                where h.status <> 'ok' and h.searched_at >= r.started_at
                  and h.searched_at <= coalesce(r.finished_at, now()) + interval '1 minute') as failed
         from fetch_runs r
        where r.job = 'refresh' and r.started_at > now() - ($1 || ' days')::interval
          and r.started_at >= coalesce((select done_at from schema_marks where name = 'flight_observations_backfill'), '-infinity')
          and r.finished_at is not null`,
      [String(days)],
    );
    const slots = refreshes.rows.reduce((s, r) => s + slotCount(r.note), 0);
    const pulls = refreshes.rows.reduce((s, r) => s + n(r.pulls), 0);
    const empty = refreshes.rows.reduce((s, r) => s + n(r.empty), 0);
    const failed = refreshes.rows.reduce((s, r) => s + n(r.failed), 0);
    // Searches that left nothing and are NOT explained by "came back empty"
    // or "the search itself failed".
    const unexplained = Math.max(0, slots - pulls - empty - failed);
    const hDay = await db.query<{ resort_id: string; hotel_name: string }>(
      `select resort_id, hotel_name from hotel_samples where pulled_at > now() - interval '1 day'`,
    );
    const disney = hDay.rows.filter((r) => matchDisneyHotel(r.resort_id, r.hotel_name)).length;
    const hTotal = await db.query<{ c: string; hotels: string }>(
      `select count(*) as c, count(distinct (resort_id, hotel_name)) as hotels from hotel_samples`,
    );
    lines.push("");
    lines.push("HOTELS (every Google hotel search is kept, Disney's own hotels included)");
    lines.push(`  Last 24 hours: ${fmt(hDay.rows.length)} hotel rates (${fmt(disney)} of them Disney's own hotels, which now move our on-property prices).`);
    lines.push(`  Paid hotel searches, last ${days} days: ${fmt(slots)} made, ${fmt(pulls)} kept`
      + (empty ? `, ${fmt(empty)} came back with no prices from Google` : "")
      + (failed ? `, ${fmt(failed)} failed` : "")
      + (unexplained ? `, ${fmt(unexplained)} left nothing and aren't explained.` : "."));
    lines.push(`  Kept in total: ${fmt(n(hTotal.rows[0]?.c))} hotel rates across ${fmt(n(hTotal.rows[0]?.hotels))} hotels.`);
    if (slots > 0 && pulls === 0) {
      problems.push({
        id: "intake-hotels-lost",
        title: `None of the last ${days} days' ${fmt(slots)} paid hotel searches are in the record`,
        why: "Every search is paid for. If none of them are being kept, the hotel scorecard, the /admin hotel list and the Disney price check from Google all go blind. Tell Claude.",
        side: "both", blocking: true,
      });
    } else if (unexplained > 0) {
      problems.push({
        id: "intake-hotels-short",
        title: `${fmt(unexplained)} of ${fmt(slots)} paid hotel searches left nothing in the record`,
        why: "These searches were paid for and nothing about them was kept, not even that they came back empty. Tell Claude: a hotel search is skipping recordHotelSearches().",
        side: "both", blocking: false,
      });
    }
    if (empty + failed > 0) {
      problems.push({
        id: "intake-hotels-empty",
        title: `${fmt(empty + failed)} of ${fmt(slots)} paid hotel searches came back with no prices`,
        why: "Each one cost a search. The refresh log names them (\"returned ... none priced\"). Usually the dates are further ahead than Google prices; if the same months repeat, tell Claude to lower HOTEL_SEARCH_MAX_DAYS.",
        side: "both", blocking: false,
      });
    }
    // Google's whole answers (rawResponses.ts): one per paid search, errors included.
    const raw = await db.query<{ source: string; c: string; mb: string }>(
      `select source, count(*)::text as c, round(sum(octet_length(body_gz)) / 1048576.0, 1)::text as mb
         from provider_responses where fetched_at > now() - interval '24 hours' group by source order by source`,
    ).catch(() => ({ rows: [] as { source: string; c: string; mb: string }[] }));
    lines.push("");
    lines.push("GOOGLE'S WHOLE ANSWERS (everything each paid search returned, kept compressed)");
    lines.push("  Last 24 hours: " + (raw.rows.length
      ? raw.rows.map((r) => `${r.source} ${fmt(n(r.c))} (${r.mb} MB)`).join(", ")
      : "none (fine on a night with no paid searches)"));
  } catch (e) {
    lines.push(`The data check could not run: ${(e as Error).message}`);
    problems.push({
      id: "intake-check-failed",
      title: "The daily data check could not read the database",
      why: `Most likely the database update hasn't run (redeploy on Render, or run the 'Parkfare migrate' workflow). Error: ${(e as Error).message}`,
      side: "both", blocking: true,
    });
  }
  return { lines, problems };
}

/** "hotel slots: tdr/2027-09 dlp/2027-10 ..." in a refresh note. */
export function slotCount(note: string): number {
  const m = /hotel slots: ([^·]*)/.exec(note ?? "");
  return m ? m[1]!.trim().split(/\s+/).filter((x) => /\//.test(x)).length : 0;
}

function label(source: string): string {
  if (source === SERPAPI_FLIGHTS) return "paid Google Flights searches";
  if (source.startsWith("travelpayouts")) return "the free feed";
  return source;
}
