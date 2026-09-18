/**
 * Exact live fares — the Plus half of the flight model.
 *
 * Free users get an estimate: this route's real median (BTS for domestic, a
 * monthly sample for international) moved by a measured trend, shown with a
 * low–high range and an `est.` chip. That costs nothing per user because it
 * reads a cache someone already paid to fill.
 *
 * Plus users can ask for the real fare on a specific date. That call is
 * metered, so it is the one place in the app where a user's click spends
 * money — which is exactly why it sits behind the paywall: the people who
 * cost money are the people paying.
 *
 * Four things keep it from running away, in the order they are checked:
 *
 *   1. CACHE FIRST. A fare already fetched for that exact route/date/length
 *      and still fresh is returned without spending anything. This is the
 *      big one: the second person to ask the same question is free, and the
 *      answer also lands in the shared cache that free estimates and the
 *      trend are built from. A Plus user's spend improves the free product.
 *   2. PER-USER DAILY CAP. One curious person cannot drain the month.
 *   3. SITE-WIDE DAILY CAP. Neither can a hundred of them.
 *   4. PROVIDER BUDGET. A hard ceiling inside the adapter itself.
 *
 * Never call this without having resolved Plus from the session cookie
 * against the database first — see the route in server.ts. A client-supplied
 * "I am Plus" flag would be a way to spend the owner's money.
 */
import type { Db } from "./db.js";
import { todayISO, type ISODate } from "./dates.js";
import { isLocalRoute } from "./config.js";
import { SerpApiFlightProvider } from "./providers/serpapiFlights.js";

/** Reserved user_id holding the site-wide daily tally. */
export const GLOBAL_BUDGET_KEY = "global";

/**
 * How long a bought fare counts as "the exact price" before it is worth
 * paying to ask again. Fares move daily, so a day-old quote is still a fair
 * answer to "what does this cost"; a week-old one is not.
 */
export const DEFAULT_FRESH_HOURS = 24;

export interface ExactFareRequest {
  userId: string;
  origin: string;
  destination: string;
  departDate: ISODate;
  tripLength: number;
}

export type ExactFareResult =
  | { ok: true; cached: boolean; price: number; carrier?: string; stops: number; deepLink?: string; fetchedAt: string; remainingToday: number }
  | { ok: false; reason: "quota_user" | "quota_global" | "no_provider" | "no_fare" | "local_route" | "error"; message: string; remainingToday: number };

export interface ExactFareLimits {
  perUserPerDay: number;
  globalPerDay: number;
  freshHours: number;
}

export function limitsFromEnv(): ExactFareLimits {
  return {
    perUserPerDay: Number(process.env.EXACT_FARE_PER_USER_PER_DAY ?? 3),
    // Sized against the rest of the month's committed spend. On SerpApi's
    // 1,000/month Starter plan: the nightly flight rotation takes ~300 and
    // hotels ~240, so ~180/month is what is left to reserve for on-demand
    // lookups — about 6 a day. This is insurance against an unbounded
    // worst case more than an expected cost: exact-fare only spends when a
    // Plus user clicks, and a handful of comped friends will not come near
    // it. Raise both only after checking what the nightly jobs actually
    // use — `npm run coverage` reports it.
    globalPerDay: Number(process.env.EXACT_FARE_GLOBAL_PER_DAY ?? 6),
    freshHours: Number(process.env.EXACT_FARE_FRESH_HOURS ?? DEFAULT_FRESH_HOURS),
  };
}

/** Lookups this user has left today, for showing a real number in the UI. */
export async function remainingForUser(
  db: Db, userId: string, limits = limitsFromEnv(), today = todayISO(),
): Promise<number> {
  const r = await db.query<{ lookups: number }>(
    `select lookups from exact_fare_usage where user_id = $1 and day = $2`, [userId, today],
  );
  return Math.max(0, limits.perUserPerDay - Number(r.rows[0]?.lookups ?? 0));
}

async function countToday(db: Db, userId: string, today: ISODate): Promise<number> {
  const r = await db.query<{ lookups: number }>(
    `select lookups from exact_fare_usage where user_id = $1 and day = $2`, [userId, today],
  );
  return Number(r.rows[0]?.lookups ?? 0);
}

async function bump(db: Db, userId: string, today: ISODate): Promise<void> {
  await db.query(
    `insert into exact_fare_usage (user_id, day, lookups, spent_at) values ($1,$2,1,now())
     on conflict (user_id, day) do update set
       lookups = exact_fare_usage.lookups + 1, spent_at = now()`,
    [userId, today],
  );
}

export interface ExactFareDeps {
  limits?: ExactFareLimits;
  today?: ISODate;
  provider?: Pick<SerpApiFlightProvider, "quote" | "budgetRemaining">;
}

export async function fetchExactFare(
  db: Db, req: ExactFareRequest, deps: ExactFareDeps = {},
): Promise<ExactFareResult> {
  const limits = deps.limits ?? limitsFromEnv();
  const today = deps.today ?? todayISO();

  // --- 0. Is there a flight to buy at all? -------------------------------
  // Someone in Los Angeles checking the exact fare to Disneyland would
  // otherwise spend a metered lookup, and one of their three daily checks,
  // to be told there are no itineraries from LAX to LAX. Refused before any
  // of the four bounds, because it costs nothing to know this.
  if (isLocalRoute(req.origin, req.destination)) {
    return {
      ok: false, reason: "local_route",
      remainingToday: await remainingForUser(db, req.userId, limits, today),
      message: "That trip doesn't involve a flight — the resort is a drive from your departure city. Try the driving option on the trip form instead.",
    };
  }

  // --- 1. Cache first, before any quota is even considered ---------------
  // A cached hit costs nothing, so it must not consume the user's daily
  // allowance. Checking the cache before the cap is what makes revisiting
  // the same trip free rather than punitive.
  const cached = await db.query<{ price_usd: string; carrier: string | null; stops: number; deep_link: string | null; fetched_at: string }>(
    `select price_usd, carrier, stops, deep_link, fetched_at
       from flight_prices
      where origin = $1 and destination = $2 and depart_date = $3 and trip_length = $4
        and source = 'serpapi_flights'
        and fetched_at > now() - ($5 || ' hours')::interval`,
    [req.origin, req.destination, req.departDate, req.tripLength, String(limits.freshHours)],
  );
  if (cached.rows[0]) {
    const row = cached.rows[0];
    return {
      ok: true, cached: true,
      price: Number(row.price_usd), carrier: row.carrier ?? undefined,
      stops: Number(row.stops ?? 0), deepLink: row.deep_link ?? undefined,
      fetchedAt: String(row.fetched_at),
      remainingToday: await remainingForUser(db, req.userId, limits, today),
    };
  }

  // --- 2 & 3. Quotas, user then site-wide --------------------------------
  const usedByUser = await countToday(db, req.userId, today);
  const remainingToday = Math.max(0, limits.perUserPerDay - usedByUser);
  if (usedByUser >= limits.perUserPerDay) {
    return {
      ok: false, reason: "quota_user", remainingToday: 0,
      message: `You've used all ${limits.perUserPerDay} exact fare checks for today. Estimates are still unlimited, and this resets tomorrow.`,
    };
  }
  const usedGlobally = await countToday(db, GLOBAL_BUDGET_KEY, today);
  if (usedGlobally >= limits.globalPerDay) {
    return {
      ok: false, reason: "quota_global", remainingToday,
      message: "Exact fare checks have hit today's site-wide limit. Estimates are unaffected — try again tomorrow.",
    };
  }

  if (!deps.provider && !process.env.SERPAPI_KEY) {
    return {
      ok: false, reason: "no_provider", remainingToday,
      message: "Exact fares aren't configured on this deployment. The estimate below is still real.",
    };
  }

  // --- 4. Spend --------------------------------------------------------
  let provider: Pick<SerpApiFlightProvider, "quote" | "budgetRemaining">;
  try {
    provider = deps.provider ?? new SerpApiFlightProvider();
  } catch (e) {
    return { ok: false, reason: "no_provider", remainingToday, message: (e as Error).message };
  }

  // Count the attempt, not the success: the provider is billed for a search
  // that finds nothing just the same, so a route with no service must not be
  // a free infinite retry.
  await bump(db, req.userId, today);
  await bump(db, GLOBAL_BUDGET_KEY, today);
  const nowRemaining = Math.max(0, limits.perUserPerDay - (usedByUser + 1));

  let quote;
  try {
    quote = await provider.quote(req.origin, req.destination, req.departDate, req.tripLength);
  } catch (e) {
    return { ok: false, reason: "error", remainingToday: nowRemaining, message: (e as Error).message };
  }
  if (!quote) {
    return {
      ok: false, reason: "no_fare", remainingToday: nowRemaining,
      message: `No fare found for ${req.origin}–${req.destination} on ${req.departDate}. The estimate below still stands.`,
    };
  }

  // Same contract as every other writer: on success only, tagged with its
  // source so the trend can tell real fares from Travelpayouts leftovers.
  // This row is now in the shared cache — the next person to ask, Plus or
  // not, benefits from it, and it feeds the trend every free estimate uses.
  await db.query(
    `insert into flight_prices
       (origin,destination,depart_date,trip_length,price_usd,carrier,stops,deep_link,source,fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'serpapi_flights',now())
     on conflict (origin,destination,depart_date,trip_length) do update set
       price_usd = excluded.price_usd, carrier = excluded.carrier,
       stops = excluded.stops, deep_link = excluded.deep_link,
       source = excluded.source, fetched_at = excluded.fetched_at`,
    [quote.origin, quote.destination, quote.departDate, quote.tripLength,
     quote.priceUsd, quote.carrier ?? null, quote.stops, quote.deepLink ?? null],
  );

  return {
    ok: true, cached: false,
    price: quote.priceUsd, carrier: quote.carrier, stops: quote.stops,
    deepLink: quote.deepLink, fetchedAt: new Date().toISOString(),
    remainingToday: nowRemaining,
  };
}
