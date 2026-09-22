import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "../db.js";
import {
  summarise, localHour, withinSampleWindow, trackedParks, namesAgree, runWaitTimes,
} from "./waitTimes.js";
import { QUEUE_TIMES_PARKS, RESORTS, WAIT_SAMPLE_FROM_HOUR, WAIT_SAMPLE_TO_HOUR } from "../config.js";

/* ------------------------------ summarise ------------------------------ */

test("a closed park summarises to NULL, not to a row of zeros", () => {
  // The whole mechanism for handling park hours without an hours table. A
  // zero is a number and would drag the month's mean toward it forever.
  const shut = { lands: [{ rides: [
    { name: "A", is_open: false, wait_time: 0 },
    { name: "B", is_open: false, wait_time: 45 },
  ] }] };
  assert.equal(summarise(shut), null);
});

test("closed rides are excluded from the mean, open ones kept", () => {
  const mixed = { lands: [{ rides: [
    { name: "open 20", is_open: true, wait_time: 20 },
    { name: "open 40", is_open: true, wait_time: 40 },
    { name: "shut 999", is_open: false, wait_time: 999 },
  ] }] };
  const s = summarise(mixed)!;
  assert.equal(s.meanWait, 30);
  assert.equal(s.maxWait, 40, "a closed ride cannot set the maximum either");
  assert.equal(s.openRides, 2);
});

test("a null wait on an OPEN ride is skipped, never read as zero", () => {
  // "Not reported" and "no queue" are different facts — the same rule the
  // climate generator applies to a missing temperature.
  const s = summarise({ lands: [{ rides: [
    { name: "reported", is_open: true, wait_time: 30 },
    { name: "unreported", is_open: true, wait_time: null },
  ] }] })!;
  assert.equal(s.meanWait, 30, "averaging 30 and 0 would give 15");
  assert.equal(s.openRides, 1);
});

test("both payload shapes are walked — nested under lands, and top level", () => {
  const both = {
    rides: [{ name: "top", is_open: true, wait_time: 10 }],
    lands: [{ rides: [{ name: "nested", is_open: true, wait_time: 30 }] }],
  };
  const s = summarise(both)!;
  assert.equal(s.openRides, 2);
  assert.equal(s.meanWait, 20);
});

test("junk in never becomes a number out", () => {
  for (const junk of [null, undefined, 42, "rides", {}, { lands: null }, { rides: "no" }]) {
    assert.equal(summarise(junk), null, `${JSON.stringify(junk)} produced a summary`);
  }
});

/* ------------------------------ local hour ------------------------------ */

test("localHour returns the PARK's hour, not UTC — across the date line", () => {
  // This is the column the whole later aggregation rests on. 02:00 UTC is
  // the previous evening in Anaheim and mid-morning in Tokyo; recording a
  // UTC hour would make Orlando's quiet morning and Shanghai's busy
  // afternoon look like the same time of day.
  const at = new Date("2027-03-16T02:00:00Z");
  assert.equal(localHour(at, "America/Los_Angeles"), 19, "previous evening in Anaheim");
  assert.equal(localHour(at, "America/New_York"), 22);
  assert.equal(localHour(at, "Asia/Tokyo"), 11, "already mid-morning the next day");
  assert.equal(localHour(at, "UTC"), 2);
});

test("an unknown timezone returns null rather than a silently wrong hour", () => {
  assert.equal(localHour(new Date(), "Mars/Olympus_Mons"), null);
});

test("midnight is hour 0, not 24", () => {
  assert.equal(localHour(new Date("2027-03-16T00:00:00Z"), "UTC"), 0);
});

/* ---------------------------- sample window ---------------------------- */

test("only 9am to 7pm local counts", () => {
  // The owner's call: "sometimes wait times are single digits ... 9am -
  // 7:00pm will be enough data." Rope-drop and the last hour describe an
  // experience nobody has.
  assert.equal(WAIT_SAMPLE_FROM_HOUR, 9);
  assert.equal(WAIT_SAMPLE_TO_HOUR, 19);
  for (const h of [0, 5, 8, 19, 20, 23]) assert.equal(withinSampleWindow(h), false, `${h}:00 should be out`);
  for (const h of [9, 12, 15, 18]) assert.equal(withinSampleWindow(h), true, `${h}:00 should be in`);
});

/* ------------------------------ park list ------------------------------ */

test("every resort has at least one Queue-Times park", () => {
  for (const r of RESORTS) {
    assert.ok(QUEUE_TIMES_PARKS[r.id]?.length, `${r.id} has no park to sample`);
  }
});

test("park ids are unique across resorts", () => {
  const ids = trackedParks().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "an id is listed twice");
});

test("the name check forgives punctuation and nothing else", () => {
  // Deliberately strict, and the strictness is the feature. Loosening this
  // to token overlap would make "Disneyland" match both Anaheim and Paris —
  // two different parks whose waits must never be recorded under each
  // other's resort. Since the ids are a DRAFT until the probe runs, a park
  // that refuses is the system working: the log prints what they actually
  // call it, and correcting the draft is a copy-paste.
  assert.ok(namesAgree("Disney's Hollywood Studios", "Disney's Hollywood Studios"));
  assert.ok(namesAgree("Disney's Hollywood Studios", "Disneys Hollywood Studios"));
  assert.ok(namesAgree("Magic Kingdom", "  magic  kingdom  "));
  assert.ok(namesAgree("Disneyland", "Disneyland Park"), "containment is allowed");
  assert.ok(!namesAgree("Disneyland Paris", "Disneyland Park (Paris)"),
    "a rearranged name refuses rather than guessing — the probe settles it");
  assert.ok(!namesAgree("Magic Kingdom", "Alton Towers"));
  assert.ok(!namesAgree("Magic Kingdom", ""));
});

/* ------------------------------- the run ------------------------------- */

const PARKS_JSON = [{
  name: "Disney",
  parks: trackedParks().map((p) => ({ id: p.id, name: p.name, timezone: "America/New_York" })),
}];

function stubFetch(handler: (url: string) => unknown) {
  return (async (url: string | URL) => {
    const body = handler(String(url));
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
}

const busyPark = { lands: [{ rides: [
  { name: "A", is_open: true, wait_time: 25 },
  { name: "B", is_open: true, wait_time: 35 },
] }] };

// 16:00 New York, comfortably inside the window for the stub's timezone.
const MIDDAY_UTC = new Date("2027-03-16T20:00:00Z");

test("a full run records one row per park", async () => {
  const db = await memoryDb();
  const res = await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  assert.equal(res.errors, 0);
  assert.equal(res.written, trackedParks().length);
  const rows = await db.query<{ n: string }>(`select count(*) as n from wait_time_samples`);
  assert.equal(Number(rows.rows[0]!.n), trackedParks().length);
});

test("what lands in the row is what we measured", async () => {
  const db = await memoryDb();
  await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  const r = await db.query<{ mean_wait_min: string; max_wait_min: number; open_rides: number; local_hour: number; source: string }>(
    `select mean_wait_min, max_wait_min, open_rides, local_hour, source from wait_time_samples limit 1`);
  const row = r.rows[0]!;
  assert.equal(Number(row.mean_wait_min), 30);
  assert.equal(row.max_wait_min, 35);
  assert.equal(row.open_rides, 2);
  assert.equal(row.local_hour, 16, "the PARK's hour, not 20:00 UTC");
  assert.equal(row.source, "queue_times");
});

test("outside the window, nothing is recorded at all", async () => {
  const db = await memoryDb();
  // 06:00 UTC is 01:00 in New York.
  const res = await runWaitTimes(db, {
    now: new Date("2027-03-16T06:00:00Z"), sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  assert.equal(res.written, 0);
  assert.equal(res.skippedWindow, trackedParks().length);
  const rows = await db.query<{ n: string }>(`select count(*) as n from wait_time_samples`);
  assert.equal(Number(rows.rows[0]!.n), 0);
});

test("a park whose name does not match is REFUSED, not recorded", async () => {
  // The guard that makes a drafted id list safe to ship: a wrong id would
  // otherwise record another park's waits under our resort forever, with
  // nothing looking broken.
  const db = await memoryDb();
  const wrong = [{ name: "Disney", parks: trackedParks().map((p) => ({
    id: p.id, name: "Alton Towers", timezone: "America/New_York",
  })) }];
  const res = await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? wrong : busyPark)),
  });
  assert.equal(res.written, 0);
  assert.equal(res.errors, trackedParks().length);
});

test("one park failing still writes the others", async () => {
  // A cache being accumulated, not a table being replaced — the opposite
  // call from the climate generator, and deliberately so.
  const db = await memoryDb();
  const first = trackedParks()[0]!;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("parks.json")) {
      return { ok: true, json: async () => PARKS_JSON, text: async () => "" } as Response;
    }
    if (u.includes(`/parks/${first.id}/`)) {
      return { ok: false, status: 500, statusText: "Server Error", text: async () => "boom" } as Response;
    }
    return { ok: true, json: async () => busyPark, text: async () => "" } as Response;
  }) as unknown as typeof fetch;

  const res = await runWaitTimes(db, { now: MIDDAY_UTC, sleep: async () => {}, fetchImpl });
  assert.equal(res.errors, 1);
  assert.equal(res.written, trackedParks().length - 1);
});

test("if the park list cannot be read, NOTHING is recorded", async () => {
  // Without timezones every sample would be judged against a UTC hour,
  // which is exactly the bias local_hour exists to remove. Rows that look
  // fine and are systematically wrong are worse than no rows.
  const db = await memoryDb();
  const fetchImpl = (async () => ({
    ok: false, status: 503, statusText: "Unavailable", text: async () => "down",
  } as Response)) as unknown as typeof fetch;
  const res = await runWaitTimes(db, { now: MIDDAY_UTC, sleep: async () => {}, fetchImpl });
  assert.equal(res.written, 0);
  assert.equal(res.errors, 1);
});

test("a dry run reports what it would do and writes nothing", async () => {
  const db = await memoryDb();
  const res = await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {}, dryRun: true,
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  assert.equal(res.written, 0);
  const rows = await db.query<{ n: string }>(`select count(*) as n from wait_time_samples`);
  assert.equal(Number(rows.rows[0]!.n), 0);
});
