import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { ownerTasks, renderOwnerTasks, TICKET_STALE_DAYS } from "./ownerTasks.js";
import { newestMileageRateYear, MILEAGE_RATE_CARRY_FORWARD_YEARS } from "./config.js";

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

test("the Plus-side jobs are present and labelled", async () => {
  const db = await memoryDb();
  const tasks = await ownerTasks(db, { env: ALL_SET, today: SETTLED });
  const plus = tasks.filter((t) => t.side === "plus").map((t) => t.id);
  assert.ok(plus.includes("attraction-list"), "the attraction list is a Plus feature's data");
  assert.ok(plus.includes("real-promos"), "applying a promo is Plus");
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
  assert.match(text, /\[PLUS\]/);
  assert.match(text, /\[FREE\]/);
  assert.match(text, /checked against real state just now/);
  assert.match(text, /always shown until marked done/);
  await db.close();
});

test("an empty list says so rather than printing a bare heading", () => {
  assert.match(renderOwnerTasks([]), /none outstanding/);
});
