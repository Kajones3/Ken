import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonOf, dowFactor, hotelSeasonFactor } from "./seasonality.js";
import { range } from "./dates.js";
import type { ISODate } from "./dates.js";

const RESORTS = ["wdw", "dlr", "tdr", "hkdl", "dlp", "shdr"];

/* --------- the whole safety property this calibration depends on --------- */

test("each resort's own season curve averages to ~1.0 across a full year", () => {
  // Owner-researched `config.ts` bases are pinned as the resort's typical
  // rate. If a resort's calibrated season curve doesn't average out to 1.0
  // across the year, every price silently drifts away from that researched
  // number -- the exact "www trap" shape CLAUDE.md warns about elsewhere.
  for (const resortId of RESORTS) {
    const days = range("2026-01-01" as ISODate, "2026-12-31" as ISODate);
    const avg = days.reduce((sum, d) => sum + seasonOf(resortId, d).m, 0) / days.length;
    assert.ok(Math.abs(avg - 1) < 0.02, `${resortId}: season average is ${avg}, expected ~1.0`);
  }
});

test("each resort's own day-of-week curve averages to ~1.0 across a week", () => {
  for (const resortId of RESORTS) {
    // a week starting on a Sunday so every weekday is hit exactly once
    const days = range("2026-02-01" as ISODate, "2026-02-07" as ISODate);
    const avg = days.reduce((sum, d) => sum + dowFactor(resortId, d), 0) / days.length;
    assert.ok(Math.abs(avg - 1) < 0.03, `${resortId}: day-of-week average is ${avg}, expected ~1.0`);
  }
});

/* ------------------------- the two real DOW shapes ------------------------ */

test("WDW and Disneyland: a mild curve that peaks Thu-Fri-Sat, not a big weekend jump", () => {
  for (const resortId of ["wdw", "dlr"]) {
    const sun = dowFactor(resortId, "2026-02-01" as ISODate);
    const mon = dowFactor(resortId, "2026-02-02" as ISODate);
    const fri = dowFactor(resortId, "2026-02-06" as ISODate);
    const sat = dowFactor(resortId, "2026-02-07" as ISODate);
    assert.ok(fri > mon && sat > mon, `${resortId}: weekend should beat Monday`);
    assert.ok(sat - mon < 0.15, `${resortId}: weekend premium should be mild, not sharp`);
    assert.ok(sun < fri, `${resortId}: Sunday is not a weekend-premium day at these resorts`);
  }
});

test("Tokyo, Hong Kong, Paris and Shanghai: a sharp Fri/Sat spike over flat weekdays", () => {
  for (const resortId of ["tdr", "hkdl", "dlp", "shdr"]) {
    const tue = dowFactor(resortId, "2026-02-03" as ISODate);
    const sat = dowFactor(resortId, "2026-02-07" as ISODate);
    assert.ok(sat - tue > 0.1, `${resortId}: Saturday should be a real spike over a weekday`);
  }
});

test("Shanghai's day-of-week curve is borrowed from Hong Kong, not its own", () => {
  for (const d of range("2026-01-01" as ISODate, "2026-01-07" as ISODate)) {
    assert.equal(dowFactor("shdr", d), dowFactor("hkdl", d));
  }
});

test("Shanghai's season curve is borrowed from Hong Kong, not its own", () => {
  // same multiplier, deliberately different label -- Shanghai's says "borrowed"
  for (const d of range("2026-01-01" as ISODate, "2026-12-31" as ISODate)) {
    assert.equal(seasonOf("shdr", d).m, seasonOf("hkdl", d).m);
  }
});

/* --------------------- specific, checkable calendar facts ------------------ */

test("WDW and Disneyland: Christmas/NYE week is among the most expensive of the year", () => {
  // WDW's real Animal Kingdom Villas chart ties Christmas/NYE with the
  // spring-break/Easter week (Mar 21-28) exactly -- both are real peak
  // periods, not a strict single winner, so this checks "top tier" rather
  // than "beats literally every other date."
  for (const resortId of ["wdw", "dlr"]) {
    const dec26 = seasonOf(resortId, "2026-12-26" as ISODate).m;
    const days = range("2026-01-01" as ISODate, "2026-12-31" as ISODate);
    const maxOverall = Math.max(...days.map((d) => seasonOf(resortId, d).m));
    const ordinaryMonth = seasonOf(resortId, "2026-06-15" as ISODate).m;
    assert.equal(dec26, maxOverall, `${resortId}: Dec 26 should be in the resort's own peak tier`);
    assert.ok(dec26 > ordinaryMonth * 1.2, `${resortId}: Christmas should clearly beat an ordinary month`);
  }
});

test("Disneyland: August is real-data cheapest, not a guessed value month", () => {
  const aug = seasonOf("dlr", "2026-08-05" as ISODate).m;
  const dec26 = seasonOf("dlr", "2026-12-26" as ISODate).m;
  assert.ok(aug < dec26);
  assert.ok(aug < 1, "August should sit below the resort's own annual average");
});

test("Hong Kong: real chart says summer is the peak, not a value season", () => {
  const july = seasonOf("hkdl", "2026-07-15" as ISODate).m;
  const september = seasonOf("hkdl", "2026-09-15" as ISODate).m;
  assert.ok(july > september, "Hong Kong's real Jul-Aug summer peak should beat its real Sept low");
});

test("Tokyo: the real Silver Week spike (Sept 19-23) beats the rest of September", () => {
  const spike = seasonOf("tdr", "2026-09-21" as ISODate).m;
  const restOfSept = seasonOf("tdr", "2026-09-10" as ISODate).m;
  assert.ok(spike > restOfSept);
});

test("Paris: the real chart's end-of-March ramp into spring break is a genuine peak", () => {
  const springBreak = seasonOf("dlp", "2027-04-01" as ISODate).m;
  const january = seasonOf("dlp", "2027-01-15" as ISODate).m;
  assert.ok(springBreak > january);
});

/* ---------------- the composed factor actually used by pricing ------------- */

test("hotelSeasonFactor composes season and day-of-week for the resort asked", () => {
  const date = "2026-08-07" as ISODate; // a Friday
  const expected = seasonOf("dlr", date).m * dowFactor("dlr", date);
  assert.equal(hotelSeasonFactor("dlr", date), expected);
});

test("an unknown resort id falls back to WDW's day-of-week curve rather than throwing", () => {
  assert.doesNotThrow(() => dowFactor("not-a-real-resort", "2026-06-01" as ISODate));
});
