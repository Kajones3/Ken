import { test } from "node:test";
import assert from "node:assert/strict";
import {
  thanksgivingDate, holidayWindowsFor, holidayFlightPremium,
  THANKSGIVING_PREMIUM_KEY, CHRISTMAS_PREMIUM_KEY,
} from "./holidayWindows.js";

test("Thanksgiving is the 4th Thursday of November, and moves by year", () => {
  // Real calendar facts, checkable against any calendar: Thanksgiving 2026 is
  // Nov 26; 2027 is Nov 25.
  assert.equal(thanksgivingDate(2026), "2026-11-26");
  assert.equal(thanksgivingDate(2027), "2027-11-25");
});

test("December always splits the same way, whatever the year", () => {
  const windows = holidayWindowsFor("2027-12");
  assert.deepEqual(windows.map((w) => w.id), ["before-christmas", "around-christmas"]);
  assert.deepEqual(windows[0], { id: "before-christmas", label: "Before Christmas (Dec 1–23)", from: "2027-12-01", to: "2027-12-23" });
  assert.deepEqual(windows[1], { id: "around-christmas", label: "Around Christmas (Dec 24–31)", from: "2027-12-24", to: "2027-12-31" });
});

test("November's Thanksgiving window tracks the real, moving date", () => {
  const windows2026 = holidayWindowsFor("2026-11");
  assert.equal(windows2026.length, 1);
  assert.equal(windows2026[0]!.id, "thanksgiving-week");
  // Tue before (24th) through Mon after (30th) — matches WDW's own real
  // crowd windows built earlier this project (Nov 24-26 arrival days, Nov
  // 27-30 the weekend after), so the two features agree on what week means.
  assert.equal(windows2026[0]!.from, "2026-11-24");
  assert.equal(windows2026[0]!.to, "2026-11-30");

  const windows2027 = holidayWindowsFor("2027-11");
  assert.equal(windows2027[0]!.from, "2027-11-23");
  assert.equal(windows2027[0]!.to, "2027-11-29");
});

test("every other month has no named window", () => {
  for (const m of ["2027-01", "2027-03", "2027-07", "2027-10"]) {
    assert.deepEqual(holidayWindowsFor(m), []);
  }
});

test("an unparseable month is a plain [], never a throw", () => {
  assert.deepEqual(holidayWindowsFor("garbage"), []);
  assert.deepEqual(holidayWindowsFor(""), []);
});

test("the flight premium follows the real date, not the search window", () => {
  assert.equal(holidayFlightPremium("2026-11-24")?.settingKey, THANKSGIVING_PREMIUM_KEY);
  assert.equal(holidayFlightPremium("2026-11-30")?.settingKey, THANKSGIVING_PREMIUM_KEY);
  assert.equal(holidayFlightPremium("2026-11-23"), null, "one day before the window");
  assert.equal(holidayFlightPremium("2026-12-01"), null, "one day after the window");

  assert.equal(holidayFlightPremium("2026-12-24")?.settingKey, CHRISTMAS_PREMIUM_KEY);
  assert.equal(holidayFlightPremium("2026-12-31")?.settingKey, CHRISTMAS_PREMIUM_KEY);
  assert.equal(holidayFlightPremium("2026-12-23"), null);

  assert.equal(holidayFlightPremium("2026-07-04"), null, "July 4th: real data says it doesn't move");
});

test("the premium tracks the year's own Thanksgiving, not a fixed calendar range", () => {
  // 2026's window is Nov 24-30; 2027's is Nov 23-29 (Thanksgiving moved a day
  // earlier). Nov 30 is the LAST day of 2026's window but ONE DAY PAST
  // 2027's -- if the code hardcoded a Nov 24-30 range instead of computing
  // Thanksgiving per year, this would wrongly return a match for 2027 too.
  assert.equal(holidayFlightPremium("2026-11-30")?.settingKey, THANKSGIVING_PREMIUM_KEY);
  assert.equal(holidayFlightPremium("2027-11-30"), null, "one day past 2027's own window");
});
