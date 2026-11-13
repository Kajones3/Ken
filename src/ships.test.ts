import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayShipItems, validateShipItem, shipSummary, SHIPPED_SHIP_ITEMS } from "./ships.js";
import { readShipPage } from "../public/screenshot-reader.js";

test("the owner's rows replace, hide and add to the shipped list", () => {
  const first = SHIPPED_SHIP_ITEMS[0]!;
  const rows = overlayShipItems([
    { ...first, note: "Owner's words", hidden: false },
    { id: "wish-palo-steakhouse", ship: "Disney Wish", kind: "adults", name: "Palo Steakhouse", note: "", hidden: true },
    { id: "wonder-tianas-place", ship: "Disney Wonder", kind: "dining", name: "Tiana's Place", note: "", hidden: false },
  ]);
  assert.equal(rows.find((r) => r.id === first.id)!.note, "Owner's words");
  assert.equal(rows.find((r) => r.id === "wish-palo-steakhouse")!.hidden, true);
  assert.equal(rows.find((r) => r.id === "wonder-tianas-place")!.source, "owner");
  const wish = shipSummary(rows, "Wish");
  assert.ok(!wish.byKind.adults!.some((x) => x.name === "Palo Steakhouse"), "hidden stays off the card");
  assert.equal(shipSummary(rows, "Wonder").byKind.dining![0]!.name, "Tiana's Place");
  assert.equal(overlayShipItems([]).length, SHIPPED_SHIP_ITEMS.length, "empty table = the shipped list");
});

test("a ship item needs a real ship, kind and name", () => {
  assert.equal(validateShipItem({ ship: "Disney Wish", kind: "dining", name: "X" }).ok, true);
  assert.equal(validateShipItem({ ship: "Disney Wishful", kind: "dining", name: "X" }).ok, false);
  assert.equal(validateShipItem({ ship: "Disney Wish", kind: "bar", name: "X" }).ok, false);
  assert.equal(validateShipItem({ ship: "Disney Wish", kind: "dining", name: " " }).ok, false);
  const v = validateShipItem({ ship: "Disney Believe", kind: "kids", name: "Oceaneer Club" });
  assert.equal(v.ok && v.value.id, "believe-oceaneer-club");
});

// The shape of Disney's ship page (headings, name lines, taglines, paragraphs),
// in our own made-up words.
const PAGE = `Our Ships
Dining with Character
Eat at themed restaurants every night of the trip, rotating from one room to the next.
Harbor Lights Supper Club
A Night to Remember
Guests dine at Harbor Lights Supper Club while the room changes colour around them, with songs and a seafood menu for the table.
Quick Bites & Treats
Captain's Snack Shack
Grab a sandwich at Captain's Snack Shack any time of day, with seats inside and out on the open deck nearby.
Elevated Adult Escapes
Moonlit Lounge
This quiet bar is open to families in the morning, but at night it becomes a haven for adults only, with views over the sea.
Tidepool Retreat
An adults-only pool and bar set apart from the family decks, with loungers and a hot tub for unwinding in the afternoon.
Action-Packed Kids Clubs
Little Sailors Nursery
Babies and toddlers 6 months to 3 years of age are looked after by trained counselors at Little Sailors Nursery all day.
More to Explore
Deck Hands Club
Children ages 3 to 10 build boats and play games at Deck Hands Club with counselors and visits from friends.
Spacious Staterooms and Suites
Inside
Oceanview`;

test("a pasted ship page becomes names and facts, never Disney's sentences", () => {
  const got = readShipPage(PAGE);
  const by = (n: string) => got.find((x) => x.name === n)!;
  assert.equal(by("Harbor Lights Supper Club").kind, "dining");
  assert.equal(by("Harbor Lights Supper Club").likely, true);
  assert.equal(by("A Night to Remember").likely, false, "a tagline is offered unticked");
  assert.equal(by("Captain's Snack Shack").kind, "quick");
  assert.equal(by("Moonlit Lounge").note, "Adults only at night");
  assert.equal(by("Tidepool Retreat").note, "Adults only");
  assert.equal(by("Little Sailors Nursery").note, "Ages 6 months to 3 years");
  assert.equal(by("Deck Hands Club").note, "Ages 3 to 10");
  assert.ok(!got.some((x: any) => /Inside|Oceanview|More to Explore/.test(x.name)), "stops at the staterooms");
  for (const x of got) assert.ok(x.note.length < 60);
});
