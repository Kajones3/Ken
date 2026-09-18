import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SerpApiHotelProvider, sampleCheckIn } from "./serpapi.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

let calls = 0;
function mockFetch(status = 200) {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ properties: [{ name: "Some Inn", rate_per_night: { extracted_lowest: 120 } }] }),
      { status },
    );
  }) as typeof fetch;
}

const RESORT = "wdw";

test("off-property stops calling once the budget is spent", async () => {
  // The gap this closes: the hourly limiter only *paces* spending, it never
  // stops it, so before this a loop bug or a long month list could run up an
  // unbounded bill. Every other paid path here already had a hard ceiling.
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 2); // budget of 2
  await p.hotelMonth(RESORT, "2027-03");
  await p.hotelMonth(RESORT, "2027-04");
  await p.hotelMonth(RESORT, "2027-05");
  assert.equal(calls, 2, "the third month must not reach the provider");
  assert.equal(p.budgetRemaining, 0);
});

test("on-property rates still come back after the budget is spent", async () => {
  // On-property is generated locally from config.ts and costs nothing, so an
  // exhausted budget must not take it down with off-property — the same
  // reasoning that made a 429 stop killing the whole resort/month.
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 0); // no budget at all
  const quotes = await p.hotelMonth(RESORT, "2027-03");
  assert.equal(calls, 0, "no budget means no paid call");
  assert.ok(quotes.length > 0, "on-property is local and must survive");
  assert.ok(quotes.every((q) => q.onProperty), "only the free on-property rows remain");
});

test("a failed lookup still counts against the budget", async () => {
  // SerpApi bills for a search that errors or finds nothing, so charging
  // only successes would make a failing resort a free infinite retry.
  mockFetch(429);
  const p = new SerpApiHotelProvider("key", 999, 5);
  await p.hotelMonth(RESORT, "2027-03");
  assert.equal(p.callsSpent, 1, "the errored call is still a paid search");
  assert.equal(p.budgetRemaining, 4);
});

test("an off-property failure never costs the on-property rates", async () => {
  mockFetch(500);
  const p = new SerpApiHotelProvider("key", 999, 5);
  const quotes = await p.hotelMonth(RESORT, "2027-03");
  assert.ok(quotes.length > 0);
  assert.ok(quotes.every((q) => q.onProperty));
});


/* ---------------------------------------------------------------------------
 * sampleCheckIn — the date bug that was throwing away most of the hotel
 * budget for roughly half of every month.
 * ------------------------------------------------------------------------ */

test("mid-month is used whenever mid-month is still ahead of us", () => {
  // The original intent, unchanged: away from both month edges, so the
  // sampled price represents the month rather than its boundary.
  assert.equal(sampleCheckIn("2027-03", "2027-02-01"), "2027-03-14");
  assert.equal(sampleCheckIn("2027-03", "2027-03-01"), "2027-03-14");
});

test("a check-in date that has already been is never requested", () => {
  // THE BUG. Standing on 18 September and asking for September's rates, the
  // old code asked for the 14th and Google Hotels answered
  // `check_in_date cannot be in the past` — six times a night, once per
  // resort, with the budget counter charging for every one.
  const pick = sampleCheckIn("2026-09", "2026-09-18");
  assert.equal(pick, "2026-09-19", "the soonest bookable night, not the 14th");
  assert.ok(pick! > "2026-09-18", "must be in the future, always");
});

test("a month with no bookable night left asks for nothing at all", () => {
  // Standing on the last day of the month, tomorrow is next month — there is
  // no night left in this one to price at any price, so we don't pay to ask.
  assert.equal(sampleCheckIn("2026-09", "2026-09-30"), null);
  assert.equal(sampleCheckIn("2026-09", "2026-10-05"), null);
});

test("every day of a month yields either a future date inside it, or nothing", () => {
  // The property that matters, checked exhaustively rather than at the two
  // ends: whatever we ask for is bookable and belongs to the month we are
  // pricing. A date outside either bound is the old bug in a new costume.
  for (let d = 1; d <= 30; d++) {
    const today = `2026-09-${String(d).padStart(2, "0")}`;
    const pick = sampleCheckIn("2026-09", today);
    if (pick === null) continue;
    assert.ok(pick > today, `${pick} is not after ${today}`);
    assert.ok(pick >= "2026-09-01" && pick <= "2026-09-30", `${pick} escaped the month`);
  }
});

test("a resort/month outside the night's rotation is never paid for", () => {
  // The other half of the budget fix: the provider spends only where the
  // rotation says, so the nightly allowance can't be consumed by whichever
  // resort happens to come first in the config array.
  mockFetch();
  const slots = new Set(["shdr|2027-03"]);
  const p = new SerpApiHotelProvider("key", 999, 8, slots, "2027-01-01");
  return (async () => {
    await p.hotelMonth("wdw", "2027-03");   // not in the rotation
    await p.hotelMonth("dlr", "2027-03");   // not in the rotation
    assert.equal(calls, 0, "resorts outside the plan must not spend");
    const quotes = await p.hotelMonth("shdr", "2027-03");
    assert.equal(calls, 1, "the resort that won the slot does spend");
    assert.ok(quotes.some((q) => !q.onProperty), "and gets real off-property rows");
  })();
});

test("on-property rates still come back for a resort outside the rotation", () => {
  // Same rule as an exhausted budget: skipping the paid half must never take
  // down the free half that needs no network call at all.
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 8, new Set(["shdr|2027-03"]), "2027-01-01");
  return (async () => {
    const quotes = await p.hotelMonth("wdw", "2027-03");
    assert.equal(calls, 0);
    assert.ok(quotes.length > 0 && quotes.every((q) => q.onProperty));
  })();
});

test("an unpriceable month costs nothing even when it holds a slot", () => {
  mockFetch();
  const p = new SerpApiHotelProvider("key", 999, 8, new Set(["wdw|2026-09"]), "2026-09-30");
  return (async () => {
    await p.hotelMonth("wdw", "2026-09");
    assert.equal(calls, 0, "no bookable night left, so no paid question to ask");
    assert.equal(p.callsSpent, 0);
  })();
});
