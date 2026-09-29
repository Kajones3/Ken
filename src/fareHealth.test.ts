import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { memoryDb, type Db } from "./db.js";
import { nationalBtsAverage, basisVerdict, trendAgeDays } from "./fareHealth.js";
import { ownerTasks } from "./ownerTasks.js";
import { newestMileageRateYear } from "./config.js";

const SCHEMA = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
const migrate = (db: Db) => db.exec(SCHEMA);

async function btsRow(db: Db, origin: string, fare: number, opts: { source?: string; roundTrip?: boolean } = {}) {
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,p25_fare_usd,median_fare_usd,
       p75_fare_usd,passengers_sampled,itin_count,source,round_trip)
     values ($1,'MCO',2025,2,$2,$3,$2,$4,1000,100,$5,$6)`,
    [origin, fare, fare * 0.5, fare * 1.5, opts.source ?? "bts_db1b", opts.roundTrip ?? false],
  );
}
const fareOf = async (db: Db, origin: string) => {
  const { rows } = await db.query<Record<string, string>>(
    `select avg_fare_usd, p25_fare_usd, median_fare_usd, p75_fare_usd, round_trip, fetched_at
       from historical_fares where origin = $1`, [origin]);
  return rows[0]!;
};

test("the database update doubles one-leg BTS rows exactly once, and leaves fetched_at alone", async () => {
  const db = await memoryDb();
  await btsRow(db, "BNA", 110);                                    // written before the fix
  await btsRow(db, "ATL", 300, { roundTrip: true });               // written by the fixed loader
  await btsRow(db, "JFK", 900, { source: "sampled_live" });        // international: a real round trip
  const before = await fareOf(db, "BNA");

  await migrate(db);
  const once = await fareOf(db, "BNA");
  assert.equal(Number(once.median_fare_usd), 220);
  assert.equal(Number(once.p25_fare_usd), 110);
  assert.equal(Number(once.p75_fare_usd), 330);
  assert.equal(Number(once.avg_fare_usd), 220);
  assert.equal(String(once.fetched_at), String(before.fetched_at),
    "re-stamping would stop bought fares counting as evidence against the baseline");

  await migrate(db);
  await migrate(db);
  assert.equal(Number((await fareOf(db, "BNA")).median_fare_usd), 220, "running it again must change nothing");
  assert.equal(Number((await fareOf(db, "ATL")).median_fare_usd), 300, "an already round-trip row is untouched");
  assert.equal(Number((await fareOf(db, "JFK")).median_fare_usd), 900, "international baselines were never halved");
  await db.close();
});

test("flight checks saved against the half-price model are rescaled once; nothing else is", async () => {
  const db = await memoryDb();
  const add = (id: string, resort: string, category: string, model: number, roundTrip: boolean) => db.query(
    `insert into price_checks (id, checked_on, resort_id, category, amount, currency, price_is, unit_usd,
       match_key, model_usd, dedupe, model_round_trip)
     values ($1, '2026-09-27', $2, $3, 400, 'USD', 'per_person', 400, 'k', $4, $5, $6)`,
    [id, resort, category, model, `dedupe-${id}`, roundTrip]);
  await add("00000000-0000-0000-0000-000000000001", "wdw", "flight", 200, false);  // old, domestic
  await add("00000000-0000-0000-0000-000000000002", "dlr", "flight", 200, true);   // new code
  await add("00000000-0000-0000-0000-000000000003", "tdr", "flight", 1200, false); // international
  await add("00000000-0000-0000-0000-000000000004", "wdw", "hotel", 300, false);   // not a flight
  await migrate(db);
  await migrate(db);
  const { rows } = await db.query<{ id: string; model_usd: string }>(
    `select id, model_usd from price_checks order by id`);
  assert.deepEqual(rows.map((r) => Number(r.model_usd)), [400, 200, 1200, 300]);
  await db.close();
});

test("the basis check catches a factor of two either way, not a few percent", () => {
  assert.equal(basisVerdict(204), "low");
  assert.equal(basisVerdict(409), "ok");
  assert.equal(basisVerdict(330), "ok");
  assert.equal(basisVerdict(818), "high");
});

const SETTLED = `${newestMileageRateYear()}-02-01`;
const ALL_SET = { OWNER_EMAIL: "o@x.test", ALERT_FROM_EMAIL: "a@x.test", RESEND_API_KEY: "re" } as NodeJS.ProcessEnv;

test("a half-price baseline is a BLOCKING line in the owner's daily email", async () => {
  const db = await memoryDb();
  await btsRow(db, "BNA", 204, { roundTrip: true });
  assert.equal(Math.round((await nationalBtsAverage(db))!.avg), 204);
  const t = (await ownerTasks(db, { env: ALL_SET, today: SETTLED })).find((x) => x.id === "fare-basis");
  assert.ok(t);
  assert.equal(t!.blocking, true);
  assert.match(t!.title, /HALF/);
  await db.close();
});

test("a sensible baseline says nothing", async () => {
  const db = await memoryDb();
  await btsRow(db, "BNA", 410, { roundTrip: true });
  const ids = (await ownerTasks(db, { env: ALL_SET, today: SETTLED })).map((x) => x.id);
  assert.ok(!ids.includes("fare-basis"));
  await db.close();
});

test("a fare correction that hasn't updated in over a week is reported, and a fresh one isn't", async () => {
  const db = await memoryDb();
  assert.equal(await trendAgeDays(db), null);
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter, computed_at)
     values ('00000000-0000-0000-0000-00000000000a', 1, 0.9, 1.1, 5, '2025Q2', $1)`,
    [`${SETTLED}T00:00:00Z`]);
  const later = new Date(`${SETTLED}T12:00:00Z`);
  later.setUTCDate(later.getUTCDate() + 19);
  const stale = await ownerTasks(db, { env: ALL_SET, today: later.toISOString().slice(0, 10) });
  const t = stale.find((x) => x.id === "fare-trend-stale");
  assert.ok(t);
  assert.match(t!.title, /19 days/);
  assert.equal(t!.blocking, false);
  const fresh = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  assert.ok(!fresh.some((x) => x.id === "fare-trend-stale"));
  await db.close();
});
