/**
 * A private, owner-only daily digest of what real provider data actually
 * landed in the cache recently — which routes and which hotels a vendor
 * genuinely returned prices for, and when.
 *
 * Why this is worth its own job rather than a line in the refresh summary:
 * refresh reports "N calls, M rows" and can report success while the routes
 * a user actually searches hold nothing real. coverage.ts answers the same
 * question far more thoroughly, but for one origin at a time and only on a
 * terminal. This is the whole-cache version, small enough to read over
 * coffee, and it arrives whether or not anyone remembers to look.
 *
 * "Real" means a row whose `source` names a provider that actually returned
 * it. A row tagged `mock`, or left unlabelled because it predates source
 * tracking, is not a pull and is counted separately rather than quietly
 * folded in — the whole point is to know what genuinely came from a vendor.
 *
 * Reads only. No provider calls, no writes beyond its own fetch_runs row.
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "../db.js";
import type { EmailSender } from "../email/types.js";
import { pickEmailSender } from "../email/pick.js";

/** Sources that do NOT mean "a vendor returned this". Everything else does. */
export const NON_PROVIDER_SOURCES = ["mock"];

export const DEFAULT_WINDOW_DAYS = 15;

export interface RoutePull {
  origin: string;
  destination: string;
  source: string;
  rows: number;
  /** Departure dates covered by those rows, not the day they were fetched. */
  firstDepart: string;
  lastDepart: string;
  lastPulled: string;
}

export interface HotelPull {
  resortId: string;
  hotelId: string;
  hotelName: string;
  source: string;
  rows: number;
  firstStay: string;
  lastStay: string;
  lastPulled: string;
}

export interface PullsDigestOptions {
  sender?: EmailSender;
  ownerEmail?: string;
  /** How far back to look. The owner's ask was 15 days. */
  windowDays?: number;
  /** Send even when nothing was pulled. A silent morning is itself a signal. */
  sendWhenEmpty?: boolean;
}

/** Postgres hands back date/timestamp columns as JS Dates; format, don't slice. */
function day(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function stamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return String(v);
}

export async function routePulls(db: Db, windowDays: number): Promise<RoutePull[]> {
  const { rows } = await db.query<{
    origin: string; destination: string; source: string; n: string;
    first_depart: unknown; last_depart: unknown; last_pulled: unknown;
  }>(
    `select origin, destination, source,
            count(*) as n,
            min(depart_date) as first_depart,
            max(depart_date) as last_depart,
            max(fetched_at)  as last_pulled
       from flight_prices
      where fetched_at >= now() - ($1 || ' days')::interval
        and source is not null
        and source <> all($2::text[])
      group by origin, destination, source
      order by max(fetched_at) desc, origin, destination`,
    [String(windowDays), NON_PROVIDER_SOURCES],
  );
  return rows.map((r) => ({
    origin: r.origin, destination: r.destination, source: r.source, rows: Number(r.n),
    firstDepart: day(r.first_depart), lastDepart: day(r.last_depart), lastPulled: stamp(r.last_pulled),
  }));
}

export async function hotelPulls(db: Db, windowDays: number): Promise<HotelPull[]> {
  const { rows } = await db.query<{
    resort_id: string; hotel_id: string; hotel_name: string; source: string; n: string;
    first_stay: unknown; last_stay: unknown; last_pulled: unknown;
  }>(
    `select resort_id, hotel_id, max(hotel_name) as hotel_name, source,
            count(*) as n,
            min(stay_date) as first_stay,
            max(stay_date) as last_stay,
            max(fetched_at) as last_pulled
       from hotel_rates
      where fetched_at >= now() - ($1 || ' days')::interval
        and source is not null
        and source <> all($2::text[])
      group by resort_id, hotel_id, source
      order by resort_id, max(fetched_at) desc, hotel_id`,
    [String(windowDays), NON_PROVIDER_SOURCES],
  );
  return rows.map((r) => ({
    resortId: r.resort_id, hotelId: r.hotel_id, hotelName: r.hotel_name, source: r.source,
    rows: Number(r.n), firstStay: day(r.first_stay), lastStay: day(r.last_stay),
    lastPulled: stamp(r.last_pulled),
  }));
}

/**
 * Rows written in the same window that are NOT a real pull. Reported as a
 * one-line footnote so a digest that says "nothing was pulled" can't be
 * mistaken for "the refresh job is broken" when the truth is "no provider
 * key is configured, so it's all mock data".
 */
async function nonPullCounts(db: Db, windowDays: number): Promise<{ flights: number; hotels: number }> {
  const q = async (table: string) => {
    const { rows } = await db.query<{ n: string }>(
      `select count(*) as n from ${table}
        where fetched_at >= now() - ($1 || ' days')::interval
          and (source is null or source = any($2::text[]))`,
      [String(windowDays), NON_PROVIDER_SOURCES],
    );
    return Number(rows[0]?.n ?? 0);
  };
  return { flights: await q("flight_prices"), hotels: await q("hotel_rates") };
}

export function formatDigest(
  routes: RoutePull[], hotels: HotelPull[], windowDays: number,
  nonPull: { flights: number; hotels: number },
): string {
  const out: string[] = [];
  out.push(`Real provider data pulled in the last ${windowDays} days.`);
  out.push("");

  out.push(`FLIGHT ROUTES — ${routes.length} route/source combination${routes.length === 1 ? "" : "s"}`);
  if (!routes.length) {
    out.push("  Nothing. No route had a real fare pulled in this window.");
  } else {
    const totalRows = routes.reduce((n, r) => n + r.rows, 0);
    const n = new Set(routes.map((r) => `${r.origin}-${r.destination}`)).size;
    out.push(`  ${totalRows} fare rows across ${n} distinct route${n === 1 ? "" : "s"}.`);
    out.push("");
    out.push("  route     source              rows  departures covered        last pulled");
    for (const r of routes) {
      out.push(
        `  ${(r.origin + "-" + r.destination).padEnd(9)} ${r.source.padEnd(19)} ` +
        `${String(r.rows).padStart(4)}  ${r.firstDepart} to ${r.lastDepart}  ${r.lastPulled}`,
      );
    }
  }
  out.push("");

  out.push(`HOTELS — ${hotels.length} hotel/source combination${hotels.length === 1 ? "" : "s"}`);
  if (!hotels.length) {
    out.push("  Nothing. No hotel had a real rate pulled in this window.");
  } else {
    const totalRows = hotels.reduce((n, h) => n + h.rows, 0);
    const n = new Set(hotels.map((h) => h.hotelId)).size;
    out.push(`  ${totalRows} nightly rates across ${n} distinct hotel${n === 1 ? "" : "s"}.`);
    out.push("");
    out.push("  resort  hotel                                  source             rows  stays covered             last pulled");
    for (const h of hotels) {
      out.push(
        `  ${h.resortId.padEnd(7)} ${h.hotelName.slice(0, 38).padEnd(38)} ${h.source.padEnd(17)} ` +
        `${String(h.rows).padStart(4)}  ${h.firstStay} to ${h.lastStay}  ${h.lastPulled}`,
      );
    }
  }

  if (nonPull.flights || nonPull.hotels) {
    out.push("");
    out.push(
      `Not counted above: ${nonPull.flights} flight and ${nonPull.hotels} hotel rows were written in ` +
      "the same window by the mock provider, or carry no source label because they predate " +
      "source tracking. Those are not real pulls, so they are deliberately left out.",
    );
  }

  return out.join("\n");
}

export async function runPullsDigest(db: Db, opts: PullsDigestOptions = {}) {
  const sender = opts.sender ?? pickEmailSender();
  const ownerEmail = opts.ownerEmail ?? process.env.OWNER_EMAIL ?? "";
  const windowDays = opts.windowDays ?? Number(process.env.PULLS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  const sendWhenEmpty = opts.sendWhenEmpty ?? true;

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job) values ($1,'pulls_digest')`, [runId]);

  const routes = await routePulls(db, windowDays);
  const hotels = await hotelPulls(db, windowDays);
  const nonPull = await nonPullCounts(db, windowDays);
  const text = formatDigest(routes, hotels, windowDays, nonPull);

  let sent = 0;
  const anything = routes.length > 0 || hotels.length > 0;
  if (ownerEmail && (anything || sendWhenEmpty)) {
    try {
      await sender.send({
        to: ownerEmail,
        subject: anything
          ? `Parkfare: ${routes.length} route and ${hotels.length} hotel pulls in the last ${windowDays} days`
          : `Parkfare: no real provider data pulled in the last ${windowDays} days`,
        text,
      });
      sent = 1;
    } catch (e) {
      console.error(`pulls digest send failed (${sender.name}):`, (e as Error).message);
    }
  }

  const note = !ownerEmail
    ? `${routes.length} routes, ${hotels.length} hotels — OWNER_EMAIL is not set, not sent`
    : `${routes.length} routes, ${hotels.length} hotels, ${sent ? "sent" : "send failed"}`;
  await db.query(
    `update fetch_runs set finished_at = now(), rows_written = $2, note = $3 where id = $1`,
    [runId, routes.length + hotels.length, note],
  );
  return { routes: routes.length, hotels: hotels.length, sent, windowDays, text, note };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const r = await runPullsDigest(db);
  // Printed as well as emailed, so `npm run pulls-digest` is useful on its own
  // and so the GitHub Actions log shows exactly what went out.
  console.log(r.text);
  console.log(`\npulls digest: ${r.note}`);
  await db.close();
}
