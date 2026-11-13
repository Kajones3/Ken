import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { memoryDb } from "./db.js";
import { readAdventureDates } from "../public/screenshot-reader.js";
import { saveAdventureDepartures, listAdventures } from "./cruisesAdventures.js";

// Real OCR (Chromium + Tesseract, word positions) of the owner's Paris Escape
// "Rates & Dates" screenshot, 2026-11-14.
const words = JSON.parse(fs.readFileSync(new URL("./testdata/abd-dates-paris-2026-11.words.json", import.meta.url), "utf8"));

test("ABD Rates & Dates: every departure, child and adult in the right column, Adult Exclusive has no child price", () => {
  const r = readAdventureDates(words);
  assert.deepEqual(r.departures, [
    { start: "2027-06-01", end: "2027-06-03", adult: 2999, child: 2849, adultOnly: false },
    { start: "2027-06-15", end: "2027-06-17", adult: 3599, child: 3419, adultOnly: false },
    { start: "2027-06-29", end: "2027-07-01", adult: 2999, child: 2849, adultOnly: false },
    { start: "2027-09-07", end: "2027-09-09", adult: 2999, child: null, adultOnly: true },
    { start: "2027-09-21", end: "2027-09-23", adult: 3199, child: null, adultOnly: true },
  ]);
  assert.equal(r.childMaxAge, 11);
  assert.equal(r.adultMinAge, 12);
  assert.equal(r.occupancy, "double");
});

test("a single date (\"Pair this departure with the June 3, 2027 ... Cruise\") is never a departure", () => {
  const w = [{ text: "Pair", x0: 0, y0: 0, x1: 30, y1: 10 }, { text: "June", x0: 40, y0: 0, x1: 70, y1: 10 },
    { text: "3,", x0: 75, y0: 0, x1: 85, y1: 10 }, { text: "2027", x0: 90, y0: 0, x1: 120, y1: 10 }];
  assert.equal(readAdventureDates(w).departures.length, 0);
});

test("saving a Rates & Dates table: every row kept, a repeat the same day skipped, Adult Exclusive refuses a child price", async () => {
  const db = await memoryDb();
  const base = { tripName: "France: Paris Escape", currency: "USD", seenOn: "2026-11-14", days: 3, nights: 2, childMaxAge: 11 };
  const deps = [
    { ...base, departureDate: "2027-06-01", returnDate: "2027-06-03", price: 2999, childPrice: 2849 },
    { ...base, departureDate: "2027-09-07", returnDate: "2027-09-09", price: 2999, adultOnly: true },
  ];
  const r1 = await saveAdventureDepartures(db, deps, "2026-11-14");
  assert.deepEqual(r1, { ok: true, saved: 2, skipped: 0 });
  const r2 = await saveAdventureDepartures(db, deps, "2026-11-14");
  assert.deepEqual(r2, { ok: true, saved: 0, skipped: 2 });
  const rows = await listAdventures(db);
  assert.equal(rows.length, 2);
  const sep = rows.find((x) => x.departureDate === "2027-09-07")!;
  assert.equal(sep.adultOnly, true);
  assert.equal(sep.returnDate, "2027-09-09");
  assert.equal(sep.childMaxAge, 11);
  const bad = await saveAdventureDepartures(db, [{ ...deps[1]!, childPrice: 100 }], "2026-11-14");
  assert.equal(bad.ok, false);
  const noDate = await saveAdventureDepartures(db, [{ ...base, price: 2999 }], "2026-11-14");
  assert.equal(noDate.ok, false, "a departure needs its date");
});

// The owner's second Paris Rates & Dates screenshot (2026-11-13, a 2,000px
// wide crop): OCR split the prices ("$2 99 9", "$3,41 9"), so the adult column
// read empty and June 15's child price read $341.
test("ABD Rates & Dates: prices OCR split into pieces are put back together", () => {
  const w = JSON.parse(fs.readFileSync(new URL("./testdata/abd-dates-paris-2026-11-13-full.words.json", import.meta.url), "utf8"));
  assert.deepEqual(readAdventureDates(w).departures, [
    { start: "2027-06-01", end: "2027-06-03", adult: 2999, child: 2849, adultOnly: false },
    { start: "2027-06-15", end: "2027-06-17", adult: 3599, child: 3419, adultOnly: false },
    { start: "2027-06-29", end: "2027-07-01", adult: 2999, child: 2849, adultOnly: false },
    { start: "2027-09-07", end: "2027-09-09", adult: 2999, child: null, adultOnly: true },
    { start: "2027-09-21", end: "2027-09-23", adult: 3199, child: null, adultOnly: true },
  ]);
});

test("the trip page: dinner that wrapped to the next line, nights, the trip's name and place", async () => {
  const { readAdventure } = await import("../public/screenshot-reader.js");
  const a = readAdventure(fs.readFileSync(new URL("./testdata/abd-page-paris-2026-11-13.ocr.txt", import.meta.url), "utf8"));
  assert.equal(a.days, 3);
  assert.equal(a.nights, 2, "from the address bar's 2-night");
  assert.equal(a.price, 2999);
  assert.deepEqual([a.meals, a.breakfasts, a.lunches, a.dinners], [4, 2, 1, 1]);
  assert.deepEqual([a.minAge, a.suggestedAge, a.adultExclusiveAge], [5, 8, 18]);
  assert.equal(a.tripType, "Escape");
  assert.equal(a.name, "Paris Escape");
  assert.equal(a.destination, "Paris");
  assert.deepEqual(a.highlights, ["Saint-Germain Guided Food Tour", "Dinner at the Eiffel Tower", "The Louvre"]);
});
