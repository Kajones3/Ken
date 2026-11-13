import { test } from "node:test";
import assert from "node:assert/strict";
import { adventuresInMonth, priceForParty, underPerPerson } from "./adventureSearch.js";
import type { AdventureSighting } from "./cruisesAdventures.js";

const row = (o: Partial<AdventureSighting>): AdventureSighting => ({
  id: "x", savedAt: "2026-11-14T00:00:00Z", seenOn: "2026-11-14", tripName: "France: Paris Escape", destination: "Paris",
  days: 3, nights: 2, departureDate: "2027-06-01", price: 2999, childPrice: 2849, currency: "USD", priceUsd: 2999,
  tripType: "Escape", meals: null, breakfasts: null, lunches: null, dinners: null, minAge: 5, suggestedAge: null,
  adultExclusiveAge: null, highlights: [], note: null, returnDate: "2027-06-03", adultOnly: false, childMaxAge: 11, ...o,
});

test("this month's departures, newest price each", () => {
  const rows = [row({}), row({ seenOn: "2026-10-01", price: 2500, priceUsd: 2500 }), row({ departureDate: "2027-07-01" }),
    row({ departureDate: null })];
  const d = adventuresInMonth(rows, "2026-11-14", "2027-06");
  assert.equal(d.length, 1);
  assert.equal(d[0]!.adultUsd, 2999);
  assert.equal(d[0]!.childUsd, 2849);
});

test("the party pays adult and child prices; adults-only and age limits say so", () => {
  const [d] = adventuresInMonth([row({})], "2026-11-14", "2027-06");
  const p = priceForParty(d!, { adults: 2, childAges: [8, 12] });
  assert.ok(p.ok);
  if (p.ok) assert.equal(p.total, 2999 * 3 + 2849);
  assert.equal(priceForParty(d!, { adults: 2, childAges: [3] }).ok, false);
  const [a] = adventuresInMonth([row({ adultOnly: true, childPrice: null })], "2026-11-14", "2027-06");
  const no = priceForParty(a!, { adults: 2, childAges: [8] });
  assert.equal(no.ok, false);
});

test("a free visitor is told 'from under $X a person', rounded up to $500", () => {
  const d = adventuresInMonth([row({}), row({ tripName: "B", price: 3399, priceUsd: 3399 })], "2026-11-14", "2027-06");
  assert.equal(underPerPerson(d), 3000);
  assert.equal(underPerPerson([]), null);
});
