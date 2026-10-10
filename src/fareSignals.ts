/**
 * "What moves the price?" — a read-only report for /admin (owner, 2026-10-10:
 * "Put a read only report on /admin so I can look at it").
 *
 * It lays the evidence we already hold side by side, so the owner can see
 * which signals actually line up with real fares before any of them is
 * allowed to move a number travelers see:
 *
 *  1. International: what we bought vs the flat seed guess, per destination
 *     and per travel quarter. One shared trend multiplier is applied to every
 *     international route today; this shows how far apart the destinations
 *     and seasons really are.
 *  2. Our bought fare (Google's MIDDLE itinerary for one date) vs Google's
 *     own "typical price" (what the CHEAPEST seat on the route usually costs)
 *     — two different questions, shown so neither is mistaken for the other.
 *  3. Google's price level ("low / typical / high for this time") by resort
 *     and travel month, next to our crowd band for that month. A first look
 *     at whether flight demand and our crowd bands agree. Nothing here
 *     changes a crowd band.
 *  4. Which government fare-survey quarters we hold, by source.
 *
 * No provider calls and no writes. Everything comes from the append-only
 * record (flight_observations, flight_insights) and historical_fares.
 */
import type { Db } from "./db.js";
import { RESORTS } from "./config.js";
import { crowdFor } from "./crowds.js";

const INTL_DESTS = ["CDG", "NRT", "HND", "PVG", "HKG"];

/** Which resort an arrival airport belongs to. */
export function resortForAirport(iata: string): { id: string; name: string; region: string } | undefined {
  const r = RESORTS.find((x) => x.iata === iata || x.altArrivalAirports.some((a) => a.iata === iata));
  return r ? { id: r.id, name: r.name, region: r.region } : undefined;
}

export interface LevelCount { resortId: string; month: number; level: string | null; n: number }
export interface LevelRow {
  resortId: string; resortName: string; month: number;
  searches: number; lowPct: number; typicalPct: number; highPct: number;
  crowd: string | null; crowdBasis: string | null;
}

/** Turns raw (resort, month, price level, count) rows into one row per resort
 *  and month with each level's share. Searches with no level are counted in
 *  `searches` but in none of the shares, so the three shares can sum below
 *  100 and never pretend an unknown was "typical". Pure, for its test. */
export function levelShares(rows: LevelCount[], names: Record<string, string>): LevelRow[] {
  const acc = new Map<string, { resortId: string; month: number; n: number; low: number; typical: number; high: number }>();
  for (const r of rows) {
    const k = `${r.resortId}|${r.month}`;
    const a = acc.get(k) ?? { resortId: r.resortId, month: r.month, n: 0, low: 0, typical: 0, high: 0 };
    a.n += r.n;
    const lv = (r.level ?? "").toLowerCase();
    if (lv === "low") a.low += r.n;
    else if (lv === "typical") a.typical += r.n;
    else if (lv === "high") a.high += r.n;
    acc.set(k, a);
  }
  const pct = (x: number, n: number) => (n ? Math.round((x / n) * 100) : 0);
  return [...acc.values()]
    .sort((a, b) => a.resortId.localeCompare(b.resortId) || a.month - b.month)
    .map((a) => {
      const c = crowdFor(a.resortId, a.month);
      return {
        resortId: a.resortId, resortName: names[a.resortId] ?? a.resortId, month: a.month,
        searches: a.n, lowPct: pct(a.low, a.n), typicalPct: pct(a.typical, a.n), highPct: pct(a.high, a.n),
        crowd: c?.label ?? null, crowdBasis: c?.basis ?? null,
      };
    });
}

export async function loadFareSignals(db: Db) {
  const trends = (await db.query<{ kind: string; multiplier: string; sample_routes: number; computed_at: unknown }>(
    `select distinct on (kind) kind, multiplier, sample_routes, computed_at
       from fare_trend order by kind, computed_at desc`,
  )).rows.map((r) => ({ kind: r.kind, multiplier: Number(r.multiplier), routes: Number(r.sample_routes), computedAt: r.computed_at }));

  // Bought international fare vs the seed guess for the same route and quarter.
  const seedJoin = `
    with b as (
      select o.origin, o.destination, extract(quarter from o.depart_date)::int as q, o.price_usd
        from flight_observations o
       where o.source = 'serpapi_flights' and o.destination = any($1)
    ), s as (
      select distinct on (origin, destination, quarter) origin, destination, quarter,
             coalesce(median_fare_usd, avg_fare_usd) as seed
        from historical_fares where source = 'seed_guess'
       order by origin, destination, quarter, year desc
    )`;
  const byDestination = (await db.query<{ destination: string; n: string; cities: string; bought: string; seed: string; ratio: string; lo: string; hi: string }>(
    `${seedJoin}
     select b.destination, count(*) as n, count(distinct b.origin) as cities,
            percentile_cont(0.5) within group (order by b.price_usd) as bought,
            percentile_cont(0.5) within group (order by s.seed) as seed,
            percentile_cont(0.5) within group (order by b.price_usd / s.seed) as ratio,
            percentile_cont(0.25) within group (order by b.price_usd / s.seed) as lo,
            percentile_cont(0.75) within group (order by b.price_usd / s.seed) as hi
       from b join s on s.origin = b.origin and s.destination = b.destination and s.quarter = b.q
      group by b.destination order by b.destination`,
    [INTL_DESTS],
  )).rows.map((r) => ({
    destination: r.destination, resort: resortForAirport(r.destination)?.name ?? r.destination,
    fares: Number(r.n), cities: Number(r.cities), boughtMedian: Number(r.bought), seedMedian: Number(r.seed),
    ratio: Number(r.ratio), ratioLow: Number(r.lo), ratioHigh: Number(r.hi),
  }));
  const byQuarter = (await db.query<{ region: string; q: number; n: string; ratio: string }>(
    `${seedJoin}
     select case when b.destination = 'CDG' then 'Europe' else 'Asia' end as region, b.q,
            count(*) as n, percentile_cont(0.5) within group (order by b.price_usd / s.seed) as ratio
       from b join s on s.origin = b.origin and s.destination = b.destination and s.quarter = b.q
      group by 1, 2 order by 1, 2`,
    [INTL_DESTS],
  )).rows.map((r) => ({ region: r.region, quarter: Number(r.q), fares: Number(r.n), ratio: Number(r.ratio) }));

  // Our fare (the middle itinerary) vs Google's own typical range and lowest
  // for the SAME search, matched within an hour of each other.
  const vsGoogle = (await db.query<{ destination: string; n: string; ours: string; lo: string; hi: string; lowest: string; above: string; below: string }>(
    `select o.destination, count(*) as n,
            percentile_cont(0.5) within group (order by o.price_usd) as ours,
            percentile_cont(0.5) within group (order by i.typical_low) as lo,
            percentile_cont(0.5) within group (order by i.typical_high) as hi,
            percentile_cont(0.5) within group (order by i.lowest_price) as lowest,
            sum(case when o.price_usd > i.typical_high then 1 else 0 end) as above,
            sum(case when o.price_usd < i.typical_low then 1 else 0 end) as below
       from flight_observations o
       join flight_insights i on i.origin = o.origin and i.destination = o.destination
        and i.depart_date = o.depart_date and i.trip_length = o.trip_length
        and abs(extract(epoch from (i.observed_at - o.observed_at))) < 3600
      where o.source = 'serpapi_flights' and i.typical_low is not null
      group by 1 order by 1`,
  )).rows.map((r) => ({
    destination: r.destination, resort: resortForAirport(r.destination)?.name ?? r.destination,
    searches: Number(r.n), ours: Number(r.ours), typicalLow: Number(r.lo), typicalHigh: Number(r.hi),
    lowest: Number(r.lowest), above: Number(r.above), below: Number(r.below),
  }));

  // Google's "price level" for each paid search, by resort and TRAVEL month.
  const rawLevels = (await db.query<{ destination: string; month: number; level: string | null; n: string }>(
    `select destination, extract(month from depart_date)::int as month, lower(price_level) as level, count(*) as n
       from flight_insights group by 1, 2, 3`,
  )).rows;
  const counts: LevelCount[] = [];
  for (const r of rawLevels) {
    const res = resortForAirport(r.destination);
    if (res) counts.push({ resortId: res.id, month: Number(r.month), level: r.level, n: Number(r.n) });
  }
  const names = Object.fromEntries(RESORTS.map((r) => [r.id, r.name]));
  const priceLevels = levelShares(counts, names);

  const surveys = (await db.query<{ source: string; year: number; quarter: number; routes: string; fetched: unknown }>(
    `select source, year, quarter, count(*) as routes, max(fetched_at) as fetched
       from historical_fares where source like 'bts%'
      group by 1, 2, 3 order by 2, 3, 1`,
  )).rows.map((r) => ({ source: r.source, year: Number(r.year), quarter: Number(r.quarter), routes: Number(r.routes), loadedAt: r.fetched }));

  return { trends, byDestination, byQuarter, vsGoogle, priceLevels, surveys };
}
