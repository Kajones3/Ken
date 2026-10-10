/**
 * How expensive everyday things are at each resort, compared with Orlando
 * (2026-09-27).
 *
 * The owner, on the old Money line ("One US dollar is about 0.87 euro... That
 * converts a price; it does not tell you whether prices here are high or
 * low"): "This is awful... I want it all compared to Orlando. Everyone is
 * going to be comparing these trips to a Disney World trip anyway." So every
 * resort is measured against Orlando, and an exchange rate is only used to
 * turn the answer into local money.
 *
 * WHERE THE NUMBERS COME FROM, all free and all official:
 *
 *  - Paris, Tokyo, Shanghai and Hong Kong: the World Bank's International
 *    Comparison Program (ICP 2021), which prices the same basket of goods in
 *    every country. We use three of its headings: food and non-alcoholic
 *    beverages (groceries) and restaurants and hotels (eating out). Licence:
 *    CC BY 4.0, so a commercial site may use it with credit.
 *  - Carried forward to today with the World Bank's own 2025 estimate of how
 *    prices moved since 2021, and with TODAY'S exchange rate from
 *    exchangeData.ts. That last part matters most: the yen fell from about
 *    110 to the dollar in 2021 to about 157 now, and a table frozen in 2021
 *    would say Tokyo restaurants cost what Orlando's do. Because the rate is
 *    read live, the monthly exchange-rate job keeps this current with nobody
 *    touching it.
 *  - Orlando and the Los Angeles area (Disneyland): the US Bureau of
 *    Economic Analysis's Regional Price Parities for 2024, which say how far
 *    each metro sits above or below the US average. That is what turns "Japan
 *    against the US" into "Japan against Orlando". Public domain.
 *
 * WHAT IT IS NOT, said in the UI as well:
 *  - Country-wide for the four overseas resorts. Tokyo, Paris and Shanghai
 *    usually run above their country's average, so these lean low there.
 *  - Not Disney's prices. Food inside a park is priced by Disney, and the
 *    app's own food line (config.ts `food`) is what carries that. This is the
 *    world outside the gates: a dinner in town, a convenience-store run.
 *  - "Restaurants and hotels" is one heading at the World Bank. We call it
 *    eating out because hotels are already priced line by line elsewhere.
 *  - No "overall cost of living" figure. The World Bank's overall number
 *    counts rent and public health care, which no traveler pays, and it put
 *    France 17% below Orlando when Paris plainly isn't.
 *
 * GROCERIES ARE THE SHAKY ONE. For eating out the World Bank and Numbeo's
 * city figures agree on direction (Tokyo 31% vs 52% cheaper, Shanghai 50% vs
 * 66%, Paris about the same in both). For groceries they do not: the World
 * Bank has Tokyo 12% ABOVE Orlando and Numbeo 24% below. The World Bank
 * prices the same product everywhere, and a Western grocery basket is dear
 * in Japan; Numbeo's is what locals buy. Flagged to the owner 2026-09-27.
 *
 * WHY NOT NUMBEO. It has city-level figures (Tokyo, not Japan) and would be
 * the better source, but its terms forbid showing its data on a commercial
 * site without a paid licence. Checked 2026-09-27. If the owner buys one,
 * this file is the one place to swap it in.
 */
import { EXCHANGE_RATES, type Rate } from "./exchangeData.js";

/** When the figures below were last looked up. Nagged yearly by ownerTasks.ts:
 *  the World Bank republishes its estimates each year and BEA each December. */
export const PRICE_LEVELS_REVIEWED = "2026-09-27";

export const PRICE_LEVELS_SOURCE =
  "World Bank International Comparison Program and the US Bureau of Economic Analysis";

interface Country {
  /** The place the figures describe, as said in a sentence. */
  place: string;
  currency: string;
  /** ICP 2021 purchasing power parities, local currency per US dollar
   *  (US = 1). Series 1101000 and 1111000, classification PPPGlob. */
  ppp2021: { groceries: number; eatingOut: number };
  /** World Bank PPP for household consumption (PA.NUS.PRVT.PP), 2021 and the
   *  2025 estimate. Their ratio is how far prices there moved against US
   *  prices since 2021, and carries the 2021 headings forward. */
  household2021: number;
  household2025: number;
}

/** Looked up from api.worldbank.org on 2026-09-27. */
const COUNTRIES: Record<string, Country> = {
  dlp: {
    place: "France", currency: "EUR",
    ppp2021: { groceries: 0.934540390968323, eatingOut: 0.938525259494781 },
    household2021: 0.792193, household2025: 0.732501,
  },
  tdr: {
    place: "Japan", currency: "JPY",
    ppp2021: { groceries: 180.056732177734, eatingOut: 114.282707214355 },
    household2021: 109.444421, household2025: 103.33658,
  },
  shdr: {
    place: "mainland China", currency: "CNY",
    ppp2021: { groceries: 7.20112895965576, eatingOut: 3.8485631942749 },
    household2021: 4.01282787322998, household2025: 3.4595580434271,
  },
  hkdl: {
    place: "Hong Kong", currency: "HKD",
    ppp2021: { groceries: 11.2418022155762, eatingOut: 5.07093620300293 },
    household2021: 6.38834095001221, household2025: 5.76759042860516,
  },
};

/** BEA Regional Price Parities, 2024, US average = 100. Groceries read the
 *  "goods" parity and eating out "services: other" — the nearest BEA
 *  headings. "All items" is deliberately not used: it is mostly rent. */
interface Metro { place: string; groceries: number; eatingOut: number }
const ORLANDO: Metro = { place: "Orlando", groceries: 96.24, eatingOut: 98.864 };
const METROS: Record<string, Metro> = {
  dlr: { place: "the Los Angeles area", groceries: 106.623, eatingOut: 104.362 },
};

export interface PriceLevel {
  /** Where the figures describe — a country, or a US metro. */
  place: string;
  /** Price here divided by the same thing in Orlando. 0.7 = 30% cheaper. */
  eatingOut: number;
  groceries: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Each resort against Orlando. Walt Disney World is the yardstick and has no
 * row. A resort whose exchange rate is missing gets no row rather than a
 * number worked out from nothing.
 */
export function priceLevelsVsOrlando(rates: Record<string, Rate> = EXCHANGE_RATES): Record<string, PriceLevel> {
  const out: Record<string, PriceLevel> = {};
  for (const [id, m] of Object.entries(METROS)) {
    out[id] = {
      place: m.place,
      eatingOut: r3(m.eatingOut / ORLANDO.eatingOut),
      groceries: r3(m.groceries / ORLANDO.groceries),
    };
  }
  for (const [id, c] of Object.entries(COUNTRIES)) {
    const fx = rates[c.currency]?.perUsd;
    if (!fx || !(fx > 0)) continue;
    const carry = c.household2025 / c.household2021;
    // PPP / exchange rate = price level against the US average; divide by
    // Orlando's own level against that same average.
    const vsUs = (ppp: number) => ppp / fx;
    out[id] = {
      place: c.place,
      eatingOut: r3(vsUs(c.ppp2021.eatingOut * carry) / (ORLANDO.eatingOut / 100)),
      groceries: r3(vsUs(c.ppp2021.groceries * carry) / (ORLANDO.groceries / 100)),
    };
  }
  return out;
}

/** "about 30% less than", "about 10% more than", "about the same as" —
 *  rounded to 5%, because a price survey is not precise to the percent, and
 *  anything within 5% either way is "the same". */
export function vsOrlandoPhrase(ratio: number): string {
  const raw = (ratio - 1) * 100;
  if (!Number.isFinite(raw) || Math.abs(raw) < 5) return "about the same as";
  const pct = Math.round(raw / 5) * 5;
  return `about ${Math.abs(pct)}% ${pct < 0 ? "less" : "more"} than`;
}
