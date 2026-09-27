import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import {
  parseDateLoose, matchResort, parseMoney, validateCheck, unitOf, matchHotel,
  ticketBandFrom, ticketDaysFrom, addChecks, listChecks, deleteCheck, type CheckValue,
} from "./priceChecks.js";
import {
  computeFactors, shrink, ratioOf, summarizeByLead, leadBucket, countedChecks, cheapestRoomPerStay,
  FACTOR_MAX, type CountedCheck,
} from "./checkFactors.js";
import { loadBook } from "./book.js";
import { setSetting } from "./settings.js";
import { RESORT_BY_ID } from "./config.js";
import { EXCHANGE_RATES } from "./exchangeData.js";
import { hotelSeasonFactor } from "./seasonality.js";
import { addDaysISO, todayISO, range } from "./dates.js";

const tdr = RESORT_BY_ID.get("tdr")!;

/* ------------------------------ reading a row ---------------------------- */

test("dates the way a spreadsheet writes them are read, and impossible ones are not", () => {
  assert.equal(parseDateLoose("12/17/2026"), "2026-12-17", "the owner's own sheet used M/D/YYYY");
  assert.equal(parseDateLoose("2026-12-17"), "2026-12-17");
  assert.equal(parseDateLoose("3/5/27"), "2027-03-05");
  assert.equal(parseDateLoose("2026-02-30"), null);
  assert.equal(parseDateLoose("17/12/2026"), null, "day-first is refused rather than read as the 17th month");
});

test("a resort by name, city or id — with the Disneylands kept apart", () => {
  assert.equal(matchResort("Tokyo")?.id, "tdr");
  assert.equal(matchResort("Disneyland Paris")?.id, "dlp");
  assert.equal(matchResort("Hong Kong Disneyland")?.id, "hkdl");
  assert.equal(matchResort("Disneyland")?.id, "dlr");
  assert.equal(matchResort("wdw")?.id, "wdw");
  assert.equal(matchResort("Orlando")?.id, "wdw");
  assert.equal(matchResort("Six Flags"), undefined);
});

test("amounts as the owner typed them: yen written out, symbols, and a blank currency", () => {
  const yen = parseMoney("502500 yen", "", tdr);
  assert.ok(yen.ok && yen.currency === "JPY" && yen.amount === 502500);
  const yn = parseMoney("360 Yn", "", tdr);
  assert.ok(yn.ok && yn.currency === "JPY" && yn.amount === 360, "the sheet's own typo for yen");
  const sym = parseMoney("¥10,900", "", tdr);
  assert.ok(sym.ok && sym.currency === "JPY" && sym.amount === 10900);
  const yuan = parseMoney("¥659", "", RESORT_BY_ID.get("shdr")!);
  assert.ok(yuan.ok && yuan.currency === "CNY", "¥ is the yuan in Shanghai");
  const hk = parseMoney("790", "HKD", RESORT_BY_ID.get("hkdl")!);
  assert.ok(hk.ok && hk.currency === "HKD");
  const bare = parseMoney("2081", "", tdr);
  assert.ok(bare.ok && bare.currency === "USD" && bare.guessed, "a bare number is dollars, and says it guessed");
  assert.equal(parseMoney("", "", tdr).ok, false);
  assert.equal(parseMoney("100", "GBP", tdr).ok, false, "a currency we can't convert is refused, not guessed");
});

const tokyoHotel = {
  trip: "Tokyo Christmas (expensive)", checked_on: "2026-09-27", resort: "tdr", category: "hotel",
  item: "Tokyo Disney Celebration Hotel", detail: "Discover", start_date: "2026-12-17", end_date: "2026-12-22",
  amount: "250000", currency: "JPY", price_is: "whole_stay",
};

test("the owner's Tokyo rows validate, and a whole stay becomes a nightly rate", () => {
  const v = validateCheck(tokyoHotel, "2026-09-27");
  assert.ok(v.ok);
  if (!v.ok) return;
  const u = unitOf(v.value);
  const expected = Math.round((250000 / EXCHANGE_RATES.JPY!.perUsd / 5) * 100) / 100;
  assert.equal(u.unitUsd, expected, "250,000 yen over 5 nights, in dollars");
  assert.equal(u.unit, "per room, per night");

  const flight = validateCheck({ checked_on: "9/27/2026", resort: "Tokyo", category: "flight",
    from_airport: "RDU", start_date: "12/17/2026", end_date: "12/22/2026", amount: "2081" }, "2026-09-27");
  assert.ok(flight.ok);
  if (flight.ok) {
    assert.equal(flight.value.priceIs, "per_person", "a flight defaults to per person");
    assert.equal(unitOf(flight.value).unitUsd, 2081);
  }
});

test("rows that can't be read say what to fix", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...tokyoHotel, resort: "Six Flags" }, /not one of the six resorts/],
    [{ ...tokyoHotel, category: "vibes" }, /not a category/],
    [{ ...tokyoHotel, end_date: "" }, /needs an end_date/],
    [{ ...tokyoHotel, checked_on: "2099-01-01" }, /in the future/],
    [{ ...tokyoHotel, end_date: "2026-12-01" }, /before start_date/],
    [{ resort: "tdr", category: "flight", from_airport: "ZZZ", start_date: "2026-12-17", amount: "900" }, /departure airport/],
  ];
  for (const [row, re] of cases) {
    const v = validateCheck(row, "2026-09-27");
    assert.equal(v.ok, false, String(re));
    if (!v.ok) assert.match(v.reason, re);
  }
});

test("a blank currency at a foreign resort warns rather than passing silently", () => {
  const v = validateCheck({ ...tokyoHotel, amount: "250000", currency: "" }, "2026-09-27");
  assert.ok(v.ok);
  if (v.ok) assert.ok(v.warnings.some((w) => /read as US dollars/.test(w)));
});

test("a party total is split per person only when the party size is known", () => {
  const base = validateCheck({ resort: "tdr", category: "ticket", start_date: "2026-12-17", amount: "400", price_is: "total" }, "2026-09-27");
  assert.ok(base.ok);
  if (!base.ok) return;
  assert.equal(unitOf(base.value).unitUsd, null);
  const withParty: CheckValue = { ...base.value, adults: 2, childrenAges: [6, 9] };
  assert.equal(unitOf(withParty).unitUsd, 100);
});

test("hotel names are matched the way people type them", () => {
  assert.equal(matchHotel(tdr, "Disney Celebration Hotel")?.id, "tdr-ch");
  assert.equal(matchHotel(tdr, "Tokyo Disneyland Hotel")?.id, "tdr-tdh");
  assert.equal(matchHotel(tdr, "Disney Ambassador Hotel")?.id, "tdr-amb");
  assert.equal(matchHotel(tdr, "Hotel MiraCosta")?.id, "tdr-mc");
  assert.equal(matchHotel(tdr, "Hilton Tokyo Bay"), undefined, "a hotel we don't price is not forced onto one we do");
});

test("ticket wording: which band, how many days", () => {
  assert.equal(ticketBandFrom("1-Day Passport Adult (18+)"), "adult");
  assert.equal(ticketBandFrom("Child (4-11)"), "child");
  assert.equal(ticketBandFrom("Junior 12-17"), "junior");
  assert.equal(ticketBandFrom("Senior 60+"), "senior");
  assert.equal(ticketDaysFrom("1-Day Passport"), 1);
  assert.equal(ticketDaysFrom("4 day ticket"), 4);
});

/* ----------------------------------- the math ---------------------------- */

const hotelCheck = (unitUsd: number, groupKey = "g1", modelUsd = 200): CountedCheck =>
  ({ category: "hotel", matchKey: "tdr-ch", unitUsd, modelUsd, modelBaseUsd: 180, groupKey });

test("one check moves an estimate a quarter of the way; three move it halfway", () => {
  assert.equal(shrink(2, 1, 3), 1.25);
  assert.equal(shrink(2, 3, 3), 1.5);
  assert.equal(shrink(2, 1, 0), FACTOR_MAX, "0 trusts the checks completely");
  assert.equal(shrink(1.62, 0, 3), 1, "no checks, no change");
});

test("room types on one stay count once, at the cheapest room", () => {
  // Superior at 1.5x our rate and a family room at 3x: the family room is a
  // different product, not evidence that the hotel costs three times as much.
  const f = computeFactors([hotelCheck(300, "stay1"), hotelCheck(600, "stay1")], { priorWeight: 3 });
  const x = f.get("hotel|tdr-ch")!;
  assert.equal(x.n, 1);
  assert.equal(x.medianRatio, 1.5);
  assert.equal(x.factor, 1.125);
});

test("a ratio that is surely a typo is kept out of the math", () => {
  const f = computeFactors([hotelCheck(200 * 40, "a")], { priorWeight: 3 });
  assert.equal(f.size, 0, "40x is a currency mistake, not a price");
});

test("a base rate changed since the check is not counted twice", () => {
  const c = hotelCheck(300);
  assert.equal(ratioOf(c), 1.5);
  // The owner raised the base from 180 to 270 — our model is now 300 too.
  assert.equal(ratioOf(c, 270), 1);
  const f = computeFactors([c], { priorWeight: 3, hotelBase: () => 270 });
  assert.equal(f.get("hotel|tdr-ch")!.factor, 1);
});

test("how far ahead a price was checked is bucketed and summarized", () => {
  assert.equal(leadBucket(30), "Under 2 months");
  assert.equal(leadBucket(81), "2–4 months");
  assert.equal(leadBucket(170), "4–6 months");
  assert.equal(leadBucket(400), "9 months or more");
  const s = summarizeByLead([
    { category: "hotel", leadDays: 81, ratio: 1.2 },
    { category: "hotel", leadDays: 90, ratio: 1.4 },
    { category: "hotel", leadDays: 300, ratio: 1.0 },
    { category: "food", leadDays: null, ratio: null },
  ]);
  assert.deepEqual(s.map((x) => [x.bucket, x.n, x.medianRatio]),
    [["2–4 months", 2, 1.3], ["9 months or more", 1, 1]]);
});

/* ------------------------------ end to end ------------------------------- */

async function seedTokyo(db: Awaited<ReturnType<typeof memoryDb>>, from: string, nights: number) {
  for (const d of range(from, addDaysISO(from, nights))) {
    await db.query(
      `insert into hotel_rates (hotel_id, resort_id, hotel_name, descriptor, stay_date, nightly_usd, tier, on_property)
       values ('tdr-ch','tdr','Tokyo Disney Celebration Hotel','Value · shuttle',$1,200,'value',true)`, [d]);
    await db.query(
      `insert into ticket_prices (resort_id, park_date, adult_usd, child_usd) values ('tdr',$1,60,40)`, [d]);
  }
}

test("a hotel check is stored with both dates and our figure that day, and nudges the rate", async () => {
  const db = await memoryDb();
  const today = todayISO();
  const start = addDaysISO(today, 80), end = addDaysISO(start, 5);
  await seedTokyo(db, start, 5);
  const row = { ...tokyoHotel, checked_on: today, start_date: start, end_date: end };
  const v = validateCheck(row);
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(await addChecks(db, [v.value], "owner@example.com"), { added: 1, duplicates: 0 });
  assert.deepEqual(await addChecks(db, [v.value]), { added: 0, duplicates: 1 },
    "the same price uploaded twice is one data point");

  const [c] = await listChecks(db);
  assert.equal(c!.leadDays, 80, "how far ahead it was checked is kept");
  assert.equal(c!.matchKey, "tdr-ch");
  const nights = range(start, addDaysISO(start, 4));
  const model = nights.reduce((a, d) => a + 180 * hotelSeasonFactor("tdr", d), 0) / nights.length;
  assert.ok(Math.abs(c!.modelUsd! - model) < 0.02, "our model that day, from the base rate and the season");
  assert.equal(c!.notCounted, "");
  assert.ok(c!.ratio! > 1);

  // The board now reads the nudged rate, and says so.
  const book = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: end, tripLength: 4 });
  const night = book.hotelNights("tdr", start).find((h) => h.hotelId === "tdr-ch")!;
  const f = computeFactors(await countedChecks(db), { priorWeight: 3 }).get("hotel|tdr-ch")!;
  assert.equal(night.nightly, Math.round(200 * f.factor * 100) / 100);
  assert.deepEqual(night.checkAdjust, { pct: Math.round((f.factor - 1) * 100), n: 1 });

  // ...unless asked for the model as it stands without checks, or switched off.
  const raw = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: end, tripLength: 4 }, { applyChecks: false });
  assert.equal(raw.hotelNights("tdr", start).find((h) => h.hotelId === "tdr-ch")!.nightly, 200);
  await setSetting(db, "checks.use", 0);
  const off = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: end, tripLength: 4 });
  assert.equal(off.hotelNights("tdr", start).find((h) => h.hotelId === "tdr-ch")!.nightly, 200);

  assert.equal(await deleteCheck(db, c!.id), true);
  assert.equal((await listChecks(db)).length, 0);
});

test("a family room on the same stay is kept but does not double the nudge", async () => {
  const db = await memoryDb();
  const start = addDaysISO(todayISO(), 80), end = addDaysISO(start, 5);
  await seedTokyo(db, start, 5);
  const rows = [
    { ...tokyoHotel, item: "Disney Ambassador Hotel", detail: "Superior", amount: "371500", start_date: start, end_date: end },
    { ...tokyoHotel, item: "Disney Ambassador Hotel", detail: "Family Room", amount: "768000", start_date: start, end_date: end },
  ].map((r) => validateCheck({ ...r, checked_on: todayISO() }));
  await addChecks(db, rows.map((r) => (r as { ok: true; value: CheckValue }).value));
  assert.equal((await listChecks(db)).length, 2, "both kept");
  const f = computeFactors(await countedChecks(db), { priorWeight: 3 }).get("hotel|tdr-amb")!;
  assert.equal(f.n, 1, "one stay, counted at its standard room");
});

test("tickets compare against that day's ticket price, and food is a record only", async () => {
  const db = await memoryDb();
  const start = addDaysISO(todayISO(), 80);
  await seedTokyo(db, start, 1);
  const t = validateCheck({ resort: "tdr", category: "ticket", item: "1-Day Passport", detail: "Adult (18+)",
    start_date: start, amount: "¥10,900" });
  const food = validateCheck({ resort: "tdr", category: "food", item: "Eastside Cafe", detail: "Child's set", amount: "1400 yen" });
  assert.ok(t.ok && food.ok);
  if (!t.ok || !food.ok) return;
  await addChecks(db, [t.value, food.value]);
  const list = await listChecks(db);
  const ticket = list.find((x) => x.category === "ticket")!;
  assert.equal(ticket.modelUsd, 60, "the day's adult price, one day");
  assert.equal(ticket.matchKey, "tdr");
  const meal = list.find((x) => x.category === "food")!;
  assert.match(meal.notCounted, /kept as a record/);
  assert.ok(meal.unitUsd! > 0, "still converted and stored");

  const book = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: start, tripLength: 4 });
  const row = book.ticket("tdr", start)!;
  assert.ok(row.adult > 60, "the day's ticket nudged toward what was seen");
  assert.equal(row.checkAdjust?.n, 1);
});

test("a flight check is measured against our estimate, and nudges that route's estimate", async () => {
  const db = await memoryDb();
  const start = addDaysISO(todayISO(), 80);
  const q = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
  await db.query(
    `insert into historical_fares (origin, destination, year, quarter, avg_fare_usd, p25_fare_usd, median_fare_usd,
       p75_fare_usd, passengers_sampled, source, fetched_at)
     values ('RDU','NRT', $1, $2, 1000, 900, 1000, 1100, 50, 'sampled_live', now())`,
    [new Date().getUTCFullYear(), q]);
  const v = validateCheck({ resort: "tdr", category: "flight", from_airport: "RDU", start_date: start,
    end_date: addDaysISO(start, 5), amount: "2081" });
  assert.ok(v.ok);
  if (!v.ok) return;
  await addChecks(db, [v.value]);
  const [c] = await listChecks(db);
  assert.equal(c!.matchKey, "RDU|tdr");
  assert.ok(c!.modelUsd! >= 1000 && c!.modelUsd! <= 1100 * 1.6, `our estimate that day, not ${c!.modelUsd}`);
  const book = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: start, tripLength: 4 });
  const est = book.flightEstimate!("RDU", "NRT")!;
  assert.ok(est.med > 1000, "the route's estimate moved toward the fare seen");
  assert.equal(est.checkAdjust?.n, 1);
  const raw = await loadBook(db, { origin: "RDU", destinations: ["NRT"], resortIds: ["tdr"], from: start, to: start, tripLength: 4 }, { applyChecks: false });
  assert.equal(raw.flightEstimate!("RDU", "NRT")!.med, 1000);
});

test("the lead-time table reads one row per hotel stay, at its cheapest room", () => {
  const row = (unitUsd: number, detail: string) => ({ category: "hotel", matchKey: "tdr-amb", startDate: "2026-12-17",
    endDate: "2026-12-22", checkedOn: "2026-09-27", unitUsd, detail, leadDays: 81, ratio: unitUsd / 463 });
  const kept = cheapestRoomPerStay([row(473, "Superior"), row(977, "Family Room"), row(524, "Character Room")]);
  assert.deepEqual(kept.map((r) => r.detail), ["Superior"]);
  assert.equal(summarizeByLead(kept)[0]!.medianRatio, Math.round((473 / 463) * 1000) / 1000);
});
