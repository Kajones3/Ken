import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { typicalIn, resortById, type HotelNight, type TripParams } from "./pricing.js";
import { monthLevels, quoteMonths } from "./monthView.js";
import { monthBounds, range } from "./dates.js";

const NIGHT: HotelNight = { hotelId: "m", name: "Moderate lodge", descriptor: "", nightly: 100, tier: "moderate" as never, onProperty: true };

/** Two months of fares: March cheap, April dear, so the months differ only by flight. */
function twoMonthBook() {
  const days = [...range("2027-03-01", "2027-03-31"), ...range("2027-04-01", "2027-04-30")];
  const padded = [...days, "2027-05-01", "2027-05-02", "2027-05-03"];
  return bookFrom({
    flights: days.map((date, i) => ({ dest: "MCO", date,
      row: { price: (date < "2027-04" ? 200 : 400) + (i % 7) * 10, stops: 0, carrier: "Delta" } })),
    hotels: padded.map((date) => ({ resortId: "wdw", date, night: NIGHT })),
    tickets: padded.map((date) => ({ resortId: "wdw", date, row: { adult: 130, child: 120 } })),
    promos: [],
  });
}

const PARAMS: TripParams = {
  origin: "IAH", adults: 2, childAges: [], nights: 2, parkDays: 1,
  stay: "on", tier: 1, food: "mix", destination: "MCO",
};

test("each month's total is the number the board quotes for that month", () => {
  const book = twoMonthBook();
  const rows = quoteMonths(book, resortById("wdw"), PARAMS, {}, ["2027-03", "2027-04"]);
  for (const row of rows) {
    const [from, to] = monthBounds(row.month);
    const board = typicalIn(book, resortById("wdw"), PARAMS, {}, range(from, to));
    assert.equal(row.total, Math.round(board.typical!.total), row.month);
    assert.equal(row.cheapest, Math.round(board.cheapest!.total), row.month);
  }
  assert.ok(rows[0]!.total! < rows[1]!.total!, "March's cheap fares show as a cheaper month");
});

test("a month with nothing priced is a gap, not a zero", () => {
  const rows = quoteMonths(twoMonthBook(), resortById("wdw"), PARAMS, {}, ["2027-03", "2027-06"]);
  assert.equal(rows[1]!.total, null);
  assert.equal(rows[1]!.level, null);
  assert.equal(rows[0]!.level, "typical", "alone, March is its own middle");
});

test("levels are measured against the resort's own middle month, with a 5% band", () => {
  assert.deepEqual(monthLevels([1000, 1040, 960, 1200, 800, null]),
    ["typical", "typical", "typical", "pricier", "cheaper", null]);
  assert.deepEqual(monthLevels([null, null]), [null, null]);
});
