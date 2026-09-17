import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { fetchExactFare, limitsFromEnv, remainingForUser, GLOBAL_BUDGET_KEY, type ExactFareLimits } from "./exactFare.js";

const LIMITS: ExactFareLimits = { perUserPerDay: 3, globalPerDay: 5, freshHours: 24 };
const TODAY = "2027-01-15";

/** A stand-in for SerpApi that counts how many times it was actually paid for. */
function stubProvider(opts: { price?: number; returnsNothing?: boolean; throws?: boolean } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    budgetRemaining: 999,
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      calls++;
      if (opts.throws) throw new Error("provider exploded");
      if (opts.returnsNothing) return null;
      return {
        origin, destination, departDate, tripLength,
        priceUsd: opts.price ?? 412, carrier: "Delta", stops: 0, deepLink: "https://example.test",
      };
    },
  };
}

const req = {
  userId: "u1", origin: "ATL", destination: "MCO",
  departDate: "2027-03-04", tripLength: 7,
};

test("a real lookup is fetched, stored, and tagged as a real fare", async () => {
  const db = await memoryDb();
  const p = stubProvider({ price: 412 });
  const res = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });

  assert.equal(res.ok, true);
  assert.equal(res.ok && res.cached, false);
  assert.equal(res.ok && res.price, 412);
  assert.equal(p.calls, 1);

  // It lands in the shared cache, tagged, so the trend and everyone else's
  // estimates benefit from a Plus user's spend.
  const { rows } = await db.query(
    `select price_usd, source from flight_prices where origin='ATL' and destination='MCO'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].price_usd), 412);
  assert.equal(rows[0].source, "serpapi_flights");
  await db.close();
});

test("a second ask for the same fare is served from cache and costs nothing", async () => {
  const db = await memoryDb();
  const p = stubProvider();
  await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  const again = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });

  assert.equal(again.ok, true);
  assert.equal(again.ok && again.cached, true);
  assert.equal(p.calls, 1, "the provider must not be paid twice for the same question");
  await db.close();
});

test("a cache hit does not consume the user's daily allowance", async () => {
  // Revisiting a trip you already looked at must be free, not punitive —
  // that is why the cache is checked before the quota.
  const db = await memoryDb();
  const p = stubProvider();
  await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  const afterFirst = await remainingForUser(db, "u1", LIMITS, TODAY);
  for (let i = 0; i < 5; i++) {
    await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  }
  assert.equal(await remainingForUser(db, "u1", LIMITS, TODAY), afterFirst);
  assert.equal(p.calls, 1);
  await db.close();
});

test("a stale cached fare is re-bought rather than passed off as exact", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source,fetched_at)
     values ('ATL','MCO','2027-03-04',7,999,'serpapi_flights', now() - interval '40 hours')`,
  );
  const p = stubProvider({ price: 412 });
  const res = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  assert.equal(res.ok && res.cached, false);
  assert.equal(res.ok && res.price, 412);
  assert.equal(p.calls, 1);
  await db.close();
});

test("an estimate row from another source is never mistaken for an exact fare", async () => {
  // A Travelpayouts row sitting on the same route/date must not satisfy a
  // request for the real price — that is the whole thing being paid for.
  const db = await memoryDb();
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source)
     values ('ATL','MCO','2027-03-04',7,41,'travelpayouts')`,
  );
  const p = stubProvider({ price: 412 });
  const res = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  assert.equal(res.ok && res.cached, false);
  assert.equal(res.ok && res.price, 412);
  await db.close();
});

test("the per-user daily cap stops one person draining the month", async () => {
  const db = await memoryDb();
  const p = stubProvider();
  for (let i = 0; i < LIMITS.perUserPerDay; i++) {
    const r = await fetchExactFare(db, {
      ...req, departDate: `2027-03-0${i + 1}`,
    }, { provider: p, limits: LIMITS, today: TODAY });
    assert.equal(r.ok, true, `lookup ${i + 1} should have been allowed`);
  }
  const blocked = await fetchExactFare(db, {
    ...req, departDate: "2027-04-01",
  }, { provider: p, limits: LIMITS, today: TODAY });

  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.reason, "quota_user");
  assert.equal(p.calls, LIMITS.perUserPerDay, "nothing may be spent past the cap");
  assert.equal(blocked.remainingToday, 0);
  // The refusal must point at the thing that still works.
  assert.match(!blocked.ok ? blocked.message : "", /estimate/i);
  await db.close();
});

test("the site-wide cap stops many users draining the month", async () => {
  const db = await memoryDb();
  const p = stubProvider();
  let allowed = 0;
  // Five different users, each well under their own cap, together past the
  // global one.
  for (let u = 0; u < 5; u++) {
    for (let i = 0; i < 2; i++) {
      const r = await fetchExactFare(db, {
        ...req, userId: `user${u}`, departDate: `2027-03-1${i}`,
      }, { provider: p, limits: LIMITS, today: TODAY });
      if (r.ok) allowed++;
    }
  }
  // globalPerDay is 5; cache hits on the shared dates are free and unmetered,
  // so what must hold is that no more than 5 were ever actually bought.
  assert.ok(p.calls <= LIMITS.globalPerDay, `spent ${p.calls}, cap is ${LIMITS.globalPerDay}`);
  const g = await db.query(`select lookups from exact_fare_usage where user_id = $1`, [GLOBAL_BUDGET_KEY]);
  assert.ok(Number(g.rows[0].lookups) <= LIMITS.globalPerDay);
  assert.ok(allowed > 0);
  await db.close();
});

test("a route with no fare still counts against quota — the search was billed", async () => {
  // The provider charges for a search that finds nothing, so an unserved
  // route must not be a free infinite retry.
  const db = await memoryDb();
  const p = stubProvider({ returnsNothing: true });
  const res = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "no_fare");
  assert.equal(await remainingForUser(db, "u1", LIMITS, TODAY), LIMITS.perUserPerDay - 1);
  await db.close();
});

test("a provider error counts too, and never writes a junk row", async () => {
  const db = await memoryDb();
  const p = stubProvider({ throws: true });
  const res = await fetchExactFare(db, req, { provider: p, limits: LIMITS, today: TODAY });
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "error");
  assert.equal(await remainingForUser(db, "u1", LIMITS, TODAY), LIMITS.perUserPerDay - 1);
  const { rows } = await db.query(`select count(*)::int as n from flight_prices`);
  assert.equal(rows[0].n, 0, "a failed lookup must leave no row behind");
  await db.close();
});

test("quotas are per day, so yesterday's use doesn't block today", async () => {
  const db = await memoryDb();
  const p = stubProvider();
  for (let i = 0; i < LIMITS.perUserPerDay; i++) {
    await fetchExactFare(db, { ...req, departDate: `2027-03-0${i + 1}` },
      { provider: p, limits: LIMITS, today: "2027-01-14" });
  }
  const nextDay = await fetchExactFare(db, { ...req, departDate: "2027-05-05" },
    { provider: p, limits: LIMITS, today: TODAY });
  assert.equal(nextDay.ok, true);
  await db.close();
});

test("with no provider configured it says so instead of throwing", async () => {
  const db = await memoryDb();
  const hadKey = process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_KEY;
  try {
    const res = await fetchExactFare(db, req, { limits: LIMITS, today: TODAY });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, "no_provider");
    // Nothing was spent, so nothing should have been counted.
    assert.equal(await remainingForUser(db, "u1", LIMITS, TODAY), LIMITS.perUserPerDay);
  } finally {
    if (hadKey !== undefined) process.env.SERPAPI_KEY = hadKey;
  }
  await db.close();
});

test("a bought fare takes over pricing, so the trip total stops using the estimate", async () => {
  // The feedback loop that makes this worth paying for. A Plus user's lookup
  // is written into the shared cache, so the very next re-price reads it as
  // a REAL fare and drops the estimate entirely — the total updates rather
  // than the exact number sitting in a box disagreeing with it.
  const { loadBook } = await import("./book.js");
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,source)
     values ('ATL','MCO',2026,1,290,268,342,431,'bts_db1b')`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.0, 1.0, 1.0, 9, '2026Q1')`,
  );
  const bookArgs = {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-04", to: "2027-03-11", tripLength: 7,
  };

  const before = await loadBook(db, bookArgs);
  assert.equal(before.flight("ATL", "MCO", "2027-03-04", 7), undefined, "no real fare yet");
  assert.equal(before.flightEstimate!("ATL", "MCO")!.med, 342, "so the estimate is what shows");

  await fetchExactFare(db, req, { provider: stubProvider({ price: 511 }), limits: LIMITS, today: TODAY });

  const after = await loadBook(db, bookArgs);
  const real = after.flight("ATL", "MCO", "2027-03-04", 7);
  assert.equal(real?.price, 511, "the bought fare is now the priced fare");
  assert.equal(real?.estimate, undefined, "and it carries no estimate marker");
  await db.close();
});

test("an exact fare corrects the estimate for OTHER dates on that route", async () => {
  // The owner's ask, verbatim: "the estimate said $382 and the exact fare came
  // back $511 — when this happens I want to make sure we update our estimate."
  // Evidence from this route beats an average measured across other routes, so
  // buying one real fare moves every other date in that quarter.
  const { loadBook } = await import("./book.js");
  const db = await memoryDb();
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,source)
     values ('ATL','MCO',2026,1,290,268,342,431,'bts_db1b')`,
  );
  await db.query(
    `insert into fare_trend (id,multiplier,low_multiplier,high_multiplier,sample_routes,basis_quarter)
     values (gen_random_uuid(), 1.117, 1.02, 1.24, 9, '2026Q1')`,
  );
  // A DIFFERENT date from the one that gets bought.
  const otherDate = {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-12", to: "2027-03-19", tripLength: 7,
  };

  const before = (await loadBook(db, otherDate)).flightEstimate!("ATL", "MCO")!;
  assert.equal(before.med, 382.01, "342 x the global trend of 1.117");
  assert.equal(before.routeSamples, undefined, "nothing route-specific known yet");

  await fetchExactFare(db, { ...req, departDate: "2027-03-04" },
    { provider: stubProvider({ price: 511 }), limits: LIMITS, today: TODAY });

  const after = (await loadBook(db, otherDate)).flightEstimate!("ATL", "MCO")!;
  assert.equal(after.med, 511, "the route's own evidence now sets the estimate");
  assert.equal(after.routeSamples, 1, "and the UI can say it rests on one fare");
  assert.ok(after.low < after.med && after.med < after.high, "the band moves with it");
  await db.close();
});

test("a correction only counts fares NEWER than the baseline it corrects", async () => {
  // Otherwise it is circular: an international baseline is built FROM sampled
  // real fares, so measuring those same fares against it always yields 1.0 and
  // would report "0% adjustment" as though something had been verified.
  const { loadBook } = await import("./book.js");
  const db = await memoryDb();
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source,fetched_at)
     values ('ATL','MCO','2027-03-04',7,900,'serpapi_flights', now() - interval '10 days')`,
  );
  // Baseline written AFTER that fare, as the monthly rebuild would.
  await db.query(
    `insert into historical_fares
       (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,source,fetched_at)
     values ('ATL','MCO',2027,1,900,850,900,950,'sampled_live', now())`,
  );
  const book = await loadBook(db, {
    origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-12", to: "2027-03-19", tripLength: 7,
  });
  const est = book.flightEstimate!("ATL", "MCO")!;
  assert.equal(est.med, 900, "the baseline stands, uncorrected by its own inputs");
  assert.equal(est.routeSamples, undefined, "and no correction is claimed");
  await db.close();
});

test("the shipped default caps are sized for the SerpApi plan actually bought", async () => {
  // These defaults are the only thing standing between a Plus user's clicks
  // and the month's search allowance, and they were originally sized for the
  // 5,000/month Developer plan (25/user, 90/day site-wide) while the project
  // runs on Starter's 1,000. Pinned so they can't drift back up silently:
  // 6/day site-wide is ~180/month, which is what's left after the nightly
  // flight rotation (~300) and hotels (~240).
  delete process.env.EXACT_FARE_PER_USER_PER_DAY;
  delete process.env.EXACT_FARE_GLOBAL_PER_DAY;
  const limits = limitsFromEnv();
  assert.equal(limits.perUserPerDay, 3);
  assert.equal(limits.globalPerDay, 6);
});

test("the caps stay overridable, so a plan upgrade doesn't need a code change", async () => {
  process.env.EXACT_FARE_GLOBAL_PER_DAY = "90";
  assert.equal(limitsFromEnv().globalPerDay, 90);
  delete process.env.EXACT_FARE_GLOBAL_PER_DAY;
});
