import { test } from "node:test";
import assert from "node:assert/strict";
import { findAmounts, findDates, guessCategory, guessResort, findAirports, guessName } from "../public/screenshot-reader.js";

// Text shaped like what OCR hands back from real booking pages: line breaks
// in odd places, a ¥ read as Y, a stray flight number.
const HOTEL = `Disney Ambassador Hotel
Superior Room  2 Adults 1 Child
Check-in Thu, Dec 17  Check-out Tue, Dec 22  5 nights
Total  ¥371,500 (tax included)
Y74,300 per night`;

const FLIGHT = `RDU → NRT  Round trip · Economy
Dec 17, 2026 - Dec 22, 2026
Delta DL 1234 · 1 stop · 17 hr 25 min
$2,081 per person   Total $6,243`;

test("hotel page: both yen prices, and the dates without a year land on the coming December", () => {
  const a = findAmounts(HOTEL, "JPY");
  assert.deepEqual(a.map((x) => [x.amount, x.currency]), [[371500, "JPY"], [74300, "JPY"]],
    "the Y that OCR makes of ¥ is still yen; 2, 1 and 5 are counts, not prices");
  assert.deepEqual(findDates(HOTEL, "2026-09-27"), ["2026-12-17", "2026-12-22"]);
  assert.equal(guessCategory(HOTEL), "hotel");
  assert.equal(guessResort(HOTEL), "tdr");
});

test("flight page: the fares, not the flight number, the year or the hours", () => {
  const a = findAmounts(FLIGHT);
  assert.deepEqual(a.map((x) => [x.amount, x.currency]), [[2081, "USD"], [6243, "USD"]]);
  assert.deepEqual(findDates(FLIGHT, "2026-09-27"), ["2026-12-17", "2026-12-22"]);
  assert.equal(guessCategory(FLIGHT), "flight");
  assert.deepEqual(findAirports(FLIGHT), ["RDU"]);
});

test("¥ is the yuan at Shanghai, and written-out currencies are read", () => {
  assert.deepEqual(findAmounts("Standard ticket ¥659", "CNY").map((x) => x.currency), ["CNY"]);
  assert.deepEqual(findAmounts("1-Day Passport 10,900 yen").map((x) => [x.amount, x.currency]), [[10900, "JPY"]]);
  assert.deepEqual(findAmounts("General HK$790  Child HK$611").map((x) => [x.amount, x.currency]),
    [[790, "HKD"], [611, "HKD"]]);
  assert.deepEqual(findAmounts("USD2081").map((x) => [x.amount, x.currency]), [[2081, "USD"]]);
  assert.deepEqual(findAmounts("€129.50 per night").map((x) => [x.amount, x.currency]), [[129.5, "EUR"]]);
});

test("dates in the other shapes booking pages use", () => {
  assert.deepEqual(findDates("17 Dec 2026 – 22 Dec 2026"), ["2026-12-17", "2026-12-22"]);
  assert.deepEqual(findDates("12/17/2026 to 12/22/2026"), ["2026-12-17", "2026-12-22"]);
  assert.deepEqual(findDates("2026年12月17日"), ["2026-12-17"]);
  assert.deepEqual(findDates("March 3", "2026-09-27"), ["2027-03-03"], "a month already past this year is next year");
});

test("what real OCR produced from a booking screenshot: a missing space, a stray quote mark", () => {
  // Verbatim Tesseract output from a mock Disney Ambassador page (2026-09-27).
  const ocr = "Disney Ambassador Hotel\n\nTokyo Disney Resort - Maihama\n\n\u2018Superior Room - 2 Adults, 1 Child\n\nCheck-in: Thu, Dec 17,2026 Check-out: Tue, Dec 22, 2026\n5 nights\n\nTotal \u00a5371,500 (tax included)\n\n\u00a574,300 per night\n";
  assert.deepEqual(findDates(ocr, "2027-01-15"), ["2026-12-17", "2026-12-22"],
    "the year is read even with no space after the comma, not guessed from today");
  assert.deepEqual(findAmounts(ocr, "JPY").map((x) => [x.amount, x.currency, x.context]),
    [[371500, "JPY", "(tax included)"], [74300, "JPY", "per night"]]);
  assert.equal(guessName(ocr), "Disney Ambassador Hotel");
  assert.equal(guessResort(ocr), "tdr");
  assert.equal(guessCategory(ocr), "hotel");
});
