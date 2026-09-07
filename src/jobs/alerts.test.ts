import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCap, suppressAnomalies, runAlerts, type Candidate } from "./alerts.js";
import { memoryDb } from "../db.js";
import { loadBook } from "../book.js";
import { cheapestIn, type TripParams } from "../pricing.js";
import { RESORT_BY_ID, bucketFor } from "../config.js";
import { range } from "../dates.js";
import type { EmailMessage, EmailSender } from "../email/types.js";

const c = (userId: string, dropPct: number): Candidate => ({
  tripId: crypto.randomUUID(), userId, email: `${userId}@example.com`, resortId: "wdw",
  oldTotal: 6000, newTotal: 6000 * (1 - dropPct / 100), dropPct,
  kind: "total_drop", detail: "",
});

test("a user is capped at three alerts a day, keeping the biggest drops", () => {
  const out = applyCap([c("u1", 5), c("u1", 30), c("u1", 12), c("u1", 8), c("u2", 6)], 3);
  assert.equal(out.filter((x) => x.userId === "u1").length, 3);
  assert.equal(out.filter((x) => x.userId === "u2").length, 1);
  assert.deepEqual(out.filter((x) => x.userId === "u1").map((x) => x.dropPct), [30, 12, 8]);
});

test("a provider glitch that moves everything is suppressed, not emailed", () => {
  const wild = Array.from({ length: 10 }, (_, i) => c(`u${i}`, 60));
  const { keep, reason } = suppressAnomalies(wild, 10);
  assert.equal(keep.length, 0);
  assert.match(reason, /bad data/);
});

test("a normal day passes through", () => {
  const normal = [c("u1", 7), c("u2", 9)];
  const { keep, reason } = suppressAnomalies(normal, 40);
  assert.equal(keep.length, 2);
  assert.equal(reason, "");
});

test("a real gas-price swing is never suppressed as 'bad data', even alone in the batch", () => {
  // Regression: gas_price_change reuses the dropPct field to carry a percent
  // move, which used to feed straight into the same "too many trips moved
  // too much" anomaly check built for per-trip provider prices — so one
  // legitimate 33% gas swing, checked against a population of just itself,
  // looked identical to 100% of trips moving wildly and got suppressed.
  const gasOnly: Candidate = { ...c("u1", 33), kind: "gas_price_change" };
  const { keep, reason } = suppressAnomalies([gasOnly], 1);
  assert.equal(keep.length, 1);
  assert.equal(reason, "");
});

test("a failed send leaves the alert for next run to retry — it is not lost", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  await db.query(`insert into users (id, email, plus_until) values ($1,$2,'2099-01-01')`,
    [userId, "flaky@example.com"]);
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops)
     values ('ATL','MCO','2027-03-01',4,100,0)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  const params: TripParams = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs",
  };
  // A 10% baseline bump guarantees a real drop without tripping anomaly
  // suppression (>=25% is treated as bad data, not a sale) — so compute the
  // actual cached total the same way findAlerts will, rather than guess.
  const resort = RESORT_BY_ID.get("wdw")!;
  const book = await loadBook(db, {
    origin: params.origin, destinations: [resort.iata], resortIds: [resort.id],
    from: "2027-03-01", to: "2027-03-02", tripLength: bucketFor(params.nights),
  });
  const { best } = cheapestIn(book, resort, params, {}, range("2027-03-01", "2027-03-01"));
  assert.ok(best, "fixture data must actually be priceable");
  const baseline = best!.total * 1.10;

  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
     values ($1,$2,$3,'{}',$4,0)`,
    [tripId, userId, JSON.stringify({ ...params, month: "2027-03", resortId: "wdw" }), baseline],
  );

  let calls = 0;
  const flaky: EmailSender = {
    name: "flaky",
    async send(_msg: EmailMessage) {
      calls++;
      if (calls === 1) throw new Error("simulated outage");
    },
  };

  const first = await runAlerts(db, { sender: flaky });
  assert.equal(first.fired, 1);
  assert.equal(first.sent, 0, "the send failed, so nothing was marked sent");

  const { rows: pending } = await db.query(
    `select id, notified_at from price_alerts where trip_id = $1 order by fired_at`, [tripId]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].notified_at, null, "unsent alerts stay unnotified, not silently dropped");
  const alertId = pending[0].id;

  const second = await runAlerts(db, { sender: flaky });
  assert.equal(second.retried, 1);
  assert.equal(second.retriedSent, 1, "the retry succeeds once the outage clears");

  const { rows: after } = await db.query(`select notified_at from price_alerts where id = $1`, [alertId]);
  assert.ok(after[0].notified_at, "the originally-failed alert is now marked notified");

  await db.close();
});

test("a user who has never been Plus gets no alerts, however far the price drops", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  // No plus_until at all — a brand-new user, never granted Plus.
  await db.query(`insert into users (id, email) values ($1,$2)`, [userId, "free@example.com"]);
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops)
     values ('ATL','MCO','2027-03-01',4,100,0)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  const params: TripParams = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs",
  };
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
     values ($1,$2,$3,'{}',100000,0)`,   // a baseline this high guarantees a huge drop, if it were even checked
    [tripId, userId, JSON.stringify({ ...params, month: "2027-03", resortId: "wdw" })],
  );

  const result = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(result.checked, 0, "a never-Plus user's trip is not even considered");
  assert.equal(result.fired, 0);

  await db.close();
});

test("a driving trip gets a gas-price alert when the price has moved enough since it was saved", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  await db.query(`insert into users (id, email, plus_until) values ($1,$2,'2099-01-01')`,
    [userId, "driver@example.com"]);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  // "now": $4.00/gal. Trip was saved at $3.00/gal — a 33% move, well past the 8% default threshold.
  await db.query(`insert into gas_prices (as_of, price_per_gallon_usd, source) values ('2027-03-01', 4.00, 'test')`);
  const params: TripParams & { month: string; resortId: string; gasPriceAtSaveUsd: number } = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs", transportMode: "drive",
    month: "2027-03", resortId: "wdw", gasPriceAtSaveUsd: 3.00,
  };
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
     values ($1,$2,$3,'{}',100000,100)`,   // impossibly high threshold/baseline: only the gas alert should fire
    [tripId, userId, JSON.stringify(params)],
  );

  const result = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(result.fired, 1);
  assert.equal(result.candidates[0]!.kind, "gas_price_change");
  assert.match(result.candidates[0]!.detail, /risen/);
  assert.match(result.candidates[0]!.detail, /\$3\.00/);
  assert.match(result.candidates[0]!.detail, /\$4\.00/);

  await db.close();
});

test("a new curated promo for a saved trip's resort fires a deal alert, once", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  await db.query(`insert into users (id, email, plus_until) values ($1,$2,'2099-01-01')`,
    [userId, "dealseeker@example.com"]);
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops)
     values ('ATL','MCO','2027-03-01',4,100,0)`);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  const params: TripParams & { month: string; resortId: string } = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs", month: "2027-03", resortId: "wdw",
  };
  // Impossibly high threshold/baseline so only the deal alert can fire.
  // created_at values are in the past relative to the real clock (not the
  // 2027 travel dates elsewhere in this fixture) because the second run
  // below compares against price_alerts.fired_at, which is real now().
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct,created_at)
     values ($1,$2,$3,'{}',100000,100,'2024-01-01T00:00:00Z')`,
    [tripId, userId, JSON.stringify(params)],
  );
  // Created after the trip was saved — this is what makes it "new" to this trip.
  await db.query(
    `insert into promos (id,resort_id,label,effect_kind,effect_value,starts_on,ends_on,active,created_at)
     values ($1,'wdw','Summer room discount','room_pct_off',20,'2027-01-01','2027-12-31',true,'2024-01-02T00:00:00Z')`,
    [randomUUID()],
  );

  const first = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(first.fired, 1);
  assert.equal(first.candidates[0]!.kind, "new_promo");
  assert.match(first.candidates[0]!.detail, /Summer room discount/);

  // A second run with no new promo since must not re-fire the same one.
  const second = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(second.fired, 0);

  await db.close();
});

test("a promo that predates the saved trip is not treated as new", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  await db.query(`insert into users (id, email, plus_until) values ($1,$2,'2099-01-01')`,
    [userId, "latecomer@example.com"]);
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops)
     values ('ATL','MCO','2027-03-01',4,100,0)`);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  const params: TripParams & { month: string; resortId: string } = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs", month: "2027-03", resortId: "wdw",
  };
  // Trip saved AFTER the promo already existed — nothing new to report.
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct,created_at)
     values ($1,$2,$3,'{}',100000,100,'2024-01-05T00:00:00Z')`,
    [tripId, userId, JSON.stringify(params)],
  );
  await db.query(
    `insert into promos (id,resort_id,label,effect_kind,effect_value,starts_on,ends_on,active,created_at)
     values ($1,'wdw','Old promo','room_pct_off',20,'2027-01-01','2027-12-31',true,'2024-01-01T00:00:00Z')`,
    [randomUUID()],
  );

  const result = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(result.fired, 0);

  await db.close();
});

test("a driving trip gets no gas-price alert when the price has barely moved", async () => {
  const db = await memoryDb();
  const userId = randomUUID(), tripId = randomUUID();
  await db.query(`insert into users (id, email, plus_until) values ($1,$2,'2099-01-01')`,
    [userId, "driver2@example.com"]);
  await db.query(
    `insert into ticket_prices (resort_id,park_date,adult_usd,child_usd)
     values ('wdw','2027-03-01',100,90)`);
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property)
     values ('h1','wdw','Test Hotel','','2027-03-01',150,'value',true)`);
  await db.query(`insert into gas_prices (as_of, price_per_gallon_usd, source) values ('2027-03-01', 3.10, 'test')`);
  const params: TripParams & { month: string; resortId: string; gasPriceAtSaveUsd: number } = {
    origin: "ATL", adults: 2, childAges: [], nights: 1, parkDays: 1,
    stay: "on", tier: 0, food: "qs", transportMode: "drive",
    month: "2027-03", resortId: "wdw", gasPriceAtSaveUsd: 3.00, // ~3.3% move, under the 8% default
  };
  await db.query(
    `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
     values ($1,$2,$3,'{}',100000,100)`,
    [tripId, userId, JSON.stringify(params)],
  );

  const result = await runAlerts(db, { sender: { name: "unused", async send() {} } });
  assert.equal(result.fired, 0);

  await db.close();
});
