/**
 * Food, built from MEALS (2026-10-15, owner's ask): "I'd like to be able to
 * update the dining numbers. Like I can tell you that most character dining
 * in Disney World will be between 50 - 75 per person. So I should be able to
 * enter that as a price."
 *
 * How a day of food is priced now:
 *  1. Each resort has a price RANGE per meal type (quick-service meal,
 *     table-service meal, character meal, snack, a day of groceries), per
 *     adult, as the menu prices it. Every range is editable in /admin ->
 *     Rates & settings.
 *  2. We use the MIDDLE of each range, for every search, including the
 *     cheapest trip (owner: "Do not use the cheap end of the dinner prices.
 *     Really just use maybe a middle number because these prices never really
 *     change").
 *  3. Prices are ALL-IN: sales tax where the menu leaves it off (the US), and
 *     at the two US resorts an 18% tip on table-service and character meals
 *     (owner: "Tipping overseas is rare but expected in the US ... Just note
 *     that tip is added in"). Overseas menus already include tax; Shanghai's
 *     character meals add a reported 15% service charge.
 *  4. A dining style is a day of meals (DAY_OF_MEALS, approved by the owner).
 *  5. A child (the resort's child ticket band) costs CHILD_MEAL_SHARE of an
 *     adult: real WDW character menus price a child at 62-69% of an adult.
 *     Under-3s eat free. Juniors (Tokyo's 12-17) eat as adults: they order
 *     off the adult menu.
 *
 * The seed ranges are web research of 2026-10-15, in each resort's own
 * currency, converted at today's exchange rate. Tokyo, Hong Kong and
 * Shanghai sources are thin; docs/numbers-to-verify.md lists every one.
 * Pure: no I/O. Owner values arrive through `setting`.
 */
import type { FoodStyle } from "./config.js";
import { EXCHANGE_RATES } from "./exchangeData.js";
import { priceLevelsVsOrlando } from "./priceLevels.js";

export type MealKind = "qs" | "ts" | "character" | "snack" | "groceries";
export const MEAL_KINDS: readonly MealKind[] = ["qs", "ts", "character", "snack", "groceries"];

export const MEAL_LABEL: Record<MealKind, { one: string; many: string }> = {
  qs: { one: "quick-service meal", many: "quick-service meals" },
  ts: { one: "table-service meal", many: "table-service meals" },
  character: { one: "character meal", many: "character meals" },
  snack: { one: "snack", many: "snacks" },
  groceries: { one: "day of groceries", many: "days of groceries" },
};

/** What a day of each dining style is made of (owner-approved 2026-10-15).
 *  Groceries are counted in DAYS: a breakfast from groceries is a third of one. */
export const DAY_OF_MEALS: Record<Exclude<FoodStyle, "plan">, Partial<Record<MealKind, number>>> = {
  grocery: { groceries: 1, snack: 1 },
  someQs: { groceries: 1 / 3, qs: 1, snack: 1 },
  qs: { qs: 3, snack: 1 },
  mix: { qs: 2, ts: 1, snack: 1 },
  ts: { qs: 1, ts: 2, snack: 1 },
  someCharacter: { qs: 1, ts: 1, character: 1, snack: 1 },
  character: { qs: 1, character: 2, snack: 1 },
};

interface Seed { low: number; high: number; source: string }
interface ResortMeals {
  currency: string;
  /** Menu prices in `currency`, per adult, before tax and tip. Groceries are
   *  NOT here: they come from the US figure x the resort's grocery price level. */
  meals: Record<Exclude<MealKind, "groceries">, Seed>;
  /** Sales tax added to restaurant and snack prices (0 where menus include it). */
  taxPct: number;
  /** A tip or service charge, and the meals it applies to. */
  tipPct: number;
  tipOn: MealKind[];
  tipWord: "tip" | "service charge";
  taxNote: string;
}

/** A day of groceries for one adult in the US, USD. USDA's moderate-cost food
 *  plan for a single adult 19-50 is about $320-380 a month in 2026 (secondary
 *  write-ups of the USDA report, not the report itself): $11-13 a day. That is
 *  cooking at home; vacation shopping usually costs more, so treat it as a floor. */
export const US_GROCERY_DAY = { low: 11, high: 13 };

export const MEALS: Record<string, ResortMeals> = {
  wdw: {
    currency: "USD",
    meals: {
      qs: { low: 15, high: 25, source: "Quick-service entrees $15-25 (2026 menu write-ups)" },
      ts: { low: 25, high: 65, source: "Table-service entrees $25-65 (2026 menu write-ups); entree only" },
      character: { low: 50, high: 75, source: "Owner, 2026-10-15 (menus: breakfast $49-79, dinner $62-92)" },
      snack: { low: 5, high: 9, source: "Dole Whip $5.99, churro $7.49, Mickey pretzel $8.49 (Disney Food Blog, Oct 2025)" },
    },
    taxPct: 6.5, tipPct: 18, tipOn: ["ts", "character"], tipWord: "tip",
    taxNote: "Orange County sales tax 6.5% (the four parks and Disney Springs; resorts in Osceola County charge about 7%)",
  },
  dlr: {
    currency: "USD",
    meals: {
      qs: { low: 12, high: 22, source: "Quick-service entrees $12-22 (2026 menu write-ups)" },
      ts: { low: 25, high: 60, source: "Table-service entrees $25-60 (2026 menu write-ups); entree only" },
      character: { low: 58, high: 79, source: "Plaza Inn $58, Goofy's Kitchen $59-79 (2026)" },
      snack: { low: 5, high: 9, source: "Churro about $5.50-6.75; prices rose July 2026 (WDWNT)" },
    },
    taxPct: 7.75, tipPct: 18, tipOn: ["ts", "character"], tipWord: "tip",
    taxNote: "Anaheim sales tax 7.75% (Goofy's Kitchen adds an 18% gratuity itself)",
  },
  dlp: {
    currency: "EUR",
    meals: {
      qs: { low: 13, high: 19, source: "Quick-service meal about EUR 16 (range put around it by Claude)" },
      ts: { low: 42, high: 55, source: "Table-service set menus EUR 42-55" },
      character: { low: 65, high: 100, source: "Cafe Mickey EUR 65, Royal Banquet EUR 100" },
      snack: { low: 4, high: 9, source: "Ice cream EUR 4-6, soda EUR 4.20, turkey leg EUR 9" },
    },
    taxPct: 0, tipPct: 0, tipOn: [], tipWord: "tip",
    taxNote: "French menu prices include tax and service",
  },
  tdr: {
    currency: "JPY",
    meals: {
      qs: { low: 1500, high: 2300, source: "Quick-service sets JPY 1,500-2,300" },
      ts: { low: 4000, high: 8000, source: "Magellan's course JPY 8,000; lunch sets about $30 (thin)" },
      character: { low: 8100, high: 9000, source: "Character and hotel buffets JPY 8,100-9,000" },
      snack: { low: 300, high: 500, source: "Churro JPY 300-450, popcorn about JPY 400" },
    },
    taxPct: 0, tipPct: 0, tipOn: [], tipWord: "tip",
    taxNote: "Japanese menu prices include tax; no tipping",
  },
  hkdl: {
    currency: "HKD",
    meals: {
      qs: { low: 120, high: 180, source: "Quick-service meals HK$120-180" },
      ts: { low: 250, high: 400, source: "NO SOURCE FOUND: Claude's placeholder between quick service and character, please check" },
      character: { low: 400, high: 488, source: "Character dining about HK$400-488" },
      snack: { low: 25, high: 60, source: "Egg tart HK$25, Mickey waffle HK$50, grilled squid HK$60 (June 2026)" },
    },
    taxPct: 0, tipPct: 0, tipOn: [], tipWord: "service charge",
    taxNote: "Hong Kong has no sales tax; whether table-service meals add a service charge is not checked",
  },
  shdr: {
    currency: "CNY",
    meals: {
      qs: { low: 60, high: 120, source: "Quick-service meal CNY 60-120 per person" },
      ts: { low: 200, high: 400, source: "Table-service CNY 200-400" },
      character: { low: 200, high: 500, source: "Character dining CNY 200-500, plus a 15% service charge" },
      snack: { low: 20, high: 40, source: "Snack carts CNY 20-40" },
    },
    taxPct: 0, tipPct: 15, tipOn: ["character"], tipWord: "service charge",
    taxNote: "Chinese menu prices include tax; character meals add a 15% service charge",
  },
};

export const CHILD_MEAL_SHARE_KEY = "food.childSharePct";
export const DEFAULT_CHILD_MEAL_SHARE_PCT = 63;
export const mealKey = (resortId: string, kind: MealKind, end: "low" | "high") => `food.${resortId}.${kind}.${end}`;
export const taxKey = (resortId: string) => `food.${resortId}.taxPct`;
export const tipKey = (resortId: string) => `food.${resortId}.tipPct`;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The shipped range for one meal at one resort, in US dollars. */
export function shippedMealRange(resortId: string, kind: MealKind): { low: number; high: number; source: string } | undefined {
  const m = MEALS[resortId];
  if (!m) return undefined;
  if (kind === "groceries") {
    const level = resortId === "wdw" ? 1 : priceLevelsVsOrlando()[resortId]?.groceries ?? 1;
    return {
      low: r2(US_GROCERY_DAY.low * level), high: r2(US_GROCERY_DAY.high * level),
      source: resortId === "wdw"
        ? "USDA moderate-cost food plan, single adult: about $11-13 a day cooking at home"
        : `The US figure ($11-13) x this place's grocery prices against Orlando (World Bank / BEA, x${level})`,
    };
  }
  const s = m.meals[kind];
  const perUsd = EXCHANGE_RATES[m.currency]?.perUsd ?? 1;
  return { low: r2(s.low / perUsd), high: r2(s.high / perUsd), source: s.source };
}

type Setting = ((key: string) => number | undefined) | undefined;

export interface MealLine { kind: MealKind; count: number; each: number }
export interface FoodDay {
  /** One adult's day of food, all in. */
  perAdult: number;
  meals: MealLine[];
  childSharePct: number;
  taxPct: number;
  tipPct: number;
  tipOn: MealKind[];
  tipWord: "tip" | "service charge";
}

/** One meal's all-in price: the middle of its range, plus tax and any tip. */
export function mealPrice(setting: Setting, resortId: string, kind: MealKind): number {
  const shipped = shippedMealRange(resortId, kind);
  const m = MEALS[resortId];
  if (!shipped || !m) return 0;
  const low = setting?.(mealKey(resortId, kind, "low")) ?? shipped.low;
  const high = Math.max(low, setting?.(mealKey(resortId, kind, "high")) ?? shipped.high);
  const mid = (low + high) / 2;
  if (kind === "groceries") return r2(mid);   // US groceries are untaxed in FL and CA
  const tax = (setting?.(taxKey(resortId)) ?? m.taxPct) / 100;
  const tip = m.tipOn.includes(kind) ? (setting?.(tipKey(resortId)) ?? m.tipPct) / 100 : 0;
  return r2(mid * (1 + tax + tip));
}

/** A day of food for one adult in this dining style. "plan" (a dining plan
 *  we could not apply) prices as quick service, as it always has. */
export function foodDay(setting: Setting, resortId: string, style: FoodStyle): FoodDay {
  const m = MEALS[resortId];
  const day = DAY_OF_MEALS[style === "plan" ? "qs" : style];
  const meals: MealLine[] = MEAL_KINDS.filter((k) => day[k]).map((k) => ({ kind: k, count: day[k]!, each: mealPrice(setting, resortId, k) }));
  return {
    perAdult: r2(meals.reduce((s, x) => s + x.count * x.each, 0)),
    meals,
    childSharePct: setting?.(CHILD_MEAL_SHARE_KEY) ?? DEFAULT_CHILD_MEAL_SHARE_PCT,
    taxPct: setting?.(taxKey(resortId)) ?? m?.taxPct ?? 0,
    tipPct: m?.tipOn.length ? setting?.(tipKey(resortId)) ?? m.tipPct : 0,
    tipOn: m?.tipOn ?? [],
    tipWord: m?.tipWord ?? "tip",
  };
}
