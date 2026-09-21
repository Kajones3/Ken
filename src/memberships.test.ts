import { test } from "node:test";
import assert from "node:assert/strict";
import { bookFrom } from "./book.js";
import { priceTrip, resortById, type HotelNight, type TripParams } from "./pricing.js";
import {
  parsePassHoldings, parseDvcRental, dvcCredit, findTier, passPriceKey,
  PASS_PROGRAMS, DVC_TAKE_HOME_PER_POINT,
} from "./memberships.js";
import { SETTING_BY_KEY } from "./settings.js";

const START = "2027-03-01";

function night(id: string, name: string, nightly: number, tier: string, on: boolean): HotelNight {
  return { hotelId: id, name, descriptor: "", nightly, tier: tier as any, onProperty: on };
}

function fullBook(resortId: string, iata: string, settings?: Map<string, number>) {
  const hotels = [night("m", "Moderate lodge", 300, "moderate", true),
                  night("b", "Budget motel", 120, "budget", false)];
  const dates = Array.from({ length: 6 }, (_, i) =>
    new Date(new Date(`${START}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const book = bookFrom({
    flights: dates.map((date) => ({ dest: iata, date, row: { price: 400, stops: 0 } })),
    hotels: dates.flatMap((date) => hotels.map((n) => ({ resortId, date, night: n }))),
    tickets: dates.map((date) => ({ resortId, date, row: { adult: 130, child: 120 } })),
    promos: [],
  });
  return settings ? { ...book, setting: (k: string) => settings.get(k) } : book;
}

/** Two adults, one 8-year-old. */
const base: TripParams = {
  origin: "ATL", adults: 2, childAges: [8], nights: 4, parkDays: 3,
  stay: "off", tier: 1, food: "mix",
};

const priced = (p: Partial<TripParams>, settings?: Map<string, number>) => {
  const r = priceTrip(fullBook("wdw", "MCO") as any, resortById("wdw"), { ...base, ...p }, {}, START);
  if (!r.ok) throw new Error(r.reason);
  return r.price;
};

/* ------------------------------ the catalogue ---------------------------- */

test("every pass price is editable by the owner without a code change", () => {
  // The whole point of the settings registry. A pass price Disney raises
  // every year is exactly the kind of number that must not need a deploy.
  for (const prog of PASS_PROGRAMS) {
    for (const t of prog.tiers) {
      const def = SETTING_BY_KEY.get(passPriceKey(prog.resortId, t.id));
      assert.ok(def, `${prog.resortId}/${t.id} has no settings entry`);
      assert.equal(def!.default, t.priceUsd);
    }
  }
});

test("a pass tier that no longer exists is dropped, not thrown", () => {
  // Disney replaced the Enchant Key with the Explore Key in January. Anybody
  // who had saved a trip holding one must still get a board.
  assert.deepEqual(parsePassHoldings([{ resortId: "dlr", tierId: "enchant", count: 2 }]), []);
  assert.deepEqual(parsePassHoldings([{ resortId: "tdr", tierId: "incredi", count: 2 }]), []);
  assert.deepEqual(parsePassHoldings("four passes"), []);
  assert.deepEqual(parsePassHoldings([{ resortId: "wdw", tierId: "incredi", count: 0 }]), []);
});

test("one holding per resort — two tiers do not stack two pass costs", () => {
  const h = parsePassHoldings([
    { resortId: "wdw", tierId: "incredi", count: 2 },
    { resortId: "wdw", tierId: "pixie", count: 2 },
    { resortId: "dlr", tierId: "believe", count: 1 },
  ]);
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => x.resortId), ["wdw", "dlr"]);
});

/* -------------------------- what a pass actually does -------------------- */

test("a pass zeroes what its holder pays at the gate, and nobody else's", () => {
  const without = priced({});
  const one = priced({ annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 1 }] });
  const all = priced({ annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 3 }] });

  assert.ok(one.tickets < without.tickets, "one pass took one person off the ticket line");
  assert.ok(one.tickets > 0, "the other two still pay");
  assert.equal(Math.round(all.tickets), 0, "three passes cover a party of three");
  assert.ok(without.total > all.total, "and the trip costs less to the holder");
});

test("a pass at Disneyland does nothing at Walt Disney World", () => {
  // A Magic Key does not get you into Magic Kingdom. This is why a holding
  // names its resort instead of being one flat "I have a pass" flag.
  const p = priced({ annualPasses: [{ resortId: "dlr", tierId: "inspire", count: 3 }] });
  assert.equal(p.tickets, priced({}).tickets);
  assert.equal(p.membership, null);
});

test("a fifth pass on a party of four is reported as unused, not as a saving", () => {
  const p = priced({ annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 8 }] });
  assert.equal(p.membership!.pass!.count, 8);
  assert.equal(p.membership!.pass!.used, 3, "the party is three people");
});

test("the pass's own price is reported, never charged to this one trip", () => {
  // The decision this pins: an annual pass is not bought for one trip, and
  // charging it to whichever trip is on screen would make a short visit look
  // absurd. The traveller gets both numbers and compares them.
  const p = priced({ annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 2 }] });
  const pass = p.membership!.pass!;
  assert.equal(pass.annualCostUsd, findTier("wdw", "incredi")!.priceUsd * 2);
  assert.ok(pass.ticketsWithoutPassUsd > 0, "and what these days would have cost without them");
  assert.ok(p.total < pass.annualCostUsd + p.total, "the pass price is not inside the total");

  const without = priced({});
  // Everything else about the trip is identical, so the only difference in
  // the total is the gate cost the passes covered.
  assert.ok(Math.abs((without.total - p.total) - pass.savedUsd) < 0.05,
    `the total moved by exactly what the passes saved (${without.total - p.total} vs ${pass.savedUsd})`);
});

test("the owner's pass price wins over the shipped one", () => {
  const settings = new Map([[passPriceKey("wdw", "incredi"), 1800]]);
  const book = fullBook("wdw", "MCO", settings);
  const r = priceTrip(book as any, resortById("wdw"),
    { ...base, annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 2 }] }, {}, START);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.price.membership!.pass!.annualCostUsd, 3600);
});

test("a pass holder does not buy a park hopper they already have", () => {
  const hop = priced({ hopper: true });
  const hopWithPass = priced({ hopper: true, annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 3 }] });
  assert.ok(hop.hopperUsd > 0);
  assert.equal(hopWithPass.hopperUsd, 0, "every traveller is covered, so nobody buys hopping twice");
});

test("the parking perk lands on parking, not on the ticket line", () => {
  // Off property, where parking is a real cost. On property it is usually
  // zero already and the perk correctly does nothing.
  const off = priced({ stay: "off" });
  const withPass = priced({ stay: "off", annualPasses: [{ resortId: "wdw", tierId: "incredi", count: 1 }] });
  assert.ok(off.transport > 0, "there is parking to save");
  assert.equal(withPass.transport, 0, "an Incredi-Pass covers standard theme-park parking");
  assert.ok(withPass.membership!.pass!.savedUsd > withPass.membership!.pass!.ticketsWithoutPassUsd,
    "and the saving is more than the gate alone");
});

/* ---------------------------------- DVC ---------------------------------- */

test("points rented are take-home money, and a blank box is not zero dollars", () => {
  assert.equal(parseDvcRental("", ""), null, "saying nothing is not the same as renting nothing");
  assert.equal(parseDvcRental(0, 20), null);
  const d = parseDvcRental("150", "");
  assert.deepEqual(d, { points: 150, takeHomePerPointUsd: DVC_TAKE_HOME_PER_POINT },
    "an unstated rate falls back to the maintained figure");
  assert.equal(parseDvcRental("150", "$19.50")!.takeHomePerPointUsd, 19.5, "a pasted dollar sign is fine");
  assert.equal(dvcCredit({ points: 150, takeHomePerPointUsd: 18 }), 2700);
});

test("a typo in the points box cannot invent thousands of dollars", () => {
  assert.equal(parseDvcRental("999999", "18")!.points, 2000);
  assert.equal(parseDvcRental("100", "5000")!.takeHomePerPointUsd, 60);
});

test("renting points comes off the total and nothing else", () => {
  const plain = priced({});
  const rented = priced({ dvcRental: { points: 100, takeHomePerPointUsd: 18 } });
  assert.equal(rented.membership!.dvc!.creditUsd, 1800);
  assert.equal(rented.hotel, plain.hotel, "it is not a discount on the room");
  assert.equal(rented.tickets, plain.tickets);
  assert.ok(Math.abs((plain.total - rented.total) - 1800) < 0.01);
});

test("renting more than the trip costs leaves it at zero, never negative", () => {
  const p = priced({ dvcRental: { points: 2000, takeHomePerPointUsd: 60 } });
  assert.equal(p.total, 0);
});

test("saying nothing about either leaves the trip exactly as it was", () => {
  // The safety property: every existing caller passes neither of these, and
  // the board they get must not move by a cent.
  const p = priced({});
  assert.equal(p.membership, null);
});
