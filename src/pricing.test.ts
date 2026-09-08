import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { bandOf, cheapestIn, poolFor, priceTrip, resortById, type Overrides, type TripParams } from "./pricing.js";
import type { HotelNight, PromoRow } from "./pricing.js";

const START = "2027-03-01";

function night(id: string, name: string, nightly: number, tier: string, on: boolean): HotelNight {
  return { hotelId: id, name, descriptor: "", nightly, tier: tier as any, onProperty: on };
}

/** A book with everything a 2-night trip needs, for one resort. */
function fullBook(resortId: string, iata: string, opts: {
  fare?: number; nights?: HotelNight[]; days?: number; adult?: number; child?: number; junior?: number;
  origin?: string; promos?: PromoRow[];
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
    promos: opts.promos ?? [],
  });
}

function promo(over: Partial<PromoRow> = {}): PromoRow {
  return {
    id: "p1", resortId: "wdw", label: "Summer room discount",
    effectKind: "room_pct_off", effectValue: 20,
    startsOn: "2027-01-01", endsOn: "2027-12-31", historical: true, sourceNote: "",
    ...over,
  };
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

test("stay: none prices $0 hotel with no pick, not a failed trip", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, { ...base, stay: "none" }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.rooms, 0);
  assert.equal(r.price.transport, 0);
  assert.equal(r.price.hotel, 0);
  assert.equal(r.price.hotelPick.hotelId, "none");
});

test("stay: none skips a dining plan too, same as an off-property stay", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, { ...base, stay: "none", food: "plan" }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.foodPlan, null);
});

test("park hopper adds a flat per-ticket amount, only where configured", () => {
  const wdw = resortById("wdw");
  const shdr = resortById("shdr"); // one park, no hopper product
  const wdwBook = fullBook("wdw", "MCO");
  const shdrBook = fullBook("shdr", "PVG");
  const without = priceTrip(wdwBook, wdw, base, {}, START);
  const withHopper = priceTrip(wdwBook, wdw, { ...base, hopper: true }, {}, START);
  assert.ok(without.ok && withHopper.ok);
  assert.ok(withHopper.price.hopperUsd > 0);
  assert.equal(Math.round((withHopper.price.tickets - without.price.tickets) * 100), Math.round(withHopper.price.hopperUsd * 100));

  const shdrHopper = priceTrip(shdrBook, shdr, { ...base, hopper: true }, {}, START);
  assert.ok(shdrHopper.ok);
  assert.equal(shdrHopper.price.hopperUsd, 0, "Shanghai has one park — hopper is silently a no-op");
});

test("ticket base no longer inverts WDW vs. Disneyland at the off-peak floor", () => {
  // Regression: base constants used to have Disneyland (148) priced above
  // WDW (132) at every date, which put a WDW trip cheaper than Disneyland's
  // even in Disneyland's own off-peak season — backwards from published
  // 2026 pricing where WDW's low end ($119) sits above Disneyland's ($104).
  const wdw = resortById("wdw"), dlr = resortById("dlr");
  assert.ok(wdw.ticket.base > dlr.ticket.base, "WDW's base should sit above Disneyland's, not below");
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

test("promos: a curated room discount applies to the cache-derived rate", () => {
  const book = fullBook("wdw", "MCO", { promos: [promo({ effectKind: "room_pct_off", effectValue: 20 })] });
  const withoutPromo = priceTrip(book, resortById("wdw"), base, {}, START);
  const withPromo = priceTrip(book, resortById("wdw"), base, { wdw: { promoId: "p1" } }, START);
  assert.ok(withoutPromo.ok && withPromo.ok);
  assert.equal(withPromo.price.rooms, withoutPromo.price.rooms * 0.8);
  assert.equal(withPromo.price.appliedPromos.length, 1);
  assert.equal(withPromo.price.appliedPromos[0]!.amountUsd, withoutPromo.price.rooms * 0.2);
  assert.ok(withPromo.price.total < withoutPromo.price.total);
});

test("promos: a curated room discount is suppressed once you've typed your own nightly rate", () => {
  const book = fullBook("wdw", "MCO", { promos: [promo({ effectKind: "room_flat_off", effectValue: 50 })] });
  const r = priceTrip(book, resortById("wdw"), base, { wdw: { nightly: 150, promoId: "p1" } }, START);
  assert.ok(r.ok);
  assert.equal(r.price.rooms, 150 * base.nights, "your own rate is not second-guessed by a curated guess");
  assert.equal(r.price.appliedPromos[0]!.amountUsd, 0);
  assert.match(r.price.appliedPromos[0]!.skipped ?? "", /own nightly rate/);
});

test("promos: a ticket discount applies regardless of any hotel override", () => {
  const book = fullBook("wdw", "MCO", { promos: [promo({ effectKind: "ticket_pct_off", effectValue: 10 })] });
  const without = priceTrip(book, resortById("wdw"), base, { wdw: { nightly: 150 } }, START);
  const withPromo = priceTrip(book, resortById("wdw"), base, { wdw: { nightly: 150, promoId: "p1" } }, START);
  assert.ok(without.ok && withPromo.ok);
  assert.equal(Math.round(withPromo.price.tickets * 100), Math.round(without.price.tickets * 0.9 * 100));
});

test("promos: free dining only has an effect when a plan actually resolved", () => {
  const book = fullBook("wdw", "MCO", { promos: [promo({ effectKind: "free_dining", effectValue: 0 })] });
  const noPlan = priceTrip(book, resortById("wdw"), { ...base, food: "mix" }, { wdw: { promoId: "p1" } }, START);
  assert.ok(noPlan.ok);
  assert.equal(noPlan.price.appliedPromos[0]!.amountUsd, 0);
  assert.match(noPlan.price.appliedPromos[0]!.skipped ?? "", /no dining plan/);

  const withPlan = priceTrip(book, resortById("wdw"), { ...base, food: "plan", stay: "on" }, { wdw: { promoId: "p1" } }, START);
  assert.ok(withPlan.ok);
  assert.equal(withPlan.price.food, 0, "free dining zeroes out the food total");
  assert.ok(withPlan.price.appliedPromos[0]!.amountUsd > 0);
});

test("promos: a personal discount stacks on top of your own nightly rate", () => {
  const book = fullBook("wdw", "MCO");
  const overrides: Overrides = { wdw: { nightly: 200, personalPromo: { kind: "room_pct_off", value: 15, label: "DVC member" } } };
  const r = priceTrip(book, resortById("wdw"), base, overrides, START);
  assert.ok(r.ok);
  assert.equal(r.price.rooms, 200 * base.nights * 0.85);
  assert.equal(r.price.appliedPromos[0]!.source, "personal");
});

test("promos: flat-off-total is clamped so the trip never prices negative", () => {
  const book = fullBook("wdw", "MCO");
  const overrides: Overrides = { wdw: { personalPromo: { kind: "flat_off_total", value: 999999, label: "Huge discount" } } };
  const r = priceTrip(book, resortById("wdw"), base, overrides, START);
  assert.ok(r.ok);
  assert.equal(r.price.total, 0);
});

test("promos: an unknown promoId is ignored, not a hard failure", () => {
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, resortById("wdw"), base, { wdw: { promoId: "does-not-exist" } }, START);
  assert.ok(r.ok);
  assert.equal(r.price.appliedPromos.length, 0);
});

test("destination: defaults to the resort's primary airport when unset", () => {
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const r = priceTrip(book, resortById("wdw"), base, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.destination, "MCO");
});

test("destination: an alternate airport prices against its own cached fare", () => {
  const dates = ["2027-03-01", "2027-03-02", "2027-03-03", "2027-03-04", "2027-03-05", "2027-03-06"];
  const book = bookFrom({
    flights: [
      ...dates.map((date) => ({ dest: "MCO", date, row: { price: 300, stops: 0 } })),
      ...dates.map((date) => ({ dest: "TPA", date, row: { price: 150, stops: 1 } })),
    ],
    hotels: dates.flatMap((date) => [{ resortId: "wdw", date, night: { hotelId: "v", name: "Value inn", descriptor: "", nightly: 150, tier: "value" as any, onProperty: true } }]),
    tickets: dates.map((date) => ({ resortId: "wdw", date, row: { adult: 130, child: 120 } })),
  });
  const flying = { ...base, destination: "TPA" };
  const r = priceTrip(book, resortById("wdw"), flying, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.destination, "TPA");
  assert.equal(r.price.flightPick!.price, 150);
  assert.equal(r.price.flightPick!.stops, 1);
});

test("destination: a gap for the requested airport fails clearly, naming that airport", () => {
  const book = fullBook("wdw", "MCO"); // only MCO cached, not TPA
  const flying = { ...base, destination: "TPA" };
  const r = priceTrip(book, resortById("wdw"), flying, {}, START);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /TPA/);
});

test("transport mode: driving replaces flights entirely, using the cached gas price", () => {
  const book = fullBook("wdw", "MCO");
  const driving = { ...base, transportMode: "drive" as const };
  const r = priceTrip(book, resortById("wdw"), driving, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.flights, 0);
  assert.equal(r.price.flightPick, null);
  assert.equal(r.price.transportMode, "drive");
  assert.ok(r.price.driving > 0, "driving should be a real positive cost");
  assert.equal(r.price.drivingPick!.from, "ATL");
  assert.ok(r.price.drivingPick!.roundTripMiles > 0);
});

test("transport mode: a geocoded originPoint bypasses the fixed ORIGINS list", () => {
  const book = fullBook("wdw", "MCO");
  // Not a real ORIGINS entry — proves origin alone isn't what's used when originPoint is set.
  const driving = {
    ...base, origin: "ZZZ", transportMode: "drive" as const,
    originPoint: { label: "Chattanooga, Tennessee", lat: 35.05, lon: -85.31 },
  };
  const r = priceTrip(book, resortById("wdw"), driving, {}, START);
  assert.ok(r.ok, "originPoint should let an unrecognized origin code still price");
  assert.equal(r.price.drivingPick!.from, "Chattanooga, Tennessee");
  assert.ok(r.price.drivingPick!.roundTripMiles > 0);
});

test("transport mode: driving falls back to the configured guess when no gas price is cached", () => {
  const bookNoGas = fullBook("wdw", "MCO"); // fullBook doesn't set gasPrice
  const driving = { ...base, transportMode: "drive" as const };
  const r = priceTrip(bookNoGas, resortById("wdw"), driving, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.drivingPick!.gasPricePerGallonUsd, 3.15); // DRIVING.fallbackGasPriceUsd
});

test("transport mode: an overnight stop adds nights times cost per night, nothing more", () => {
  const book = fullBook("wdw", "MCO");
  const noStop = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  const withStop = priceTrip(
    book, resortById("wdw"),
    { ...base, transportMode: "drive", overnightStop: { label: "Jacksonville", nights: 2, costPerNightUsd: 95 } },
    {}, START,
  );
  assert.ok(noStop.ok && withStop.ok);
  // Both sides also carry the same wear-and-tear term, rounded independently
  // on each side — compare within a cent rather than asserting bit-exact equality.
  assert.ok(Math.abs(withStop.price.driving - noStop.price.driving - 190) < 0.01);
});

test("transport mode: driving includes wear and tear at the IRS mileage rate", () => {
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  assert.ok(r.ok);
  const miles = r.price.drivingPick!.roundTripMiles; // rounded for display, so allow slack below
  // START = 2027-03-01, a Jan-Jun month -> the 0.725/mi rate.
  assert.ok(Math.abs(r.price.drivingPick!.wearAndTearUsd - miles * 0.725) < 1);
  assert.ok(Math.abs(r.price.driving - (r.price.drivingPick!.gasCostUsd + r.price.drivingPick!.wearAndTearUsd)) < 0.01);
});

test("rental car: renting instead of driving your own car zeroes wear and tear", () => {
  const book = fullBook("wdw", "MCO");
  const owned = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  const rented = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive", rentalCar: true }, {}, START);
  assert.ok(owned.ok && rented.ok);
  assert.ok(owned.price.drivingPick!.wearAndTearUsd > 0, "owning a car wears it out");
  assert.equal(rented.price.drivingPick!.wearAndTearUsd, 0, "a rental has no wear-and-tear cost to the user");
  assert.ok(rented.price.rentalCarUsd > 0);
});

test("rental car: same formula whether flying or driving, always its own line", () => {
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const flyingRented = priceTrip(book, resortById("wdw"), { ...base, rentalCar: true }, {}, START);
  const drivingRented = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive", rentalCar: true }, {}, START);
  assert.ok(flyingRented.ok && drivingRented.ok);
  assert.equal(flyingRented.price.rentalCarUsd, drivingRented.price.rentalCarUsd);
  assert.equal(flyingRented.price.rentalCarUsd, 65 * (base.nights + 1));
  assert.equal(flyingRented.price.rentalCarPick?.dailyRateUsd, 65);
  // Flying + rental: the rental is on top of the flight total.
  const flyingNoRental = priceTrip(book, resortById("wdw"), { ...base }, {}, START);
  assert.ok(flyingNoRental.ok);
  assert.ok(Math.abs(flyingRented.price.total - flyingNoRental.price.total - flyingRented.price.rentalCarUsd) < 0.01);
});

test("rental car: not renting means no rental line at all", () => {
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.rentalCarUsd, 0);
  assert.equal(r.price.rentalCarPick, null);
});

test("transport mode: driving from an unrecognized starting city fails, doesn't guess", () => {
  const book = fullBook("wdw", "MCO");
  const driving = { ...base, origin: "ZZZ", transportMode: "drive" as const };
  const r = priceTrip(book, resortById("wdw"), driving, {}, START);
  assert.equal(r.ok, false);
});

test("transport mode: driving to an overseas resort fails cleanly, not with an absurd number", () => {
  // Regression: driving mode had no region check, so "driving" from Atlanta
  // to Shanghai priced a real-looking $2,473 "gas cost" for crossing an ocean.
  const book = fullBook("shdr", "PVG");
  const driving = { ...base, transportMode: "drive" as const };
  const r = priceTrip(book, resortById("shdr"), driving, {}, START);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /driving/i);
});

test("transport mode: flying with miles discounts the cached fare, no floor", () => {
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const miles = { ...base, transportMode: "miles" as const, milesPct: 50 };
  const r = priceTrip(book, resortById("wdw"), miles, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.perSeatFare, 150);
});

test("transport mode: flying with 100% miles prices the seat free, below the cash floor", () => {
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const miles = { ...base, transportMode: "miles" as const, milesPct: 100 };
  const r = priceTrip(book, resortById("wdw"), miles, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.perSeatFare, 0);
});

test("transport mode: plain flying ignores a stray milesPct — no accidental discount", () => {
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const r = priceTrip(book, resortById("wdw"), { ...base, milesPct: 90 }, {}, START);
  assert.ok(r.ok);
  assert.equal(r.price.perSeatFare, 300);
});
