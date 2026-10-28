import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTicketCalendar } from "../public/screenshot-reader.js";
import { validateCalendar, saveCalendar, latestCalendar, oneDayFigure, calendarSummary } from "./ticketCalendar.js";
import { seedTickets } from "./jobs/refresh.js";
import { RESORT_BY_ID } from "./config.js";
import { ticketMultiDay } from "./pricing.js";
import { memoryDb } from "./db.js";

// The owner's screenshot of 2026-10-21 (Walt Disney World, 5-day ticket,
// October 2027), rebuilt as a page and read by the real reader in Chromium:
// these are the words and boxes Tesseract handed back, verbatim.
const OCT_2027: Record<number, number> = { 1: 145, 2: 153, 3: 153, 4: 153, 5: 153, 6: 154, 7: 154, 8: 155, 9: 155, 10: 154,
  11: 152, 12: 152, 13: 152, 14: 152, 15: 152, 16: 153, 17: 147, 18: 147, 19: 147, 20: 152, 21: 152, 22: 153, 23: 155,
  24: 154, 25: 156, 26: 157, 27: 158, 28: 158, 29: 159, 30: 160, 31: 158 };
const words = (JSON.parse(readFileSync(new URL("./testdata/wdw-ticket-calendar-2027-10.words.json", import.meta.url), "utf8")) as Array<[string, number, number, number, number]>)
  .map(([text, x0, y0, x1, y1]) => ({ text, x0, y0, x1, y1 }));

test("ticket calendar: real OCR of Disney's October 2027 5-day calendar reads every day right", () => {
  const cal = readTicketCalendar(words);
  assert.equal(cal.month, "2027-10");
  assert.equal(cal.ticketDays, 5);
  assert.equal(cal.adultAges, "10+");
  assert.equal(cal.prices.length, 31);
  for (const p of cal.prices) assert.equal(p.perDay, OCT_2027[Number(p.date.slice(8))], p.date);
  // The "From $130 per day" strip above the calendar and "$154.36" in the
  // footer are not calendar days.
  assert.deepEqual(cal.missing, []);
});

test("ticket calendar: without the Sun-Sat headings the columns come from the prices", () => {
  const noHeads = words.filter((w) => !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(w.text));
  const cal = readTicketCalendar(noHeads);
  assert.equal(cal.prices.length, 31);
  for (const p of cal.prices) assert.equal(p.perDay, OCT_2027[Number(p.date.slice(8))], p.date);
  assert.ok(cal.warnings.some((w: string) => /headings/.test(w)));
});

test("ticket calendar: no month heading is said, not guessed", () => {
  const cal = readTicketCalendar(words.filter((w) => !/^(October|2027)$/.test(w.text)));
  assert.equal(cal.month, null);
  assert.equal(cal.prices.length, 0);
  assert.match(cal.warnings[0]!, /month/);
});

test("ticket calendar import: checked, kept append-only, and the board prices from it", async () => {
  const db = await memoryDb();
  const month = "2099-03";
  const prices = Array.from({ length: 31 }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, perDay: 150 }));
  assert.equal(validateCalendar({ resortId: "hkdl", ticketDays: 5, month, prices }, "2026-10-21").ok, false, "USD calendars only");
  assert.equal(validateCalendar({ resortId: "dlr", ticketDays: 5, month, prices }, "2026-10-21").ok, false, "Disneyland's 2-5 day tickets have no calendar");
  assert.equal(validateCalendar({ resortId: "dlr", ticketDays: 1, month, prices }, "2026-10-21").ok, true, "Disneyland's 1-day calendar is kept");
  assert.equal(validateCalendar({ resortId: "wdw", ticketDays: 5, month, prices: prices.slice(0, 3) }, "2026-10-21").ok, false, "a crop, not a month");
  assert.equal(validateCalendar({ resortId: "wdw", ticketDays: 5, month, prices: [{ date: "2099-04-01", perDay: 150 }, ...prices] }, "2026-10-21").ok, false);
  const bad = validateCalendar({ resortId: "wdw", ticketDays: 5, month, prices: [...prices.slice(1), { date: `${month}-01`, perDay: 1534 }] }, "2026-10-21");
  assert.equal(bad.ok, false, "a misread digit is refused, by date");
  const v = validateCalendar({ resortId: "wdw", ticketDays: 5, month, prices }, "2026-10-21");
  assert.ok(v.ok);
  if (!v.ok) return;
  await saveCalendar(db, v.value, "owner@example.com");
  // A second import of the same month is a new row; the newer wins.
  await saveCalendar(db, { ...v.value, prices: v.value.prices.map((p) => ({ ...p, perDay: 160 })) }, "owner@example.com");
  const held = await db.query(`select count(*)::int as n from ticket_calendar where resort_id = 'wdw'`);
  assert.equal(Number((held.rows[0] as { n: number }).n), 62, "both imports kept");
  const latest = await latestCalendar(db, `${month}-01`, `${month}-31`);
  assert.equal(latest.get(`wdw|${month}-15`)![5], 160);
  await seedTickets(db, [month], ["wdw"]);
  const row = (await db.query(`select adult_usd, from_calendar from ticket_prices where resort_id = 'wdw' and park_date = '${month}-15'`)).rows[0] as { adult_usd: string; from_calendar: boolean };
  assert.equal(row.from_calendar, true);
  const wdw = RESORT_BY_ID.get("wdw")!;
  // The one-day figure, priced as a 5-day ticket, gives back Disney's 5 x $160.
  assert.ok(Math.abs(Number(row.adult_usd) * ticketMultiDay(wdw, 5) * 5 - 800) < 0.1);
  assert.equal(oneDayFigure(wdw, 160, 5), Number(row.adult_usd));
  const sum = await calendarSummary(db);
  assert.deepEqual(sum.map((x) => [x.resortId, x.month, x.ticketDays, x.dates, x.low]), [["wdw", month, 5, 31, 160]]);
});

test("a calendar date prices the whole ticket from its START day, as Disney does", async () => {
  const { priceTrip } = await import("./pricing.js");
  const { bookFrom } = await import("./book.js");
  const wdw = RESORT_BY_ID.get("wdw")!;
  const start = "2099-03-02";
  const one = (perDay: number) => oneDayFigure(wdw, perDay, 5);
  const dates = Array.from({ length: 10 }, (_, i) => `2099-03-${String(i + 2).padStart(2, "0")}`);
  const book = bookFrom({
    flights: dates.map((date) => ({ dest: "MCO", date, row: { price: 400, stops: 0 } })),
    hotels: dates.flatMap((date) => [{ resortId: "wdw", date, night: { hotelId: "m", name: "Moderate", descriptor: "Moderate resort", nightly: 300, tier: "moderate" as const, onProperty: true } }]),
    tickets: dates.map((date, i) => ({ resortId: "wdw", date, row: { adult: one(150 + i * 10), child: one(150 + i * 10) * 0.966, fromCalendar: true } })),
    promos: [],
  });
  const r = priceTrip(book, wdw, { origin: "ATL", adults: 1, childAges: [], nights: 6, parkDays: 5, stay: "on", tier: 1, food: "mix" }, {}, start);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.price.ticketsFromCalendar, true);
  // 5 x the start day's $150, plus Disney's 6.5% tax; not the average of the 2nd-6th.
  assert.ok(Math.abs(r.price.tickets - 150 * 5 * 1.065) < 0.05, String(r.price.tickets));
});

test("ticket calendars: each LENGTH is kept on its own; a second length adds, never replaces", async () => {
  const db = await memoryDb();
  const month = "2099-10";
  const prices = (perDay: number) => Array.from({ length: 31 }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, perDay }));
  for (const [days, perDay] of [[2, 193], [4, 179]] as const) {
    const v = validateCalendar({ resortId: "wdw", ticketDays: days, month, prices: prices(perDay) }, "2026-10-21");
    assert.ok(v.ok);
    if (v.ok) await saveCalendar(db, v.value, "owner@example.com");
  }
  const latest = await latestCalendar(db, `${month}-01`, `${month}-31`);
  assert.deepEqual(latest.get(`wdw|${month}-08`), { 2: 193, 4: 179 }, "the 4-day import did not replace the 2-day one");
  const sum = await calendarSummary(db);
  assert.deepEqual(sum.map((x) => [x.month, x.ticketDays, x.dates]), [[month, 2, 31], [month, 4, 31]]);
  // The nightly row's one-day figure comes from the length nearest Walt Disney
  // World's suggested 5 park days: the 4-day calendar.
  await seedTickets(db, [month], ["wdw"]);
  const row = (await db.query(`select adult_usd from ticket_prices where resort_id = 'wdw' and park_date = '${month}-08'`)).rows[0] as { adult_usd: string };
  assert.equal(Number(row.adult_usd), oneDayFigure(RESORT_BY_ID.get("wdw")!, 179, 4));
});

test("ticket calendars: a trip uses its own length exactly, else the nearest length held", async () => {
  const { priceTrip, calendarPerDay } = await import("./pricing.js");
  const { bookFrom } = await import("./book.js");
  const wdw = RESORT_BY_ID.get("wdw")!;
  const start = "2099-10-08";
  const dates = Array.from({ length: 8 }, (_, i) => `2099-10-${String(i + 8).padStart(2, "0")}`);
  const calendar = { 2: 193, 4: 179 };
  const book = bookFrom({
    flights: dates.map((date) => ({ dest: "MCO", date, row: { price: 400, stops: 0 } })),
    hotels: dates.map((date) => ({ resortId: "wdw", date, night: { hotelId: "m", name: "Moderate", descriptor: "Moderate resort", nightly: 300, tier: "moderate" as const, onProperty: true } })),
    tickets: dates.map((date) => ({ resortId: "wdw", date, row: { adult: oneDayFigure(wdw, 179, 4), child: oneDayFigure(wdw, 179, 4) * 0.966, fromCalendar: true, calendar } })),
    promos: [],
  });
  const price = (parkDays: number) => {
    const r = priceTrip(book, wdw, { origin: "ATL", adults: 1, childAges: [], nights: 6, parkDays, stay: "on", tier: 1, food: "mix" }, {}, start);
    assert.ok(r.ok);
    return r.ok ? r.price : null!;
  };
  // Disney's own numbers for Oct 8 2027: 2-day $386, 4-day $716 (plus 6.5% tax).
  const two = price(2), four = price(4), five = price(5), three = price(3);
  assert.ok(Math.abs(two.tickets - 193 * 2 * 1.065) < 0.05, String(two.tickets));
  assert.equal(two.ticketCalendarDays, 2);
  assert.ok(Math.abs(four.tickets - 179 * 4 * 1.065) < 0.05, String(four.tickets));
  assert.equal(four.ticketCalendarDays, 4);
  // No 5-day calendar: the 4-day one, carried by Disney's length discount.
  assert.equal(five.ticketCalendarDays, 4);
  assert.ok(Math.abs(five.tickets - calendarPerDay(wdw, calendar, 5)!.perDay * 5 * 1.065) < 0.05);
  assert.ok(five.tickets > four.tickets);
  // 3 days is as near 2 as 4: the longer ticket wins the tie.
  assert.equal(three.ticketCalendarDays, 4);
});

test("ticket calendars: a saved month can be opened again, newest price per date for that length", async () => {
  const { calendarMonth } = await import("./ticketCalendar.js");
  const db = await memoryDb();
  const month = "2099-11";
  const prices = (perDay: number) => Array.from({ length: 30 }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, perDay }));
  for (const [days, perDay] of [[5, 150], [5, 155], [2, 190]] as const) {
    const v = validateCalendar({ resortId: "wdw", ticketDays: days, month, prices: prices(perDay) }, "2026-10-21");
    if (v.ok) await saveCalendar(db, v.value, "owner@example.com");
  }
  const five = await calendarMonth(db, "wdw", month, 5);
  assert.equal(five.length, 30);
  assert.equal(five[0]!.date, `${month}-01`);
  assert.ok(five.every((p) => p.perDay === 155), "the newer 5-day import");
  assert.ok((await calendarMonth(db, "wdw", month, 2)).every((p) => p.perDay === 190));
  assert.deepEqual(await calendarMonth(db, "dlr", month, 5), []);
});

// The owner's September 2027 5-day calendar (2026-10-28): Disney's thin font
// draws "11" so tight that the reader sees "n" ("$112+" -> "$n2+").
const SEP_2027: Record<number, number> = { 1: 112, 2: 113, 3: 114, 4: 116, 5: 115, 6: 114, 7: 112, 8: 113, 9: 113, 10: 114,
  11: 116, 12: 116, 13: 116, 14: 115, 15: 116, 16: 116, 17: 118, 18: 119, 19: 117, 20: 115, 21: 114, 22: 116, 23: 117,
  24: 120, 25: 127, 26: 128, 27: 132, 28: 135, 29: 140, 30: 142 };
test("ticket calendar: a \"$11x\" price read as \"$n2+\" is repaired and marked to check", () => {
  const sep = (JSON.parse(readFileSync(new URL("./testdata/wdw-ticket-calendar-2027-09.words.json", import.meta.url), "utf8")) as Array<[string, number, number, number, number]>)
    .map(([text, x0, y0, x1, y1]) => ({ text, x0, y0, x1, y1 }));
  const cal = readTicketCalendar(sep);
  assert.equal(cal.month, "2027-09");
  assert.equal(cal.ticketDays, 5);
  assert.equal(cal.prices.length, 28);
  for (const p of cal.prices) assert.equal(p.perDay, SEP_2027[Number(p.date.slice(8))], p.date);
  // "$ns+" (118) and "7+" (117) can't be told apart from noise: left for the owner.
  assert.deepEqual(cal.missing, ["2027-09-17", "2027-09-19"]);
  const checked = cal.prices.filter((p) => p.check).map((p) => Number(p.date.slice(8)));
  assert.deepEqual(checked, [1, 2, 5, 6, 7, 8, 9, 11]);
});

test("ticket calendar: Disneyland's 1-day calendar, letter headings and \"$\" badges, reads every day", () => {
  // Owner's screenshot, 2026-10-28: day numbers above the prices, no "+",
  // headings S M T W T F S (the W missed), Dec 1-2 a green "$" badge read "0154".
  const dec = (JSON.parse(readFileSync(new URL("./testdata/dlr-ticket-calendar-2026-12.words.json", import.meta.url), "utf8")) as Array<[string, number, number, number, number]>)
    .map(([text, x0, y0, x1, y1]) => ({ text, x0, y0, x1, y1 }));
  const cal = readTicketCalendar(dec);
  assert.equal(cal.month, "2026-12");
  assert.equal(cal.ticketDays, null, "the page names no length");
  assert.equal(cal.resortGuess, "dlr");
  assert.deepEqual(cal.warnings, [], "the letter headings were read");
  const want: Record<number, number> = { 1: 154, 2: 154, 3: 174, 4: 199, 5: 199, 6: 189, 7: 174, 8: 174, 9: 189, 10: 174, 11: 189, 12: 199, 18: 199, 19: 224, 20: 224, 21: 199 };
  for (let d = 13; d <= 17; d++) want[d] = 189;
  for (let d = 22; d <= 31; d++) want[d] = 224;
  assert.equal(cal.prices.length, 31);
  for (const p of cal.prices) assert.equal(p.perDay, want[Number(p.date.slice(8))], p.date);
  assert.deepEqual(cal.prices.filter((p) => p.check).map((p) => p.date), ["2026-12-01", "2026-12-02"]);
});

test("Disneyland 2+ day tickets are one price for any date; the 1-day still follows the season", async () => {
  const { priceTrip } = await import("./pricing.js");
  const { bookFrom } = await import("./book.js");
  const dlr = RESORT_BY_ID.get("dlr")!;
  const price = (start: string, oneDay: number, parkDays: number, childAges: number[] = []) => {
    const dates = Array.from({ length: 8 }, (_, i) => { const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
    const book = bookFrom({
      flights: dates.map((date) => ({ dest: "LAX", date, row: { price: 300, stops: 0 } })),
      hotels: dates.map((date) => ({ resortId: "dlr", date, night: { hotelId: "p", name: "Pixar Place", descriptor: "On property", nightly: 400, tier: "moderate" as const, onProperty: true } })),
      tickets: dates.map((date) => ({ resortId: "dlr", date, row: { adult: oneDay, child: oneDay * dlr.ticket.child } })),
      promos: [],
    });
    const r = priceTrip(book, dlr, { origin: "ATL", adults: 1, childAges, nights: 5, parkDays, stay: "on", tier: 1, food: "mix" }, {}, start);
    assert.ok(r.ok);
    return r.ok ? r.price : null!;
  };
  // A quiet day's one-day row ($110) and a peak day's ($220): the 3-day costs $425 either way.
  const quiet = price("2099-02-02", 110, 3), peak = price("2099-07-01", 220, 3);
  assert.ok(Math.abs(quiet.tickets - 425) < 0.01, String(quiet.tickets));
  assert.ok(Math.abs(peak.tickets - 425) < 0.01, String(peak.tickets));
  assert.equal(peak.ticketsFlat, true);
  // A child (3-9) pays the child share.
  const fam = price("2099-07-01", 220, 3, [6]);
  assert.ok(Math.abs(fam.tickets - 425 * (1 + dlr.ticket.child)) < 0.01, String(fam.tickets));
  // The 1-day ticket still moves with the date.
  const one = price("2099-07-01", 220, 1);
  assert.equal(one.ticketsFlat, false);
  assert.ok(Math.abs(one.tickets - 220) < 0.01, String(one.tickets));
});

test("a saved Disneyland 1-day calendar prices a 1-day trip and never moves its flat 2-5 day tickets", async () => {
  const { priceTrip } = await import("./pricing.js");
  const { bookFrom } = await import("./book.js");
  const dlr = RESORT_BY_ID.get("dlr")!;
  const dates = Array.from({ length: 8 }, (_, i) => `2099-12-${String(i + 1).padStart(2, "0")}`);
  // A calendar row, as seedTickets writes it from a 1-day calendar: per day = the 1-day price.
  const book = bookFrom({
    flights: dates.map((date) => ({ dest: "LAX", date, row: { price: 300, stops: 0 } })),
    hotels: dates.map((date) => ({ resortId: "dlr", date, night: { hotelId: "p", name: "Pixar Place", descriptor: "On property", nightly: 400, tier: "moderate" as const, onProperty: true } })),
    tickets: dates.map((date) => ({ resortId: "dlr", date, row: { adult: 154, child: 154 * dlr.ticket.child, fromCalendar: true, calendar: { 1: 154 } } })),
    promos: [],
  });
  const trip = (parkDays: number) => {
    const r = priceTrip(book, dlr, { origin: "ATL", adults: 1, childAges: [], nights: 5, parkDays, stay: "on", tier: 1, food: "mix" }, {}, "2099-12-01");
    assert.ok(r.ok); return r.ok ? r.price : null!;
  };
  const one = trip(1);
  assert.equal(one.ticketsFromCalendar, true);
  assert.ok(Math.abs(one.tickets - 154) < 0.01, String(one.tickets));
  const three = trip(3);
  assert.equal(three.ticketsFlat, true);
  assert.ok(Math.abs(three.tickets - 425) < 0.01, String(three.tickets));
});
