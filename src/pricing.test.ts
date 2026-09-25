import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { bandOf, cheapestIn, ticketMultiDay, hopperPerTicket, poolFor, priceTrip, resortById, leanedFare, foodRate, DEFAULT_ESTIMATE_LEAN, ESTIMATE_LEAN_KEY, type Overrides, type TripParams } from "./pricing.js";
import type { HotelNight, PromoRow } from "./pricing.js";
import { newestMileageRateYear, MILEAGE_RATE_CARRY_FORWARD_YEARS, type FoodStyle } from "./config.js";

const START = "2027-03-01";

function night(id: string, name: string, nightly: number, tier: string, on: boolean): HotelNight {
  return { hotelId: id, name, descriptor: "", nightly, tier: tier as any, onProperty: on };
}

/** A book with everything a 2-night trip needs, for one resort. */
function fullBook(resortId: string, iata: string, opts: {
  fare?: number; nights?: HotelNight[]; days?: number; adult?: number; child?: number; junior?: number;
  origin?: string; promos?: PromoRow[];
  /** First cached date. Defaults to START; set it to price a trip in another year. */
  startISO?: string;
} = {}) {
  const days = opts.days ?? 6;
  const hotels = opts.nights ?? [
    night("v", "Value inn", 150, "value", true),
    night("m", "Moderate lodge", 300, "moderate", true),
    night("d", "Deluxe tower", 600, "deluxe", true),
    night("b", "Budget motel", 120, "budget", false),
  ];
  const first = new Date(`${opts.startISO ?? START}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(first.getTime() + i * 86_400_000);
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

test("a fare override stands even below the cached fare, and says that it is", () => {
  // This reverses an earlier decision, on the owner's instruction. The
  // override used to be raised up to the cheapest known fare, so typing $50
  // silently priced $400 and the box lied about what it had done. It now
  // holds, and fareBelowFloor is what the card warns on.
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const under: Overrides = { wdw: { farePerSeat: 50 } };
  const over: Overrides = { wdw: { farePerSeat: 900 } };
  const a = priceTrip(book, wdw, base, under, START);
  const b = priceTrip(book, wdw, base, over, START);
  assert.ok(a.ok && b.ok);
  assert.equal(a.price.perSeatFare, 50, "your number is your number");
  assert.deepEqual(a.price.fareBelowFloor, { yours: 50, cheapestKnown: 400 }, "and it is flagged");
  assert.equal(b.price.perSeatFare, 900, "raised as asked");
  assert.equal(b.price.fareBelowFloor, null, "nothing to warn about above the floor");
});

test("a negative fare override is floored at zero, not turned into a discount", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const r = priceTrip(book, wdw, base, { wdw: { farePerSeat: -500 } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 0);
  assert.ok(r.price.flights >= 0, "a trip can be cheap, never negative");
});

test("a food override is a whole-party daily total, so party size stops moving it", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const ov: Overrides = { wdw: { foodPerDayUsd: 250 } };
  const two = priceTrip(book, wdw, base, ov, START);
  const four = priceTrip(book, wdw, { ...base, adults: 4, childAges: [...base.childAges, 8, 5] }, ov, START);
  assert.ok(two.ok && four.ok);
  if (!two.ok || !four.ok) return;
  assert.equal(two.price.food, four.price.food,
    "a party total already contains whatever the party eats");
  // Part-days still apply: arrival and departure are not whole eating days.
  assert.equal(Math.round(two.price.food), Math.round(250 * (base.nights + 0.4)));
});

test("foodRate: the seven dining styles run cheapest to priciest in order", () => {
  // 2026-09-25 (owner's ask): seven real, discrete styles instead of four.
  // "someQs" and "someCharacter" are blends and must sit strictly between
  // their neighbors, not merely somewhere in the overall range.
  const wdw = resortById("wdw");
  const order: FoodStyle[] = ["grocery", "someQs", "qs", "mix", "ts", "someCharacter", "character"];
  const rates = order.map((s) => foodRate(wdw, s));
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i]! > rates[i - 1]!,
      `${order[i]} (${rates[i]}) should cost more than ${order[i - 1]} (${rates[i - 1]})`);
  }
});

test("foodRate: someQs and someCharacter are the midpoint of their neighbors", () => {
  const wdw = resortById("wdw");
  assert.equal(foodRate(wdw, "someQs"), (wdw.food.grocery + wdw.food.qs) / 2);
  assert.equal(foodRate(wdw, "someCharacter"), (wdw.food.ts + wdw.food.character) / 2);
});

test("foodRate: 'plan' falls back to counter service, same as the model always used", () => {
  const wdw = resortById("wdw");
  assert.equal(foodRate(wdw, "plan"), foodRate(wdw, "qs"));
});

test("a trip actually prices differently across all seven dining styles", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const styles: FoodStyle[] = ["grocery", "someQs", "qs", "mix", "ts", "someCharacter", "character"];
  const totals = styles.map((food) => {
    const r = priceTrip(book, wdw, { ...base, food }, {}, START);
    assert.ok(r.ok, `${food} should price`);
    return r.ok ? r.price.food : -1;
  });
  for (let i = 1; i < totals.length; i++) {
    assert.ok(totals[i]! > totals[i - 1]!, `${styles[i]} should cost more than ${styles[i - 1]}`);
  }
});

test("a food override loses to a dining plan, which is a real purchased product", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const withPlan = priceTrip(book, wdw, { ...base, food: "plan", stay: "on" },
    { wdw: { foodPerDayUsd: 1 } }, START);
  assert.ok(withPlan.ok);
  if (!withPlan.ok) return;
  assert.ok(withPlan.price.foodPlan, "the plan is what was bought");
  assert.ok(withPlan.price.food > 100, "a $1/day guess can't undercut a plan you've paid for");
});

test("excludeFlights: a completely empty book still prices, instead of hard-failing", () => {
  const wdw = resortById("wdw");
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const withoutFlights = { ...noFlights, flight: () => undefined, flightEstimate: () => undefined };
  const r = priceTrip(withoutFlights, wdw, base, { wdw: { excludeFlights: true } }, START);
  assert.ok(r.ok, "excluding flights must bypass the cache-gap hard failure");
  if (!r.ok) return;
  assert.equal(r.price.flights, 0);
  assert.equal(r.price.perSeatFare, 0);
  assert.equal(r.price.flightPick, null);
});

test("excludeFlights: bypasses the floor entirely, even with a real cached fare present", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const r = priceTrip(book, wdw, base, { wdw: { excludeFlights: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 0, "not a price claim, so the $400 floor never applies");
});

test("excludeFlights wins over a farePerSeat set on the same override", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const r = priceTrip(book, wdw, base, { wdw: { farePerSeat: 900, excludeFlights: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 0, "excludeFlights is ignored-farePerSeat, not the other way round");
});

test("excludeFlights: a farePerSeat below the cache still stands when flights are counted", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400 });
  const under: Overrides = { wdw: { farePerSeat: 50 } };
  const r = priceTrip(book, wdw, base, under, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 50, "your own number, same as any other non-excluded override");
});

test("excludeFlights behaves the same under miles transport mode", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 300 });
  const miles = { ...base, transportMode: "miles" as const, milesPct: 50 };
  const r = priceTrip(book, wdw, miles, { wdw: { excludeFlights: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 0);
  assert.equal(r.price.flights, 0);
});

test("excludeFlights is a no-op under driving mode (flights are already zero there)", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const driving = { ...base, transportMode: "drive" as const };
  const r = priceTrip(book, wdw, driving, { wdw: { excludeFlights: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.flights, 0);
  assert.equal(r.price.flightPick, null);
  assert.ok(r.price.driving > 0, "driving cost is unaffected by a flights-only exclude flag");
});

test("a nightly override is used flat and does not flex", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, { wdw: { nightly: 150 } }, START);
  assert.ok(r.ok);
  assert.equal(r.price.rooms, 150 * base.nights);
  assert.equal(r.price.hotelTier.custom, true);
});

test("excludeHotel: prices $0 hotel with no pick, same shape as stay: none", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, { wdw: { excludeHotel: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(base.stay, "on", "params.stay itself is untouched — this is a per-resort override");
  assert.equal(r.price.rooms, 0);
  assert.equal(r.price.transport, 0);
  assert.equal(r.price.hotel, 0);
  assert.equal(r.price.hotelPick.hotelId, "none");
});

test("excludeHotel skips a dining plan too, even though params.stay wants one", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, { ...base, stay: "on", food: "plan" }, { wdw: { excludeHotel: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.foodPlan, null);
});

test("excludeHotel suppresses a curated room promo, with its own skip reason", () => {
  const book = fullBook("wdw", "MCO", { promos: [promo({ effectKind: "room_pct_off", effectValue: 20 })] });
  const r = priceTrip(book, resortById("wdw"), base, { wdw: { excludeHotel: true, promoId: "p1" } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.rooms, 0);
  assert.equal(r.price.appliedPromos[0]!.amountUsd, 0);
  assert.match(r.price.appliedPromos[0]!.skipped ?? "", /not counting a hotel/);
});

test("excludeHotel wins over a nightly rate set on the same override", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, { wdw: { nightly: 150, excludeHotel: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.rooms, 0, "excludeHotel is ignored-nightly, not the other way round");
  assert.equal(r.price.hotelPick.hotelId, "none");
});

test("a per-resort excludeHotel does not leak into another resort's pricing", () => {
  const wdwBook = fullBook("wdw", "MCO");
  const dlrBook = fullBook("dlr", "SNA");
  const overrides: Overrides = { wdw: { excludeHotel: true } };
  const wdwResult = priceTrip(wdwBook, resortById("wdw"), base, overrides, START);
  const dlrResult = priceTrip(dlrBook, resortById("dlr"), base, overrides, START);
  assert.ok(wdwResult.ok && dlrResult.ok);
  assert.equal(wdwResult.price.hotelPick.hotelId, "none");
  assert.notEqual(dlrResult.price.hotelPick.hotelId, "none");
  assert.ok(dlrResult.price.rooms > 0);
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
  //
  // Relaxed to >= on 2026-09-23, when real published totals replaced the
  // guessed bases: both resorts are $149 for a one-day ticket at standard
  // mid-season, so they now tie. A tie is not the failure this guards
  // against — the failure was Disneyland priced ABOVE Walt Disney World,
  // which made an Orlando trip come back cheaper than Anaheim against a real
  // booking that said otherwise. That direction is still pinned.
  const wdw = resortById("wdw"), dlr = resortById("dlr");
  assert.ok(wdw.ticket.base >= dlr.ticket.base, "Disneyland must never be priced above WDW");
  // And the real one-day totals must agree with the bases they were taken
  // from, or the two halves of the ticket model are describing different
  // resorts.
  assert.equal(wdw.ticket.multiDayAdultUsd?.[0], wdw.ticket.base);
  assert.equal(dlr.ticket.multiDayAdultUsd?.[0], dlr.ticket.base);
});

test("a dining plan is only available on-property; off-property falls back to counter service", () => {
  // "Compare both" is gone (2026-09-25) — this used to test that stay:"both"
  // forced a dining plan onto an on-property room. With only "on"/"off"/
  // "none" left, planFor() itself already refuses a plan for "off"/"none";
  // this pins that off-property never quietly gets one.
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const on = priceTrip(book, wdw, { ...base, food: "plan", stay: "on" }, {}, START);
  assert.ok(on.ok);
  assert.ok(on.price.foodPlan, "plan applied on-property");
  assert.equal(on.price.hotelPick.onProperty, true);

  const off = priceTrip(book, wdw, { ...base, food: "plan", stay: "off" }, {}, START);
  assert.ok(off.ok);
  assert.equal(off.price.foodPlan, null, "no dining plan off-property");
  assert.equal(off.price.hotelPick.onProperty, false);
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

test("flight estimate: no exact cache hit falls back to a labeled BTS-baseline estimate", () => {
  const wdw = resortById("wdw");
  // Hotels/tickets present but no flight rows at all — book.flight() misses every date.
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const withoutFlights = { ...noFlights, flight: () => undefined };
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2025Q2" };
  const withEstimate = { ...withoutFlights, flightEstimate: () => estimate };
  const r = priceTrip(withEstimate, wdw, base, {}, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  // The shipped lean is 100, so the shown figure is this route's p75 — the
  // dear end of what people actually paid on it. The full low/med/high is
  // still attached, so the card can show the range it came from.
  assert.equal(r.price.perSeatFare, estimate.high);
  assert.deepEqual(r.price.flightPick, { price: estimate.high, estimate });
});

test("flight estimate: the lean is an owner setting, and dialling it back shows the median", () => {
  const wdw = resortById("wdw");
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2025Q2" };
  const withEstimate = {
    ...noFlights,
    flight: () => undefined,
    flightEstimate: () => estimate,
    setting: (key: string) => (key === ESTIMATE_LEAN_KEY ? 50 : undefined),
  };
  const r = priceTrip(withEstimate, wdw, base, {}, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, estimate.med, "a lean of 50 is the median");
});

test("flight estimate: with the lean hook absent, pricing still works and leans high", () => {
  // The safety property the whole settings registry rests on: an empty
  // table, or a book with no setting hook at all, must price exactly as the
  // app ships. Here that means the default lean, not a fare of zero.
  const wdw = resortById("wdw");
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2025Q2" };
  const noSettingHook = { ...noFlights, flight: () => undefined, flightEstimate: () => estimate };
  assert.equal((noSettingHook as { setting?: unknown }).setting, undefined);
  const r = priceTrip(noSettingHook, wdw, base, {}, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, estimate.high);
});

test("flight estimate: a Thanksgiving-week date gets the holiday premium, an ordinary date doesn't", () => {
  // 2027's Thanksgiving is Nov 25 (the 4th Thursday) -- see holidayWindows.test.ts.
  // Thanksgiving Day itself sits inside that window.
  const wdw = resortById("wdw");
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2027Q4" };
  const holidayBook = fullBook("wdw", "MCO", { days: 6, startISO: "2027-11-25" });
  const withEstimate = { ...holidayBook, flight: () => undefined, flightEstimate: () => estimate };
  const r = priceTrip(withEstimate, wdw, base, {}, "2027-11-25");
  assert.ok(r.ok);
  if (!r.ok) return;
  // Default lean is 100 (the dear end), so the shown figure is the HIGH band
  // -- but moved by the +55% default Thanksgiving premium first: 800 * 1.55.
  assert.equal(r.price.perSeatFare, 1240);
  assert.equal(r.price.flightPick?.estimate?.holidayPremiumPct, 55);
  assert.equal(r.price.flightPick?.estimate?.holidayLabel, "Thanksgiving travel week");

  // A date one day outside the window gets no premium at all -- same estimate, unmoved.
  const ordinaryBook = fullBook("wdw", "MCO", { days: 6, startISO: "2027-11-22" });
  const withOrdinary = { ...ordinaryBook, flight: () => undefined, flightEstimate: () => estimate };
  const r2 = priceTrip(withOrdinary, wdw, base, {}, "2027-11-22");
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.price.perSeatFare, 800);
  assert.equal(r2.price.flightPick?.estimate?.holidayPremiumPct, undefined);
});

test("flight estimate: the holiday premium never touches a REAL cached fare", () => {
  // A real per-date fare already reflects whatever the market actually
  // charges for Thanksgiving -- adding a synthetic premium on top of it
  // would double-count.
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400, days: 6, startISO: "2027-11-25" });
  const r = priceTrip(book, wdw, base, {}, "2027-11-25");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 400, "the real fare stands, unmoved");
  assert.equal(r.price.flightPick?.price, 400);
  assert.equal(r.price.flightPick?.estimate, undefined, "a real row carries no estimate at all");
});

test("flight estimate: the holiday premium is an owner setting", () => {
  const wdw = resortById("wdw");
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2026Q4" };
  const christmasBook = fullBook("wdw", "MCO", { days: 6, startISO: "2026-12-26" });
  const withSetting = {
    ...christmasBook, flight: () => undefined, flightEstimate: () => estimate,
    setting: (key: string) => (key === "flight.christmasPremiumPct" ? 10 : undefined),
  };
  const r = priceTrip(withSetting, wdw, base, {}, "2026-12-26");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 880, "800 x 1.10, the owner's own figure, not the shipped 58%");
  assert.equal(r.price.flightPick?.estimate?.holidayPremiumPct, 10);
});

test("flight estimate: a route with no BTS baseline still fails cleanly, not with a fabricated number", () => {
  const wdw = resortById("wdw");
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const withoutFlights = { ...noFlights, flight: () => undefined, flightEstimate: () => undefined };
  const r = priceTrip(withoutFlights, wdw, base, {}, START);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no cached fare/);
});

test("flight estimate: a real cached fare wins when it's at or above the route's own median", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 400, days: 6 });
  const lowEstimate = { ...book, flightEstimate: () => ({ low: 1, med: 2, high: 3, basisQuarter: "2020Q1" }) };
  const r = priceTrip(lowEstimate, wdw, base, {}, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.perSeatFare, 400);
  assert.equal(r.price.flightPick?.estimate, undefined);
});

test("flight estimate: the median wins and is shown as an estimate when it's HIGHER than a real cached fare", () => {
  // A real cached fare can itself be a deal-feed's cheapest-found number
  // (Travelpayouts' calendar endpoint), not a representative one -- if the
  // route's own honest median is higher, it corrects the shown price
  // upward rather than quietly keeping a fare that undersells reality.
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 90, days: 6 }); // a suspiciously cheap "real" fare
  const highEstimate = { ...book, flightEstimate: () => ({ low: 300, med: 450, high: 600, basisQuarter: "2027Q1" }) };
  const r = priceTrip(highEstimate, wdw, base, {}, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  // Which number wins is still decided on the MEDIAN — $450 beats the
  // suspicious $90, so the estimate is what gets shown. What then gets
  // DISPLAYED is the leaned figure, $600. Keeping those two decisions
  // separate matters: comparing the real row against the leaned figure
  // instead would start overriding genuine fares far more often, which is a
  // different change wearing this one's clothes.
  assert.equal(r.price.perSeatFare, 600, "the estimate wins over the real-but-unrepresentative $90 fare");
  assert.equal(r.price.flightPick?.price, 600);
  assert.ok(r.price.flightPick?.estimate, "shown honestly as an estimate, not passed off as the real $90 quote");
});

test("flight estimate: a farePerSeat override still floors against the real row's price, not the corrected median", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO", { fare: 90, days: 6 });
  const highEstimate = { ...book, flightEstimate: () => ({ low: 300, med: 450, high: 600, basisQuarter: "2027Q1" }) };
  const r = priceTrip(highEstimate, wdw, base, { wdw: { farePerSeat: 100 } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  // 100 is below the median-corrected 450 but above the real $90 finding, so
  // it stands and nothing is flagged. The floor that fareBelowFloor measures
  // against is still the real row's price, not the higher median it displays
  // as -- warning somebody off $100 because a BTS median says $450 would be
  // the estimate overruling the evidence.
  assert.equal(r.price.perSeatFare, 100);
  assert.equal(r.price.fareBelowFloor, null);
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

test("excludeHotel and excludeFlights together: total is tickets + food only", () => {
  const wdw = resortById("wdw");
  const book = fullBook("wdw", "MCO");
  const r = priceTrip(book, wdw, base, { wdw: { excludeHotel: true, excludeFlights: true } }, START);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.flights, 0);
  assert.equal(r.price.hotel, 0);
  assert.equal(Math.round(r.price.total), Math.round(r.price.tickets + r.price.food));
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
  // START = 2027-03-01, a Jan-Jun month -> the 0.725/mi rate (carried forward
  // from 2026, which is the newest year we have a published figure for).
  assert.ok(Math.abs(r.price.drivingPick!.wearAndTearUsd - miles * 0.725) < 1);
  assert.ok(Math.abs(r.price.driving - (r.price.drivingPick!.gasCostUsd + r.price.drivingPick!.wearAndTearUsd)) < 0.01);
});

test("the rate a trip was priced at carries the year it came from", () => {
  const book = fullBook("wdw", "MCO", { startISO: "2026-03-01" });
  const r = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, "2026-03-01");
  assert.ok(r.ok);
  const rate = r.price.drivingPick!.mileageRate!;
  assert.equal(rate.rateYear, 2026);
  assert.equal(rate.tripYear, 2026);
  assert.equal(rate.carriedForward, false, "2026 has a published rate — nothing is being reused");
  assert.equal(rate.ratePerMile, 0.725);
});

test("a trip in a year with no published rate still prices, flagged as carried forward", () => {
  const book = fullBook("wdw", "MCO");
  // START = 2027-03-01. The IRS has not published 2027, so this reuses 2026's
  // figure rather than refusing — the app books 365 days out, and refusing
  // would break every driving comparison from 1 January onward.
  const r = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  assert.ok(r.ok);
  const rate = r.price.drivingPick!.mileageRate!;
  assert.equal(rate.tripYear, 2027);
  assert.equal(rate.rateYear, 2026);
  assert.equal(rate.carriedForward, true, "reusing an older year's rate must never be silent");
});

test("a trip too far past the newest rate fails cleanly instead of guessing", () => {
  const tooFar = newestMileageRateYear() + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  // A book that fully covers those dates, so the mileage rate is the only
  // thing that can make this fail.
  const book = fullBook("wdw", "MCO", { startISO: `${tooFar}-03-01` });
  const r = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, `${tooFar}-03-01`);
  assert.equal(r.ok, false, "pricing on a rate that stale would be a real misstatement of cost");
  assert.ok(!r.ok && r.reason.includes("mileage rate"), `reason should name the cause: ${!r.ok && r.reason}`);
});

test("no wear and tear charged means a missing rate cannot block the trip", () => {
  const tooFar = newestMileageRateYear() + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  const book = fullBook("wdw", "MCO", { startISO: `${tooFar}-03-01` });
  // An explicit opt-out charges no wear and tear, so it has no business
  // failing over a rate it never uses.
  const r = priceTrip(
    book, resortById("wdw"), { ...base, transportMode: "drive", includeWearAndTear: false }, {}, `${tooFar}-03-01`,
  );
  assert.ok(r.ok, "should still price with wear-and-tear opted out");
  assert.equal(r.price.drivingPick!.wearAndTearUsd, 0);
  assert.equal(r.price.drivingPick!.mileageRate, null, "no rate was used, so none is reported");
});

test("includeWearAndTear: false drops wear and tear, prices gas only", () => {
  const book = fullBook("wdw", "MCO");
  const withWear = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  const gasOnly = priceTrip(
    book, resortById("wdw"), { ...base, transportMode: "drive", includeWearAndTear: false }, {}, START,
  );
  assert.ok(withWear.ok && gasOnly.ok);
  assert.equal(gasOnly.price.drivingPick!.wearAndTearUsd, 0);
  assert.equal(gasOnly.price.driving, gasOnly.price.drivingPick!.gasCostUsd);
  assert.ok(gasOnly.price.driving < withWear.price.driving, "dropping wear and tear must actually lower the total");
});

test("includeWearAndTear: unset behaves the same as true (default is to include it)", () => {
  const book = fullBook("wdw", "MCO");
  const unset = priceTrip(book, resortById("wdw"), { ...base, transportMode: "drive" }, {}, START);
  const explicitTrue = priceTrip(
    book, resortById("wdw"), { ...base, transportMode: "drive", includeWearAndTear: true }, {}, START,
  );
  assert.ok(unset.ok && explicitTrue.ok);
  assert.equal(unset.price.drivingPick!.wearAndTearUsd, explicitTrue.price.drivingPick!.wearAndTearUsd);
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

/* ------------------- leaning the estimate high ------------------------- */

test("leanedFare picks a point in the route's OWN observed range", () => {
  const est = { low: 200, med: 280, high: 360 };
  assert.equal(leanedFare(est, 0), 200, "0 is p25");
  assert.equal(leanedFare(est, 50), 280, "50 is the median exactly");
  assert.equal(leanedFare(est, 100), 360, "100 is p75");
  assert.equal(leanedFare(est, 25), 240, "halfway between p25 and the median");
  assert.equal(leanedFare(est, 75), 320, "halfway between the median and p75");
});

test("leanedFare lands ON the median at 50 even when the spread is lopsided", () => {
  // A straight line from low to high would miss the median entirely here,
  // and the median is the one point in the range that carries meaning.
  const lopsided = { low: 100, med: 120, high: 900 };
  assert.equal(leanedFare(lopsided, 50), 120);
});

test("leanedFare can never leave the observed range", () => {
  // The whole defence of this setting is that it chooses among real numbers
  // rather than inventing one. Out-of-range input must not break that.
  const est = { low: 200, med: 280, high: 360 };
  for (const lean of [-50, 0, 37, 50, 99, 100, 1000, NaN, Infinity]) {
    const v = leanedFare(est, lean);
    assert.ok(v >= 200 && v <= 360, `lean ${lean} produced ${v}, outside 200-360`);
  }
});

test("a garbled lean falls back to the default rather than to zero", () => {
  const est = { low: 200, med: 280, high: 360 };
  assert.equal(leanedFare(est, NaN), leanedFare(est, DEFAULT_ESTIMATE_LEAN));
});

test("the shipped default leans HIGH — the owner's call", () => {
  // Recorded as a test because it is a decision, not a default: showing $100
  // and landing on $200 is the failure this app exists to prevent, and the
  // reverse costs nobody a booking.
  assert.equal(DEFAULT_ESTIMATE_LEAN, 100);
  assert.equal(leanedFare({ low: 200, med: 280, high: 360 }, DEFAULT_ESTIMATE_LEAN), 360);
});

test("the fare on the card and the fare in the total are the same number", () => {
  // Found by a test, not by reading: the leaned figure went into the total
  // while flightPick kept the plain median, so a reader adding up the card
  // would have got a different answer from the board. Two places holding
  // the same number is how that happens, and this is the guard.
  const wdw = resortById("wdw");
  const noFlights = fullBook("wdw", "MCO", { days: 6 });
  const estimate = { low: 500, med: 650, high: 800, basisQuarter: "2025Q2" };
  for (const lean of [0, 25, 50, 75, 100]) {
    const b = {
      ...noFlights, flight: () => undefined, flightEstimate: () => estimate,
      setting: (key: string) => (key === ESTIMATE_LEAN_KEY ? lean : undefined),
    };
    const r = priceTrip(b, wdw, base, {}, START);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.price.flightPick?.price, r.price.perSeatFare,
      `lean ${lean}: card says ${r.price.flightPick?.price}, total priced ${r.price.perSeatFare}`);
  }
});

/**
 * The published multi-day tables. These exist because the straight-line
 * `slope`/`floor` curve could not describe either US resort: Walt Disney
 * World's marginal day drops from $140 (day three) to $35 (day five), and
 * Disneyland's two-day ticket costs MORE per day than its one-day.
 */
test("a multi-day ticket charges Disney's published total, not a fitted curve", () => {
  for (const id of ["wdw", "dlr"]) {
    const r = resortById(id);
    const totals = r.ticket.multiDayAdultUsd!;
    assert.ok(totals, `${id} should carry published totals`);
    for (let days = 1; days <= totals.length; days++) {
      // one day's gate price x days x the factor must reproduce the published
      // total, which is the entire claim this machinery makes.
      const got = r.ticket.base * days * ticketMultiDay(r, days);
      assert.ok(Math.abs(got - totals[days - 1]!) < 0.5,
        `${id} ${days}-day: priced ${got.toFixed(2)}, Disney publishes ${totals[days - 1]}`);
    }
  }
});

test("Disneyland's two-day ticket really is dearer per day, and is not clamped away", () => {
  const dlr = resortById("dlr");
  assert.ok(ticketMultiDay(dlr, 2) > 1,
    "clamping this to 1 would undercharge the most common Disneyland trip");
  assert.ok(ticketMultiDay(dlr, 5) < ticketMultiDay(dlr, 2));
});

test("past the end of the table the last marginal day is repeated", () => {
  const wdw = resortById("wdw");
  const totals = wdw.ticket.multiDayAdultUsd!;
  const lastMarginal = totals[totals.length - 1]! - totals[totals.length - 2]!;
  const n = totals.length;
  const eight = wdw.ticket.base * (n + 1) * ticketMultiDay(wdw, n + 1);
  assert.ok(Math.abs(eight - (totals[n - 1]! + lastMarginal)) < 0.5,
    "an extra day should cost what the last real extra day cost");
});

test("a resort with no published table still uses its curve", () => {
  const dlp = resortById("dlp");
  assert.equal(dlp.ticket.multiDayAdultUsd, undefined);
  assert.equal(ticketMultiDay(dlp, 4),
    Math.max(dlp.ticket.floor, 1 - dlp.ticket.slope * 3));
});

test("Park Hopper scales with ticket length where Disney publishes it", () => {
  const dlr = resortById("dlr");
  assert.equal(hopperPerTicket(dlr, 1, dlr.ticket.hopperAdultUsd), 70);
  assert.equal(hopperPerTicket(dlr, 5, dlr.ticket.hopperAdultUsd), 135);
  // Beyond the table, the longest published add-on stands rather than growing
  // forever — Disney's own hopper stops rising too.
  assert.equal(hopperPerTicket(dlr, 12, dlr.ticket.hopperAdultUsd), 135);
});

/**
 * Tokyo sells no Park Hopper — its 1-Day Passport admits you to one park,
 * named at purchase. The shipped +$38 was a guess at a product a traveller
 * cannot normally buy, which put money on the board nobody could spend.
 */
test("Tokyo charges no Park Hopper even when one is asked for", () => {
  const tdr = resortById("tdr");
  assert.equal(tdr.ticket.hopperAdultUsd, undefined);
  const book = fullBook("tdr", "NRT");
  const on = priceTrip(book, tdr, { ...base, hopper: true }, {}, START);
  const off = priceTrip(book, tdr, { ...base, hopper: false }, {}, START);
  assert.ok(on.ok && off.ok);
  if (!on.ok || !off.ok) return;
  assert.equal(on.price.hopperUsd, 0);
  assert.equal(on.price.total, off.price.total, "asking for a hopper must cost nothing here");
});
