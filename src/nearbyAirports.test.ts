import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { driveHours, loadNearbyCheaper, nearbyOrigins, pickNearbyCheaper } from "./nearbyAirports.js";

test("nearbyOrigins: Raleigh's drivable airports, nearest first", () => {
  const near = nearbyOrigins("RDU").map((n) => n.iata);
  assert.equal(near[0], "CLT");
  for (const a of ["CLT", "IAD", "ATL"]) assert.ok(near.includes(a), `${a} should be in reach of RDU`);
  assert.ok(!near.includes("MCO") && !near.includes("BOS"));
  assert.deepEqual(nearbyOrigins("ZZZ"), []);
});

test("driveHours is a rough, rounded figure", () => {
  assert.equal(driveHours(130), 2.5);
  assert.equal(driveHours(10), 0.5);
});

test("pickNearbyCheaper: the owner's own case, March 2026 to LAX and to Orlando", () => {
  const p = "March 2026";
  const lax = pickNearbyCheaper("RDU", [
    { origin: "RDU", median: 611, period: p }, { origin: "CLT", median: 566, period: p },
    { origin: "IAD", median: 658, period: p }, { origin: "ATL", median: 687, period: p },
  ]);
  assert.equal(lax?.origin, "CLT");
  assert.equal(lax?.savingPerSeat, 45);
  // From RDU nobody nearby beats Raleigh to Orlando.
  assert.equal(pickNearbyCheaper("RDU", [
    { origin: "RDU", median: 287, period: p }, { origin: "ATL", median: 376, period: p },
    { origin: "IAD", median: 399, period: p }, { origin: "CLT", median: 485, period: p },
  ]), null);
  // ...but from Charlotte, Raleigh is worth the drive.
  assert.equal(pickNearbyCheaper("CLT", [
    { origin: "CLT", median: 485, period: p }, { origin: "RDU", median: 287, period: p },
  ])?.savingPerSeat, 198);
});

test("pickNearbyCheaper ignores small savings and a different period", () => {
  assert.equal(pickNearbyCheaper("RDU", [
    { origin: "RDU", median: 611, period: "March 2026" }, { origin: "CLT", median: 590, period: "March 2026" },
  ]), null);
  assert.equal(pickNearbyCheaper("RDU", [
    { origin: "RDU", median: 611, period: "March 2026" }, { origin: "CLT", median: 300, period: "March 2025" },
  ]), null);
});

test("loadNearbyCheaper prefers the monthly survey and compares like with like", async () => {
  const db = await memoryDb();
  const ins = (o: string, med: number, tickets = 500) => db.query(
    `insert into historical_fares_monthly
       (origin,destination,year,month,avg_fare_usd,p25_fare_usd,median_fare_usd,p75_fare_usd,passengers_sampled,itin_count,file)
     values ($1,'LAX',2026,3,$2,$2,$2,$2,$3,$3,'t')`, [o, med, tickets]);
  await ins("RDU", 611); await ins("CLT", 566); await ins("IAD", 658);
  const res = await loadNearbyCheaper(db, "RDU", ["LAX", "MCO"], "2027-03");
  assert.equal(res.get("LAX")?.origin, "CLT");
  assert.equal(res.get("LAX")?.period, "March 2026");
  assert.equal(res.has("MCO"), false);
  // A month with too few tickets falls back to the quarterly survey.
  await db.query(
    `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd,passengers_sampled,source)
     values ('RDU','MCO',2025,2,300,300,900,'bts_db1b'), ('ATL','MCO',2025,2,240,240,900,'bts_db1b')`);
  const q = await loadNearbyCheaper(db, "RDU", ["MCO"], "2027-05");
  assert.equal(q.get("MCO")?.origin, "ATL");
  assert.equal(q.get("MCO")?.period, "April–June 2025");
  await db.close();
});
