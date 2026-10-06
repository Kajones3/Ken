/**
 * Nightly: buy real fares for the routes people actually search.
 *
 * This is the half of the pricing model that costs money, and it is
 * deliberately the small half. Pre-fetching every supported route is not
 * affordable (19 origins x 11 airports x 3 trip lengths x 365 days is
 * ~229,000 metered lookups), so instead:
 *
 *   1. route_searches records what people ask for (see routeDemand.ts).
 *   2. This job spends a bounded number of real lookups on the busiest of
 *      those, sampling a few dates per route/month rather than every day.
 *   3. jobs/fareTrend.ts measures how far those real fares sit from the
 *      same routes' BTS medians, and
 *   4. book.ts moves *every other* route's BTS median by that same
 *      percentage, labeled as an estimate.
 *
 * So a busy route gets a real number, and a quiet one gets a real
 * historical median moved by a real, currently-measured trend. Neither is
 * a made-up curve.
 *
 * Every lookup is bounded twice over: SERPAPI_FLIGHTS_BUDGET caps the
 * provider itself, and POPULAR_ROUTES_LIMIT caps how many routes are
 * considered. Both fail closed — no key, no spend.
 */
import { randomUUID } from "node:crypto";
import { monthBounds, monthKey, quarterOf, todayISO, addDaysISO } from "../dates.js";
import { getDb, type Db } from "../db.js";
import { popularRoutes, recentlyBought, rotationRoutes, trendAnchorRoutes, type PopularRoute } from "../routeDemand.js";
import { SerpApiFlightProvider } from "../providers/serpapiFlights.js";
import { TRIP_BUCKETS, isLocalRoute, firstPlannableMonth, plannableMonths } from "../config.js";
import { loadScoreboard, type RouteScore } from "../fareScoreboard.js";
import { recordFlightObservations, SERPAPI_FLIGHTS } from "../observations.js";
import { flushRaw } from "../rawResponses.js";

/**
 * Which departure dates to actually buy for one route/month. Sampling, not
 * every day: fares within a month move far less than fares across seasons,
 * and a handful of real anchor points per month is what the trend needs.
 * Days 7/14/21 avoid both month edges, where a "month" search is least
 * likely to land.
 */
export function sampleDates(month: string, perMonth: number): string[] {
  const [first, last] = monthBounds(month);
  const lastDay = Number(last.slice(8, 10));
  const out: string[] = [];
  const step = Math.max(1, Math.floor(lastDay / (perMonth + 1)));
  for (let i = 1; i <= perMonth; i++) {
    const day = Math.min(lastDay, step * i);
    const iso = `${month}-${String(day).padStart(2, "0")}`;
    if (iso >= first && !out.includes(iso)) out.push(iso);
  }
  return out;
}

/**
 * The routes travelers see furthest off, and a month to buy for each
 * (owner, 2026-10-06: spend part of the nightly searches where we're most
 * wrong). Only routes outside the accuracy zone, in either direction. The
 * month is one of the months already tested if it can still be picked and
 * wasn't bought in the last few days, else another month of the same
 * season, so a route gathers the 2-3 fares in one season that let it be
 * trusted. Pure.
 */
export function pickWorstRoutes(
  routes: RouteScore[], opts: { useCandidate: boolean; zonePct: number; fresh: Set<string>;
    plannable: string[]; n: number; taken?: Set<string> },
): PopularRoute[] {
  const plannable = new Set(opts.plannable);
  const seen = (r: RouteScore) => (opts.useCandidate ? r.candPct : r.shownPct) ?? r.shownPct;
  const out: PopularRoute[] = [];
  const quarterMonths = (m: string) => {
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const q0 = Math.floor((mo - 1) / 3) * 3 + 1;
    return [0, 1, 2].map((i) => `${y}-${String(q0 + i).padStart(2, "0")}`);
  };
  const ranked = routes
    .filter((r) => { const v = seen(r); return v !== null && Math.abs(v) > opts.zonePct; })
    .sort((a, b) => Math.abs(seen(b)!) - Math.abs(seen(a)!));
  for (const r of ranked) {
    if (out.length >= opts.n) break;
    if (opts.taken?.has(`${r.origin}|${r.destination}`)) continue;
    if (isLocalRoute(r.origin, r.destination)) continue;
    const candidates = [...r.months, ...r.months.flatMap(quarterMonths)];
    const month = candidates.find((m) => plannable.has(m) && !opts.fresh.has(`${r.origin}|${r.destination}|${m}`));
    if (month) out.push({ origin: r.origin, destination: r.destination, departMonth: month, searches: 0 });
  }
  return out;
}

export interface PopularRoutesOptions {
  limit?: number;
  datesPerMonth?: number;
  /** Which trip lengths to buy. One by default: the middle bucket is what a
   *  typical search lands on, and buying all three triples the bill for a
   *  trend that reads the same either way. */
  buckets?: number[];
  routes?: PopularRoute[];
  /** Slots kept for the routes travelers see furthest off (idea 3). */
  worstSlots?: number;
  provider?: Pick<SerpApiFlightProvider, "quote" | "callsSpent" | "budgetRemaining">;
}

export async function runPopularRoutes(db: Db, opts: PopularRoutesOptions = {}) {
  const limit = opts.limit ?? Number(process.env.POPULAR_ROUTES_LIMIT ?? 12);
  const datesPerMonth = opts.datesPerMonth ?? Number(process.env.POPULAR_ROUTES_DATES ?? 3);
  const buckets = opts.buckets ?? [TRIP_BUCKETS[Math.floor(TRIP_BUCKETS.length / 2)]!];

  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'popular_routes',$2)`,
    [runId, `limit ${limit} x ${datesPerMonth} dates x ${buckets.length} bucket(s)`]);

  // A route+month bought in the last few days is skipped: re-buying it
  // lands on the same date and only overwrites last night's fare. See
  // recentlyBought(). Read more demand than the limit so skipped ones leave
  // room for the next busiest before rotation fills the rest.
  const fresh = opts.routes ? new Set<string>() : await recentlyBought(db);
  const notFresh = (r: PopularRoute) => !fresh.has(`${r.origin}|${r.destination}|${r.departMonth}`);
  // Part of tonight's budget goes to the routes we're most wrong about.
  // Demand gets what's left, so the owner's own test searches can't crowd
  // it out (they filled all 18 slots on 2026-10-03).
  const worstSlots = opts.routes ? 0 : Math.min(limit, opts.worstSlots ?? Number(process.env.POPULAR_ROUTES_WORST ?? 6));
  let worst: PopularRoute[] = [];
  if (worstSlots > 0) {
    try {
      const board = await loadScoreboard(db, 30);
      worst = pickWorstRoutes(board.routes, {
        useCandidate: board.useCandidate, zonePct: board.zonePct, fresh,
        plannable: plannableMonths(todayISO()), n: worstSlots,
      });
      if (worst.length) console.log(`popular-routes: ${worst.length} furthest-off route(s): ` +
        worst.map((r) => `${r.origin}->${r.destination} ${r.departMonth}`).join(", "));
    } catch (e) {
      // The scoreboard is a guide, not a requirement: tonight just buys by
      // demand and rotation instead.
      console.warn(`popular-routes: furthest-off routes skipped: ${(e as Error).message}`);
    }
  }
  const worstKeys = new Set(worst.map((r) => `${r.origin}|${r.destination}`));
  let routes = opts.routes
    ?? [...worst, ...(await popularRoutes(db, limit * 4)).filter(notFresh)
      .filter((r) => !worstKeys.has(`${r.origin}|${r.destination}`)).slice(0, limit - worst.length)];

  // Fill the rest of tonight's slots by rotation, stalest route first.
  // Demand still wins where it exists — someone actually asking about a
  // route is better evidence than a schedule — but before launch there is
  // no demand, and without this the job re-bought the same few routes every
  // night and coverage never widened. See rotationRoutes().
  if (!opts.routes && routes.length < limit) {
    // Cycle the sampled month across roughly four quarters on successive
    // nights, so revisiting a route later anchors a different quarter
    // instead of overwriting the same one. A bought fare corrects its whole
    // quarter, so spreading across quarters buys more than depth in one.
    const quarterStep = Math.floor(Date.now() / 86_400_000) % 4;
    // Never earlier than the first month the form offers: 60 days out from
    // the 1st of a month is still next month, which nobody can pick.
    const sampled = monthKey(addDaysISO(todayISO(), 60 + quarterStep * 90));
    const earliest = firstPlannableMonth(todayISO());
    const rotationMonth = sampled < earliest ? earliest : sampled;
    const taken = new Set(routes.map((r) => `${r.origin}|${r.destination}`));
    routes = routes.concat(
      await rotationRoutes(db, limit - routes.length, rotationMonth, taken),
    );
  }

  // Top up with trend anchors so the multiplier stays computable even on a
  // day when demand was thin or entirely international (see
  // trendAnchorRoutes). Without this, one busy Tokyo day would leave every
  // estimated route in the app showing "no cached price".
  if (!opts.routes) {
    const anchorMonth = (routes[0]?.departMonth) ?? addDaysISO(todayISO(), 90).slice(0, 7);
    const anchors = (await trendAnchorRoutes(db, quarterOf(`${anchorMonth}-01`), anchorMonth)).filter(notFresh);
    const seen = new Set(routes.map((r) => `${r.origin}|${r.destination}|${r.departMonth}`));
    for (const a of anchors) {
      const key = `${a.origin}|${a.destination}|${a.departMonth}`;
      if (!seen.has(key)) { routes.push(a); seen.add(key); }
    }
  }

  // Backstop for the routes that did not come from rotation (which filters
  // these out itself): a real user in Los Angeles searching Disneyland writes
  // LAX->SNA into route_searches, and demand-driven buying would then treat
  // that as the busiest route in the app and pay for a fare that cannot
  // exist. Demand is evidence of interest, not evidence a flight is sold.
  const localRoutes = routes.filter((r) => isLocalRoute(r.origin, r.destination));
  if (localRoutes.length) {
    console.log(
      `popular-routes: skipping ${localRoutes.length} local route(s) — ` +
      localRoutes.map((r) => `${r.origin}->${r.destination}`).join(", "),
    );
    routes = routes.filter((r) => !isLocalRoute(r.origin, r.destination));
  }

  let calls = 0, rows = 0, errors = 0, misses = 0;

  if (routes.length) {
    const provider = opts.provider ?? new SerpApiFlightProvider();
    outer: for (const route of routes) {
      for (const bucket of buckets) {
        for (const date of sampleDates(route.departMonth, datesPerMonth)) {
          if (provider.budgetRemaining <= 0) {
            console.warn("popular-routes: provider budget exhausted, stopping early");
            break outer;
          }
          try {
            calls++;
            const q = await provider.quote(route.origin, route.destination, date, bucket);
            if (!q) { misses++; continue; }
            // Same upsert contract as the main refresh: on success only. A
            // failed lookup leaves yesterday's real fare in place.
            // The record first (observations.ts): every paid fare is kept,
            // even if the working copy below is later replaced.
            await recordFlightObservations(db, [q], SERPAPI_FLIGHTS);
            await db.query(
              `insert into flight_prices
                 (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,source,fetched_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'serpapi_flights',now())
               on conflict (origin,destination,depart_date,trip_length) do update set
                 price_usd = excluded.price_usd, carrier = excluded.carrier,
                 stops = excluded.stops, deep_link = excluded.deep_link,
                 source = excluded.source, fetched_at = excluded.fetched_at`,
              [q.origin, q.destination, q.departDate, q.tripLength,
               q.priceUsd, q.carrier ?? null, q.stops, q.deepLink ?? null],
            );
            rows++;
          } catch (e) {
            errors++;
            console.error(`popular ${route.origin}->${route.destination} ${date}:`, (e as Error).message);
          } finally {
            // Google's whole answer, kept after every search, misses and errors included.
            await flushRaw(db, provider);
          }
        }
      }
    }
  }

  await db.query(
    `update fetch_runs set finished_at = now(), calls = $2, rows_written = $3, errors = $4,
       note = note || ' · ' || $5 where id = $1`,
    [runId, calls, rows, errors, `${routes.length} routes, ${misses} with no fare`],
  );
  return { runId, routes: routes.length, calls, rows, errors, misses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.SERPAPI_KEY) {
    console.log("popular-routes: SERPAPI_KEY not set — nothing bought, estimates stay as they are.");
    process.exit(0);
  }
  const db = await getDb();
  const res = await runPopularRoutes(db);
  console.log(
    `popular-routes done: ${res.routes} routes, ${res.calls} calls, ` +
    `${res.rows} real fares written, ${res.misses} with no fare, ${res.errors} errors`,
  );
  await db.close();
}
