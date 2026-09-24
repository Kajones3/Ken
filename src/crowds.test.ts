import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crowdFor, crowdFlag, crowdRank, quietestMonths, quietestThisMonth,
  parseCrowdSensitivity, MONTH_NAMES,
} from "./crowds.js";
import { CROWDS, CROWD_BANDS, CROWD_LABELS, RESORTS, type CrowdBand } from "./config.js";

test("every resort has a full, valid twelve-month year", () => {
  for (const r of RESORTS) {
    const year = CROWDS[r.id];
    assert.ok(year, `${r.id} has no crowd row — a resort on the board with no crowd box`);
    assert.equal(year.months.length, 12, `${r.id} does not have twelve months`);
    for (const [i, b] of year.months.entries()) {
      assert.ok(CROWD_BANDS.includes(b), `${r.id} month ${i + 1} has invalid band ${b}`);
    }
    for (const k of Object.keys(year.why ?? {})) {
      const m = Number(k);
      assert.ok(m >= 1 && m <= 12, `${r.id} has a 'why' for month ${k}`);
    }
  }
});

test("every band has a label", () => {
  for (const b of CROWD_BANDS) assert.ok(CROWD_LABELS[b], `no label for ${b}`);
});

/**
 * The honesty pin, and it has already earned its keep twice.
 *
 * The rule is not "which resorts own DVC inventory" — Hong Kong turned out
 * to have a real Disney Collection Exchange chart, so that version of the
 * rule was wrong. The rule is: a month may only claim a points-chart basis
 * if a chart actually covers it. Charts rarely cover a whole year (Hong
 * Kong's runs April to December; Tokyo's is one quarter), and Walt Disney
 * World's has not been supplied at all, so its twelve months are still
 * guesses and must say so.
 */
test("a month claims a points chart only where one actually covers it", () => {
  for (const [id, year] of Object.entries(CROWDS)) {
    for (let m = 1; m <= 12; m++) {
      const c = crowdFor(id, m);
      assert.ok(c, `${id} month ${m} missing`);
      if (c.basis !== "dvcPoints") continue;
      assert.ok(year.chartMonths?.includes(m),
        `${id} month ${m} claims a points chart, but chartMonths does not cover it`);
    }
  }
});

test("a charted month is no longer flagged provisional", () => {
  const dlr = crowdFor("dlr", 6);
  assert.equal(dlr?.basis, "dvcPoints");
  assert.equal(dlr?.provisional, false, "a real chart reading is not a placeholder");
  // Hong Kong's chart starts in April, so March is still judgement.
  assert.equal(crowdFor("hkdl", 3)?.basis, "estimate");
  assert.equal(crowdFor("hkdl", 8)?.basis, "dvcPoints");
});

test("bands rank in order, and an unknown band sorts as moderate", () => {
  assert.ok(crowdRank("veryLow") < crowdRank("low"));
  assert.ok(crowdRank("low") < crowdRank("moderate"));
  assert.ok(crowdRank("moderate") < crowdRank("high"));
  assert.ok(crowdRank("high") < crowdRank("peak"));
  assert.equal(crowdRank("nonsense" as CrowdBand), crowdRank("moderate"));
});

test("an unknown resort or month is null, never a throw", () => {
  assert.equal(crowdFor("nope", 3), null);
  assert.equal(crowdFor("wdw", 0), null);
  assert.equal(crowdFor("wdw", 13), null);
  assert.equal(crowdFlag("nope", 3, "high"), null);
  assert.deepEqual(quietestMonths("nope"), []);
});

test("'not much' never flags, however busy the month", () => {
  for (let m = 1; m <= 12; m++) {
    for (const r of RESORTS) assert.equal(crowdFlag(r.id, m, "none"), null);
  }
});

/** Find a month at a given band, so these tests survive a resort's bands
 *  being re-read off a new points chart — which has now happened twice. */
function monthAt(resortId: string, band: CrowdBand): number | null {
  const months = CROWDS[resortId]?.months ?? [];
  const i = months.indexOf(band);
  return i === -1 ? null : i + 1;
}

test("'somewhat' flags high and peak; 'a lot' also flags moderate", () => {
  // REVISED 2026-09-25: 'somewhat' used to flag only peak, so a real
  // Thanksgiving-week trip to WDW (banded 'high', one notch under
  // Christmas's 'peak') never flagged at the default sensitivity.
  const peak = monthAt("wdw", "peak")!;
  assert.ok(peak, "wdw should have a peak month");
  assert.ok(crowdFlag("wdw", peak, "some"), "peak should flag at 'somewhat'");

  // A "high" month exists at Disneyland; wdw's real chart has none, which is
  // itself worth not hard-coding either way.
  const high = monthAt("dlr", "high")!;
  assert.ok(high, "dlr should have a high month");
  assert.ok(crowdFlag("dlr", high, "some"), "a high month should flag at 'somewhat'");

  const moderate = monthAt("dlr", "moderate")!;
  assert.ok(moderate, "dlr should have a moderate month");
  assert.equal(crowdFlag("dlr", moderate, "some"), null, "a moderate month should not flag at 'somewhat'");
  assert.ok(crowdFlag("dlr", moderate, "high"), "a moderate month should flag at 'a lot'");

  const quiet = monthAt("wdw", "veryLow")!;
  assert.equal(crowdFlag("wdw", quiet, "high"), null, "a quiet month should never flag");
});

test("alternatives are offered only at 'a lot', and only when genuinely quieter", () => {
  const peakMonth = monthAt("wdw", "peak")!;
  const peak = crowdFlag("wdw", peakMonth, "high");
  assert.ok(peak);
  assert.ok(peak.alternatives.length > 0, "a peak month should offer quieter months");
  for (const a of peak.alternatives) {
    assert.ok(peak.alternatives.every(() => crowdRank(peak.band) - a.rank >= 2),
      "an alternative must be at least two bands quieter");
  }
  assert.deepEqual(crowdFlag("wdw", peakMonth, "some")?.alternatives, [],
    "'somewhat' should not push alternative months");
});

test("the detail sentence names the month and does not claim to measure crowds", () => {
  const peakMonth = monthAt("wdw", "peak")!;
  const f = crowdFlag("wdw", peakMonth, "high");
  assert.ok(f?.detail.includes(MONTH_NAMES[peakMonth - 1]!));
});

/**
 * Both basis notes must hedge. The regex looks for an AFFIRMATIVE claim to
 * have measured something ("we measured", "based on actual attendance") —
 * not the word "measured" itself, since the DVC note legitimately says a
 * points chart is NOT a measured wait time, and an earlier version of this
 * test failed on exactly that correct sentence.
 */
test("no basis note claims to have measured crowds, and every one hedges", () => {
  for (const id of Object.keys(CROWDS)) {
    const c = crowdFor(id, 6);
    assert.ok(c, `${id} has no June row`);
    assert.ok(
      !/\b(we |is |are )(measured|counted|based on actual)\b/i.test(c.basisNote),
      `${id} claims to have measured crowds`,
    );
    assert.ok(/forecast|estimate/i.test(c.basisNote), `${id} does not hedge`);
  }
});

/**
 * The owner's own case: domestic parks at peak over Thanksgiving while an
 * overseas park is a fine time to go. If this ever returns the six resorts in
 * board order the comparison says nothing.
 */
test("quietestThisMonth ranks the six resorts and puts the quietest first", () => {
  const ids = RESORTS.map((r) => r.id);
  const nov = quietestThisMonth(ids, 11);
  assert.equal(nov.length, ids.length);
  for (let i = 1; i < nov.length; i++) {
    assert.ok(nov[i - 1]!.rank <= nov[i]!.rank, "not sorted quietest-first");
  }
  assert.ok(nov[0]!.rank < nov[nov.length - 1]!.rank,
    "November should not be uniformly busy across all six resorts");
});

test("quietestMonths is stable and genuinely quietest-first", () => {
  const q = quietestMonths("wdw", 3);
  assert.equal(q.length, 3);
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1]!.rank <= q[i]!.rank);
  assert.deepEqual(quietestMonths("wdw", 3).map((x) => x.month), q.map((x) => x.month));
});

test("an unknown sensitivity from a client falls back to 'somewhat'", () => {
  assert.equal(parseCrowdSensitivity("high"), "high");
  assert.equal(parseCrowdSensitivity("none"), "none");
  assert.equal(parseCrowdSensitivity(undefined), "some");
  assert.equal(parseCrowdSensitivity("{}"), "some");
  assert.equal(parseCrowdSensitivity(7), "some");
});

/* -------------------------- real-date crowd windows ------------------------ */

test("December splits into a cheap first three weeks and an expensive Christmas week", () => {
  // The exact complaint that motivated windows: a monthly average calls all
  // of December "moderate", which is honest and still misleading -- 1-23 and
  // 24-31 are two different trips.
  const early = crowdFor("wdw", 12, 10);
  const christmas = crowdFor("wdw", 12, 26);
  assert.equal(early?.band, "low");
  assert.equal(christmas?.band, "peak");
  assert.ok((early?.rank ?? 0) < (christmas?.rank ?? 0));
  assert.equal(early?.datePrecise, true);
  assert.equal(christmas?.datePrecise, true);
});

test("Thanksgiving's real peak is the arrival days, not the weekend after", () => {
  const arriving = crowdFor("wdw", 11, 25); // Tue-ish, flying in for Thursday
  const weekendAfter = crowdFor("wdw", 11, 29); // the following weekend
  assert.equal(arriving?.band, "high");
  assert.equal(weekendAfter?.band, "moderate");
  assert.ok((arriving?.rank ?? 0) > (weekendAfter?.rank ?? 0));
});

test("without a day, WDW still returns its whole-month band unchanged", () => {
  // Every existing month-only caller (quietestMonths, a bare comparison) must
  // see exactly the old behaviour -- windows are additive, never a silent
  // change to what a 2-argument call returns.
  const decemberWholeMonth = crowdFor("wdw", 12);
  assert.equal(decemberWholeMonth?.band, "moderate");
  assert.equal(decemberWholeMonth?.datePrecise, false);
});

test("a resort with no windows defined is unaffected by passing a day", () => {
  const withDay = crowdFor("dlr", 6, 15);
  const withoutDay = crowdFor("dlr", 6);
  assert.equal(withDay?.band, withoutDay?.band);
  assert.equal(withDay?.datePrecise, false);
});

test("crowdFlag describes a date-precise match as \"for these dates\", not the whole month", () => {
  const flag = crowdFlag("wdw", 12, "high", 26);
  assert.ok(flag);
  assert.match(flag!.detail, /for these dates/);
  assert.doesNotMatch(flag!.detail, /typical here in December/);
});

test("an out-of-range day for a resort's windows falls back to the month band", () => {
  // day=32 never matches any real "MM-DD" window -- windowFor must return
  // null rather than throw or silently match the wrong thing.
  assert.doesNotThrow(() => crowdFor("wdw", 1, 32));
  const bogus = crowdFor("wdw", 1, 32);
  assert.equal(bogus?.datePrecise, false);
  assert.equal(bogus?.band, "veryLow"); // January's whole-month band
});
