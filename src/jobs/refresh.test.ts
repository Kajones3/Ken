import { test } from "node:test";
import assert from "node:assert/strict";
import { dueMonths, allTierMonths, runRefresh } from "./refresh.js";
import { memoryDb } from "../db.js";

test("dueMonths: on a day divisible by every tier's cadence, all three tiers contribute", () => {
  // day 21 is divisible by 1 (near), 3 (mid), and 7 (far)
  const months = dueMonths("2026-09-07", 21);
  assert.ok(months.includes("2026-09")); // near tier, day 0
  assert.ok(months.includes("2027-03")); // far tier, day ~181-365
});

test("dueMonths: on a day only divisible by the near tier's cadence, far months are absent", () => {
  // day 1 is divisible by 1 (near) but not 3 (mid) or 7 (far)
  const months = dueMonths("2026-09-07", 1);
  assert.ok(months.includes("2026-09"));
  assert.ok(!months.includes("2027-03"));
});

test("allTierMonths: covers the full year regardless of which day it is", () => {
  const months = allTierMonths("2026-09-07");
  assert.ok(months.includes("2026-09")); // near tier start
  assert.ok(months.includes("2027-03")); // far tier middle
  assert.ok(months.includes("2027-09")); // far tier end, ~365 days out
});

test("allTierMonths is a superset of dueMonths on any given day", () => {
  const all = new Set(allTierMonths("2026-09-07"));
  for (const dayOfYear of [1, 2, 3, 7, 21, 100]) {
    for (const m of dueMonths("2026-09-07", dayOfYear)) {
      assert.ok(all.has(m), `${m} (due on day ${dayOfYear}) missing from allTierMonths`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * The nightly loop itself: what it asks for, and what it refuses to ask for.
 * ------------------------------------------------------------------------ */

/** Records every route and resort/month the job asks about. */
function recordingProvider() {
  const flights: string[] = [];
  const hotels: string[] = [];
  return {
    flights, hotels,
    name: "recorder",
    hotelSource: "recorder",
    async flightMonth(origin: string, destination: string, month: string) {
      flights.push(`${origin}->${destination}`);
      void month;
      return [];
    },
    async hotelMonth(resortId: string, month: string) {
      hotels.push(`${resortId}|${month}`);
      return [];
    },
  };
}

test("the refresh never asks for a flight to the city it is departing from", async () => {
  // Every night this job asked Travelpayouts for LAX->LAX and LAX->SNA, three
  // trip lengths each, once per month in the run — eighteen guaranteed 400s
  // per refresh, logged as errors and then ignored.
  const db = await memoryDb();
  const p = recordingProvider();
  const res = await runRefresh(db, {
    months: ["2027-03"], origins: ["LAX", "ATL"], resorts: ["dlr", "wdw"],
    provider: p, hotelSlots: null,
  });

  assert.ok(!p.flights.includes("LAX->LAX"), "LAX->LAX must never be requested");
  assert.ok(!p.flights.includes("LAX->SNA"), "LAX->SNA must never be requested");
  assert.ok(p.flights.includes("ATL->SNA"), "a real route to Disneyland is unaffected");
  assert.ok(p.flights.includes("LAX->MCO"), "LAX still flies to Orlando");
  assert.equal(res.skipped, 2, "both local pairs counted as skipped, not as calls");
  await db.close();
});

test("a resort/month that won a hotel slot is refreshed even when its month is not due", async () => {
  // The rotation runs across the whole year, so a slot can land on a month
  // tonight's flight tiering does not touch. If the job only walked due
  // months that slot would be silently dropped and the budget spent on
  // nothing — the rotation has to drive the hotel pass, not just filter it.
  const db = await memoryDb();
  const p = recordingProvider();
  await runRefresh(db, {
    months: ["2027-03"], origins: ["ATL"], resorts: ["wdw"], provider: p,
    hotelSlots: [{ resortId: "wdw", month: "2027-11", lastPulledAt: 0 }],
  });

  assert.ok(p.hotels.includes("wdw|2027-03"), "the due month still gets its free on-property pass");
  assert.ok(p.hotels.includes("wdw|2027-11"), "and the slot's month gets its paid call");
  await db.close();
});

test("a resort/month is never asked about twice in one run", async () => {
  // The due-month pass and the rotation overlap by design; asking twice would
  // mean paying twice for the same lookup.
  const db = await memoryDb();
  const p = recordingProvider();
  await runRefresh(db, {
    months: ["2027-03"], origins: ["ATL"], resorts: ["wdw"], provider: p,
    hotelSlots: [{ resortId: "wdw", month: "2027-03", lastPulledAt: 0 }],
  });
  assert.deepEqual(p.hotels, ["wdw|2027-03"]);
  await db.close();
});
