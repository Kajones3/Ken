import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RESORTS, RESORT_BY_ID, IRS_MILEAGE_RATES, MILEAGE_RATE_CARRY_FORWARD_YEARS,
  irsMileageRate, newestMileageRateYear, mileageRateStatus,
} from "./config.js";

/**
 * `dataConfidence` is the "our cost model does not quite match how this
 * resort sells a trip" badge. It exists so the six-resort comparison can
 * stay complete without overclaiming — the same honesty rule the flight
 * estimates follow.
 *
 * These tests pin WHICH resorts carry it. That is a launch decision, not an
 * implementation detail: adding or removing a badge should be a deliberate
 * edit that fails a test first, never something that drifts.
 */
test("only the three resorts with real cost-model gaps carry a confidence badge", () => {
  const flagged = RESORTS.filter((r) => r.dataConfidence).map((r) => r.id).sort();
  assert.deepEqual(flagged, ["dlp", "hkdl", "shdr"]);
});

test("Paris's badge names the actual gap: we price room-only, Disney bundles", () => {
  const dlp = RESORT_BY_ID.get("dlp")!;
  assert.ok(dlp.dataConfidence);
  assert.match(dlp.dataConfidence!.note, /package|bundle/i);
  // The badge is only true while hotel and tickets really are separate
  // lines. If a package price is ever modelled, this is the reminder to
  // drop the badge instead of leaving it contradicting the breakdown.
  assert.equal(dlp.plans.length > 0, true, "meal plans are separate from ticket bundling");
  assert.ok(
    !("packageUsd" in (dlp.ticket as object)),
    "package pricing appears to be modelled now — remove Paris's badge",
  );
});

test("Shanghai's badge names the actual gap: height bands, which are not modelled", () => {
  const shdr = RESORT_BY_ID.get("shdr")!;
  assert.ok(shdr.dataConfidence);
  assert.match(shdr.dataConfidence!.note, /height/i);
  // The badge must stay true to the model. If height banding is ever
  // implemented, `bands` grows a height field and this assertion is the
  // reminder to drop the badge rather than leave it lying to people.
  assert.ok(
    !("height" in (shdr.bands as object)),
    "height banding appears to be modelled now — remove Shanghai's badge",
  );
});

test("Hong Kong's badge names the actual gap: unverified age bands", () => {
  const hkdl = RESORT_BY_ID.get("hkdl")!;
  assert.ok(hkdl.dataConfidence);
  assert.match(hkdl.dataConfidence!.note, /age/i);
});

test("every badge renders and gives the reader somewhere to check", () => {
  for (const r of RESORTS) {
    const dc = r.dataConfidence;
    if (!dc) continue;
    // Short enough to sit in a chip next to the resort name.
    assert.ok(dc.level.length > 0 && dc.level.length <= 24,
      `${r.id}: badge label "${dc.level}" is ${dc.level.length} chars, too long for a chip`);
    // A real, actionable sentence — not "we're still working on it".
    assert.ok(dc.note.length >= 60, `${r.id}: note is too short to explain anything`);
    assert.match(dc.note, /[.!]$/, `${r.id}: note should end as a sentence`);
    assert.doesNotMatch(dc.note, /working on it|coming soon|TBD/i,
      `${r.id}: say what is actually unmodelled, not that it is in progress`);
    // The detail view links here so someone can check the real price.
    assert.match(r.ticketUrl, /^https:\/\//, `${r.id}: badge needs a real ticket URL to link to`);
  }
});

test("a badged resort is still fully priced — badging is not hiding", () => {
  // The whole point of choosing badges over a staged launch: all six resorts
  // still price. A badge that quietly disabled a resort would defeat it.
  for (const id of ["shdr", "hkdl", "dlp"]) {
    const r = RESORT_BY_ID.get(id)!;
    assert.ok(r.ticket.base > 0, `${id} must still have real ticket pricing`);
    assert.ok(r.hotels.length > 0, `${id} must still have hotels to price`);
    assert.ok(r.food.qs > 0, `${id} must still have food rates`);
  }
});

/**
 * The IRS mileage rate is hand-entered and the IRS publishes a new one every
 * December, so the real failure mode isn't a wrong number — it's a right
 * number quietly outliving its year. These tests pin the year-awareness:
 * that a rate knows which year it's for, that reusing an old one is always
 * flagged, that it stops being reused once it's genuinely too old, and that
 * the owner gets a signal before any of that bites.
 */
test("every rate on file is tagged with a real year and two plausible half-year rates", () => {
  assert.ok(IRS_MILEAGE_RATES.length > 0, "there must be at least one rate on file");
  for (const r of IRS_MILEAGE_RATES) {
    assert.ok(Number.isInteger(r.year) && r.year > 2000, `${r.year} is not a real year`);
    for (const rate of [r.janToJunPerMile, r.julToDecPerMile]) {
      assert.ok(rate > 0.3 && rate < 2, `${r.year}: ${rate}/mi is outside any plausible IRS rate`);
    }
  }
  const years = IRS_MILEAGE_RATES.map((r) => r.year);
  assert.equal(new Set(years).size, years.length, "a year must not appear twice");
});

test("a year we have on file uses its own rate, and is not marked carried forward", () => {
  const jan = irsMileageRate("2026-01-15");
  const jul = irsMileageRate("2026-07-15");
  assert.ok(jan.ok && jul.ok);
  assert.equal(jan.ratePerMile, 0.725);
  assert.equal(jul.ratePerMile, 0.76);
  assert.equal(jan.rateYear, 2026);
  assert.equal(jan.tripYear, 2026);
  assert.equal(jan.carriedForward, false);
  assert.equal(jul.carriedForward, false);
});

test("the half-year split is June/July, not some other month", () => {
  const jun = irsMileageRate("2026-06-30");
  const jul = irsMileageRate("2026-07-01");
  assert.ok(jun.ok && jul.ok);
  assert.equal(jun.ratePerMile, 0.725);
  assert.equal(jul.ratePerMile, 0.76);
});

test("a year with no rate on file reuses the newest one AND says it did", () => {
  const newest = newestMileageRateYear();
  const r = irsMileageRate(`${newest + 1}-03-01`);
  assert.ok(r.ok, "the next year must still price — the app books 365 days out");
  assert.equal(r.carriedForward, true, "reusing last year's rate must never be silent");
  assert.equal(r.rateYear, newest);
  assert.equal(r.tripYear, newest + 1);
});

test("a year too far past the newest rate refuses rather than guessing", () => {
  const newest = newestMileageRateYear();
  const tooFar = newest + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  const r = irsMileageRate(`${tooFar}-03-01`);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes(String(tooFar)));
  assert.ok(!r.ok && r.reason.includes(String(newest)));
});

test("a year older than anything on file refuses too — we never invented a past rate", () => {
  const oldest = Math.min(...IRS_MILEAGE_RATES.map((r) => r.year));
  const r = irsMileageRate(`${oldest - 1}-03-01`);
  assert.equal(r.ok, false);
});

test("the owner is warned about a year with no rate while it is still only carried forward", () => {
  const newest = newestMileageRateYear();
  // Stand on 1 July of the newest year: the 365-day booking window reaches
  // into the next year, which has no rate yet.
  const s = mileageRateStatus(`${newest}-07-01`);
  assert.deepEqual(s.uncoveredYears, [newest + 1]);
  assert.equal(s.newestYearOnFile, newest);
  assert.equal(s.pricingBroken, false, "carried forward is a warning, not a breakage");
});

test("the owner is told plainly once a missing year actually stops trips pricing", () => {
  const newest = newestMileageRateYear();
  const s = mileageRateStatus(`${newest + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1}-07-01`);
  assert.ok(s.uncoveredYears.length > 0);
  assert.equal(s.pricingBroken, true);
});

test("a fully covered booking window warns about nothing", () => {
  const oldest = Math.min(...IRS_MILEAGE_RATES.map((r) => r.year));
  // A one-day window inside a year we have on file.
  const s = mileageRateStatus(`${oldest}-02-01`, 1);
  assert.deepEqual(s.uncoveredYears, []);
  assert.equal(s.pricingBroken, false);
});
