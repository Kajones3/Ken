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
/** Disney's four room types (its fourth is "Concierge"; "suite" is kept for
 *  rows saved before 2026-11-13 and means the same). */
export const CRUISE_CABINS = ["inside", "oceanview", "verandah", "concierge", "suite"] as const;
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
  sailEnd?: string; was?: unknown; soldOut?: unknown; partyAdults?: unknown; partyChildren?: unknown;
}
export interface CruiseRow {
  seenOn: string; title: string; nights: number | null; departurePort: string | null; ports: string | null;
  ship: string | null; sailDate: string | null; cabin: string | null; price: number | null; currency: string;
  priceUsd: number | null; save: number | null; datesCount: number | null; theme: string | null;
  guaranteed: boolean; note: string | null; rawText: string | null;
  /** The last day of the sailing, the crossed-out price, "Unavailable", and
   *  the party the per-person price was shown for (blank = not recorded). */
  sailEnd: string | null; was: number | null; soldOut: boolean;
  partyAdults: number | null; partyChildren: number | null;
}

export function validateCruise(i: CruiseInput, today: string): Result<CruiseRow> {
  const title = text(i.title, 160);
  if (!title) return { ok: false, reason: "Give the cruise a name, like \"3-Night Bahamian Cruise from Fort Lauderdale\"." };
  const soldOut = i.soldOut === true || i.soldOut === "true";
  const price = money(i.price);
  if (soldOut ? (Number.isNaN(price) || (price !== null && (price <= 0 || price > 200000)))
    : (price === null || Number.isNaN(price) || price <= 0 || price > 200000))
    return { ok: false, reason: `"${title}": the price per person should be a number, like 686${soldOut ? ", or blank when it's sold out" : ""}.` };
  const was = money(i.was);
  if (Number.isNaN(was) || (was !== null && (price === null || was <= price || was > 200000)))
    return { ok: false, reason: `"${title}": the crossed-out price should be above the price, or blank.` };
  const currency = currencyOf(i.currency);
  if (!currency) return { ok: false, reason: `"${title}": the currency should be USD, GBP or EUR.` };
  const save = money(i.save);
  if (Number.isNaN(save) || (save !== null && (save < 0 || save > 200000)))
    return { ok: false, reason: `"${title}": "Save" should be a number like 138, or blank.` };
  const nights = int(i.nights, 1, 60), datesCount = int(i.datesCount, 0, 999);
  if (nights === "bad") return { ok: false, reason: `"${title}": nights should be a whole number from 1 to 60.` };
  if (datesCount === "bad") return { ok: false, reason: `"${title}": the number of dates should be a whole number.` };
  const sailDate = date(i.sailDate), sailEnd = date(i.sailEnd);
  if (sailDate === "bad") return { ok: false, reason: `"${title}": the sail date should be a real date.` };
  if (sailEnd === "bad" || (sailEnd && (!sailDate || sailEnd <= sailDate)))
    return { ok: false, reason: `"${title}": the last day should be a real date after the sail date.` };
  const partyAdults = int(i.partyAdults, 1, 8), partyChildren = int(i.partyChildren, 0, 8);
  if (partyAdults === "bad" || partyChildren === "bad")
    return { ok: false, reason: `"${title}": the party should be 1 to 8 adults and 0 to 8 children.` };
  const seen = seenOn(i.seenOn, today);
  if (seen === "bad") return { ok: false, reason: `"${title}": the day you saw it can't be in the future.` };
  const cabin = text(i.cabin, 20)?.toLowerCase() ?? null;
  if (cabin && !(CRUISE_CABINS as readonly string[]).includes(cabin))
    return { ok: false, reason: `"${title}": the room should be inside, oceanview, verandah or concierge, or blank.` };
  return { ok: true, value: {
    seenOn: seen, title, nights, departurePort: text(i.departurePort, 80), ports: text(i.ports, 300),
    ship: text(i.ship, 80), sailDate, cabin, price, currency, priceUsd: price === null ? null : toUsd(price, currency),
    sailEnd, was, soldOut, partyAdults, partyChildren,
    save, datesCount, theme: text(i.theme, 80), guaranteed: i.guaranteed === true || i.guaranteed === "true",
    note: text(i.note, 400), rawText: typeof i.rawText === "string" ? i.rawText.slice(0, 10000) : null,
  } };
}

/** The same sighting: same day, cruise, sailing, room, price and party.
 *  Saving one again (the same screenshot dropped twice, owner 2026-11-13)
 *  adds nothing to the history, so it's skipped. */
const sightingKey = (r: { seenOn: string; title: string; sailDate: string | null; cabin: string | null;
  price: number | null; soldOut: boolean; partyAdults: number | null; partyChildren: number | null }) =>
  [r.seenOn, r.title.toLowerCase(), r.sailDate ?? "", r.cabin ?? "", r.soldOut ? "sold" : String(r.price),
    r.partyAdults ?? "", r.partyChildren ?? ""].join("|");

/** Saves several cruises at once (one screenshot holds several), all or
 *  nothing, so a bad row never leaves half a screenshot saved. A row that
 *  repeats one already saved (or one earlier in the same batch) is skipped
 *  and counted. */
export async function saveCruises(db: Db, inputs: CruiseInput[], today: string):
  Promise<{ ok: true; saved: number; skipped: number } | { ok: false; reason: string }> {
  if (!Array.isArray(inputs) || !inputs.length) return { ok: false, reason: "Nothing to save." };
  if (inputs.length > 300) return { ok: false, reason: "That's more than 300 prices at once." };
  const rows: CruiseRow[] = [];
  for (const i of inputs) { const v = validateCruise(i, today); if (!v.ok) return v; rows.push(v.value); }
  const days = [...new Set(rows.map((r) => r.seenOn))];
  const have = new Set((await db.query<any>(
    `select seen_on, title, sail_date, cabin, price, sold_out, party_adults, party_children
       from cruise_sightings where seen_on = any($1::date[])`, [days])).rows.map((x) => sightingKey({
    seenOn: dateStr(x.seen_on), title: x.title, sailDate: x.sail_date ? dateStr(x.sail_date) : null, cabin: x.cabin,
    price: x.price === null ? null : Number(x.price), soldOut: x.sold_out,
    partyAdults: x.party_adults, partyChildren: x.party_children })));
  let saved = 0, skipped = 0;
  for (const r of rows) {
    const k = sightingKey(r);
    if (have.has(k)) { skipped++; continue; }
    have.add(k);
    await db.query(
      `insert into cruise_sightings (id, seen_on, title, nights, departure_port, ports, ship, sail_date, cabin,
         price, currency, price_usd, save_amount, dates_count, theme, guaranteed, note, raw_text,
         sail_end, was_price, sold_out, party_adults, party_children)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [randomUUID(), r.seenOn, r.title, r.nights, r.departurePort, r.ports, r.ship, r.sailDate, r.cabin,
        r.price, r.currency, r.priceUsd, r.save, r.datesCount, r.theme, r.guaranteed, r.note, r.rawText,
        r.sailEnd, r.was, r.soldOut, r.partyAdults, r.partyChildren]);
    saved++;
  }
  return { ok: true, saved, skipped };
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
  const perNight = cabin === "suite" || cabin === "concierge" ? rates.concierge : rates.regular;
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
    withGratuityUsd: grat === null || x.price_usd === null ? null : Math.round((Number(x.price_usd) + grat) * 100) / 100,
    id: x.id, savedAt: new Date(x.created_at).toISOString(), seenOn: dateStr(x.seen_on), title: x.title,
    nights: x.nights, departurePort: x.departure_port, ports: x.ports, ship: x.ship,
    sailDate: x.sail_date ? dateStr(x.sail_date) : null, cabin: x.cabin,
    price: x.price === null ? null : Number(x.price), currency: x.currency,
    priceUsd: x.price_usd === null ? null : Number(x.price_usd), save: x.save_amount === null ? null : Number(x.save_amount),
    datesCount: x.dates_count, theme: x.theme, guaranteed: x.guaranteed, note: x.note,
    sailEnd: x.sail_end ? dateStr(x.sail_end) : null, was: x.was_price === null ? null : Number(x.was_price),
    soldOut: x.sold_out === true, partyAdults: x.party_adults, partyChildren: x.party_children,
    };
  });
}
/**
 * Corrects one saved price (owner, 2026-11-14: "I need to be able to edit the
 * cruise sailings"). For a row saved wrong, like Delete: a NEW price seen on
 * another day is still a new row, so the history stays history. The row is
 * re-checked as a whole, exactly as when it was first saved.
 */
export async function updateCruise(db: Db, id: string, input: CruiseInput, today: string):
  Promise<{ ok: true } | { ok: false; reason: string; notFound?: boolean }> {
  const cur = (await listCruises(db, 100000)).find((c) => c.id === id);
  if (!cur) return { ok: false, reason: "That saved price isn't there any more.", notFound: true };
  const merged: Record<string, unknown> = {
    seenOn: cur.seenOn, title: cur.title, nights: cur.nights, departurePort: cur.departurePort ?? "",
    ports: cur.ports ?? "", ship: cur.ship ?? "", sailDate: cur.sailDate ?? "",
    cabin: cur.cabin ?? "", price: cur.price, currency: cur.currency, save: cur.save, datesCount: cur.datesCount,
    theme: cur.theme ?? "", guaranteed: cur.guaranteed, note: cur.note ?? "",
    sailEnd: cur.sailEnd ?? "", was: cur.was, soldOut: cur.soldOut,
    partyAdults: cur.partyAdults, partyChildren: cur.partyChildren,
  };
  for (const [k, v] of Object.entries(input ?? {})) if (k in merged) merged[k] = v;
  const v = validateCruise(merged as CruiseInput, today);
  if (!v.ok) return v;
  const r = v.value;
  await db.query(
    `update cruise_sightings set seen_on=$2, title=$3, nights=$4, departure_port=$5, ports=$6, ship=$7, sail_date=$8,
       cabin=$9, price=$10, currency=$11, price_usd=$12, save_amount=$13, dates_count=$14, theme=$15, guaranteed=$16,
       note=$17, sail_end=$18, was_price=$19, sold_out=$20, party_adults=$21, party_children=$22
     where id=$1`,
    [id, r.seenOn, r.title, r.nights, r.departurePort, r.ports, r.ship, r.sailDate, r.cabin, r.price, r.currency,
      r.priceUsd, r.save, r.datesCount, r.theme, r.guaranteed, r.note, r.sailEnd, r.was, r.soldOut,
      r.partyAdults, r.partyChildren]);
  return { ok: true };
}

/**
 * Facts about a whole cruise, set on every row saved under its name: the
 * ship, nights, home port and ports of call (the Galveston 7-night had no
 * ports line, so nothing could price it). Blank = leave as it is; "-" clears.
 * Optionally renames the cruise (rows under the new name join it).
 */
export async function updateCruiseDetails(db: Db, input: {
  title?: unknown; newTitle?: unknown; ship?: unknown; nights?: unknown; departurePort?: unknown; ports?: unknown;
}): Promise<{ ok: true; changed: number } | { ok: false; reason: string }> {
  const title = text(input.title, 160);
  if (!title) return { ok: false, reason: "Which cruise? Its name is missing." };
  const sets: string[] = [], vals: unknown[] = [title];
  const field = (col: string, raw: unknown, max: number) => {
    if (raw === undefined || raw === null || raw === "") return;
    vals.push(raw === "-" ? null : text(raw, max)); sets.push(`${col} = $${vals.length}`);
  };
  field("ship", input.ship, 80); field("departure_port", input.departurePort, 80); field("ports", input.ports, 300);
  if (input.nights !== undefined && input.nights !== null && input.nights !== "") {
    const n = int(input.nights, 1, 60);
    if (n === "bad" || n === null) return { ok: false, reason: "Nights should be a whole number from 1 to 60." };
    vals.push(n); sets.push(`nights = $${vals.length}`);
  }
  const newTitle = text(input.newTitle, 160);
  if (newTitle && newTitle !== title) { vals.push(newTitle); sets.push(`title = $${vals.length}`); }
  if (!sets.length) return { ok: false, reason: "Nothing to change." };
  const r = await db.query(`update cruise_sightings set ${sets.join(", ")} where title = $1 returning id`, vals);
  if (!r.rows.length) return { ok: false, reason: "No saved prices under that name." };
  return { ok: true, changed: r.rows.length };
}

export async function deleteCruise(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from cruise_sightings where id = $1 returning id`, [id])).rows.length > 0;
}

/* ------------------- a cruise's Rate & Room Details panel ------------------- */

export interface RateGuest { label: string; kind: "adult" | "child"; amount: number }
export interface RateInput {
  seenOn?: string; title?: string; sailDate?: string; cabin?: string; guests?: unknown; taxes?: unknown;
  total?: unknown; totalWas?: unknown; shownAs?: string; currency?: string; note?: string; rawText?: string;
}
export interface RateRow {
  seenOn: string; title: string; sailDate: string | null; cabin: string | null; adults: number; children: number;
  guests: RateGuest[]; taxes: number | null; total: number | null; totalWas: number | null;
  shownAs: "room" | "person" | null; currency: string; note: string | null; rawText: string | null;
}

export function validateRates(i: RateInput, today: string): Result<RateRow> {
  const title = text(i.title, 160);
  if (!title) return { ok: false, reason: "Which cruise is this? Give it the cruise's name." };
  const raw = Array.isArray(i.guests) ? i.guests : [];
  const guests: RateGuest[] = [];
  for (const g of raw as any[]) {
    const kind = g && (g.kind === "adult" || g.kind === "child") ? g.kind : null;
    const amount = money(g && g.amount);
    if (!kind || amount === null || Number.isNaN(amount) || amount < 0 || amount > 100000)
      return { ok: false, reason: "Each guest needs adult or child and an amount." };
    guests.push({ label: text(g.label, 20) || (kind === "adult" ? "Adult" : "Child"), kind, amount });
  }
  const adults = guests.filter((g) => g.kind === "adult").length;
  if (!adults || guests.length > 8) return { ok: false, reason: "The price summary should list 1 to 8 guests, at least one adult." };
  const taxes = money(i.taxes), total = money(i.total), totalWas = money(i.totalWas);
  if ([taxes, total, totalWas].some((v) => Number.isNaN(v) || (v !== null && (v! < 0 || v! > 200000))))
    return { ok: false, reason: "Taxes and the stateroom price should be numbers, or blank." };
  const shownAs = i.shownAs === "room" || i.shownAs === "person" ? i.shownAs : null;
  const sailDate = date(i.sailDate);
  if (sailDate === "bad") return { ok: false, reason: "The sail date should be a real date, or blank." };
  const seen = seenOn(i.seenOn, today);
  if (seen === "bad") return { ok: false, reason: "The day you saw it can't be in the future." };
  const cabin = text(i.cabin, 20)?.toLowerCase() ?? null;
  if (cabin && !(CRUISE_CABINS as readonly string[]).includes(cabin))
    return { ok: false, reason: "The room should be inside, oceanview, verandah or concierge, or blank." };
  const currency = currencyOf(i.currency);
  if (!currency) return { ok: false, reason: "The currency should be USD, GBP or EUR." };
  return { ok: true, value: {
    seenOn: seen, title, sailDate, cabin, adults, children: guests.length - adults, guests, taxes, total, totalWas,
    shownAs, currency, note: text(i.note, 400), rawText: typeof i.rawText === "string" ? i.rawText.slice(0, 10000) : null,
  } };
}

/** What a price summary teaches, whichever way Disney showed it (the shares
 *  are the same divided or not): a child's price as a share of an adult's,
 *  and taxes as a share of the stateroom price. */
export function rateShares(r: { guests: RateGuest[]; taxes: number | null; total: number | null }):
  { childShare: number | null; taxShare: number | null } {
  const a = r.guests.filter((g) => g.kind === "adult").map((g) => g.amount);
  const c = r.guests.filter((g) => g.kind === "child").map((g) => g.amount);
  const avg = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  return {
    childShare: a.length && c.length && avg(a) > 0 ? Math.round((avg(c) / avg(a)) * 1000) / 1000 : null,
    taxShare: r.taxes !== null && r.total ? Math.round((r.taxes / r.total) * 1000) / 1000 : null,
  };
}

export async function saveRates(db: Db, input: RateInput, today: string):
  Promise<{ ok: true; id: string | null; skipped: boolean } | { ok: false; reason: string }> {
  const v = validateRates(input, today);
  if (!v.ok) return v;
  const r = v.value;
  const dup = await db.query(
    `select 1 from cruise_rate_details where seen_on = $1 and lower(title) = lower($2)
        and sail_date is not distinct from $3 and cabin is not distinct from $4 and guests = $5
        and total is not distinct from $6 limit 1`,
    [r.seenOn, r.title, r.sailDate, r.cabin, JSON.stringify(r.guests), r.total]);
  if (dup.rows.length) return { ok: true, id: null, skipped: true };
  const id = randomUUID();
  await db.query(
    `insert into cruise_rate_details (id, seen_on, title, sail_date, cabin, adults, children, guests, taxes, total,
       total_was, shown_as, currency, note, raw_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, r.seenOn, r.title, r.sailDate, r.cabin, r.adults, r.children, JSON.stringify(r.guests), r.taxes, r.total,
      r.totalWas, r.shownAs, r.currency, r.note, r.rawText]);
  return { ok: true, id, skipped: false };
}

export interface RateSighting extends Omit<RateRow, "rawText"> {
  id: string; savedAt: string; childShare: number | null; taxShare: number | null;
}
export async function listRates(db: Db, limit = 500): Promise<RateSighting[]> {
  const r = await db.query<any>(
    `select * from cruise_rate_details order by seen_on desc, created_at desc limit $1`, [limit]);
  return r.rows.map((x) => {
    let guests: RateGuest[] = [];
    try { guests = JSON.parse(x.guests || "[]"); } catch { guests = []; }
    const n = (v: any) => (v === null ? null : Number(v));
    const row = {
      id: x.id, savedAt: new Date(x.created_at).toISOString(), seenOn: dateStr(x.seen_on), title: x.title,
      sailDate: x.sail_date ? dateStr(x.sail_date) : null, cabin: x.cabin, adults: x.adults, children: x.children,
      guests, taxes: n(x.taxes), total: n(x.total), totalWas: n(x.total_was), shownAs: x.shown_as,
      currency: x.currency, note: x.note,
    };
    return { ...row, ...rateShares(row) };
  });
}
export async function deleteRates(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from cruise_rate_details where id = $1 returning id`, [id])).rows.length > 0;
}

/* ------------------------- Adventures by Disney ------------------------- */

export interface AdventureInput {
  seenOn?: string; tripName?: string; destination?: string; days?: unknown; nights?: unknown;
  departureDate?: string; price?: unknown; childPrice?: unknown; currency?: string; tripType?: string;
  meals?: unknown; breakfasts?: unknown; lunches?: unknown; dinners?: unknown; minAge?: unknown;
  suggestedAge?: unknown; adultExclusiveAge?: unknown; highlights?: unknown; note?: string; rawText?: string;
  returnDate?: string; adultOnly?: unknown; childMaxAge?: unknown;
}
export interface AdventureRow {
  seenOn: string; tripName: string; destination: string | null; days: number | null; nights: number | null;
  departureDate: string | null; price: number; childPrice: number | null; currency: string; priceUsd: number;
  tripType: string | null; meals: number | null; breakfasts: number | null; lunches: number | null;
  dinners: number | null; minAge: number | null; suggestedAge: number | null; adultExclusiveAge: number | null;
  highlights: string[]; note: string | null; rawText: string | null;
  /** A dated departure's last day; "Adult Exclusive"; the child column's top age. */
  returnDate: string | null; adultOnly: boolean; childMaxAge: number | null;
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
    ["adultExclusiveAge", 0, 25, "adults-only age"], ["childMaxAge", 0, 25, "child age"]] as const) {
    const v = int((i as any)[k], lo, hi);
    if (v === "bad") return { ok: false, reason: `The ${label} should be a whole number from ${lo} to ${hi}, or blank.` };
    nums[k] = v;
  }
  const departureDate = date(i.departureDate);
  if (departureDate === "bad") return { ok: false, reason: "The departure date should be a real date, or blank." };
  const returnDate = date(i.returnDate);
  if (returnDate === "bad" || (returnDate && (!departureDate || returnDate < departureDate)))
    return { ok: false, reason: "The last day should be a real date on or after the departure, or blank." };
  const adultOnly = i.adultOnly === true || i.adultOnly === "true";
  if (adultOnly && childPrice !== null) return { ok: false, reason: "An Adult Exclusive departure has no child price." };
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
    returnDate, adultOnly, childMaxAge: nums.childMaxAge!,
  } };
}

async function insertAdventure(db: Db, r: AdventureRow): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into adventure_sightings (id, seen_on, trip_name, destination, days, nights, departure_date, price,
       child_price, currency, price_usd, trip_type, meals, breakfasts, lunches, dinners, min_age, suggested_age,
       adult_exclusive_age, highlights, note, raw_text, return_date, adult_only, child_max_age)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [id, r.seenOn, r.tripName, r.destination, r.days, r.nights, r.departureDate, r.price, r.childPrice, r.currency,
      r.priceUsd, r.tripType, r.meals, r.breakfasts, r.lunches, r.dinners, r.minAge, r.suggestedAge,
      r.adultExclusiveAge, JSON.stringify(r.highlights), r.note, r.rawText, r.returnDate, r.adultOnly, r.childMaxAge]);
  return id;
}
export async function saveAdventure(db: Db, input: AdventureInput, today: string):
  Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateAdventure(input, today);
  if (!v.ok) return v;
  return { ok: true, id: await insertAdventure(db, v.value) };
}

/**
 * A whole "Rates & Dates" table at once (owner, 2026-11-14), all or nothing.
 * The same day + trip + departure + prices saved again is skipped and
 * counted, as for cruises, so dropping a screenshot twice is safe.
 */
export async function saveAdventureDepartures(db: Db, inputs: AdventureInput[], today: string):
  Promise<{ ok: true; saved: number; skipped: number } | { ok: false; reason: string }> {
  if (!inputs.length) return { ok: false, reason: "No departures to save." };
  const rows: AdventureRow[] = [];
  for (const [k, i] of inputs.entries()) {
    const v = validateAdventure(i, today);
    if (!v.ok) return { ok: false, reason: `Departure ${k + 1}: ${v.reason}` };
    if (!v.value.departureDate) return { ok: false, reason: `Departure ${k + 1}: a departure date is needed.` };
    rows.push(v.value);
  }
  let saved = 0, skipped = 0;
  for (const r of rows) {
    const dup = await db.query(
      `select 1 from adventure_sightings where seen_on = $1 and trip_name = $2 and departure_date = $3
         and price = $4 and child_price is not distinct from $5 limit 1`,
      [r.seenOn, r.tripName, r.departureDate, r.price, r.childPrice]);
    if (dup.rows.length) { skipped++; continue; }
    await insertAdventure(db, r); saved++;
  }
  return { ok: true, saved, skipped };
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
      returnDate: x.return_date ? dateStr(x.return_date) : null, adultOnly: x.adult_only === true,
      childMaxAge: x.child_max_age ?? null,
    };
  });
}
export async function deleteAdventure(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from adventure_sightings where id = $1 returning id`, [id])).rows.length > 0;
}
