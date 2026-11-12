/**
 * Cruises and Adventures by Disney, read from the owner's screenshots in
 * /admin (owner, 2026-11-12: "right now they should just store information
 * so if and when we launch those, we can have historical data"). Disney
 * publishes no price feed for either, and scraping its site was ruled out,
 * so the owner's own screenshots are the source. Nothing here prices a trip
 * or reaches a traveler.
 *
 * Every save is a NEW row with the day it was seen, so a price seen again
 * next week becomes history rather than replacing last week's. The only
 * delete is for a row saved by mistake.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { toUsd } from "./ticketCalendar.js";
import { settingsMap } from "./settings.js";

export const SIGHTING_CURRENCIES = ["USD", "GBP", "EUR"] as const;
export const CRUISE_CABINS = ["inside", "oceanview", "verandah", "suite"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : null;
};
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,£€\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const int = (v: unknown, lo: number, hi: number): number | null | "bad" => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : "bad";
};
const date = (v: unknown): string | null | "bad" => {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : "bad";
};
function seenOn(v: unknown, today: string): string | "bad" {
  const d = date(v);
  if (d === null) return today;
  if (d === "bad" || d > today) return "bad";
  return d;
}
function currencyOf(v: unknown): string | null {
  const c = typeof v === "string" && v ? v.toUpperCase() : "USD";
  return (SIGHTING_CURRENCIES as readonly string[]).includes(c) ? c : null;
}

/* ------------------------------- cruises ------------------------------- */

export interface CruiseInput {
  seenOn?: string; title?: string; nights?: unknown; departurePort?: string; ports?: string; ship?: string;
  sailDate?: string; cabin?: string; price?: unknown; currency?: string; save?: unknown; datesCount?: unknown;
  theme?: string; guaranteed?: unknown; note?: string; rawText?: string;
}
export interface CruiseRow {
  seenOn: string; title: string; nights: number | null; departurePort: string | null; ports: string | null;
  ship: string | null; sailDate: string | null; cabin: string | null; price: number; currency: string;
  priceUsd: number; save: number | null; datesCount: number | null; theme: string | null;
  guaranteed: boolean; note: string | null; rawText: string | null;
}

export function validateCruise(i: CruiseInput, today: string): Result<CruiseRow> {
  const title = text(i.title, 160);
  if (!title) return { ok: false, reason: "Give the cruise a name, like \"3-Night Bahamian Cruise from Fort Lauderdale\"." };
  const price = money(i.price);
  if (price === null || Number.isNaN(price) || price <= 0 || price > 200000)
    return { ok: false, reason: `"${title}": the price per person should be a number, like 686.` };
  const currency = currencyOf(i.currency);
  if (!currency) return { ok: false, reason: `"${title}": the currency should be USD, GBP or EUR.` };
  const save = money(i.save);
  if (Number.isNaN(save) || (save !== null && (save < 0 || save > 200000)))
    return { ok: false, reason: `"${title}": "Save" should be a number like 138, or blank.` };
  const nights = int(i.nights, 1, 60), datesCount = int(i.datesCount, 0, 999);
  if (nights === "bad") return { ok: false, reason: `"${title}": nights should be a whole number from 1 to 60.` };
  if (datesCount === "bad") return { ok: false, reason: `"${title}": the number of dates should be a whole number.` };
  const sailDate = date(i.sailDate);
  if (sailDate === "bad") return { ok: false, reason: `"${title}": the sail date should be a real date.` };
  const seen = seenOn(i.seenOn, today);
  if (seen === "bad") return { ok: false, reason: `"${title}": the day you saw it can't be in the future.` };
  const cabin = text(i.cabin, 20)?.toLowerCase() ?? null;
  if (cabin && !(CRUISE_CABINS as readonly string[]).includes(cabin))
    return { ok: false, reason: `"${title}": the room should be inside, oceanview, verandah or suite, or blank.` };
  return { ok: true, value: {
    seenOn: seen, title, nights, departurePort: text(i.departurePort, 80), ports: text(i.ports, 300),
    ship: text(i.ship, 80), sailDate, cabin, price, currency, priceUsd: toUsd(price, currency),
    save, datesCount, theme: text(i.theme, 80), guaranteed: i.guaranteed === true || i.guaranteed === "true",
    note: text(i.note, 400), rawText: typeof i.rawText === "string" ? i.rawText.slice(0, 10000) : null,
  } };
}

/** Saves several cruises at once (one screenshot holds several), all or
 *  nothing, so a bad row never leaves half a screenshot saved. */
export async function saveCruises(db: Db, inputs: CruiseInput[], today: string):
  Promise<{ ok: true; saved: number } | { ok: false; reason: string }> {
  if (!Array.isArray(inputs) || !inputs.length) return { ok: false, reason: "Nothing to save." };
  if (inputs.length > 50) return { ok: false, reason: "That's more than 50 cruises at once." };
  const rows: CruiseRow[] = [];
  for (const i of inputs) { const v = validateCruise(i, today); if (!v.ok) return v; rows.push(v.value); }
  for (const r of rows) {
    await db.query(
      `insert into cruise_sightings (id, seen_on, title, nights, departure_port, ports, ship, sail_date, cabin,
         price, currency, price_usd, save_amount, dates_count, theme, guaranteed, note, raw_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [randomUUID(), r.seenOn, r.title, r.nights, r.departurePort, r.ports, r.ship, r.sailDate, r.cabin,
        r.price, r.currency, r.priceUsd, r.save, r.datesCount, r.theme, r.guaranteed, r.note, r.rawText]);
  }
  return { ok: true, saved: rows.length };
}

/**
 * Disney's recommended gratuity for one person over a whole sailing, in
 * dollars, at TODAY's rates from /admin settings (not stored with the row, so
 * a rate the owner corrects applies to every saved cruise). Suites and
 * Concierge pay the higher rate. Null when the nights are unknown.
 */
export function gratuityPerPerson(nights: number | null, cabin: string | null,
  rates: { regular: number; concierge: number }): number | null {
  if (!nights) return null;
  const perNight = cabin === "suite" ? rates.concierge : rates.regular;
  return Math.round(nights * perNight * 100) / 100;
}

export interface CruiseSighting extends Omit<CruiseRow, "rawText"> {
  id: string; savedAt: string;
  /** Gratuities for one person, in dollars, and the dollar price with them added. */
  gratuityUsd: number | null; withGratuityUsd: number | null;
}
export async function listCruises(db: Db, limit = 1000): Promise<CruiseSighting[]> {
  const r = await db.query<any>(
    `select * from cruise_sightings order by seen_on desc, created_at desc limit $1`, [limit]);
  let set = new Map<string, number>();
  try { set = await settingsMap(db); } catch { /* fall back to the shipped rates below */ }
  const rates = { regular: set.get("cruise.gratuityPerNight") ?? 16,
    concierge: set.get("cruise.gratuityConciergePerNight") ?? 27.25 };
  return r.rows.map((x) => {
    const grat = gratuityPerPerson(x.nights, x.cabin, rates);
    return {
    gratuityUsd: grat,
    withGratuityUsd: grat === null ? null : Math.round((Number(x.price_usd) + grat) * 100) / 100,
    id: x.id, savedAt: new Date(x.created_at).toISOString(), seenOn: dateStr(x.seen_on), title: x.title,
    nights: x.nights, departurePort: x.departure_port, ports: x.ports, ship: x.ship,
    sailDate: x.sail_date ? dateStr(x.sail_date) : null, cabin: x.cabin, price: Number(x.price),
    currency: x.currency, priceUsd: Number(x.price_usd), save: x.save_amount === null ? null : Number(x.save_amount),
    datesCount: x.dates_count, theme: x.theme, guaranteed: x.guaranteed, note: x.note,
    };
  });
}
export async function deleteCruise(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from cruise_sightings where id = $1 returning id`, [id])).rows.length > 0;
}

/* ------------------------- Adventures by Disney ------------------------- */

export interface AdventureInput {
  seenOn?: string; tripName?: string; destination?: string; days?: unknown; nights?: unknown;
  departureDate?: string; price?: unknown; childPrice?: unknown; currency?: string; tripType?: string;
  meals?: unknown; breakfasts?: unknown; lunches?: unknown; dinners?: unknown; minAge?: unknown;
  suggestedAge?: unknown; adultExclusiveAge?: unknown; highlights?: unknown; note?: string; rawText?: string;
}
export interface AdventureRow {
  seenOn: string; tripName: string; destination: string | null; days: number | null; nights: number | null;
  departureDate: string | null; price: number; childPrice: number | null; currency: string; priceUsd: number;
  tripType: string | null; meals: number | null; breakfasts: number | null; lunches: number | null;
  dinners: number | null; minAge: number | null; suggestedAge: number | null; adultExclusiveAge: number | null;
  highlights: string[]; note: string | null; rawText: string | null;
}

export function validateAdventure(i: AdventureInput, today: string): Result<AdventureRow> {
  const tripName = text(i.tripName, 160);
  if (!tripName) return { ok: false, reason: "Give the trip its name, like \"Germany: Munich Escape\". The screenshot often doesn't show it." };
  const price = money(i.price), childPrice = money(i.childPrice);
  if (price === null || Number.isNaN(price) || price <= 0 || price > 200000)
    return { ok: false, reason: "The price per person should be a number, like 2799." };
  if (Number.isNaN(childPrice) || (childPrice !== null && (childPrice <= 0 || childPrice > 200000)))
    return { ok: false, reason: "The child price should be a number, or blank." };
  const currency = currencyOf(i.currency);
  if (!currency) return { ok: false, reason: "The currency should be USD, GBP or EUR." };
  const nums: Record<string, number | null> = {};
  for (const [k, lo, hi, label] of [["days", 1, 60, "days"], ["nights", 0, 60, "nights"], ["meals", 0, 200, "meals"],
    ["breakfasts", 0, 60, "breakfasts"], ["lunches", 0, 60, "lunches"], ["dinners", 0, 60, "dinners"],
    ["minAge", 0, 25, "minimum age"], ["suggestedAge", 0, 25, "suggested age"],
    ["adultExclusiveAge", 0, 25, "adults-only age"]] as const) {
    const v = int((i as any)[k], lo, hi);
    if (v === "bad") return { ok: false, reason: `The ${label} should be a whole number from ${lo} to ${hi}, or blank.` };
    nums[k] = v;
  }
  const departureDate = date(i.departureDate);
  if (departureDate === "bad") return { ok: false, reason: "The departure date should be a real date, or blank." };
  const seen = seenOn(i.seenOn, today);
  if (seen === "bad") return { ok: false, reason: "The day you saw it can't be in the future." };
  const raw = Array.isArray(i.highlights) ? i.highlights : typeof i.highlights === "string" ? i.highlights.split(/\n|;/) : [];
  const highlights = raw.map((h) => text(h, 120)).filter((h): h is string => !!h).slice(0, 12);
  return { ok: true, value: {
    seenOn: seen, tripName, destination: text(i.destination, 80), days: nums.days!, nights: nums.nights!,
    departureDate, price, childPrice, currency, priceUsd: toUsd(price, currency), tripType: text(i.tripType, 40),
    meals: nums.meals!, breakfasts: nums.breakfasts!, lunches: nums.lunches!, dinners: nums.dinners!,
    minAge: nums.minAge!, suggestedAge: nums.suggestedAge!, adultExclusiveAge: nums.adultExclusiveAge!,
    highlights, note: text(i.note, 400), rawText: typeof i.rawText === "string" ? i.rawText.slice(0, 10000) : null,
  } };
}

export async function saveAdventure(db: Db, input: AdventureInput, today: string):
  Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateAdventure(input, today);
  if (!v.ok) return v;
  const r = v.value, id = randomUUID();
  await db.query(
    `insert into adventure_sightings (id, seen_on, trip_name, destination, days, nights, departure_date, price,
       child_price, currency, price_usd, trip_type, meals, breakfasts, lunches, dinners, min_age, suggested_age,
       adult_exclusive_age, highlights, note, raw_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [id, r.seenOn, r.tripName, r.destination, r.days, r.nights, r.departureDate, r.price, r.childPrice, r.currency,
      r.priceUsd, r.tripType, r.meals, r.breakfasts, r.lunches, r.dinners, r.minAge, r.suggestedAge,
      r.adultExclusiveAge, JSON.stringify(r.highlights), r.note, r.rawText]);
  return { ok: true, id };
}

export interface AdventureSighting extends Omit<AdventureRow, "rawText"> { id: string; savedAt: string }
export async function listAdventures(db: Db, limit = 1000): Promise<AdventureSighting[]> {
  const r = await db.query<any>(
    `select * from adventure_sightings order by seen_on desc, created_at desc limit $1`, [limit]);
  return r.rows.map((x) => {
    let highlights: string[] = [];
    try { highlights = JSON.parse(x.highlights || "[]"); } catch { highlights = []; }
    return {
      id: x.id, savedAt: new Date(x.created_at).toISOString(), seenOn: dateStr(x.seen_on), tripName: x.trip_name,
      destination: x.destination, days: x.days, nights: x.nights,
      departureDate: x.departure_date ? dateStr(x.departure_date) : null, price: Number(x.price),
      childPrice: x.child_price === null ? null : Number(x.child_price), currency: x.currency,
      priceUsd: Number(x.price_usd), tripType: x.trip_type, meals: x.meals, breakfasts: x.breakfasts,
      lunches: x.lunches, dinners: x.dinners, minAge: x.min_age, suggestedAge: x.suggested_age,
      adultExclusiveAge: x.adult_exclusive_age, highlights, note: x.note,
    };
  });
}
export async function deleteAdventure(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from adventure_sightings where id = $1 returning id`, [id])).rows.length > 0;
}
