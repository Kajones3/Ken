import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { typicalIn, resortById, type HotelNight, type TripParams } from "./pricing.js";
import { bestMonthOf, crowdDots, monthLevels, quoteMonths } from "./monthView.js";
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

test("with 'the cheapest day' picked, each tile is the board's cheapest-day total", () => {
  // Owner, 2026-10-09: board Paris $8,412, June tile $9,170. The board
  // honored "Which day should we price?" and the tiles did not.
  const book = twoMonthBook();
  const rows = quoteMonths(book, resortById("wdw"), PARAMS, {}, ["2027-03", "2027-04"], undefined, "cheapest");
  for (const row of rows) {
    const [from, to] = monthBounds(row.month);
    const board = typicalIn(book, resortById("wdw"), PARAMS, {}, range(from, to));
    assert.equal(row.total, Math.round(board.cheapest!.total), row.month);
    assert.notEqual(row.total, Math.round(board.typical!.total), "the test book must tell the two apart");
  }
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

test("best time to go: the cheapest month, saving rounded down, only past $200 and 5%", () => {
  const q = (month: string, total: number | null) => ({ month, total, cheapest: total, level: null });
  const months = [q("2027-01", 7_920), q("2027-03", 9_550), q("2027-06", 9_100), q("2027-08", null)];
  assert.deepEqual(bestMonthOf(months, "2027-03"), { month: "2027-01", total: 7_920, saving: 1_600 });
  // The searched month is the cheapest: say so.
  assert.deepEqual(bestMonthOf(months, "2027-01"), { already: true });
  // Cheaper, but under 5% of the trip ($9,550 vs $9,100 is $450 < $477): not worth a line.
  assert.deepEqual(bestMonthOf([q("2027-03", 9_550), q("2027-06", 9_100)], "2027-03"), { already: true });
  // Under $200 on a small trip, even past 5%.
  assert.deepEqual(bestMonthOf([q("2027-03", 2_000), q("2027-06", 1_850)], "2027-03"), { already: true });
  // No price for the searched month: nothing honest to compare with.
  assert.equal(bestMonthOf(months, "2027-08"), null);
});

test("crowd dots: each resort against its own year, quietest month 1 dot, busiest 5", () => {
  const year = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, "0")}`);
  for (const id of ["wdw", "dlr", "dlp", "tdr", "shdr", "hkdl"]) {
    const dots = crowdDots(id, year);
    const shown = dots.filter((d) => d > 0);
    assert.ok(shown.length > 0, id);
    if (new Set(shown).size > 1) {
      assert.equal(Math.min(...shown), 1, `${id} quietest month gets one dot`);
      assert.equal(Math.max(...shown), 5, `${id} busiest month gets five`);
    }
  }
  // One month alone has nothing to compare with.
  assert.deepEqual(crowdDots("wdw", ["2027-03"]), [3]);
});
