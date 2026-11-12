import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { memoryDb } from "./db.js";
import { splitCruises, readAdventure } from "../public/screenshot-reader.js";
import { validateCruise, saveCruises, listCruises, deleteCruise, validateAdventure, saveAdventure, listAdventures } from "./cruisesAdventures.js";

// Real OCR of the owner's own screenshots (2026-11-12), read in Chromium.
const CRUISE_OCR = fs.readFileSync(new URL("./testdata/cruise-list-2026-11.ocr.txt", import.meta.url), "utf8");
const ABD_OCR = fs.readFileSync(new URL("./testdata/abd-page-2026-11.ocr.txt", import.meta.url), "utf8");

test("the cruise list screenshot reads as three cards, each with its own price", () => {
  const c = splitCruises(CRUISE_OCR);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => [x.title, x.price, x.save, x.datesCount]), [
    ["3-Night Bahamian Cruise from Fort Lauderdale", 686, 138, 26],
    ["4-Night Western Caribbean Cruise from Galveston", 714, 200, 13],
    ["3-Night Bahamian Cruise from Fort Lauderdale", 767, 213, null],
  ], "Fort and Lauderdale were split apart by OCR and still read as the port");
  assert.equal(c[0]!.ports, "Disney Lookout Cay at Lighthouse Point Nassau, Bahamas");
  assert.equal(c[1]!.ports, "Progreso, Mexico");
  assert.equal(c[2]!.theme, "Very Merrytime");
  assert.ok(c.every((x) => x.currency === "USD" && x.guaranteed && x.perPerson));
});

test("the Adventures by Disney screenshot reads days, price, meals, ages and highlights", () => {
  const a = readAdventure(ABD_OCR);
  assert.equal(a.days, 3); assert.equal(a.price, 2799); assert.equal(a.tripType, "Escape");
  assert.deepEqual([a.meals, a.breakfasts, a.lunches, a.dinners], [4, 2, 1, 1], "lunches worked out from 4 meals");
  assert.deepEqual([a.minAge, a.suggestedAge, a.adultExclusiveAge], [5, 6, 18]);
  assert.deepEqual(a.highlights, ["Visit Neuschwanstein Castle", "Create a Traditional German Treat",
    "Enjoy a Tasting at Weihenstephan Brewery"]);
});

test("cruises: a seen price is kept as history, never replaced; a bad row saves nothing", async () => {
  const db = await memoryDb();
  const today = "2026-11-12";
  const card = { title: "3-Night Bahamian Cruise from Fort Lauderdale", nights: 3, price: "$686", save: 138, datesCount: 26 };
  assert.deepEqual(await saveCruises(db, [card], today), { ok: true, saved: 1 });
  assert.deepEqual(await saveCruises(db, [{ ...card, price: 650, seenOn: "2026-11-05" }], today), { ok: true, saved: 1 });
  const bad = await saveCruises(db, [card, { title: "x", price: "abc" }], today);
  assert.equal(bad.ok, false);
  const rows = await listCruises(db);
  assert.equal(rows.length, 2, "both sightings kept, the rejected batch wrote nothing");
  assert.deepEqual(rows.map((r) => [r.seenOn, r.price]), [["2026-11-12", 686], ["2026-11-05", 650]]);
  assert.ok(await deleteCruise(db, rows[1]!.id));
  assert.equal((await listCruises(db)).length, 1);
  await db.close();
});

test("cruise and adventure checks refuse what can't be true", () => {
  const today = "2026-11-12";
  assert.equal(validateCruise({ title: "A", price: 500, seenOn: "2026-12-01" }, today).ok, false, "seen in the future");
  assert.equal(validateCruise({ title: "A", price: 500, cabin: "penthouse" }, today).ok, false);
  const gbp = validateCruise({ title: "A", price: 500, currency: "gbp" }, today);
  assert.ok(gbp.ok && gbp.value.currency === "GBP" && gbp.value.priceUsd > 500, "pounds kept and converted");
  assert.equal(validateAdventure({ price: 2799 }, today).ok, false, "the trip needs a name");
  assert.equal(validateAdventure({ tripName: "Munich", price: 2799, minAge: 40 }, today).ok, false);
});

test("an adventure saves with its highlights and reads back", async () => {
  const db = await memoryDb();
  const r = await saveAdventure(db, { tripName: "Germany Escape", days: 3, price: 2799, tripType: "Escape",
    meals: 4, highlights: ["Visit Neuschwanstein Castle", "Create a Traditional German Treat"] }, "2026-11-12");
  assert.equal(r.ok, true);
  const [a] = await listAdventures(db);
  assert.equal(a!.tripName, "Germany Escape");
  assert.deepEqual(a!.highlights, ["Visit Neuschwanstein Castle", "Create a Traditional German Treat"]);
  assert.equal(a!.seenOn, "2026-11-12");
  await db.close();
});
