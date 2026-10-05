/**
 * The governing rule (top of CLAUDE.md, owner 2026-10-03): every flight and
 * hotel price we are handed is KEPT with its source, nothing is overwritten,
 * and pricing weights the sources. These tests pin each half of that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, type Db } from "./db.js";
import { blendFares, flightSourceKind, recordFlightObservations, SERPAPI_FLIGHTS, FLIGHT_WEIGHT_KEYS } from "./observations.js";
import { upsertFlights } from "./jobs/refresh.js";
import { runPopularRoutes } from "./jobs/popularRoutes.js";
import { loadBook } from "./book.js";
import { setSetting } from "./settings.js";
import { clearGoogleDisneyCache, googleDisneyRates } from "./disneyEvidence.js";
import { recordHotelSamples } from "./hotelScoreboard.js";
import { GOOGLE_DISNEY_WEIGHT_KEY, weightedMedian } from "./checkFactors.js";
import { dataIntake, slotCount } from "./dataIntake.js";
import { loadHotelList } from "./hotelList.js";

const at = (iso: string) => new Date(iso);

test("blendFares: weighted sources average; a weight-0 source is a fallback, never thrown away", () => {
  const paid = { source: SERPAPI_FLIGHTS, price: 500, stops: 0, carrier: "DL", at: at("2026-10-03") };
  const free = { source: "travelpayouts+serpapi", price: 300, stops: 1, carrier: "F9", at: at("2026-10-03") };
  const w = (tp: number) => (s: string) => (flightSourceKind(s) === "serpapi" ? 1 : flightSourceKind(s) === "travelpayouts" ? tp : 0);

  // Free feed at 0: it doesn't pull the paid fare around...
  assert.equal(blendFares([paid, free], w(0))!.price, 500);
  // ...but it is still used when it is all we have.
  const alone = blendFares([free], w(0))!;
  assert.equal(alone.price, 300);
  assert.deepEqual(alone.sources, ["travelpayouts+serpapi"]);
  // Equal weights: an even average, itinerary from the heavier/newer source.
  const even = blendFares([paid, free], w(1))!;
  assert.equal(even.price, 400);
  assert.deepEqual(even.sources.sort(), ["serpapi_flights", "travelpayouts+serpapi"]);
  // Quarter weight.
  assert.equal(blendFares([paid, free], w(0.25))!.price, 460);
  assert.equal(blendFares([], w(1)), null);
});

test("weightedMedian is the plain median when weights are equal", () => {
  assert.equal(weightedMedian([{ r: 1, w: 1 }, { r: 3, w: 1 }]), 2);
  assert.equal(weightedMedian([{ r: 1, w: 1 }, { r: 2, w: 1 }, { r: 9, w: 1 }]), 2);
  assert.equal(weightedMedian([{ r: 1, w: 3 }, { r: 9, w: 1 }]), 1);
});

const fare = (origin: string, destination: string, departDate: string, priceUsd: number, carrier = "DL") =>
  ({ origin, destination, departDate, tripLength: 7, priceUsd, carrier, stops: 0, deepLink: "x" });
const count = async (db: Db, sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0].c);
const book = (db: Db) => loadBook(db, {
  origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"], from: "2027-03-01", to: "2027-03-20", tripLength: 7,
});

test("a paid fare and the free feed's fare for the same date are BOTH kept, and pricing blends them by weight", async () => {
  const db = await memoryDb();
  // Paid fare first, the way popular-routes writes it.
  await recordFlightObservations(db, [fare("ATL", "MCO", "2027-03-10", 500)], SERPAPI_FLIGHTS);
  await db.query(`insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,carrier,stops,source)
                  values ('ATL','MCO','2027-03-10',7,500,'DL',0,'serpapi_flights')`);
  // Then the free nightly feed lands on the same route, date and length.
  await upsertFlights(db, [fare("ATL", "MCO", "2027-03-10", 300, "F9")], "travelpayouts+serpapi");

  assert.equal(await count(db, `select count(*) as c from flight_observations where depart_date = '2027-03-10'`), 2,
    "both fares are in the record");
  // Default weights: the free feed doesn't pull the bought fare down.
  assert.equal((await book(db)).flight("ATL", "MCO", "2027-03-10", 7)?.price, 500);
  // The owner raises the free feed's weight to match: an even blend.
  await setSetting(db, FLIGHT_WEIGHT_KEYS.travelpayouts, 1);
  const row = (await book(db)).flight("ATL", "MCO", "2027-03-10", 7)!;
  assert.equal(row.price, 400);
  assert.deepEqual([...row.sources!].sort(), ["serpapi_flights", "travelpayouts+serpapi"]);
  await db.close();
});

test("the free feed re-reporting a date adds to the record; the newest of each source is what prices", async () => {
  const db = await memoryDb();
  await upsertFlights(db, [fare("ATL", "MCO", "2027-03-11", 310)], "travelpayouts+serpapi");
  await upsertFlights(db, [fare("ATL", "MCO", "2027-03-11", 290)], "travelpayouts+serpapi");
  assert.equal(await count(db, `select count(*) as c from flight_observations where depart_date = '2027-03-11'`), 2);
  assert.equal((await book(db)).flight("ATL", "MCO", "2027-03-11", 7)?.price, 290);
  await db.close();
});

test("re-buying the same paid fare never loses the earlier one", async () => {
  const db = await memoryDb();
  let price = 400;
  const stub = {
    callsSpent: 0, budgetRemaining: 100,
    async quote(origin: string, destination: string, departDate: string, tripLength: number) {
      return { origin, destination, departDate, tripLength, priceUsd: price++, stops: 0, deepLink: "x" };
    },
  };
  const routes = [{ origin: "ATL", destination: "MCO", departMonth: "2027-03", searches: 1 }];
  await runPopularRoutes(db, { routes, datesPerMonth: 1, provider: stub as never });
  await runPopularRoutes(db, { routes, datesPerMonth: 1, provider: stub as never });
  assert.equal(await count(db, `select count(*) as c from flight_observations where source = 'serpapi_flights'`), 2,
    "both nights' paid fares are kept");
  assert.equal(await count(db, `select count(*) as c from flight_prices where source = 'serpapi_flights'`), 1,
    "the working copy holds the latest");
  await db.close();
});

/* --------------------------- Disney hotels ---------------------------- */

async function seedPop(db: Db, ours: number, google: number | null) {
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source)
     values ('wdw-pop','wdw','Disney''s Pop Century','Value resort','2027-03-10',$1,'value',true,'owner_base')`, [ours]);
  if (google !== null) {
    await recordHotelSamples(db, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-10",
      rates: [{ name: "Disney's Pop Century Resort", nightly: google }, { name: "Some Motel Kissimmee", nightly: 99 }] }]);
  }
  clearGoogleDisneyCache(db);
}
const popNight = async (db: Db) =>
  (await book(db)).hotelNights("wdw", "2027-03-10").find((h) => h.hotelId === "wdw-pop")!.nightly;

test("Google's rate for a Disney hotel moves our on-property price, the way a price check does", async () => {
  const db = await memoryDb();
  await seedPop(db, 300, 450);
  const rates = await googleDisneyRates(db);
  assert.equal(rates.length, 1, "only the Disney hotel is evidence, not the motel");
  assert.equal(rates[0]!.ours, 300);
  // One data point at weight 1 against a prior of 3: a quarter of the way
  // from 1.0 to 1.5, so x1.125.
  assert.equal(await popNight(db), 337.5);
  // Raw model (what a new price check is measured against) is untouched.
  const raw = await loadBook(db, { origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: "2027-03-01", to: "2027-03-20", tripLength: 7 }, { applyChecks: false });
  assert.equal(raw.hotelNights("wdw", "2027-03-10").find((h) => h.hotelId === "wdw-pop")!.nightly, 300);
  // The owner can turn it off; the rate stays in the record.
  await setSetting(db, GOOGLE_DISNEY_WEIGHT_KEY, 0);
  assert.equal(await popNight(db), 300);
  assert.equal(await count(db, `select count(*) as c from hotel_samples`), 2);
  await db.close();
});

test("on-property rates are labelled as ours, not as a vendor's", async () => {
  const { upsertHotels } = await import("./jobs/refresh.js");
  const db = await memoryDb();
  await upsertHotels(db, [
    { hotelId: "wdw-pop", resortId: "wdw", hotelName: "Pop", descriptor: "", stayDate: "2027-03-10", nightlyUsd: 300, tier: "value", onProperty: true },
    { hotelId: "x1", resortId: "wdw", hotelName: "Motel", descriptor: "", stayDate: "2027-03-10", nightlyUsd: 99, tier: "budget", onProperty: false },
  ], "serpapi_hotels");
  const { rows } = await db.query(`select hotel_id, source from hotel_rates order by hotel_id`);
  assert.deepEqual(rows.map((r) => [r.hotel_id, r.source]), [["wdw-pop", "owner_base"], ["x1", "serpapi_hotels"]]);
  await db.close();
});

/* ------------------------------ the check ------------------------------ */

/** The test database creates the record "now"; the runs below are older. */
const recordSince = (db: Awaited<ReturnType<typeof memoryDb>>, ago: string) =>
  db.query(`update schema_marks set done_at = now() - $1::interval where name = 'flight_observations_backfill'`, [ago]);

test("the daily data check says when paid fares were bought but not kept", async () => {
  const db = await memoryDb();
  await recordSince(db, "2 hours");
  await db.query(`insert into fetch_runs (id, job, started_at, finished_at, calls, rows_written)
                  values (gen_random_uuid(), 'popular_routes', now() - interval '1 hour', now() - interval '50 minutes', 5, 5)`);
  // Only 3 of the 5 made it into the record, inside the run's window.
  for (let i = 0; i < 3; i++) {
    await db.query(`insert into flight_observations (origin,destination,depart_date,trip_length,price_usd,source,observed_at)
                    values ('ATL','MCO','2027-03-1${i}',7,400,'serpapi_flights', now() - interval '55 minutes')`);
  }
  const r = await dataIntake(db);
  const lost = r.problems.find((p) => p.id === "intake-paid-fares-lost");
  assert.ok(lost && lost.blocking, "lost paid fares are a blocking problem");
  assert.match(r.lines.join("\n"), /5 bought, 3 kept/);
  await db.close();
});

test("the daily data check is quiet about paid fares when every one was kept", async () => {
  const db = await memoryDb();
  await recordSince(db, "2 hours");
  await db.query(`insert into fetch_runs (id, job, started_at, finished_at, calls, rows_written)
                  values (gen_random_uuid(), 'popular_routes', now() - interval '1 hour', now() - interval '50 minutes', 1, 1)`);
  await db.query(`insert into flight_observations (origin,destination,depart_date,trip_length,price_usd,source,observed_at)
                  values ('ATL','MCO','2027-03-10',7,400,'serpapi_flights', now() - interval '55 minutes')`);
  const r = await dataIntake(db);
  assert.equal(r.problems.find((p) => p.id === "intake-paid-fares-lost"), undefined);
  assert.match(r.lines.join("\n"), /1 bought, 1 kept \(all of them\)/);
  await db.close();
});

test("paid runs from before the record existed are not reported as lost (the 2026-10-04 false alarm)", async () => {
  const db = await memoryDb();
  await recordSince(db, "1 day");
  // Five nights of the old code: 18 written each, none of it in the record.
  for (let d = 2; d <= 6; d++) {
    await db.query(`insert into fetch_runs (id, job, started_at, finished_at, calls, rows_written)
                    values (gen_random_uuid(), 'popular_routes', now() - ($1 || ' days')::interval,
                            now() - ($1 || ' days')::interval + interval '1 minute', 18, 18)`, [String(d)]);
  }
  // Tonight's run on the new code: 18 written, 18 recorded.
  await db.query(`insert into fetch_runs (id, job, started_at, finished_at, calls, rows_written)
                  values (gen_random_uuid(), 'popular_routes', now() - interval '1 hour', now() - interval '59 minutes', 18, 18)`);
  for (let i = 0; i < 18; i++) {
    await db.query(`insert into flight_observations (origin,destination,depart_date,trip_length,price_usd,source,observed_at)
                    values ('ATL','MCO', date '2027-03-01' + $1::int, 7, 400, 'serpapi_flights', now() - interval '59 minutes 30 seconds')`, [i]);
  }
  const r = await dataIntake(db);
  assert.equal(r.problems.find((p) => p.id === "intake-paid-fares-lost"), undefined);
  assert.equal(r.problems.find((p) => p.id === "intake-no-paid-runs"), undefined);
  const text = r.lines.join("\n");
  assert.match(text, /18 bought, 18 kept \(all of them\)/);
  assert.match(text, /Not counted: 5 paid run\(s\), 90 fares, from before the record existed/);
  await db.close();
});

test("slotCount reads the refresh note", () => {
  assert.equal(slotCount("travelpayouts+serpapi · 3 months · trend: 7 routes · hotel slots: tdr/2027-09 dlp/2027-10 hkdl/2027-10"), 3);
  assert.equal(slotCount("hotel slots: no rotation"), 0);
  assert.equal(slotCount(""), 0);
});

test("/admin hotel list shows every hotel Google returned, Disney's own marked, older cache rows too", async () => {
  const db = await memoryDb();
  await recordHotelSamples(db, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-10",
    rates: [{ name: "Disney's Pop Century Resort", nightly: 450 }, { name: "Some Motel Kissimmee", nightly: 99 }] }]);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source)
     values ('old1','wdw','Old Inn','','2027-04-10',120,'budget',false,'serpapi_hotels')`);
  const list = await loadHotelList(db);
  const wdw = list.find((r) => r.resort === "wdw")!;
  assert.equal(wdw.searches, 1);
  assert.deepEqual(wdw.hotels.map((h) => [h.name, h.disney, h.basis]), [
    ["Some Motel Kissimmee", false, "record"],
    ["Old Inn", false, "older"],
    ["Disney's Pop Century Resort", true, "record"],
  ]);
  await db.close();
});

test("the one-time backfill of old fares into the record runs once, however often migrate runs", async () => {
  const { readFileSync } = await import("node:fs");
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const db = await memoryDb();
  // Pretend this database predates the record: one labelled fare, one
  // unlabelled placeholder, and the backfill not yet done.
  await db.query(`delete from schema_marks`);
  await db.query(`insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops,source)
                  values ('ATL','MCO','2027-03-10',7,400,0,'serpapi_flights'),
                         ('ATL','MCO','2027-03-11',7,98,0,null)`);
  await db.exec(schema);
  await db.exec(schema);
  assert.equal(await count(db, `select count(*) as c from flight_observations`), 1,
    "the labelled fare is carried over once; the unlabelled placeholder never");
  await db.close();
});

test("hotel searches that came back empty are reported as empty, not as lost", async () => {
  const db = await memoryDb();
  await recordSince(db, "2 hours");
  await db.query(`insert into fetch_runs (id, job, started_at, finished_at, calls, rows_written, note)
                  values (gen_random_uuid(), 'refresh', now() - interval '1 hour', now() - interval '50 minutes', 3, 3,
                          'hotel slots: wdw/2027-03 dlr/2027-03 tdr/2027-10')`);
  await recordHotelSamples(db, [
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-14", rates: [{ name: "Motel", nightly: 99 }] },
    { resort: "dlr", month: "2027-03", checkIn: "2027-03-14", rates: [{ name: "Inn", nightly: 120 }] },
  ]);
  await db.query(`update hotel_samples set pulled_at = now() - interval '55 minutes'`);
  await db.query(`insert into hotel_searches (resort_id, month, check_in, priced, status, searched_at)
                  values ('tdr','2027-10','2027-10-14',0,'ok', now() - interval '55 minutes')`);
  const r = await dataIntake(db);
  assert.equal(r.problems.find((p) => p.id === "intake-hotels-short"), undefined, "nothing is unexplained");
  assert.ok(r.problems.find((p) => p.id === "intake-hotels-empty"));
  assert.match(r.lines.join("\n"), /3 made, 2 kept, 1 came back with no prices from Google\./);
  await db.close();
});

test("/admin hotel list sorts rentals into their own group and summarizes both", async () => {
  const db = await memoryDb();
  await recordHotelSamples(db, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-10", rates: [
    { name: "Hampton Inn", nightly: 150, kind: "hotel" },
    { name: "Sunny Pool Home", nightly: 210, kind: "vacation rental" },
    { name: "Condo near Disney", nightly: 120 },
  ] }]);
  const wdw = (await loadHotelList(db)).find((r) => r.resort === "wdw")!;
  assert.deepEqual(wdw.hotels.map((h) => [h.name, h.rental, h.rentalBy]),
    [["Hampton Inn", false, "google"], ["Condo near Disney", true, "name"], ["Sunny Pool Home", true, "google"]]);
  assert.deepEqual(wdw.rentals, { count: 2, median: 165, low: 120, high: 210 });
  assert.equal(wdw.offHotels.median, 150);
  await db.close();
});
