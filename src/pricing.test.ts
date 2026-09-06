import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { bandOf, cheapestIn, poolFor, priceTrip, resortById, type Overrides, type TripParams } from "./pricing.js";
import type { HotelNight } from "./pricing.js";

const START = "2027-03-01";

function night(id: string, name: string, nightly: number, tier: string, on: boolean): HotelNight {
  return { hotelId: id, name, descriptor: "", nightly, tier: tier as any, onProperty: on };
}

/** A book with everything a 2-night trip needs, for one resort. */
function fullBook(resortId: string, iata: string, opts: {
  fare?: number; nights?: HotelNight[]; days?: number; adult?: number; child?: number; junior?: number;
} = {}) {
  const days = opts.days ?? 6;
  const hotels = opts.nights ?? [
    night("v", "Value inn", 150, "value", true),
    night("m", "Moderate lodge", 300, "moderate", true),
    night("d", "Deluxe tower", 600, "deluxe", true),
    night("b", "Budget motel", 120, "budget", false),
  ];
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2027, 2, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  return bookFrom({
    flights: dates.map((date) => ({ dest: iata, date, row: { price: opts.fare ?? 400, stops: 0 } })),
    hotels: dates.flatMap((date) => hotels.map((n) => ({ resortId, date, night: n }))),
    tickets: dates.map((date) => ({
      resortId, date,
      row: { adult: opts.adult ?? 130, child: opts.child ?? 120, junior: opts.junior },
    })),
  });
}

const base: TripParams = {
  origin: "ATL", adults: 2, childAges: [12, 8, 2], nights: 4, parkDays: 3,
  stay: "on", tier: 1, food: "mix",
};

test("an 11-year-old: adult in the US parks, child everywhere else", () => {
  // Verified against each resort's published ticket pages.
  assert.equal(bandOf(resortById("wdw"), 11), "adult");   // US child tops out at 9
  assert.equal(bandOf(resortById("dlr"), 11), "adult");
  assert.equal(bandOf(resortById("dlp"), 11), "child");   // child runs 3-11
  assert.equal(bandOf(resortById("hkdl"), 11), "child");
  assert.equal(bandOf(resortById("shdr"), 11), "child");
  assert.equal(bandOf(resortById("tdr"), 11), "child");   // Tokyo child is 4-11
});

test("a 15-year-old: adult everywhere except Tokyo, where they are a Junior", () => {
  for (const id of ["wdw", "dlr", "dlp", "hkdl", "shdr"]) {
    assert.equal(bandOf(resortById(id), 15), "adult", id);
  }
  assert.equal(bandOf(resortById("tdr"), 15), "junior"); // adult starts at 18 in Tokyo alone
});

test("free admission ages differ too", () => {
  assert.equal(bandOf(resortById("wdw"), 2), "infant");
  assert.equal(bandOf(resortById("tdr"), 3), "infant");   // Tokyo is free under 4, not 3
  assert.equal(bandOf(resortById("wdw"), 3), "child");
});

test("under-3s pay no admission and no food", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const withToddler = priceTrip(book, wdw, base, {}, START);
  const without = priceTrip(book, wdw, { ...base, childAges: [12, 8] }, {}, START);
  assert.ok(withToddler.ok && without.ok);
  assert.equal(withToddler.price.tickets, without.price.tickets);
  assert.equal(withToddler.price.food, without.price.food);
  // but the toddler still occupies a seat, being over 2
  assert.ok(withToddler.price.flights > without.price.flights);
});

test("under-2s fly as lap infants at 10%", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 500 });
  const lap = priceTrip(book, wdw, { ...base, childAges: [1] }, {}, START);
  const seat = priceTrip(book, wdw, { ...base, childAges: [4] }, {}, START);
  assert.ok(lap.ok && seat.ok);
  assert.equal(Math.round(lap.price.flights), Math.round(500 * 2 + 50));
  assert.equal(Math.round(seat.price.flights), 1500);
});

test("a fare override can raise the price but never fall below the cached fare", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const under: Overrides = { wdw: { farePerSeat: 50 } };
  const over: Overrides = { wdw: { farePerSeat: 900 } };
  const a = priceTrip(book, wdw, base, under, START);
  const b = priceTrip(book, wdw, base, over, START);
  assert.ok(a.ok && b.ok);
  assert.equal(a.price.perSeatFare, 400, "clamped to the floor");
  assert.equal(b.price.perSeatFare, 900, "raised as asked");
});

test("a nightly override is used flat and does not flex", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, { wdw: { nightly: 150 } }, START);
  assert.ok(r.ok);
  assert.equal(r.price.rooms, 150 * base.nights);
  assert.equal(r.price.hotelTier.custom, true);
});

test("category falls back to the nearest available and says so", () => {
  const tdr = resortById("tdr");
  // Tokyo has value and deluxe on property, but no moderate.
  const book = fullBook("tdr", "NRT", {
    nights: [night("ch", "Celebration", 172, "value", true), night("mc", "MiraCosta", 640, "deluxe", true)],
  });
  const r = priceTrip(book, tdr, { ...base, tier: 1, stay: "on" }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.hotelTier.swapped, true);
  assert.notEqual(r.price.hotelTier.actual, 1);
});

test("off-property carries its parking and transfer cost", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const on = priceTrip(book, wdw, { ...base, stay: "on", tier: 0 }, {}, START);
  const off = priceTrip(book, wdw, { ...base, stay: "off", tier: 0 }, {}, START);
  assert.ok(on.ok && off.ok);
  assert.equal(on.price.transport, 0);
  assert.equal(off.price.transport, 35 * (base.nights + 1));
});

test("a dining plan forces an on-property stay", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, { ...base, food: "plan", stay: "both" }, {}, START);
  assert.ok(r.ok);
  assert.ok(r.price.foodPlan, "plan applied");
  assert.equal(r.price.hotelPick.onProperty, true);
});

test("resorts without a dining plan fall back to counter service", () => {
  const tdr = resortById("tdr");
  const book = fullBook("tdr", "NRT");
  const r = priceTrip(book, tdr, { ...base, food: "plan" }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.foodPlan, null);
  assert.ok(r.price.food > 0);
});

test("missing cache data never becomes NaN", () => {
  const wdw = resortById("wdw");
  const empty = bookFrom({});
  const r = priceTrip(empty, wdw, base, {}, START);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no cached fare/);
});

test("a gap mid-stay is refused rather than silently under-counted", () => {
  const wdw = resortById("wdw");
  // only two nights of hotel data for a four-night stay
  const book = fullBook("wdw", "MCO", { days: 2 });
  const r = priceTrip(book, wdw, base, {}, START);
  assert.equal(r.ok, false);
});

test("cheapestIn skips gaps instead of failing the whole search", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { days: 6 });
  const dates = ["2027-03-01", "2027-03-02", "2029-01-01"];
  const { best, priced, skipped } = cheapestIn(book, wdw, base, {}, dates);
  assert.ok(best);
  assert.equal(priced, 2);
  assert.equal(skipped.length, 1);
});

test("the total is the sum of its parts", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, {}, START);
  assert.ok(r.ok);
  const p = r.price;
  assert.equal(Math.round(p.total), Math.round(p.flights + p.tickets + p.hotel + p.food));
  assert.equal(Math.round(p.hotel), Math.round(p.rooms + p.transport));
});

test("the hotel pool respects the requested category, not just the cheapest bed", () => {
  const nights = [
    night("v", "Value inn", 150, "value", true),
    night("m", "Moderate lodge", 300, "moderate", true),
    night("d", "Deluxe tower", 600, "deluxe", true),
  ];
  const { pool, swapped } = poolFor(nights, "on", 1);
  assert.equal(swapped, false);
  assert.deepEqual(pool.map((h) => h.hotelId), ["m"], "moderate only — not the $150 value room");
});

test("off-property and on-property pools do not bleed into each other", () => {
  const nights = [
    night("v", "Value inn", 150, "value", true),
    night("b", "Budget motel", 90, "budget", false),
  ];
  assert.deepEqual(poolFor(nights, "on", 0).pool.map((h) => h.hotelId), ["v"]);
  assert.deepEqual(poolFor(nights, "off", 0).pool.map((h) => h.hotelId), ["b"]);
  assert.equal(poolFor(nights, "both", 0).pool.length, 2);
});
