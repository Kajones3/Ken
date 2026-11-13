import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { memoryDb } from "./db.js";
import { splitCruises, readAdventure } from "../public/screenshot-reader.js";
import { validateCruise, saveCruises, listCruises, deleteCruise, validateAdventure, saveAdventure, listAdventures, gratuityPerPerson } from "./cruisesAdventures.js";


test("gratuities: nights x Disney's rate per person, the higher rate for a suite, nothing without nights", () => {
  const rates = { regular: 16, concierge: 27.25 };
  assert.equal(gratuityPerPerson(3, null, rates), 48);
  assert.equal(gratuityPerPerson(4, "suite", rates), 109);
  assert.equal(gratuityPerPerson(4, "verandah", rates), 64);
  assert.equal(gratuityPerPerson(null, null, rates), null);
});

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
  assert.deepEqual(await saveCruises(db, [card], today), { ok: true, saved: 1, skipped: 0 });
  assert.deepEqual(await saveCruises(db, [{ ...card, price: 650, seenOn: "2026-11-05" }], today), { ok: true, saved: 1, skipped: 0 });
  const bad = await saveCruises(db, [card, { title: "x", price: "abc" }], today);
  assert.equal(bad.ok, false);
  const rows = await listCruises(db);
  assert.equal(rows.length, 2, "both sightings kept, the rejected batch wrote nothing");
  assert.deepEqual(rows.map((r) => [r.seenOn, r.price]), [["2026-11-12", 686], ["2026-11-05", 650]]);
  assert.deepEqual([rows[0]!.gratuityUsd, rows[0]!.withGratuityUsd], [48, 734], "$686 + 3 nights x $16");
  await db.query(`insert into owner_settings (key, value) values ('cruise.gratuityPerNight', '17')`);
  assert.equal((await listCruises(db))[0]!.withGratuityUsd, 737, "the owner's corrected rate applies to saved cruises");
  assert.ok(await deleteCruise(db, rows[1]!.id));
  assert.equal((await listCruises(db)).length, 1);
  await db.close();
});

test("cruise and adventure checks refuse what can't be true", () => {
  const today = "2026-11-12";
  assert.equal(validateCruise({ title: "A", price: 500, seenOn: "2026-12-01" }, today).ok, false, "seen in the future");
  assert.equal(validateCruise({ title: "A", price: 500, cabin: "penthouse" }, today).ok, false);
  const gbp = validateCruise({ title: "A", price: 500, currency: "gbp" }, today);
  assert.ok(gbp.ok && gbp.value.currency === "GBP" && gbp.value.priceUsd! > 500, "pounds kept and converted");
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

/* ---- one cruise's dates and the Rate Details panel (owner's screenshots, 2026-11-13, real OCR) ---- */
import { readCruiseScreenshot, cruisePrice, sailingDates, enlargeBy } from "../public/screenshot-reader.js";
import { saveRates, listRates, rateShares } from "./cruisesAdventures.js";
const words = (f: string) => JSON.parse(fs.readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
const grid = (r: ReturnType<typeof readCruiseScreenshot>) => r.sailings.map((s) =>
  [s.start, ...(["inside", "oceanview", "verandah", "concierge"] as const).map((k) => {
    const x = s.rooms[k]; return !x ? null : x.soldOut ? "sold out" : x.price; })]);

test("the dates reader reads every sailing of the owner's phone-width Galveston screenshot", () => {
  const r = readCruiseScreenshot(words("cruise-dates-galveston-phone-2026-11.words.json"));
  assert.deepEqual(grid(r), [
    ["2027-01-15", 905, 1035, 1250, 3790], ["2027-03-12", 1640, 1835, 2145, "sold out"],
    ["2027-03-21", 1480, 1660, 2055, 4935], ["2027-03-26", 1480, 1645, 2000, 3780],
    ["2027-04-04", 1155, 1285, 1465, 3290], ["2027-04-09", 1155, 1290, 1470, 3290],
    ["2028-01-07", 1140, 1345, 1625, 3020], ["2028-01-28", 1175, 1350, 1615, 3225],
    ["2028-02-06", 1180, 1350, 1550, 2990]]);
  assert.equal(r.sailings[7]!.end, "2028-02-02", "a sailing that runs into the next month");
  assert.ok(r.sailings.every((s) => s.nights === 5));
  // Repaired readings are marked for the owner to check.
  assert.equal(r.sailings[4]!.rooms.inside!.check, true, "\"©3155\" read as $1,155, marked");
  assert.equal(r.sailings[6]!.rooms.inside!.check, true, "\"$140\" read as $1,140, marked");
  assert.equal(r.sailings[1]!.rooms.inside!.check, false);
});

test("a sale price under Disney's green tag, and the crossed-out price", () => {
  const r = readCruiseScreenshot(words("cruise-dates-wish-2026-11.words.json"));
  assert.equal(r.ship, "Wish");
  assert.deepEqual(grid(r), [["2027-01-29", 820, 715, 775, 1734]]);
  assert.equal(r.sailings[0]!.rooms.oceanview!.was, 866);
  assert.equal(r.sailings[0]!.end, "2027-02-01");
  assert.deepEqual(cruisePrice("©9715")!.alts.slice(0, 2), [715, 1715]);
  assert.equal(cruisePrice("$1,640")!.value, 1640);
  assert.equal(cruisePrice("Unavailable"), null);
  assert.deepEqual(sailingDates("December 30 - January 3, 2027"), { start: "2026-12-30", end: "2027-01-03", nights: 4 });
  assert.equal(enlargeBy(674), 3, "a phone-width screenshot is read three times bigger");
  assert.equal(enlargeBy(2000), 1);
});

test("a Rate Details panel open over the dates: both are read, apart", () => {
  const g = readCruiseScreenshot(words("cruise-rates-galveston-2026-11.words.json"));
  assert.deepEqual(grid(g).slice(0, 2), [["2027-01-15", 905, 1035, 1250, 3790], ["2027-03-12", 1640, 1835, 2145, "sold out"]]);
  assert.deepEqual(g.rates!.guests.map((x) => x.amount), [755, 755]);
  assert.equal(g.rates!.taxes, 301.4);
  assert.equal(g.rates!.total, 1811.4);
  assert.equal(g.rates!.cabin, "inside", "\"porthole mirror (no exterior view)\"");
  const c = readCruiseScreenshot(words("cruise-rates-canaveral-2026-11.words.json"));
  assert.equal(c.title, "3-Night Bahamian Cruise from Port Canaveral");
  assert.deepEqual(grid(c), [["2026-12-28", 1394, 1550, 1586, "sold out"], ["2027-01-03", 802, 835, 731, 2433],
    ["2027-01-08", 830, "sold out", 780, 1734]]);
  assert.equal(c.rates!.adults, 2); assert.equal(c.rates!.children, 2);
  assert.equal(c.rates!.taxes, 117); assert.equal(c.rates!.total, 715);
  assert.equal(c.rates!.cabin, "oceanview");
  const sh = rateShares(c.rates!);
  assert.equal(sh.childShare, 0.541, "a child paid about 54% of an adult");
  assert.equal(sh.taxShare, 0.164);
});

test("dated cruise prices save per sailing and room; the same screenshot saved twice adds nothing", async () => {
  const db = await memoryDb();
  const base = { title: "5-Night Western Caribbean Cruise from Galveston", nights: 5, sailDate: "2027-01-15", sailEnd: "2027-01-20",
    partyAdults: 2, partyChildren: 0, ship: "Magic" };
  const batch = [{ ...base, cabin: "inside", price: 905, was: 1160 }, { ...base, cabin: "concierge", price: 3790 },
    { ...base, sailDate: "2027-03-12", sailEnd: "2027-03-17", cabin: "concierge", soldOut: true }];
  assert.deepEqual(await saveCruises(db, batch, "2026-11-13"), { ok: true, saved: 3, skipped: 0 });
  assert.deepEqual(await saveCruises(db, batch, "2026-11-13"), { ok: true, saved: 0, skipped: 3 });
  // The same price seen on another day is history, not a repeat.
  assert.deepEqual(await saveCruises(db, [{ ...batch[0]!, seenOn: "2026-11-12" }], "2026-11-13"), { ok: true, saved: 1, skipped: 0 });
  const rows = await listCruises(db);
  const sold = rows.find((r) => r.soldOut)!;
  assert.equal(sold.price, null); assert.equal(sold.withGratuityUsd, null);
  const conc = rows.find((r) => r.cabin === "concierge" && !r.soldOut)!;
  assert.equal(conc.gratuityUsd, 136.25, "Concierge pays the higher gratuity: 5 x $27.25");
  assert.equal(rows.find((r) => r.was === 1160)!.partyAdults, 2);
  assert.equal((await saveCruises(db, [{ ...base, cabin: "inside", price: 905, was: 800 }], "2026-11-13")).ok, false,
    "a crossed-out price below the price is refused");
  assert.equal((await saveCruises(db, [{ ...base, cabin: "inside" }], "2026-11-13")).ok, false, "a price, or sold out");
  await db.close();
});

test("a price summary is kept as shown, with what it teaches", async () => {
  const db = await memoryDb();
  const input = { title: "3-Night Bahamian Cruise from Port Canaveral", sailDate: "2027-01-29", cabin: "oceanview", shownAs: "person",
    guests: [{ label: "Adult 1", kind: "adult", amount: 194 }, { label: "Adult 2", kind: "adult", amount: 194 },
      { label: "Child 1", kind: "child", amount: 105 }, { label: "Child 2", kind: "child", amount: 105 }], taxes: 117, total: 715 };
  assert.equal((await saveRates(db, input, "2026-11-13") as any).skipped, false);
  assert.equal((await saveRates(db, input, "2026-11-13") as any).skipped, true, "the same panel twice is kept once");
  const [r] = await listRates(db);
  assert.equal(r!.adults, 2); assert.equal(r!.children, 2); assert.equal(r!.childShare, 0.541);
  assert.equal((await saveRates(db, { ...input, guests: [] }, "2026-11-13")).ok, false);
  await db.close();
});

test("the one-time cleanup keeps one of each cruise the owner saved two or three times", async () => {
  const db = await memoryDb();
  const ins = (note: string | null, title = "4-Night Western Caribbean Cruise from Galveston") => db.query(
    `insert into cruise_sightings (id, seen_on, title, nights, price, price_usd, save_amount, dates_count, note)
     values (gen_random_uuid(), '2026-11-13', $1, 4, 861, 861, 248, 5, $2)`, [title, note]);
  await ins(null); await ins("disneycruise.com"); await ins(null);
  await ins(null, "5-Night Western Caribbean Cruise from Galveston");
  const sql = fs.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const once = sql.slice(sql.indexOf("delete from cruise_sightings c"), sql.indexOf("insert into schema_marks (name) values ('cruise_sightings_dedupe_2026_11')"));
  await db.query(`delete from schema_marks where name = 'cruise_sightings_dedupe_2026_11'`);
  await db.query(once);
  const left = (await db.query<any>(`select title, note from cruise_sightings order by title`)).rows;
  assert.deepEqual(left.map((r) => [r.title.slice(0, 6), r.note]), [["4-Nigh", "disneycruise.com"], ["5-Nigh", null]]);
  await db.close();
});

test("a saved cruise price can be corrected, and a cruise's details set on every row", async () => {
  const { updateCruise, updateCruiseDetails } = await import("./cruisesAdventures.js");
  const db = await memoryDb();
  const today = "2026-11-14";
  const t = "7-Night Bahamian Cruise from Galveston";
  await saveCruises(db, [
    { title: t, sailDate: "2027-04-18", cabin: "inside", price: 1200, partyAdults: 2, partyChildren: 2 },
    { title: t, sailDate: "2027-04-18", cabin: "verandah", price: 1600, partyAdults: 2, partyChildren: 2 },
  ], today);
  const [row] = await listCruises(db);
  assert.deepEqual(await updateCruise(db, row!.id, { price: 1250, partyChildren: 0 }, today), { ok: true });
  const fixed = (await listCruises(db)).find((r) => r.id === row!.id)!;
  assert.equal(fixed.price, 1250);
  assert.equal(fixed.partyChildren, 0);
  assert.equal(fixed.sailDate, "2027-04-18", "fields not sent are kept");
  const bad = await updateCruise(db, row!.id, { price: "abc" }, today);
  assert.equal(bad.ok, false);
  const d = await updateCruiseDetails(db, { title: t, ports: "Castaway Cay, Cozumel", ship: "Magic", nights: 7 });
  assert.deepEqual(d, { ok: true, changed: 2 });
  assert.ok((await listCruises(db)).every((r) => r.ports === "Castaway Cay, Cozumel" && r.ship === "Magic" && r.nights === 7));
  assert.equal((await updateCruiseDetails(db, { title: t })).ok, false, "nothing to change");
  await db.close();
});
