import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb, type Db } from "../db.js";
import { rotateHotelSlots, slotKeys, PAID_HOTEL_SOURCE } from "./hotelRotation.js";

const TODAY = "2027-01-10";
const MONTHS = ["2027-02", "2027-03", "2027-04"];

/** One off-property row, as a real paid pull would leave behind. Upserts on
 *  the same (hotel_id, stay_date) key the refresh job uses, so re-buying a
 *  slot updates its timestamp exactly as a second real pull would. */
async function recordPull(
  db: Db, resortId: string, month: string, fetchedAt: string,
  opts: { onProperty?: boolean; source?: string } = {},
): Promise<void> {
  await db.query(
    `insert into hotel_rates
       (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source,fetched_at)
     values ($1,$2,'A Hotel','near the park',$3,180,'mid',$4,$5,$6)
     on conflict (hotel_id, stay_date) do update set
       source = excluded.source, fetched_at = excluded.fetched_at`,
    [`${resortId}-${month}-${opts.source ?? PAID_HOTEL_SOURCE}-${opts.onProperty ?? false}`,
     resortId, `${month}-14`, opts.onProperty ?? false,
     opts.source ?? PAID_HOTEL_SOURCE, fetchedAt],
  );
}

test("a resort/month nobody has ever bought goes first", async () => {
  // The whole point. Before this, the refresh walked resorts in config order
  // and spent the night's budget on whoever came first — so Walt Disney World
  // was re-bought every single night while Shanghai and Hong Kong, further
  // down the array, had never had a single real lookup.
  const db = await memoryDb();
  await recordPull(db, "wdw", "2027-02", "2027-01-09T00:00:00Z");
  await recordPull(db, "dlr", "2027-02", "2027-01-09T00:00:00Z");

  const slots = await rotateHotelSlots(db, {
    months: ["2027-02"], resortIds: ["wdw", "dlr", "shdr", "hkdl"], limit: 2, today: TODAY,
  });
  assert.deepEqual(slots.map((s) => s.resortId), ["hkdl", "shdr"],
    "the two never-bought resorts win, not the two at the top of the config");
  assert.ok(slots.every((s) => s.lastPulledAt === 0));
  await db.close();
});

test("once everything has been bought once, the stalest goes next", async () => {
  const db = await memoryDb();
  await recordPull(db, "wdw", "2027-02", "2027-01-01T00:00:00Z");   // oldest
  await recordPull(db, "dlr", "2027-02", "2027-01-05T00:00:00Z");
  await recordPull(db, "shdr", "2027-02", "2027-01-09T00:00:00Z");  // freshest

  const slots = await rotateHotelSlots(db, {
    months: ["2027-02"], resortIds: ["wdw", "dlr", "shdr"], limit: 2, today: TODAY,
  });
  assert.deepEqual(slots.map((s) => s.resortId), ["wdw", "dlr"]);
  await db.close();
});

test("the budget is a hard cap on how many slots are handed out", async () => {
  // A slot is a license to spend, so handing out more than the provider will
  // pay for would just recreate the old "whoever got there first" behavior
  // inside the provider instead of the job.
  const db = await memoryDb();
  const all = await rotateHotelSlots(db, {
    months: MONTHS, resortIds: ["wdw", "dlr", "shdr"], limit: 99, today: TODAY,
  });
  assert.equal(all.length, 9, "three resorts x three months, all unbought");

  const capped = await rotateHotelSlots(db, {
    months: MONTHS, resortIds: ["wdw", "dlr", "shdr"], limit: 4, today: TODAY,
  });
  assert.equal(capped.length, 4);
  assert.equal((await rotateHotelSlots(db, { months: MONTHS, limit: 0, today: TODAY })).length, 0);
  await db.close();
});

test("a month with no bookable night left never wins a slot", async () => {
  // Otherwise the rotation hands out a slot the provider then refuses, and
  // the budget is wasted exactly as it was before — the same bug, one level
  // up. Standing on 30 September, September has nothing left to price.
  const db = await memoryDb();
  const slots = await rotateHotelSlots(db, {
    months: ["2026-09", "2026-10"], resortIds: ["wdw"], limit: 5, today: "2026-09-30",
  });
  assert.deepEqual(slots.map((s) => s.month), ["2026-10"]);
  await db.close();
});

test("on-property rows are not mistaken for a real pull", async () => {
  // On-property Disney rates are generated locally and cost nothing, but they
  // are written with the same `serpapi_hotels` source tag as rows a vendor
  // really returned. Counting them would make every resort/month look freshly
  // bought the moment anything at all was written, and the rotation would
  // stop moving.
  const db = await memoryDb();
  await recordPull(db, "wdw", "2027-02", "2027-01-09T00:00:00Z", { onProperty: true });
  const slots = await rotateHotelSlots(db, {
    months: ["2027-02"], resortIds: ["wdw"], limit: 1, today: TODAY,
  });
  assert.equal(slots[0]?.lastPulledAt, 0, "still never really bought");
  await db.close();
});

test("a mock-provider row is not mistaken for a real pull either", async () => {
  const db = await memoryDb();
  await recordPull(db, "wdw", "2027-02", "2027-01-09T00:00:00Z", { source: "mock" });
  const slots = await rotateHotelSlots(db, {
    months: ["2027-02"], resortIds: ["wdw"], limit: 1, today: TODAY,
  });
  assert.equal(slots[0]?.lastPulledAt, 0);
  await db.close();
});

test("a full rotation covers every resort/month before repeating any", async () => {
  // The coverage claim in the module header, actually measured: six resorts
  // across the months the app prices, at the nightly budget, reaches
  // everything and reaches it exactly once per cycle.
  const db = await memoryDb();
  const resortIds = ["wdw", "dlr", "dlp", "tdr", "shdr", "hkdl"];
  const budget = 8;
  const total = resortIds.length * MONTHS.length;
  const seen = new Set<string>();

  let clock = Date.parse("2027-01-10T00:00:00Z");
  const nights = Math.ceil(total / budget);
  for (let night = 0; night < nights; night++) {
    const slots = await rotateHotelSlots(db, { months: MONTHS, resortIds, limit: budget, today: TODAY });
    for (const s of slots) {
      const key = `${s.resortId}|${s.month}`;
      // The invariant that matters: nothing is ever bought a second time
      // while something else has never been bought at all. Re-buying IS
      // correct once coverage is complete — that is the budget going to the
      // stalest data rather than sitting unspent — so the assertion is about
      // priority, not about never repeating.
      if (seen.has(key)) {
        assert.equal(seen.size, total,
          `${key} was re-bought while ${total - seen.size} slot(s) had never been bought`);
      }
      seen.add(key);
      clock += 1000;
      await recordPull(db, s.resortId, s.month, new Date(clock).toISOString());
    }
  }
  assert.equal(seen.size, total,
    `every resort/month should have real data within ${nights} nights`);
  await db.close();
});

test("slotKeys produces exactly what the provider checks against", async () => {
  const db = await memoryDb();
  const slots = await rotateHotelSlots(db, {
    months: ["2027-02"], resortIds: ["wdw", "dlr"], limit: 2, today: TODAY,
  });
  assert.deepEqual([...slotKeys(slots)].sort(), ["dlr|2027-02", "wdw|2027-02"]);
  await db.close();
});
