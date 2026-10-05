import { test } from "node:test";
import assert from "node:assert/strict";
import { isRental, summarize } from "./rentals.js";

test("the owner's screenshot (2026-10-05): rentals are told apart from hotels by name", () => {
  for (const r of [
    "Family 2BR at Meliá Celebration Balcony and Pool",
    "Family 2BR at Meliá Celebration Balcony and Pool - Two-Bedroom Apartment",
    "Spacious 2BR Resort Near Disney | Pool + Private Balcony",
    "Condo Near Disney-Universal-Epic-Sea World",
    "Condo near Disney Universal Free Parking",
  ]) assert.equal(isRental(r), true, r);
  for (const h of [
    "Westgate Vacation Villas Resort",
    "Westgate Towers Resort",
    "TownePlace Suites by Marriott Orlando at FLAMINGO CROSSINGS® Town Center/Western Entrance",
    "SpringHill Suites by Marriott Orlando at FLAMINGO CROSSINGS® Town Center/Western Entrance",
    "Home2 Suites by Hilton Orlando at FLAMINGO CROSSINGS Town Center",
    "Wyndham Grand Orlando Resort Bonnet Creek",
    "Disney's Pop Century Resort",
  ]) assert.equal(isRental(h), false, h);
});

test("Google's own label wins over the name", () => {
  assert.equal(isRental("Westgate Vacation Villas Resort", "vacation rental"), true);
  assert.equal(isRental("Condo Hotel Lake Buena Vista", "hotel"), false);
});

test("summarize gives count, median and range", () => {
  assert.deepEqual(summarize([95, 117, 121, 112]), { count: 4, median: 115, low: 95, high: 121 });
  assert.deepEqual(summarize([]), { count: 0, median: null, low: null, high: null });
});
