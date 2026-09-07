/**
 * The morning refresh.
 *
 * Three rules, all of them about not making things worse:
 *   1. Upsert on success only — a failed run must never delete good rows.
 *      Yesterday's price is worth far more than no price.
 *   2. Stay under the rate limit and back off on 429 (the provider does this).
 *   3. Log every run, so when prices look wrong in three months you can find out why.
 */
import { randomUUID } from "node:crypto";
import {
  ORIGINS, REFRESH_TIERS, RESORTS, TRIP_BUCKETS, RESORT_BY_ID, AIRPORT_TRANSPORT_GUESSES,
} from "../config.js";
import { addDaysISO, monthKey, todayISO, range, monthBounds } from "../dates.js";
import { getDb, type Db } from "../db.js";
import { MockProvider } from "../providers/mock.js";
import { TravelpayoutsProvider } from "../providers/travelpayouts.js";
import type { FlightQuote, HotelQuote, Provider } from "../providers/types.js";
import { seasonOf } from "../seasonality.js";

export function pickProvider(): Provider {
  return process.env.TRAVELPAYOUTS_TOKEN ? new TravelpayoutsProvider() : new MockProvider();
}

/** Months whose tier is due today. Near dates every day, far dates weekly. */
export function dueMonths(today = todayISO(), dayOfYear = dayNumber()): string[] {
  const months = new Set<string>();
  for (const tier of REFRESH_TIERS) {
    if (dayOfYear % tier.everyDays !== 0) continue;
    for (let d = tier.fromDay; d <= tier.toDay; d += 15) months.add(monthKey(addDaysISO(today, d)));
    months.add(monthKey(addDaysISO(today, tier.toDay)));
  }
  return [...months].sort();
}

/**
 * Every month any tier ever touches, regardless of whether that tier is due
 * today. `dueMonths()` is built to spread the far tier's cost across a week
 * of daily cron runs — exactly right for keeping a warm cache fresh, but it
 * means a brand-new, empty database only gets the near tier on day one and
 * doesn't reach a year out until the weekly tier has rotated all the way
 * through. This is the one-time catch-up for that gap: call it once right
 * after first deploying, then let the normal tiered `dueMonths()` cron take
 * over keeping it fresh.
 */
export function allTierMonths(today = todayISO()): string[] {
  const months = new Set<string>();
  const from = Math.min(...REFRESH_TIERS.map((t) => t.fromDay));
  const to = Math.max(...REFRESH_TIERS.map((t) => t.toDay));
  for (let d = from; d <= to; d += 15) months.add(monthKey(addDaysISO(today, d)));
  months.add(monthKey(addDaysISO(today, to)));
  return [...months].sort();
}

function dayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

async function upsertFlights(db: Db, rows: FlightQuote[]): Promise<number> {
  if (!rows.length) return 0;
  const vals: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 8;
    vals.push(r.origin, r.destination, r.departDate, r.tripLength, r.priceUsd, r.carrier ?? null, r.stops, r.deepLink ?? null);
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},now())`;
  });
  await db.query(
    `insert into flight_prices
       (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,fetched_at)
     values ${tuples.join(",")}
     on conflict (origin,destination,depart_date,trip_length) do update set
       price_usd = excluded.price_usd, carrier = excluded.carrier, stops = excluded.stops,
       deep_link = excluded.deep_link, fetched_at = excluded.fetched_at`,
    vals,
  );
  return rows.length;
}

async function upsertHotels(db: Db, rows: HotelQuote[]): Promise<number> {
  if (!rows.length) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 9;
      vals.push(r.hotelId, r.resortId, r.hotelName, r.descriptor, r.stayDate, r.nightlyUsd, r.tier, r.onProperty, r.deepLink ?? null);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},now())`;
    });
    await db.query(
      `insert into hotel_rates
         (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,deep_link,fetched_at)
       values ${tuples.join(",")}
       on conflict (hotel_id,stay_date) do update set
         nightly_usd = excluded.nightly_usd, hotel_name = excluded.hotel_name,
         descriptor = excluded.descriptor, tier = excluded.tier,
         on_property = excluded.on_property, deep_link = excluded.deep_link,
         fetched_at = excluded.fetched_at`,
      vals,
    );
    written += chunk.length;
  }
  return written;
}

/**
 * Tickets have no API at any of the six resorts. This seeds a placeholder curve
 * so the system runs end to end; replace it with rows you maintain by hand
 * against each resort's published calendar. Alarm if any resort's rows go stale.
 */
export async function seedTickets(db: Db, months: string[]): Promise<number> {
  let n = 0;
  for (const resort of RESORTS) {
    for (const m of months) {
      const [from, to] = monthBounds(m);
      const dates = range(from, to);
      const vals: unknown[] = [];
      const tuples = dates.map((d, i) => {
        const b = i * 6;
        const s = 1 + (seasonOf(resort.id, d).m - 1) * 0.55;
        const adult = Math.round(resort.ticket.base * s * 100) / 100;
        const child = Math.round(adult * resort.ticket.child * 100) / 100;
        const junior = resort.ticket.junior ? Math.round(adult * resort.ticket.junior * 100) / 100 : null;
        vals.push(resort.id, d, adult, child, junior, resort.ticketUrl);
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},now())`;
      });
      await db.query(
        `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd,junior_usd,source_url,updated_at)
         values ${tuples.join(",")}
         on conflict (resort_id,park_date) do update set
           adult_usd = excluded.adult_usd, child_usd = excluded.child_usd,
           junior_usd = excluded.junior_usd, updated_at = excluded.updated_at`,
        vals,
      );
      n += dates.length;
    }
  }
  return n;
}

/**
 * Airport parking/rideshare/transit costs, same "no live API, hand-maintained"
 * situation as tickets — but static reference data, not a time series, so
 * this is 18 rows upserted on origin, no date loop.
 */
export async function seedAirportTransport(db: Db): Promise<number> {
  const rows = Object.entries(AIRPORT_TRANSPORT_GUESSES);
  if (!rows.length) return 0;
  const vals: unknown[] = [];
  const tuples = rows.map(([origin, g], i) => {
    const b = i * 6;
    vals.push(origin, g.parkingPerDayUsd, g.rideshareRoundTripUsd, g.transitAvailable, g.transitRoundTripUsd ?? null, g.note);
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},now())`;
  });
  await db.query(
    `insert into airport_transport
       (origin,parking_per_day_usd,rideshare_roundtrip_usd,transit_available,transit_roundtrip_usd,source_note,updated_at)
     values ${tuples.join(",")}
     on conflict (origin) do update set
       parking_per_day_usd = excluded.parking_per_day_usd, rideshare_roundtrip_usd = excluded.rideshare_roundtrip_usd,
       transit_available = excluded.transit_available, transit_roundtrip_usd = excluded.transit_roundtrip_usd,
       source_note = excluded.source_note, updated_at = excluded.updated_at`,
    vals,
  );
  return rows.length;
}

export interface RefreshOptions {
  months?: string[]; origins?: string[]; resorts?: string[]; provider?: Provider;
}

export async function runRefresh(db: Db, opts: RefreshOptions = {}) {
  const provider = opts.provider ?? pickProvider();
  const months = opts.months ?? dueMonths();
  const origins = opts.origins ?? ORIGINS.map((o) => o.iata);
  const resorts = (opts.resorts ?? RESORTS.map((r) => r.id))
    .map((id) => RESORT_BY_ID.get(id)!).filter(Boolean);

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'refresh',$2)`,
    [runId, `${provider.name} · ${months.length} months`]);

  let calls = 0, rows = 0, errors = 0;
  for (const month of months) {
    for (const resort of resorts) {
      // Primary airport plus any alternates (e.g. Tampa alongside MCO for WDW) —
      // each is its own (origin, destination) pair in flight_prices, so a user
      // picking an alternate in the UI always finds a real cached fare.
      const destinations = [resort.iata, ...resort.altArrivalAirports.map((a) => a.iata)];
      for (const origin of origins) {
        for (const destination of destinations) {
          for (const bucket of TRIP_BUCKETS) {
            try {
              calls++;
              const quotes = await provider.flightMonth(origin, destination, month, bucket);
              rows += await upsertFlights(db, quotes);
            } catch (e) {
              errors++;
              console.error(`flights ${origin}->${destination} ${month}/${bucket}:`, (e as Error).message);
            }
          }
        }
      }
      try {
        calls++;
        rows += await upsertHotels(db, await provider.hotelMonth(resort.id, month));
      } catch (e) {
        errors++;
        console.error(`hotels ${resort.id} ${month}:`, (e as Error).message);
      }
    }
  }
  rows += await seedTickets(db, months);
  rows += await seedAirportTransport(db);

  await db.query(
    `update fetch_runs set finished_at = now(), calls = $2, rows_written = $3, errors = $4 where id = $1`,
    [runId, calls, rows, errors],
  );
  return { runId, calls, rows, errors, months: months.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const backfill = process.env.REFRESH_BACKFILL === "true" || process.env.REFRESH_BACKFILL === "1";
  const res = await runRefresh(db, backfill ? { months: allTierMonths() } : {});
  console.log(`refresh done: ${res.calls} calls, ${res.rows} rows, ${res.errors} errors${backfill ? " (full backfill)" : ""}`);
  await db.close();
}
