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
  ORIGINS, REFRESH_TIERS, RESORTS, TRIP_BUCKETS, RESORT_BY_ID,
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
      for (const origin of origins) {
        for (const bucket of TRIP_BUCKETS) {
          try {
            calls++;
            const quotes = await provider.flightMonth(origin, resort.iata, month, bucket);
            rows += await upsertFlights(db, quotes);
          } catch (e) {
            errors++;
            console.error(`flights ${origin}->${resort.iata} ${month}/${bucket}:`, (e as Error).message);
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

  await db.query(
    `update fetch_runs set finished_at = now(), calls = $2, rows_written = $3, errors = $4 where id = $1`,
    [runId, calls, rows, errors],
  );
  return { runId, calls, rows, errors, months: months.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const res = await runRefresh(db);
  console.log(`refresh done: ${res.calls} calls, ${res.rows} rows, ${res.errors} errors`);
  await db.close();
}
