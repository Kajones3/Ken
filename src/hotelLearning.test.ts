import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cheapestPlace, hotelAnchor, hotelPairs, learnHotels, type SampleRow } from "./hotelLearning.js";

test("the starting price is the cheapest place to book, blended toward Google's usual by the weight", () => {
  assert.equal(cheapestPlace(200), 200);
  assert.equal(cheapestPlace(200, { prices: [{ source: "Booking.com", nightly: 180 }, { source: "Expedia", nightly: 210 }] }), 180);
  // A deal: Google's usual is 250 against a lead of 200.
  assert.equal(hotelAnchor(200, { usualNightly: 250 }, 0), 200, "weight 0 = the night we saw");
  assert.equal(hotelAnchor(200, { usualNightly: 250 }, 1), 250, "weight 1 = Google's usual");
  const mid = hotelAnchor(200, { usualNightly: 250 }, 0.5);
  assert.ok(mid > 220 && mid < 226, `geometric middle, got ${mid}`);
  // Usual moves to the cheapest site's footing: 10% cheaper site, usual 250 -> 225.
  assert.equal(hotelAnchor(200, { usualNightly: 250, prices: [{ source: "X", nightly: 180 }] }, 1), 225);
});

const row = (name: string, day: number, nightly: number, extra?: SampleRow["extra"], kind?: string): SampleRow => ({
  resortId: "wdw", month: "2027-03", checkIn: "2027-03-14", pulledAt: new Date(Date.UTC(2026, 9, day)),
  hotelName: name, nightly, kind: kind ?? "hotel", extra: extra ?? null,
});

test("pairs: same hotel and month, two pulls days apart; Disney hotels and rentals left out", () => {
  const pairs = hotelPairs([
    row("Holiday Inn Lake Buena Vista", 1, 150), row("Holiday Inn Lake Buena Vista", 1, 151), row("Holiday Inn Lake Buena Vista", 11, 160),
    row("Disney's Pop Century Resort", 1, 200), row("Disney's Pop Century Resort", 11, 210),
    row("2BR Condo near Disney", 1, 120, null, "vacation rental"), row("2BR Condo near Disney", 11, 130, null, "vacation rental"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.next.nightly, 160);
});

test("the usual-price weight is learned from the record and shrunk until enough pairs back it", () => {
  // 20 hotels flagged a deal (20% below a usual of 250); ten days later each is back at usual.
  const rows: SampleRow[] = [];
  for (let i = 0; i < 20; i++) {
    rows.push(row(`Hotel ${i}`, 1, 200, { usualNightly: 250 }), row(`Hotel ${i}`, 11, 250));
  }
  const l = learnHotels(rows);
  assert.equal(l.dealPairs, 20);
  assert.equal(l.bestWeight, 1, "usual predicted the later price exactly");
  assert.equal(l.usualWeight, 0.5, "1 x 20/(20+20)");
  const at0 = l.byWeight.find((b) => b.w === 0)!, at1 = l.byWeight.find((b) => b.w === 1)!;
  assert.equal(at0.deals.typicalOffPct, 20);
  assert.equal(at1.deals.typicalOffPct, 0);
  // Deals that stay cheap teach the opposite.
  const stay: SampleRow[] = [];
  for (let i = 0; i < 20; i++) stay.push(row(`Hotel ${i}`, 1, 200, { usualNightly: 250 }), row(`Hotel ${i}`, 11, 200));
  assert.equal(learnHotels(stay).usualWeight, 0);
  // No deals at all: nothing learned, nothing moved.
  assert.equal(learnHotels([row("A", 1, 100), row("A", 11, 110)]).usualWeight, 0);
});
