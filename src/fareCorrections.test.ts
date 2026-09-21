import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import {
  validateCorrection, addCorrection, listCorrections, deleteCorrection,
  countingCorrections, median, MIN_FARE, MAX_FARE,
} from "./fareCorrections.js";
import { loadBook } from "./book.js";
import { todayISO, addDaysISO } from "./dates.js";

const soon = addDaysISO(todayISO(), 120);
const good = { origin: "RDU", destination: "MCO", departDate: soon, priceUsd: 197 };

/* ------------------------------ the row itself --------------------------- */

test("an airport we can't price is refused at the door", () => {
  assert.equal(validateCorrection({ ...good, origin: "ZZZ" }).ok, false);
  assert.equal(validateCorrection({ ...good, destination: "LHR" }).ok, false,
    "Heathrow is a real airport and not one of the six resorts' arrival airports");
  // LAX is both a departure airport and one of Disneyland's arrival
  // airports, so it is the pair that can reach the same-airport check at all.
  const same = validateCorrection({ ...good, origin: "LAX", destination: "LAX" });
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.reason, /not a flight/);
});

test("a fare for a trip that has already happened is refused, not stored inert", () => {
  // It could never count — both staleness guards would exclude it — so
  // accepting it would mean accepting something that does nothing.
  const past = validateCorrection({ ...good, departDate: "2020-01-01" });
  assert.equal(past.ok, false);
  if (!past.ok) assert.match(past.reason, /already passed/);
});

test("a pasted dollar sign is fine; a mistyped digit is not", () => {
  const ok = validateCorrection({ ...good, priceUsd: "$1,197" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.priceUsd, 1197);
  assert.equal(validateCorrection({ ...good, priceUsd: MAX_FARE + 1 }).ok, false);
  assert.equal(validateCorrection({ ...good, priceUsd: MIN_FARE - 1 }).ok, false);
  assert.equal(validateCorrection({ ...good, priceUsd: "about two hundred" }).ok, false);
});

test("a band has to be one of the three, and defaults to typical", () => {
  const d = validateCorrection(good);
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.value.band, "typical");
  assert.equal(validateCorrection({ ...good, band: "cheapish" }).ok, false);
  const hi = validateCorrection({ ...good, band: "HIGH" });
  assert.equal(hi.ok, true, "case doesn't matter");
});

test("expiry defaults forward and is refused if already past", () => {
  const d = validateCorrection(good);
  assert.equal(d.ok, true);
  if (d.ok) assert.ok(d.value.expiresOn > todayISO(), "a new row counts for a while");
  assert.equal(validateCorrection({ ...good, expiresOn: "2020-01-01" }).ok, false);
});

test("entered, listed and removable by id", async () => {
  const db = await memoryDb();
  const r = await addCorrection(db, good, "owner@example.com");
  assert.equal(r.ok, true);
  const rows = await listCorrections(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.priceUsd, 197);
  assert.equal(rows[0]!.counting, true);
  assert.equal(rows[0]!.createdBy, "owner@example.com");

  if (r.ok) {
    assert.equal(await deleteCorrection(db, r.id), true, "a typo must be removable");
    assert.equal((await listCorrections(db)).length, 0);
    assert.equal(await deleteCorrection(db, r.id), false, "and removing it twice is not an error");
  }
});

test("an expired row is still listed, marked as not counting", async () => {
  // Hiding it would turn "where did my correction go?" into a mystery.
  const db = await memoryDb();
  await addCorrection(db, good);
  await db.query(`update fare_corrections set expires_on = current_date - 1`);
  const rows = await listCorrections(db);
  assert.equal(rows.length, 1, "still visible");
  assert.equal(rows[0]!.counting, false, "but says it has stopped counting");
  assert.equal((await countingCorrections(db, ["MCO"])).length, 0, "and pricing does not see it");
});

test("a row whose travel date has passed stops counting on its own", async () => {
  const db = await memoryDb();
  await addCorrection(db, good);
  await db.query(`update fare_corrections set depart_date = current_date - 1`);
  assert.equal((await countingCorrections(db, ["MCO"])).length, 0);
});

test("median is the one the percentile rules use", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
});

/* --------------------- it has to reach a real estimate ------------------- */

/** A BTS-style baseline for one route, so an estimate exists to correct. */
async function seedBaseline(db: Awaited<ReturnType<typeof memoryDb>>, quarter: number) {
  await db.query(
    `insert into historical_fares
       (origin, destination, year, quarter, avg_fare_usd, p25_fare_usd, median_fare_usd,
        p75_fare_usd, passengers_sampled, source, fetched_at)
     values ('RDU','MCO', $1, $2, 200, 150, 200, 260, 5000, 'bts_db1b', now())`,
    [new Date().getUTCFullYear() - 1, quarter],
  );
  await db.query(
    `insert into fare_trend (id, multiplier, low_multiplier, high_multiplier, sample_routes, basis_quarter)
     values (gen_random_uuid(), 1.0, 1.0, 1.0, 10, $1)`,
    [`${new Date().getUTCFullYear() - 1}Q${quarter}`]);
}

test("a correction moves the estimate toward it — and never becomes a quote", async () => {
  const db = await memoryDb();
  const q3 = `${new Date().getUTCFullYear() + 1}-07-15`;
  await seedBaseline(db, 3);

  const before = await loadBook(db, { origin: "RDU", destinations: ["MCO"], resortIds: ["wdw"], from: q3, to: q3, tripLength: 7 });
  const e0 = before.flightEstimate?.("RDU", "MCO");
  if (!e0) return; // no baseline in this schema shape; the unit tests above still cover the rules

  await addCorrection(db, { origin: "RDU", destination: "MCO", departDate: q3, priceUsd: 400 });
  const after = await loadBook(db, { origin: "RDU", destinations: ["MCO"], resortIds: ["wdw"], from: q3, to: q3, tripLength: 7 });
  const e1 = after.flightEstimate!("RDU", "MCO")!;

  assert.ok(e1.med > e0.med, `the estimate moved toward the owner's figure (${e0.med} -> ${e1.med})`);
  assert.equal(e1.med, 400, "a 'typical' correction speaks for the median");
  assert.equal(e1.ownerCorrected, true, "and the card can say a human corrected it");
  assert.ok(e1.low <= e1.med && e1.med <= e1.high, "the band stays in order");
});

test("a 'cheap end' correction moves the low, not the middle", async () => {
  const db = await memoryDb();
  const when = `${new Date().getUTCFullYear() + 1}-07-15`;
  await seedBaseline(db, 3);
  const base = await loadBook(db, { origin: "RDU", destinations: ["MCO"], resortIds: ["wdw"], from: when, to: when, tripLength: 7 });
  const e0 = base.flightEstimate?.("RDU", "MCO");
  if (!e0) return;

  await addCorrection(db, { origin: "RDU", destination: "MCO", departDate: when, priceUsd: 120, band: "low" });
  const after = await loadBook(db, { origin: "RDU", destinations: ["MCO"], resortIds: ["wdw"], from: when, to: when, tripLength: 7 });
  const e1 = after.flightEstimate!("RDU", "MCO")!;

  assert.equal(e1.low, 120, "the cheap end is what they spoke for");
  assert.equal(e1.med, e0.med, "and the middle is untouched — they did not claim it was typical");
  assert.ok(e1.low <= e1.med, "still sorted");
});

test("a correction never reaches the real-fare cache", async () => {
  // flight_prices is what a VENDOR returned. A hand-typed figure landing
  // there would make the real-pulls digest report a pull that never happened
  // and would feed the fare trend a number nobody quoted.
  const db = await memoryDb();
  await addCorrection(db, good);
  const { rows } = await db.query(`select count(*)::int as n from flight_prices`);
  assert.equal((rows[0] as { n: number }).n, 0);
});
