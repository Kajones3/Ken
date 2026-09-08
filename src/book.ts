/**
 * Loads one slice of the cache into memory so pricing can run synchronously.
 * A whole 12-month fare calendar is three indexed queries, not 365 round trips.
 */
import type { Db } from "./db.js";
import type { ISODate } from "./dates.js";
import type { FlightRow, HotelNight, PriceBook, PromoRow, TicketRow } from "./pricing.js";
import type { Tier } from "./config.js";

export interface BookRequest {
  origin: string;
  destinations: string[];      // IATA codes
  resortIds: string[];
  from: ISODate;
  to: ISODate;
  tripLength: number;
}

/**
 * Postgres returns `date` columns as JS Date objects (at local midnight), while
 * PGlite and JSON round-trips can hand back strings. Normalise both to
 * YYYY-MM-DD without letting a timezone shift the day.
 */
export function dateStr(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

export async function loadBook(db: Db, req: BookRequest): Promise<PriceBook> {
  const flights = new Map<string, FlightRow>();
  const hotels = new Map<string, HotelNight[]>();
  const tickets = new Map<string, TicketRow>();
  let oldest: Date | null = null;
  const seen = (d: unknown) => {
    if (!d) return;
    const t = d instanceof Date ? d : new Date(String(d));
    if (!Number.isNaN(t.getTime()) && (!oldest || t < oldest)) oldest = t;
  };

  const f = await db.query(
    `select destination, depart_date, price_usd, carrier, stops, deep_link, fetched_at
       from flight_prices
      where origin = $1 and destination = any($2) and trip_length = $3
        and depart_date between $4 and $5`,
    [req.origin, req.destinations, req.tripLength, req.from, req.to],
  );
  for (const r of f.rows) {
    const date = dateStr(r.depart_date);
    flights.set(`${r.destination}|${date}`, {
      price: Number(r.price_usd), carrier: r.carrier ?? undefined,
      stops: Number(r.stops ?? 0), deepLink: r.deep_link ?? undefined,
    });
    seen(r.fetched_at);
  }

  const h = await db.query(
    `select resort_id, hotel_id, hotel_name, descriptor, stay_date, nightly_usd,
            tier, on_property, deep_link, fetched_at
       from hotel_rates
      where resort_id = any($1) and stay_date between $2 and $3`,
    [req.resortIds, req.from, req.to],
  );
  for (const r of h.rows) {
    const date = dateStr(r.stay_date);
    const key = `${r.resort_id}|${date}`;
    const list = hotels.get(key) ?? [];
    list.push({
      hotelId: r.hotel_id, name: r.hotel_name, descriptor: r.descriptor,
      nightly: Number(r.nightly_usd), tier: r.tier as Tier,
      onProperty: Boolean(r.on_property), deepLink: r.deep_link ?? undefined,
    });
    hotels.set(key, list);
    seen(r.fetched_at);
  }

  const t = await db.query(
    `select resort_id, park_date, adult_usd, child_usd, junior_usd, updated_at
       from ticket_prices
      where resort_id = any($1) and park_date between $2 and $3`,
    [req.resortIds, req.from, req.to],
  );
  for (const r of t.rows) {
    const date = dateStr(r.park_date);
    tickets.set(`${r.resort_id}|${date}`, {
      adult: Number(r.adult_usd), child: Number(r.child_usd),
      junior: r.junior_usd === null || r.junior_usd === undefined ? undefined : Number(r.junior_usd),
    });
    seen(r.updated_at);
  }

  // Owner-curated table, tiny — cheap to load in full for the requested window.
  const pr = await db.query(
    `select id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, historical, source_note
       from promos
      where active and (resort_id = any($1) or resort_id is null)
        and starts_on <= $2 and ends_on >= $3`,
    [req.resortIds, req.to, req.from],
  );
  const promos: PromoRow[] = pr.rows.map((r) => ({
    id: r.id, resortId: r.resort_id ?? null, label: r.label,
    effectKind: r.effect_kind, effectValue: Number(r.effect_value),
    startsOn: dateStr(r.starts_on), endsOn: dateStr(r.ends_on),
    historical: Boolean(r.historical), sourceNote: r.source_note ?? "",
  }));

  // Small time series, one row a day — just read the latest.
  const gp = await db.query(`select as_of, price_per_gallon_usd from gas_prices order by as_of desc limit 1`);
  const gasPriceRow = gp.rows[0]
    ? { pricePerGallonUsd: Number(gp.rows[0].price_per_gallon_usd), asOf: dateStr(gp.rows[0].as_of) }
    : undefined;

  // BTS historical baseline for this origin's routes, plus the latest
  // current-vs-baseline trend multiplier — combined lazily in
  // flightEstimate() below, only when there's no exact cache hit to use.
  const hf = await db.query(
    `select distinct on (origin, destination) origin, destination, avg_fare_usd, year, quarter
       from historical_fares
      where origin = $1 and destination = any($2)
      order by origin, destination, year desc, quarter desc`,
    [req.origin, req.destinations],
  );
  const historicals = new Map<string, { avgFareUsd: number; quarter: string }>();
  for (const r of hf.rows) {
    historicals.set(`${r.origin}|${r.destination}`, {
      avgFareUsd: Number(r.avg_fare_usd), quarter: `${r.year}Q${r.quarter}`,
    });
  }
  const ft = await db.query(
    `select multiplier, low_multiplier, high_multiplier from fare_trend order by computed_at desc limit 1`,
  );
  const trend = ft.rows[0]
    ? {
        m: Number(ft.rows[0].multiplier), lo: Number(ft.rows[0].low_multiplier),
        hi: Number(ft.rows[0].high_multiplier),
      }
    : undefined;

  return {
    flight: (_origin, dest, date) => flights.get(`${dest}|${date}`),
    flightEstimate: (origin, dest) => {
      const h = historicals.get(`${origin}|${dest}`);
      if (!h || !trend) return undefined;
      return {
        low: Math.round(h.avgFareUsd * trend.lo * 100) / 100,
        med: Math.round(h.avgFareUsd * trend.m * 100) / 100,
        high: Math.round(h.avgFareUsd * trend.hi * 100) / 100,
        basisQuarter: h.quarter,
      };
    },
    hotelNights: (resortId, date) => hotels.get(`${resortId}|${date}`) ?? [],
    ticket: (resortId, date) => tickets.get(`${resortId}|${date}`),
    promosFor: (resortId, date) => promos.filter((p) =>
      (p.resortId === resortId || p.resortId === null) && date >= p.startsOn && date <= p.endsOn),
    gasPrice: () => gasPriceRow,
    oldestFetchedAt: oldest,
  };
}

/** In-memory book for tests and for pricing straight off provider output. */
export function bookFrom(parts: {
  flights?: { dest: string; date: ISODate; row: FlightRow }[];
  hotels?: { resortId: string; date: ISODate; night: HotelNight }[];
  tickets?: { resortId: string; date: ISODate; row: TicketRow }[];
  promos?: PromoRow[];
  gasPrice?: { pricePerGallonUsd: number; asOf: string };
}): PriceBook {
  const f = new Map<string, FlightRow>();
  for (const x of parts.flights ?? []) f.set(`${x.dest}|${x.date}`, x.row);
  const h = new Map<string, HotelNight[]>();
  for (const x of parts.hotels ?? []) {
    const k = `${x.resortId}|${x.date}`;
    h.set(k, [...(h.get(k) ?? []), x.night]);
  }
  const t = new Map<string, TicketRow>();
  for (const x of parts.tickets ?? []) t.set(`${x.resortId}|${x.date}`, x.row);
  const promos = parts.promos ?? [];
  return {
    flight: (_o, dest, date) => f.get(`${dest}|${date}`),
    hotelNights: (rid, date) => h.get(`${rid}|${date}`) ?? [],
    ticket: (rid, date) => t.get(`${rid}|${date}`),
    promosFor: (resortId, date) => promos.filter((p) =>
      (p.resortId === resortId || p.resortId === null) && date >= p.startsOn && date <= p.endsOn),
    gasPrice: () => parts.gasPrice,
    oldestFetchedAt: null,
  };
}
