import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import {
  typicalIn, cheapestIn, resortById, TYPICAL_TRIM_KEY, MIN_DATES_TO_TRIM,
  type HotelNight, type TripParams,
} from "./pricing.js";

/**
 * The owner's own October calendar, Houston to Orlando, as round-trip fares
 * per person by departure day. Kept verbatim rather than tidied: it is the
 * actual distribution the decision was made against, outliers and all.
 */
const OCTOBER = [
  347, 326, 353, 1049, 172, 198, 193, 381, 760, 320, 287, 1122, 222, 711, 222,
  630, 660, 153, 119, 615, 190, 705, 133, 112, 133, 126, 112, 159, 94, 267, 87,
];

const NIGHTS: HotelNight[] = [
  { hotelId: "m", name: "Moderate lodge", descriptor: "", nightly: 100, tier: "moderate" as never, onProperty: true },
];

/** One date per fare, so the trip total moves only with the fare. */
function octoberBook(fares: number[], setting?: (k: string) => number | undefined) {
  const dates = fares.map((_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  // The trip needs nights beyond the last departure, so pad the hotel/ticket
  // side past the end of the month.
  const padded = [...dates, "2026-11-01", "2026-11-02", "2026-11-03"];
  const book = bookFrom({
    flights: dates.map((date, i) => ({ dest: "MCO", date, row: { price: fares[i]!, stops: 0, carrier: "Delta" } })),
    hotels: padded.flatMap((date) => NIGHTS.map((n) => ({ resortId: "wdw", date, night: n }))),
    tickets: padded.map((date) => ({ resortId: "wdw", date, row: { adult: 130, child: 120 } })),
    promos: [],
  });
  return setting ? { ...book, setting } : book;
}

const PARAMS: TripParams = {
  origin: "IAH", adults: 1, childAges: [], nights: 2, parkDays: 1,
  stay: "on", tier: 1, food: "mix", destination: "MCO",
};

const dates = (n: number) => OCTOBER.slice(0, n).map((_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

test("the quoted day is not the cheapest day, and the cheapest is still returned", () => {
  const book = octoberBook(OCTOBER);
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, dates(OCTOBER.length) as never[]);
  assert.ok(r.typical && r.cheapest && r.spread);
  assert.ok(r.typical.total > r.cheapest.total,
    "quoting the cheapest day is the whole bug this exists to fix");
  // The old behavior, still available and still agreeing with itself.
  const old = cheapestIn(book, resortById("wdw"), PARAMS, {}, dates(OCTOBER.length) as never[]);
  assert.equal(old.best!.total, r.cheapest.total);
});

test("both tails are dropped, and the trimmed mean lands between median and mean", () => {
  const book = octoberBook(OCTOBER);
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, dates(OCTOBER.length) as never[])!;
  const s = r.spread!;
  assert.equal(s.priced, 31);
  assert.equal(s.trimmedPerTail, 3, "10% of 31 days is 3 from each end");
  // The fare is the only moving part, so the gap between totals is the gap
  // between fares: the trim must pull the quote DOWN from the raw mean
  // (which the $1,122 and $1,049 days inflate) and UP from the median.
  assert.ok(s.trimmedMean < s.mean, "the dear tail should have been dropped");
  const fareMean = OCTOBER.reduce((a, b) => a + b, 0) / OCTOBER.length;
  const sortedFares = [...OCTOBER].sort((a, b) => a - b);
  const fareMedian = sortedFares[15]!;
  const quotedFare = s.trimmedMean - (s.mean - fareMean);
  assert.ok(quotedFare > fareMedian,
    `the quote should sit above the median (${fareMedian}), not on it`);
});

test("the quoted day is a REAL day in the set, never an average of days", () => {
  const book = octoberBook(OCTOBER);
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, dates(OCTOBER.length) as never[]);
  // Every line must add up, which is only true if this is one real trip.
  const t = r.typical!;
  // The same arithmetic priceTrip itself does, so a quoted day that was an
  // average of several days would fail here rather than looking plausible.
  const sum = t.flights + t.tickets + t.hotel + t.food + t.driving;
  assert.ok(sum >= t.total - 0.5,
    "the quoted day's own lines must account for its own total");
  assert.ok(Math.abs(t.flights - t.flightPick!.price) < 0.5,
    "one traveler, so the flight line IS the quoted fare");
  assert.ok(OCTOBER.includes(Math.round(t.flightPick!.price)),
    "the quoted fare must be one of the month's real fares");
});

test("a trimmed outlier can never come back as the quoted day", () => {
  // A lopsided month: one absurd day, everything else tight together.
  const fares = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 5000];
  const book = octoberBook(fares);
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, dates(fares.length) as never[]);
  assert.notEqual(Math.round(r.typical!.flightPick!.price), 5000,
    "the dropped day must not be re-selected as nearest to the mean it inflated");
});

test("too few days to trim honestly are not trimmed at all", () => {
  const few = OCTOBER.slice(0, MIN_DATES_TO_TRIM - 1);
  const r = typicalIn(octoberBook(few), resortById("wdw"), PARAMS, {}, dates(few.length) as never[]);
  assert.equal(r.spread!.trimmedPerTail, 0);
  assert.equal(r.spread!.trimmedMean, r.spread!.mean);
});

test("the owner's trim setting is honored, and a silly one cannot empty the set", () => {
  const at0 = typicalIn(octoberBook(OCTOBER, () => 0), resortById("wdw"), PARAMS, {}, dates(31) as never[]);
  assert.equal(at0.spread!.trimmedPerTail, 0);
  assert.equal(at0.spread!.trimmedMean, at0.spread!.mean, "no trim means the plain average");

  const at40 = typicalIn(octoberBook(OCTOBER, () => 40), resortById("wdw"), PARAMS, {}, dates(31) as never[]);
  assert.equal(at40.spread!.trimmedPerTail, 12);
  assert.ok(at40.typical, "a heavy trim must still leave a day standing");

  // Past the cap. The guard that matters: never zero days left.
  const silly = typicalIn(octoberBook(OCTOBER, () => 999), resortById("wdw"), PARAMS, {}, dates(31) as never[]);
  assert.ok(silly.typical, "an out-of-range trim must degrade, not empty the month");
});

test("a single date prices exactly as it always did", () => {
  const book = octoberBook(OCTOBER);
  const one = ["2026-10-05"] as never[];
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, one);
  const old = cheapestIn(book, resortById("wdw"), PARAMS, {}, one);
  assert.equal(r.typical!.total, old.best!.total,
    "an exact-date search must be untouched by any of this");
  assert.equal(r.spread!.trimmedPerTail, 0);
});

test("a month with nothing cached returns nulls, never a fabricated quote", () => {
  const book = bookFrom({ flights: [], hotels: [], tickets: [], promos: [] });
  const r = typicalIn(book, resortById("wdw"), PARAMS, {}, dates(31) as never[]);
  assert.equal(r.typical, null);
  assert.equal(r.cheapest, null);
  assert.equal(r.spread, null);
  assert.ok(r.skipped.length > 0, "it should say why, not fail silently");
});
