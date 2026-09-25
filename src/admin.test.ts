import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { RESORTS } from "./config.js";
import { setSetting, primeSettingsCache, clearSettingsCache, cachedSetting } from "./settings.js";
import { effectiveBase, onPropertyQuotes } from "./onProperty.js";
import { resortOfHotelSetting, reseedOnProperty } from "./reseed.js";
import { csvCell, parseCsv, entriesFromCsv } from "./csv.js";
import { MockProvider } from "./providers/mock.js";
import { todayISO, monthKey, addDaysISO } from "./dates.js";

const wdw = RESORTS.find((r) => r.id === "wdw")!;
const moderate = wdw.hotels.find((h) => h.onProperty && h.tier === "moderate")!;
const nextMonth = monthKey(addDaysISO(todayISO(), 40));

/* ------------------------- the number actually applies ------------------- */

test("an owner's rate reaches the generated nightly rows", async () => {
  const db = await memoryDb();
  clearSettingsCache();
  assert.equal(effectiveBase(moderate), moderate.base, "the shipped figure with nothing set");

  await setSetting(db, `hotel.${moderate.id}.base`, moderate.base + 100);
  await primeSettingsCache(db);
  assert.equal(effectiveBase(moderate), moderate.base + 100);

  const quotes = onPropertyQuotes(wdw, nextMonth, "on").filter((q) => q.hotelId === moderate.id);
  assert.ok(quotes.length > 27, "a month of nights");
  // Every night moves, not just the sampled one — the season curve is applied
  // on top of the owner's base, not instead of it.
  const shipped = (() => { clearSettingsCache();
    return onPropertyQuotes(wdw, nextMonth, "on").filter((q) => q.hotelId === moderate.id); })();
  for (const [i, q] of quotes.entries()) {
    assert.ok(q.nightlyUsd > shipped[i]!.nightlyUsd, `night ${q.stayDate} did not move`);
  }
  clearSettingsCache();
});

test("the nightly refresh does not quietly revert the owner", async () => {
  // The failure this exists to prevent: hotel_rates is regenerated every night
  // from the base rate, so a generator reading config.ts instead of the
  // owner's value would undo every correction by morning, silently, with the
  // admin page still showing the number they typed.
  const db = await memoryDb();
  clearSettingsCache();
  await setSetting(db, `hotel.${moderate.id}.base`, 999);
  await primeSettingsCache(db);

  const rows = await new MockProvider().hotelMonth("wdw", nextMonth);
  const mine = rows.filter((r) => r.hotelId === moderate.id);
  assert.ok(mine.length, "the provider still returns this hotel");
  assert.ok(mine.every((r) => r.nightlyUsd > moderate.base),
    "the provider generated from the shipped default, so tonight's refresh would wipe the correction");
  clearSettingsCache();
});

test("an unprimed cache is the shipped defaults, not zero", async () => {
  // Forgetting to prime must degrade to what the app ships with. Anything
  // else turns a missed call site into free hotel rooms.
  clearSettingsCache();
  assert.equal(cachedSetting("transport.wdw.off", 65), 65);
  assert.equal(cachedSetting("nothing.like.this", 12), 12);
  assert.equal(effectiveBase(moderate), moderate.base);
});

/* ------------------------------- the re-seed ----------------------------- */

test("a hotel key knows which resort it belongs to, and other keys don't pretend to", () => {
  assert.equal(resortOfHotelSetting(`hotel.${moderate.id}.base`), "wdw");
  assert.equal(resortOfHotelSetting("transport.wdw.off"), null);
  assert.equal(resortOfHotelSetting("hotel.nothing-real.base"), null);
  const dlp = RESORTS.find((r) => r.id === "dlp")!;
  assert.equal(resortOfHotelSetting(`hotel.${dlp.hotels[0]!.id}.base`), "dlp");
});

test("saving a rate rewrites the cache travelers are actually quoted from", async () => {
  const db = await memoryDb();
  clearSettingsCache();
  const key = `hotel.${moderate.id}.base`;
  await setSetting(db, key, 777);
  const written = await reseedOnProperty(db, "wdw");
  assert.ok(written > 0, "rows were written");

  const { rows } = await db.query<{ nightly_usd: string; on_property: boolean }>(
    `select nightly_usd, on_property from hotel_rates where hotel_id = $1`, [moderate.id]);
  assert.ok(rows.length > 300, "the whole window is rewritten, not just the months due tonight");
  // Compared against the shipped base rather than a multiple of it: the season
  // curve can take a night down to 0.86, so "much bigger" is the wrong test
  // and a night in a cheap season would fail it for the right reasons.
  for (const r of rows) {
    assert.ok(r.on_property, "only on-property rows are ours to generate");
    assert.ok(Number(r.nightly_usd) > moderate.base,
      `a cached night at ${r.nightly_usd} still looks like the shipped ${moderate.base}`);
  }
  clearSettingsCache();
});

test("the re-seed leaves a vendor's own off-property rates alone", async () => {
  // These are somebody else's data. Rewriting them from a guess would turn a
  // real observed price into a fabricated one with no way to tell after.
  const db = await memoryDb();
  clearSettingsCache();
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source,fetched_at)
     values ('some-offsite','wdw','Some Hotel','2 miles away',$1,123.45,1,false,'serpapi_hotels',now())`,
    [addDaysISO(todayISO(), 45)]);
  await reseedOnProperty(db, "wdw");
  const { rows } = await db.query<{ nightly_usd: string }>(
    `select nightly_usd from hotel_rates where hotel_id = 'some-offsite'`);
  assert.equal(Number(rows[0]!.nightly_usd), 123.45, "the vendor's rate is untouched");
  clearSettingsCache();
});

test("a key that isn't a hotel rate re-seeds nothing", async () => {
  const db = await memoryDb();
  const before = await db.query(`select count(*)::int as n from hotel_rates`);
  await setSetting(db, "transport.wdw.off", 40);
  const after = await db.query(`select count(*)::int as n from hotel_rates`);
  assert.equal((after.rows[0] as { n: number }).n, (before.rows[0] as { n: number }).n,
    "changing the parking-and-transfers rate must not rewrite hotel rows");
});

/* -------------------------------- the file ------------------------------- */

test("a spreadsheet survives what spreadsheets do to files", () => {
  // BOM, CRLF, a quoted cell containing a comma, and a trailing blank line —
  // every one of them Excel's doing, none of them the owner's mistake.
  const text = "﻿key,value,label\r\nhotel.x.base,250,\"Moderate, standard room\"\r\n\r\n";
  const rows = parseCsv(text);
  assert.equal(rows.length, 2, "the blank line is not a row");
  assert.deepEqual(rows[1], ["hotel.x.base", "250", "Moderate, standard room"]);
});

test("columns are found by name, so a reordered spreadsheet still imports", () => {
  const r = entriesFromCsv("label,value,key\nParking,40,transport.wdw.off\n");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.entries, [{ key: "transport.wdw.off", value: "40" }]);
});

test("a file with no key/value header is refused with something to act on", () => {
  const r = entriesFromCsv("name,amount\nParking,40\n");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /key.*value/s, "it names the columns it wanted");
  const empty = entriesFromCsv("");
  assert.equal(empty.ok, false);
});

test("a quote inside a cell round-trips", () => {
  const cell = csvCell('He said "about $250"');
  assert.equal(cell, '"He said ""about $250"""');
  assert.equal(parseCsv("a\n" + cell + "\n")[1]![0], 'He said "about $250"');
});

test("a blank value column means back to the default, and is carried as such", () => {
  const r = entriesFromCsv("key,value\ntransport.wdw.off,\n");
  assert.equal(r.ok, true);
  // applySettings reads "" as "clear it" — pinned here because the CSV path is
  // the one place an empty cell is easy to mistake for zero.
  if (r.ok) assert.equal(r.entries[0]!.value, "");
});
