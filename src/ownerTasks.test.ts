import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { ownerTasks, renderOwnerTasks, TICKET_STALE_DAYS } from "./ownerTasks.js";
import { newestMileageRateYear, MILEAGE_RATE_CARRY_FORWARD_YEARS, CROWDS_REVIEWED, CROWDS_ARE_PLACEHOLDER } from "./config.js";
import { addDaysISO, type ISODate } from "./dates.js";

/** Everything configured, so only the standing tasks remain. */
const ALL_SET = {
  OWNER_EMAIL: "owner@example.test",
  ALERT_FROM_EMAIL: "alerts@example.test",
  RESEND_API_KEY: "re_test",
} as NodeJS.ProcessEnv;

const SETTLED = `${newestMileageRateYear()}-02-01`;   // a date with a rate on file

test("an unset email secret is reported, and it is blocking", async () => {
  // The task that hides every other task: with these unset, the run goes
  // green and the mail silently never goes.
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: {} as NodeJS.ProcessEnv, today: SETTLED });
  const t = tasks.find((x) => x.id === "email-secrets")!;
  assert.ok(t, "missing secrets must be reported");
  assert.equal(t.blocking, true);
  assert.equal(t.side, "both");
  assert.match(t.title, /OWNER_EMAIL/);
  assert.match(t.title, /RESEND_API_KEY/);
  await db.close();
});

test("only the secrets that are actually missing are named", async () => {
  const db = await memoryDb();
  const tasks = await ownerTasks(db, {
    env: { OWNER_EMAIL: "o@e.test" } as NodeJS.ProcessEnv, today: SETTLED,
  });
  const t = tasks.find((x) => x.id === "email-secrets")!;
  assert.ok(!/OWNER_EMAIL/.test(t.title), "the one that IS set must not be nagged about");
  assert.match(t.title, /ALERT_FROM_EMAIL/);
  await db.close();
});

test("a configured deployment drops the email task entirely", async () => {
  // A checked task has to disappear on its own when the work is done,
  // otherwise the list becomes something you learn to ignore.
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  assert.equal(tasks.find((x) => x.id === "email-secrets"), undefined);
  await db.close();
});

test("every task says which side of the paywall it affects", async () => {
  // The owner's explicit ask: a broken free feature is everybody's problem,
  // a broken Plus feature is a paying customer's.
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: {} as NodeJS.ProcessEnv, today: SETTLED });
  assert.ok(tasks.length > 0);
  for (const t of tasks) {
    assert.ok(["free", "plus", "both"].includes(t.side), `${t.id} has no side`);
    assert.ok(t.why.length > 20, `${t.id} does not say what happens if ignored`);
    assert.ok(["checked", "standing"].includes(t.source), `${t.id} does not say how it was decided`);
  }
  await db.close();
});

test("no task is Plus-only any more — Plus buys only the PDF (2026-09-24)", async () => {
  // Attraction picks and applying a promo both moved to free at launch, and
  // nothing else here is Plus-gated data (the PDF has no hand-maintained
  // table of its own) — so "plus" should be an empty side, not a stale label
  // left over from before the regating.
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  const plus = tasks.filter((t) => t.side === "plus").map((t) => t.id);
  assert.deepEqual(plus, []);
  const attractionTask = tasks.find((t) => t.id === "attraction-list");
  const promoTask = tasks.find((t) => t.id === "real-promos");
  assert.equal(attractionTask?.side, "free", "the attraction list is free data now");
  assert.equal(promoTask?.side, "free", "applying a promo is free now");
  await db.close();
});

test("blocking jobs sort above everything else", async () => {
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: {} as NodeJS.ProcessEnv, today: SETTLED });
  const firstNonBlocking = tasks.findIndex((t) => !t.blocking);
  const lastBlocking = tasks.map((t) => t.blocking).lastIndexOf(true);
  assert.ok(firstNonBlocking === -1 || lastBlocking < firstNonBlocking,
    "a blocking job must never sit below a merely-degrading one");
  await db.close();
});

test("a missing mileage year is reported with the fix, urgent or not", async () => {
  // Both branches must carry the irs.gov instruction. A first draft put it
  // only on the urgent one, so the case you hit FIRST — a rate merely
  // carried forward — told you something was wrong and not how to fix it.
  const db = await memoryDb();
  const carried = `${newestMileageRateYear()}-07-01`;
  const soft = (await ownerTasks(db, { env: ALL_SET, today: carried }))
    .find((t) => t.id === "irs-mileage")!;
  assert.ok(soft, "a carried-forward year is still worth saying");
  assert.equal(soft.blocking, false, "carried forward is a warning, not a breakage");
  assert.match(soft.why, /irs\.gov/);

  const brokenYear = newestMileageRateYear() + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  const hard = (await ownerTasks(db, { env: ALL_SET, today: `${brokenYear}-07-01` }))
    .find((t) => t.id === "irs-mileage")!;
  assert.equal(hard.blocking, true, "trips that will not price at all are blocking");
  assert.match(hard.why, /irs\.gov/);
  assert.match(hard.why, /will NOT price/);
  await db.close();
});

test("stale ticket prices raise the alarm that never existed", async () => {
  // CLAUDE.md has said since the beginning that this should exist: "alarm on
  // any resort whose rows are >30 days old — nothing fails loudly here."
  const db = await memoryDb();
  const none = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  assert.equal(none.find((t) => t.id === "stale-tickets"), undefined, "no rows, no alarm");

  await db.query(
    `insert into ticket_prices (resort_id, park_date, adult_usd, child_usd, source_url, updated_at)
     values ('wdw','2027-03-01',150,140,'x', now() - ($1 || ' days')::interval)`,
    [String(TICKET_STALE_DAYS + 10)],
  );
  const stale = (await ownerTasks(db, { env: ALL_SET, today: SETTLED }))
    .find((t) => t.id === "stale-tickets")!;
  assert.ok(stale, "an old row must be reported");
  assert.match(stale.why, /wdw/);
  assert.equal(stale.side, "free");
  await db.close();
});

test("fresh ticket prices raise nothing", async () => {
  const db = await memoryDb();
  await db.query(
    `insert into ticket_prices (resort_id, park_date, adult_usd, child_usd, source_url, updated_at)
     values ('wdw','2027-03-01',150,140,'x', now())`,
  );
  const tasks = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  assert.equal(tasks.find((t) => t.id === "stale-tickets"), undefined);
  await db.close();
});

test("resorts with no real hotel pull are named", async () => {
  const db = await memoryDb();
  const all = (await ownerTasks(db, { env: ALL_SET, today: SETTLED }))
    .find((t) => t.id === "hotel-coverage")!;
  assert.ok(all, "an empty cache means every resort is uncovered");
  assert.match(all.why, /ten nights/, "says it clears itself if the job is running");
  await db.close();
});

test("an on-property row does not count as a real vendor pull", async () => {
  // Same trap the hotel rotation works around: on-property rates are
  // generated locally and carry the same source tag, so counting them would
  // claim coverage no vendor ever provided.
  const db = await memoryDb();
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source,fetched_at)
     values ('h1','wdw','A Hotel','d','2027-03-01',200,'mid',true,'serpapi_hotels',now())`,
  );
  const t = (await ownerTasks(db, { env: ALL_SET, today: SETTLED }))
    .find((x) => x.id === "hotel-coverage")!;
  assert.match(t.title, /Walt Disney World/, "still uncovered despite the on-property row");
  await db.close();
});

test("the rendered list labels each job free, Plus or both", async () => {
  const db = await memoryDb();
  const text = renderOwnerTasks(await ownerTasks(db, { env: {} as NodeJS.ProcessEnv, today: SETTLED }));
  assert.match(text, /Your manual jobs \(\d+\)/);
  assert.match(text, /\[FREE\+PLUS\] \[BLOCKING\]/);
  // No task is Plus-only any more (2026-09-24 — Plus buys only the PDF), so
  // a bare [PLUS] label should never appear, only [FREE] and [FREE+PLUS].
  assert.doesNotMatch(text, /\[PLUS\]/);
  assert.match(text, /\[FREE\]/);
  assert.match(text, /checked against real state just now/);
  assert.match(text, /always shown until marked done/);
  await db.close();
});

test("an empty list says so rather than printing a bare heading", () => {
  assert.match(renderOwnerTasks([]), /none outstanding/);
});

/**
 * The staleness registry. These pin the two halves that can go wrong
 * independently: a date that has aged out must produce a row, and a date that
 * has not must produce nothing — a nag that fires on day one is one the owner
 * learns to scroll past.
 */
test("a hand-maintained table that has aged out earns a task, and one that has not does not", async () => {
  const db = await memoryDb();
  // CROWDS_REVIEWED is a real date in config.ts, reviewed yearly. Ask on the
  // day after it was reviewed, and two years later.
  const fresh = await ownerTasks(db, { env: ALL_SET, today: addDaysISO(CROWDS_REVIEWED as ISODate, 1) });
  assert.equal(fresh.find((t) => t.id === "crowd-bands"), undefined,
    "a table reviewed yesterday should not be nagged about");

  const stale = await ownerTasks(db, { env: ALL_SET, today: addDaysISO(CROWDS_REVIEWED as ISODate, 800) });
  const row = stale.find((t) => t.id === "crowd-bands");
  assert.ok(row, "a table two years past review should earn a task");
  assert.equal(row.source, "checked", "it is computed from a date, not a standing reminder");
  assert.equal(row.blocking, false, "stale is not broken");
  assert.match(row.why, /Last reviewed/, "it should say when it was last looked at");
  assert.match(row.why, /CROWDS_REVIEWED/, "it should say how to clear it");
  await db.close();
});

test("a placeholder table is nagged about while its own flag says it is one", async () => {
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: ALL_SET, today: CROWDS_REVIEWED as ISODate });
  const row = tasks.find((t) => t.id === "crowd-bands-placeholder");
  if (CROWDS_ARE_PLACEHOLDER) {
    assert.ok(row, "the crowd bands say they are a placeholder, so this must be nagged about");
    assert.match(row.why, /CROWDS_ARE_PLACEHOLDER/, "it should say which flag to flip");
  } else {
    assert.equal(row, undefined, "the flag is off, so the nag must be gone");
  }
  await db.close();
});
