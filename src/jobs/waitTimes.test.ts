import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "../db.js";
import {
  ridesOf, summarize, localHour, withinSampleWindow, trackedParks, namesAgree, runWaitTimes,
} from "./waitTimes.js";
import { QUEUE_TIMES_PARKS, RESORTS, WAIT_SAMPLE_FROM_HOUR, WAIT_SAMPLE_TO_HOUR } from "../config.js";

/* ------------------------------- ridesOf ------------------------------- */

test("a closed park yields NULL, not a page of zeros", () => {
  // The whole mechanism for handling park hours without an hours table. A
  // zero is a number and would drag every later average toward it forever.
  const shut = { lands: [{ rides: [
    { name: "A", is_open: false, wait_time: 0 },
    { name: "B", is_open: false, wait_time: 45 },
  ] }] };
  assert.equal(ridesOf(shut), null);
});

test("an OPEN park keeps its closed rides, so availability stays computable", () => {
  // Their analysis notebook computes open-ride availability as open over
  // total listed. Dropping closed rides would make a park with half its
  // rides down look identical to one running everything.
  const mixed = { lands: [{ rides: [
    { name: "open 20", is_open: true, wait_time: 20 },
    { name: "open 40", is_open: true, wait_time: 40 },
    { name: "down", is_open: false, wait_time: 999 },
  ] }] };
  const rides = ridesOf(mixed)!;
  assert.equal(rides.length, 3, "all three are kept");
  const down = rides.find((r) => r.name === "down")!;
  assert.equal(down.isOpen, false);
  assert.equal(down.waitMin, null, "a closed ride has no wait, whatever the feed says");
});

test("a null wait on an OPEN ride stays null, never zero", () => {
  // "Not reported" and "no queue" are different facts — the same rule the
  // climate generator applies to a missing temperature.
  const rides = ridesOf({ lands: [{ rides: [
    { name: "reported", is_open: true, wait_time: 30 },
    { name: "unreported", is_open: true, wait_time: null },
  ] }] })!;
  assert.equal(rides.find((r) => r.name === "unreported")!.waitMin, null);
  assert.equal(summarize(rides).meanWait, 30, "averaging 30 and 0 would give 15");
});

test("both payload shapes are walked — nested under lands, and top level", () => {
  const rides = ridesOf({
    rides: [{ name: "top", is_open: true, wait_time: 10 }],
    lands: [{ rides: [{ name: "nested", is_open: true, wait_time: 30 }] }],
  })!;
  assert.equal(rides.length, 2);
  assert.equal(summarize(rides).meanWait, 20);
});

test("a ride with no name is dropped, and a duplicate name is kept once", () => {
  // The name is half the primary key. A nameless row cannot be de-duplicated
  // on the next poll, and two rows sharing a name would collide on insert.
  const rides = ridesOf({ rides: [
    { name: "Real", is_open: true, wait_time: 10 },
    { name: "   ", is_open: true, wait_time: 20 },
    { is_open: true, wait_time: 30 },
    { name: "Real", is_open: true, wait_time: 40 },
  ] })!;
  assert.deepEqual(rides.map((r) => r.name), ["Real"]);
});

test("junk in never becomes a row out", () => {
  for (const junk of [null, undefined, 42, "rides", {}, { lands: null }, { rides: "no" }]) {
    assert.equal(ridesOf(junk), null, `${JSON.stringify(junk)} produced rows`);
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
  { name: "Down", is_open: false, wait_time: 0 },
] }] };

// 16:00 New York, comfortably inside the window for the stub's timezone.
const MIDDAY_UTC = new Date("2027-03-16T20:00:00Z");

test("a full run records one row per RIDE, at every park", async () => {
  const db = await memoryDb();
  const ridesPerPark = 3;
  const res = await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  assert.equal(res.errors, 0);
  assert.equal(res.written, trackedParks().length * ridesPerPark);
  const rows = await db.query<{ n: string }>(`select count(*) as n from wait_time_samples`);
  assert.equal(Number(rows.rows[0]!.n), trackedParks().length * ridesPerPark);
});

test("what lands in a row is what we measured", async () => {
  const db = await memoryDb();
  await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  const r = await db.query<{ ride_name: string; is_open: boolean; wait_min: number | null; local_hour: number; source: string }>(
    `select ride_name, is_open, wait_min, local_hour, source from wait_time_samples
      where ride_name = 'A' limit 1`);
  const row = r.rows[0]!;
  assert.equal(row.ride_name, "A");
  assert.equal(row.is_open, true);
  assert.equal(row.wait_min, 25);
  assert.equal(row.local_hour, 16, "the PARK's hour, not 20:00 UTC");
  assert.equal(row.source, "queue_times");
});

test("the closed ride is stored too, with no wait", async () => {
  // This is the row that makes open-ride availability computable, and it is
  // the one a park-average schema would have thrown away.
  const db = await memoryDb();
  await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  const r = await db.query<{ is_open: boolean; wait_min: number | null }>(
    `select is_open, wait_min from wait_time_samples where ride_name = 'Down' limit 1`);
  assert.equal(r.rows[0]!.is_open, false);
  assert.equal(r.rows[0]!.wait_min, null);
});

test("the park average is derivable from the stored rows", async () => {
  // The point of keeping rides: the number the original design stored is
  // still available, and everything else is available too.
  const db = await memoryDb();
  await runWaitTimes(db, {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  });
  const r = await db.query<{ mean: string; open_rides: string; total_rides: string }>(
    `select avg(wait_min) as mean,
            count(*) filter (where is_open) as open_rides,
            count(*) as total_rides
       from wait_time_samples where park_id = $1`, [trackedParks()[0]!.id]);
  assert.equal(Number(r.rows[0]!.mean), 30, "(25 + 35) / 2");
  assert.equal(Number(r.rows[0]!.open_rides), 2);
  assert.equal(Number(r.rows[0]!.total_rides), 3, "availability is 2 of 3");
});

test("re-polling the same minute updates rather than duplicating", async () => {
  const db = await memoryDb();
  const deps = {
    now: MIDDAY_UTC, sleep: async () => {},
    fetchImpl: stubFetch((url) => (url.endsWith("parks.json") ? PARKS_JSON : busyPark)),
  };
  await runWaitTimes(db, deps);
  await runWaitTimes(db, deps);
  const rows = await db.query<{ n: string }>(`select count(*) as n from wait_time_samples`);
  assert.equal(Number(rows.rows[0]!.n), trackedParks().length * 3, "no duplicates on a re-run");
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
  assert.equal(res.written, (trackedParks().length - 1) * 3, "the other parks' rides still land");
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
