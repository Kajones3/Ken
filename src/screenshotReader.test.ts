import { test } from "node:test";
import assert from "node:assert/strict";
import { findAmounts, findDates, guessCategory, guessResort, findAirports, guessName, splitOffers, cleanLabel } from "../public/screenshot-reader.js";

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

/* ---------------- deals (the Deals page in /admin) ---------------- */
import { findPercents, guessDealKind, guessDealLabel, findDollarsOff } from "../public/screenshot-reader.js";

const WDW_OFFER = `Special Offers
Save up to 25% on Rooms at Select Disney Resort Hotels
Valid for most nights Feb 22 – Apr 30, 2026
Book by Jan 5, 2026. Limited availability.`;

test("a room offer: percent, kind, headline and dates", () => {
  assert.deepEqual(findPercents(WDW_OFFER), [25]);
  assert.equal(guessDealKind(WDW_OFFER), "room_pct_off");
  assert.equal(guessDealLabel(WDW_OFFER), "Save up to 25% on Rooms at Select Disney Resort Hotels");
  assert.deepEqual(findDates(WDW_OFFER, "2025-10-03").slice(0, 2), ["2026-02-22", "2026-04-30"]);
});

test("ticket, free dining and dollars-off offers", () => {
  assert.equal(guessDealKind("Save 20% on 3-day theme park tickets"), "ticket_pct_off");
  assert.equal(guessDealKind("Free Dining Plan with a room and ticket package"), "free_dining");
  assert.equal(guessDealKind("FREE Dining Plan for Kids (Ages 3 to 9) in 2026"), "kids_free_dining");
  assert.equal(guessDealKind("Save $300 off your stay of 4 nights or more"), "room_flat_off");
  assert.deepEqual(findDollarsOff("Save $300 off your stay. Rooms from $129."), [300]);
});

test("a headline that wrapped onto two lines is joined back up, but not into the dates", () => {
  assert.equal(guessDealLabel("Save up to 25% on Rooms at Select Disney\nResort Hotels\nValid Feb 22 - Apr 30, 2027"),
    "Save up to 25% on Rooms at Select Disney Resort Hotels");
});

// The owner's own daily screenshot of disneyworld.com's offers page
// (2026-10-03): three offers on one page. One form full of all three mixed
// together ("$250" headline, 25% from another offer, Sep 25 2027) was what
// prompted this.
const WDW_OFFERS = `Special Offers
3 Save Up to $250 Per Night on Select
4-Night, 4-Day Room-
and-Ticket Packages
For stays most nights Jan 3 to Jul 28, 2027
Location: Disney Resorts Collection
Offer Type: Room-and-Ticket Package
Learn More
Save Up to 25% on Rooms This Spring
For stays most nights Jan 3 to Apr 29, 2027
Location: Disney Resorts Collection
Learn More
Disney+ Perks Members: Save on Select
Packages This Holiday Season
Save up to 25% on rooms plus get a FREE Park
Hopper option with a 4-night, 4-day package.
For stays most nights Sept 25 to Dec 24, 2026
Offer Type: Room-and-Ticket Package
Learn More`;

test("an offers page splits into its offers, each with its own saving, dates and conditions", () => {
  for (const text of [WDW_OFFERS, WDW_OFFERS.replace(/Learn More\n?/g, "")]) {
    const o = splitOffers(text, "2026-10-03");
    assert.equal(o.length, 3);
    assert.deepEqual(o.map((x) => x.label), [
      "Save Up to $250 Per Night on Select 4-Night, 4-Day Room-and-Ticket Packages",
      "Save Up to 25% on Rooms This Spring",
      "Disney+ Perks Members: Save on Select Packages This Holiday Season",
    ]);
    assert.deepEqual(o.map((x) => [x.kind, x.value]), [["room_night_off", 250], ["room_pct_off", 25], ["room_pct_off", 25]]);
    assert.deepEqual(o.map((x) => [x.startsOn, x.endsOn]),
      [["2027-01-03", "2027-07-28"], ["2027-01-03", "2027-04-29"], ["2026-09-25", "2026-12-24"]]);
    assert.deepEqual(o.map((x) => x.minNights), [4, null, 4]);
    assert.ok(o.every((x) => x.resort === "wdw" && x.upTo));
    assert.match(o[2]!.conditions, /Disney\+ Perks members/);
    assert.match(o[2]!.conditions, /Park Hopper \(not counted/);
    assert.match(o[0]!.conditions, /package only/);
  }
});

test("a range names its year once: the first date takes it, even when already past", () => {
  // Read alone, "Sept 25" on Oct 3 2026 would be next year's.
  assert.deepEqual(findDates("Sept 25 to Dec 24, 2026", "2026-10-03"), ["2026-09-25", "2026-12-24"]);
  assert.deepEqual(findDates("Nov 15 – Jan 5, 2027", "2026-10-03"), ["2026-11-15", "2027-01-05"]);
  assert.deepEqual(findDates("Jan 3 – 29, 2027", "2026-10-03"), ["2027-01-03", "2027-01-29"]);
});

test("stray OCR marks come off a headline, real amounts stay", () => {
  assert.equal(cleanLabel("3 Save Up to $250"), "Save Up to $250");
  assert.equal(cleanLabel("• \"Save 20%"), "Save 20%");
  assert.equal(cleanLabel("25% Off Rooms"), "25% Off Rooms");
  assert.equal(cleanLabel("$300 off"), "$300 off");
});
