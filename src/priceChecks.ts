/**
 * The owner's price checks: real prices seen while pricing whole trips.
 *
 * WHAT THIS IS FOR, in the owner's words (2026-09-27): "Everything I bring in
 * should be information. It shouldn't necessarily OVERWRITE anything, but it
 * should help with our estimates... Every day I pull something we should be
 * able to see the date it was pulled and then the dates that it is referring
 * to and use that as a data point." So:
 *
 *  - EVERY row is kept, including the ones that can't move anything (a dish
 *    at a restaurant, a hotel we don't price). A row that can't be used says
 *    why, in `not_counted`, rather than being refused or dropped.
 *  - Each row records the day it was pulled AND the dates it is about, so how
 *    far ahead it was checked is always known.
 *  - Each row records what OUR model said for the same thing that day
 *    (model_usd), before any check nudged it. observed / model is what
 *    checkFactors.ts turns into a nudge, and the snapshot is what makes
 *    "a year from now, how far off were we six months out?" answerable: what
 *    the model said on a given day cannot be recovered later.
 *
 * WHAT IT DOES NOT DO: it never writes a hotel rate, a fare or a ticket price.
 * The settings, fare corrections and ticket table stay exactly as they are.
 *
 * The format was agreed with the owner: one row per price seen (a long
 * table), see docs/price-checks/.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { RESORTS, RESORT_BY_ID, bucketFor, type Resort, type HotelDef, type TierIndex } from "./config.js";
import { EXCHANGE_RATES } from "./exchangeData.js";
import { KNOWN_ORIGINS } from "./fareCorrections.js";
import { hotelSeasonFactor } from "./seasonality.js";
import { addDaysISO, daysBetween, todayISO, range, type ISODate } from "./dates.js";
import { priceTrip, quotedEstimate, ticketMultiDay, type TripParams } from "./pricing.js";
import { loadBook, dateStr } from "./book.js";
import { settingsMap } from "./settings.js";
import { MIN_RATIO, MAX_RATIO } from "./checkFactors.js";

export const CATEGORIES = ["flight", "hotel", "ticket", "food", "other"] as const;
export type CheckCategory = (typeof CATEGORIES)[number];
export const PRICE_IS = ["per_person", "per_night", "whole_stay", "total", "per_item", "per_day"] as const;
export type PriceIs = (typeof PRICE_IS)[number];

/** The spreadsheet's columns, in order. The sample in docs/price-checks/
 *  uses exactly these; columns are found by name, so order never matters. */
export const CSV_COLUMNS = [
  "trip", "checked_on", "resort", "category", "item", "detail", "from_airport",
  "start_date", "end_date", "adults", "seniors", "children_ages",
  "amount", "currency", "price_is", "source", "notes",
] as const;

/** When price_is is blank, what a row most likely means. Hotel prices on a
 *  booking page are usually the whole stay; the owner was not sure for their
 *  Tokyo sheet, so a blank hotel row says it assumed so. */
const DEFAULT_PRICE_IS: Record<CheckCategory, PriceIs> = {
  flight: "per_person", hotel: "whole_stay", ticket: "per_person", food: "per_item", other: "total",
};

export interface CheckValue {
  trip: string;
  checkedOn: ISODate;
  resortId: string;
  category: CheckCategory;
  item: string;
  detail: string;
  fromAirport: string | null;
  startDate: ISODate | null;
  endDate: ISODate | null;
  adults: number | null;
  seniors: number | null;
  childrenAges: number[];
  amount: number;
  currency: string;
  priceIs: PriceIs;
  source: string;
  notes: string;
}

/* --------------------------------------------------------------- parsing */

/** YYYY-MM-DD, or the M/D/YYYY a spreadsheet writes (the owner's own sheet
 *  did). M/D/YY reads as 20YY. Anything else is refused by name. */
export function parseDateLoose(v: unknown): ISODate | null {
  const s = String(v ?? "").trim();
  let y: number, m: number, d: number;
  let hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (hit) { y = +hit[1]!; m = +hit[2]!; d = +hit[3]!; }
  else if ((hit = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    m = +hit[1]!; d = +hit[2]!; y = +hit[3]!; if (y < 100) y += 2000;
  } else return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(iso + "T00:00:00Z");
  return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Resort by id, name or city. Order matters: "Disneyland Paris" and "Hong
 *  Kong Disneyland" both contain "disneyland", so they are tried first. */
const RESORT_WORDS: [string, string[]][] = [
  ["dlp", ["paris", "marne"]],
  ["hkdl", ["hong kong", "hongkong"]],
  ["shdr", ["shanghai"]],
  ["tdr", ["tokyo", "urayasu", "maihama"]],
  ["wdw", ["walt disney world", "disney world", "orlando", "florida"]],
  ["dlr", ["disneyland", "anaheim", "california"]],
];
export function matchResort(v: unknown): Resort | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const byId = RESORT_BY_ID.get(s);
  if (byId) return byId;
  for (const [id, words] of RESORT_WORDS) {
    if (words.some((w) => s.includes(w))) return RESORT_BY_ID.get(id);
  }
  return RESORTS.find((r) => r.name.toLowerCase() === s);
}

export function matchCategory(v: unknown): CheckCategory | undefined {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(flight|flights|airfare|air|fare|fares|plane)$/.test(s)) return "flight";
  if (/^(hotel|hotels|room|rooms|lodging|stay)$/.test(s)) return "hotel";
  if (/^(ticket|tickets|park ticket|park tickets|admission)$/.test(s)) return "ticket";
  if (/^(food|restaurant|restaurants|dining|meal|meals|snack|drink)$/.test(s)) return "food";
  if (/^(other|misc|souvenir|souvenirs|parking|transport)$/.test(s)) return "other";
  return undefined;
}

const CURRENCY_WORDS: [RegExp, string][] = [
  [/hk\$|hkd/i, "HKD"],
  [/€|\beur\b|euro/i, "EUR"],
  [/rmb|cny|元|yuan/i, "CNY"],
  [/\byen\b|\byn\b|円|jpy/i, "JPY"],
  [/us\$|usd|dollar/i, "USD"],
];

/**
 * An amount as typed — "502500 yen", "¥10,900", "$2,081", "HK$790" — split
 * into a number and a currency. A currency column, when filled, wins. "¥" is
 * both the yen and the yuan, so it reads as the resort's own. Nothing at all
 * reads as US dollars, and says so, since a yen figure read as dollars is the
 * mistake most likely to slip through.
 */
export function parseMoney(amountRaw: unknown, currencyRaw: unknown, resort: Resort):
  { ok: true; amount: number; currency: string; guessed: boolean } | { ok: false; reason: string } {
  const text = String(amountRaw ?? "").trim();
  const cur = String(currencyRaw ?? "").trim();
  let currency: string | undefined;
  if (cur) {
    const up = cur.toUpperCase();
    currency = EXCHANGE_RATES[up] ? up : CURRENCY_WORDS.find(([re]) => re.test(cur))?.[1]
      ?? (/[¥￥]/.test(cur) ? (resort.currency === "CNY" ? "CNY" : "JPY") : cur === "$" ? "USD" : undefined);
    if (!currency) return { ok: false, reason: `"${cur}" is not a currency we can convert — use USD, JPY, EUR, CNY or HKD` };
  }
  let guessed = false;
  if (!currency) {
    currency = CURRENCY_WORDS.find(([re]) => re.test(text))?.[1];
    if (!currency && /[¥￥]/.test(text)) currency = resort.currency === "CNY" ? "CNY" : "JPY";
    if (!currency && /\$/.test(text)) currency = "USD";
    if (!currency) { currency = "USD"; guessed = true; }
  }
  const digits = text.replace(/[^\d.]/g, "");
  const amount = Number(digits);
  if (!digits || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `"${text || "(blank)"}" is not an amount` };
  }
  if (amount > 50_000_000) return { ok: false, reason: `${text} is too large to be one price — check for a stray digit` };
  return { ok: true, amount: Math.round(amount * 100) / 100, currency, guessed };
}

const intOrNull = (v: unknown, max: number): number | null | "bad" => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : "bad";
};

export type Validated = { ok: true; value: CheckValue; warnings: string[] } | { ok: false; reason: string };

/**
 * One row, as typed. Every refusal names what to fix, because on a
 * spreadsheet upload that message is all the owner sees.
 */
export function validateCheck(input: Record<string, unknown>, today: ISODate = todayISO()): Validated {
  const warnings: string[] = [];
  const resort = matchResort(input.resort);
  if (!resort) return { ok: false, reason: `"${String(input.resort ?? "") || "(blank)"}" is not one of the six resorts — use a name like Tokyo or an id like tdr` };
  const category = matchCategory(input.category);
  if (!category) return { ok: false, reason: `"${String(input.category ?? "") || "(blank)"}" is not a category — use flight, hotel, ticket, food or other` };

  const dateField = (name: string, v: unknown): ISODate | null | string => {
    if (!String(v ?? "").trim()) return null;
    return parseDateLoose(v) ?? `"${String(v)}" in ${name} is not a date — use YYYY-MM-DD or M/D/YYYY`;
  };
  const checked = String(input.checked_on ?? "").trim() ? dateField("checked_on", input.checked_on) : today;
  if (checked && checked.includes(" ")) return { ok: false, reason: checked };
  const checkedOn = checked as ISODate;
  if (checkedOn > today) return { ok: false, reason: `checked_on ${checkedOn} is in the future — it's the day you saw the price` };
  const start = dateField("start_date", input.start_date);
  if (start && start.includes(" ")) return { ok: false, reason: start };
  const end = dateField("end_date", input.end_date);
  if (end && end.includes(" ")) return { ok: false, reason: end };
  if (start && end && end < start) return { ok: false, reason: `end_date ${end} is before start_date ${start}` };

  const money = parseMoney(input.amount, input.currency, resort);
  if (!money.ok) return { ok: false, reason: money.reason };
  if (money.guessed && resort.currency !== "USD") {
    warnings.push(`no currency given for ${money.amount.toLocaleString("en-US")} at ${resort.name}, so it was read as US dollars`);
  }

  const piRaw = String(input.price_is ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const priceIs = (piRaw || DEFAULT_PRICE_IS[category]) as PriceIs;
  if (!PRICE_IS.includes(priceIs)) {
    return { ok: false, reason: `"${String(input.price_is)}" is not a price_is — use ${PRICE_IS.join(", ")}` };
  }
  if (!piRaw && category === "hotel") warnings.push("price_is was blank, so the hotel price was read as the whole stay");

  const adults = intOrNull(input.adults, 20), seniors = intOrNull(input.seniors, 20);
  if (adults === "bad" || seniors === "bad") return { ok: false, reason: "adults and seniors must be whole numbers from 0 to 20" };
  const agesRaw = String(input.children_ages ?? "").trim();
  const childrenAges = agesRaw ? agesRaw.split(/[\s,;]+/).filter(Boolean).map(Number) : [];
  if (childrenAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) {
    return { ok: false, reason: `"${agesRaw}" should be children's ages, 0 to 17, separated by commas` };
  }

  const fromRaw = String(input.from_airport ?? "").trim().toUpperCase();
  const item = String(input.item ?? "").trim().slice(0, 200);
  if (category === "flight") {
    if (!KNOWN_ORIGINS.has(fromRaw)) return { ok: false, reason: `"${fromRaw || "(blank)"}" in from_airport is not a departure airport this app prices` };
    if (!start) return { ok: false, reason: "a flight needs a start_date (the day you fly out)" };
  }
  if (category === "hotel") {
    if (!item) return { ok: false, reason: "a hotel needs its name in item" };
    if (!start) return { ok: false, reason: "a hotel needs a start_date (check-in)" };
    if ((priceIs === "whole_stay" || priceIs === "total") && !end) {
      return { ok: false, reason: "a whole-stay hotel price needs an end_date (check-out) to work out the nightly rate" };
    }
  }

  return {
    ok: true, warnings,
    value: {
      trip: String(input.trip ?? "").trim().slice(0, 120),
      checkedOn, resortId: resort.id, category,
      item, detail: String(input.detail ?? "").trim().slice(0, 200),
      fromAirport: fromRaw || null,
      startDate: (start as ISODate | null), endDate: (end as ISODate | null),
      adults: adults as number | null, seniors: seniors as number | null, childrenAges,
      amount: money.amount, currency: money.currency, priceIs,
      source: String(input.source ?? "").trim().slice(0, 300),
      notes: String(input.notes ?? "").trim().slice(0, 500),
    },
  };
}

/* ------------------------------------------------------- one comparable unit */

export function nightsOf(v: Pick<CheckValue, "startDate" | "endDate">): number | null {
  if (!v.startDate || !v.endDate) return null;
  const n = daysBetween(v.startDate, v.endDate);
  return n > 0 ? n : null;
}

export function seatsOf(v: Pick<CheckValue, "adults" | "seniors" | "childrenAges">): number | null {
  const n = (v.adults ?? 0) + (v.seniors ?? 0) + v.childrenAges.length;
  return n > 0 ? n : null;
}

/**
 * The price in one unit we can compare with our own: per person for a round
 * trip, per room per night, per person for a ticket, as-is for anything
 * else. In US dollars at the exchange rate on file. Null, with the reason,
 * when the row can't be put in one.
 */
export function unitOf(v: CheckValue, rates = EXCHANGE_RATES):
  { unitUsd: number | null; unit: string; problem?: string } {
  const perUsd = rates[v.currency]?.perUsd;
  if (!perUsd) return { unitUsd: null, unit: "", problem: `no exchange rate on file for ${v.currency}` };
  const usd = v.amount / perUsd;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const nights = nightsOf(v), seats = seatsOf(v);
  const split = (what: string) => seats
    ? { unitUsd: r2(usd / seats), unit: what }
    : { unitUsd: null, unit: what, problem: "a total for the whole party needs the party size (adults, seniors, children_ages) to split it" };
  switch (v.category) {
    case "flight":
      if (v.priceIs === "per_person") return { unitUsd: r2(usd), unit: "per person, round trip" };
      if (v.priceIs === "total") return split("per person, round trip");
      return { unitUsd: null, unit: "", problem: `a flight price should be per_person or total, not ${v.priceIs}` };
    case "hotel":
      if (v.priceIs === "per_night") return { unitUsd: r2(usd), unit: "per room, per night" };
      if (v.priceIs === "whole_stay" || v.priceIs === "total") {
        return nights
          ? { unitUsd: r2(usd / nights), unit: "per room, per night" }
          : { unitUsd: null, unit: "", problem: "a whole-stay price needs both dates to work out a night" };
      }
      return { unitUsd: null, unit: "", problem: `a hotel price should be per_night or whole_stay, not ${v.priceIs}` };
    case "ticket":
      if (v.priceIs === "per_person") return { unitUsd: r2(usd), unit: "per person" };
      if (v.priceIs === "total") return split("per person");
      return { unitUsd: null, unit: "", problem: `a ticket price should be per_person or total, not ${v.priceIs}` };
    default:
      return { unitUsd: r2(usd), unit: v.priceIs.replace(/_/g, " ") };
  }
}

/* ---------------------------------------------------- what we priced it at */

/** Our hotel for a name as typed: "Disney Celebration Hotel" is our "Tokyo
 *  Disney Celebration Hotel". Words every Disney hotel shares are ignored;
 *  the longest overlap wins. */
const hotelWords = (s: string) => s.toLowerCase()
  .replace(/disney's|disney\b|\bhotel\b|\bresort\b|&|[^\p{L}\p{N}\s]/gu, " ")
  .replace(/\s+/g, " ").trim();
export function matchHotel(resort: Resort, name: string): HotelDef | undefined {
  const want = hotelWords(name);
  if (want.length < 4) return undefined;
  let best: HotelDef | undefined, bestLen = 0;
  for (const h of resort.hotels) {
    const have = hotelWords(h.name);
    const hit = have === want || have.includes(want) || want.includes(have);
    const len = Math.min(have.length, want.length);
    if (hit && have.length >= 4 && len > bestLen) { best = h; bestLen = len; }
  }
  return best;
}

type TicketBand = "adult" | "child" | "junior" | "senior";
export function ticketBandFrom(text: string): TicketBand {
  const s = text.toLowerCase();
  if (/senior|60\+|65\+/.test(s)) return "senior";
  if (/junior|12\s*[-–]\s*17/.test(s)) return "junior";
  if (/child|kid/.test(s)) return "child";
  return "adult";
}
export function ticketDaysFrom(text: string): number {
  const m = text.toLowerCase().match(/(\d+)\s*-?\s*day/);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 10 ? n : 1;
}

export interface Snapshot {
  matchKey: string | null;
  modelUsd: number | null;
  modelBaseUsd: number | null;
  appUsd: number | null;
  notCounted: string;
}

/**
 * What our model said, today, for the same unit — measured BEFORE any price
 * check nudged it (loadBook's applyChecks: false), or checks would be
 * measured against themselves.
 */
export async function snapshot(db: Db, v: CheckValue, unitUsd: number | null): Promise<Snapshot> {
  const resort = RESORT_BY_ID.get(v.resortId)!;
  const out: Snapshot = { matchKey: null, modelUsd: null, modelBaseUsd: null, appUsd: null, notCounted: "" };
  const r2 = (n: number) => Math.round(n * 100) / 100;

  if (v.category === "flight" && v.fromAirport && v.startDate) {
    const nights = nightsOf(v) ?? 7;
    out.matchKey = `${v.fromAirport}|${resort.id}`;
    try {
      const book = await loadBook(db, {
        origin: v.fromAirport, destinations: [resort.iata], resortIds: [resort.id],
        from: v.startDate, to: addDaysISO(v.startDate, nights + 1), tripLength: bucketFor(nights),
      }, { applyChecks: false });
      const model = quotedEstimate(book, v.fromAirport, resort.iata, v.startDate);
      out.modelUsd = model ?? null;
      const params: TripParams = {
        origin: v.fromAirport, adults: 1, childAges: [], nights, parkDays: 1,
        stay: "none", tier: 0 as TierIndex, food: "mix",
      };
      const priced = priceTrip(book, resort, params, {}, v.startDate);
      out.appUsd = priced.ok ? r2(priced.price.perSeatFare) : null;
      if (model === undefined) out.notCounted = `we have no estimate for ${v.fromAirport} to ${resort.name} yet, so there's nothing of ours to nudge`;
    } catch {
      out.notCounted = "couldn't work out what we priced this flight at";
    }
  } else if (v.category === "hotel") {
    const h = matchHotel(resort, v.item);
    if (!h) out.notCounted = `"${v.item}" isn't one of the hotels we price at ${resort.name}`;
    else if (!h.onProperty) out.notCounted = "off-property rates come from a live search, not a rate we set, so there's nothing of ours to nudge";
    else if (v.startDate) {
      const settings = await settingsMap(db);
      const base = settings.get(`hotel.${h.id}.base`) ?? h.base;
      const n = nightsOf(v);
      const nights = n ? range(v.startDate, addDaysISO(v.startDate, n - 1)) : [v.startDate];
      const avg = nights.reduce((a, d) => a + base * hotelSeasonFactor(resort.id, d), 0) / nights.length;
      out.matchKey = h.id; out.modelUsd = r2(avg); out.modelBaseUsd = base; out.appUsd = r2(avg);
    }
  } else if (v.category === "ticket") {
    const days = ticketDaysFrom(`${v.item} ${v.detail}`);
    const band = ticketBandFrom(`${v.item} ${v.detail}`);
    out.matchKey = resort.id;
    if (!v.startDate) out.notCounted = "a ticket needs a start_date to compare with that day's price";
    else {
      const dates = range(v.startDate, addDaysISO(v.startDate, days - 1));
      const { rows } = await db.query<Record<string, unknown>>(
        `select park_date, adult_usd, child_usd, junior_usd from ticket_prices
          where resort_id = $1 and park_date = any($2)`, [resort.id, dates]);
      if (rows.length < dates.length) out.notCounted = `we have no ticket price on file for ${v.startDate} yet`;
      else {
        const gate = (r: Record<string, unknown>) => {
          const adult = Number(r.adult_usd), child = Number(r.child_usd);
          const junior = r.junior_usd === null || r.junior_usd === undefined ? adult * (resort.ticket.junior ?? 0.9) : Number(r.junior_usd);
          if (band === "child") return child;
          if (band === "junior") return junior;
          if (band === "senior") return resort.bands.senior !== undefined ? child : adult;
          return adult;
        };
        const model = rows.reduce((a, r) => a + gate(r), 0) * ticketMultiDay(resort, days);
        out.modelUsd = r2(model); out.appUsd = r2(model);
      }
    }
  } else if (v.category === "food") {
    out.notCounted = "a single dish can't be turned into a daily food rate on its own, so it's kept as a record";
  } else {
    out.notCounted = "kept as a record — nothing we price matches it";
  }

  if (!out.notCounted && out.modelUsd && unitUsd) {
    const ratio = unitUsd / out.modelUsd;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      out.notCounted = `${ratio.toFixed(1)}× what we had — most likely a currency, or a whole stay read as one night, so it isn't counted`;
    }
  }
  return out;
}

/* -------------------------------------------------------------- the table */

const dedupeOf = (v: CheckValue) => [
  v.checkedOn, v.resortId, v.category, v.item.toLowerCase(), v.detail.toLowerCase(),
  v.fromAirport ?? "", v.startDate ?? "", v.endDate ?? "", v.amount, v.currency, v.priceIs,
].join("|");

/**
 * Store rows. The same price uploaded twice is one data point, not two, so a
 * repeat is skipped and counted rather than refused — re-uploading a sheet
 * with three new rows at the bottom is the normal way to use this.
 */
export async function addChecks(db: Db, values: CheckValue[], by = ""):
  Promise<{ added: number; duplicates: number }> {
  let added = 0, duplicates = 0;
  for (const v of values) {
    const unit = unitOf(v);
    const snap = unit.unitUsd === null
      ? { matchKey: null, modelUsd: null, modelBaseUsd: null, appUsd: null, notCounted: unit.problem ?? "" }
      : await snapshot(db, v, unit.unitUsd);
    const r = await db.query(
      `insert into price_checks
         (id, trip, checked_on, resort_id, category, item, detail, from_airport, start_date, end_date,
          adults, seniors, children_ages, amount, currency, price_is, source, notes,
          unit_usd, unit, match_key, model_usd, model_base_usd, app_usd, not_counted, created_by, dedupe)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       on conflict (dedupe) do nothing
       returning id`,
      [randomUUID(), v.trip, v.checkedOn, v.resortId, v.category, v.item, v.detail, v.fromAirport,
       v.startDate, v.endDate, v.adults, v.seniors, v.childrenAges.join(", "), v.amount, v.currency,
       v.priceIs, v.source, v.notes, unit.unitUsd, unit.unit, snap.matchKey, snap.modelUsd,
       snap.modelBaseUsd, snap.appUsd, snap.notCounted, by, dedupeOf(v)],
    );
    if (r.rows.length) added++; else duplicates++;
  }
  return { added, duplicates };
}

export interface StoredCheck extends CheckValue {
  id: string;
  unitUsd: number | null;
  unit: string;
  matchKey: string | null;
  modelUsd: number | null;
  modelBaseUsd: number | null;
  appUsd: number | null;
  notCounted: string;
  createdAt: string;
  /** Days between checking and travelling. Null without a start date. */
  leadDays: number | null;
  /** What was seen over what we said that day. Null when not comparable. */
  ratio: number | null;
}

export async function listChecks(db: Db): Promise<StoredCheck[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from price_checks order by checked_on desc, created_at desc`);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const day = (v: unknown) => (v === null || v === undefined ? null : dateStr(v));
  return rows.map((r) => {
    const checkedOn = dateStr(r.checked_on);
    const startDate = day(r.start_date);
    const unitUsd = num(r.unit_usd), modelUsd = num(r.model_usd);
    return {
      id: String(r.id), trip: String(r.trip ?? ""), checkedOn, resortId: String(r.resort_id),
      category: String(r.category) as CheckCategory, item: String(r.item ?? ""), detail: String(r.detail ?? ""),
      fromAirport: r.from_airport ? String(r.from_airport) : null, startDate, endDate: day(r.end_date),
      adults: num(r.adults), seniors: num(r.seniors),
      childrenAges: String(r.children_ages ?? "").split(/[\s,]+/).filter(Boolean).map(Number),
      amount: Number(r.amount), currency: String(r.currency), priceIs: String(r.price_is) as PriceIs,
      source: String(r.source ?? ""), notes: String(r.notes ?? ""),
      unitUsd, unit: String(r.unit ?? ""), matchKey: r.match_key ? String(r.match_key) : null,
      modelUsd, modelBaseUsd: num(r.model_base_usd), appUsd: num(r.app_usd),
      notCounted: String(r.not_counted ?? ""),
      createdAt: new Date(String(r.created_at)).toISOString(),
      leadDays: startDate ? daysBetween(checkedOn, startDate) : null,
      ratio: unitUsd && modelUsd ? Math.round((unitUsd / modelUsd) * 1000) / 1000 : null,
    };
  });
}

export async function deleteCheck(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`delete from price_checks where id = $1 returning id`, [id]);
  return r.rows.length > 0;
}

/** A readable name for a match key, for the admin page's "what your checks
 *  are doing" list. */
export function describeKey(category: string, matchKey: string): string {
  if (category === "flight") {
    const [origin, resortId] = matchKey.split("|");
    return `Flights ${origin} to ${RESORT_BY_ID.get(resortId ?? "")?.name ?? resortId}`;
  }
  if (category === "ticket") return `Tickets at ${RESORT_BY_ID.get(matchKey)?.name ?? matchKey}`;
  for (const r of RESORTS) {
    const h = r.hotels.find((x) => x.id === matchKey);
    if (h) return `${h.name} (${r.name})`;
  }
  return matchKey;
}
