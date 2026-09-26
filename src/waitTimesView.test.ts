import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { QUEUE_TIMES_PARKS } from "./config.js";
import { waitTimesSummary, rideSummary, waitTimeRows } from "./waitTimesView.js";

const NOW = new Date("2026-09-26T18:00:00Z");

async function seeded() {
  const db = await memoryDb();
  const rows: [number, string, string, string, number, boolean, number | null][] = [
    // Magic Kingdom: two readings of one ride, one of another, one closed.
    [6, "2026-09-25T16:00:00Z", "Space Mountain", "wdw", 12, true, 60],
    [6, "2026-09-26T16:00:00Z", "Space Mountain", "wdw", 12, true, 40],
    [6, "2026-09-26T16:00:00Z", "Haunted Mansion", "wdw", 12, true, 20],
    // Closed, and open-with-no-wait: neither is a zero-minute queue.
    [6, "2026-09-26T16:00:00Z", "Tron", "wdw", 12, false, null],
    [6, "2026-09-26T18:00:00Z", "Tron", "wdw", 14, true, null],
    // A month ago: counts in the all-time average, not the 7-day one.
    [6, "2026-08-20T16:00:00Z", "Space Mountain", "wdw", 12, true, 120],
  ];
  for (const r of rows) {
    await db.query(
      `insert into wait_time_samples (park_id, observed_at, ride_name, resort_id, local_hour, is_open, wait_min)
       values ($1,$2,$3,$4,$5,$6,$7)`, r);
  }
  return db;
}

test("every tracked park is listed, including ones that have recorded nothing", async () => {
  const db = await seeded();
  const parks = await waitTimesSummary(db, NOW);
  const tracked = Object.values(QUEUE_TIMES_PARKS).flat().length;
  assert.equal(parks.length, tracked, "an empty park is how a broken id shows up, so it must appear");
  const mk = parks.find((p) => p.parkId === 6)!;
  assert.equal(mk.rows, 6);
  assert.equal(mk.rides, 3);
  assert.equal(mk.days, 3);
  // (60+40+20+120)/4 — the closed ride and the open-without-a-wait reading are left out.
  assert.equal(mk.avgPostedWaitMin, 60);
  assert.equal(mk.avgPostedWaitMin7d, 40, "the August reading is outside the last 7 days");
  const empty = parks.find((p) => p.parkId !== 6)!;
  assert.equal(empty.rows, 0);
  assert.equal(empty.lastAt, null);
});

test("rides come back longest average first, never reading a missing wait as zero", async () => {
  const db = await seeded();
  const rides = await rideSummary(db, 6);
  assert.deepEqual(rides.map((r) => r.rideName), ["Space Mountain", "Haunted Mansion", "Tron"]);
  const tron = rides.find((r) => r.rideName === "Tron")!;
  assert.equal(tron.avgPostedWaitMin, null);
  assert.equal(tron.samples, 0);
});

test("the spreadsheet is bounded by how many days you ask for", async () => {
  const db = await seeded();
  assert.equal((await waitTimeRows(db, 7, NOW)).length, 5);
  assert.equal((await waitTimeRows(db, 60, NOW)).length, 6);
});
