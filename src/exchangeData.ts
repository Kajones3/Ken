/**
 * GENERATED DATA — the rates only. Do not hand-edit rows here.
 *
 * `npm run exchange-rates` (or the "Parkfare exchange rates" workflow)
 * rewrites this whole file from the European Central Bank's published
 * reference rates. Anything typed in it is lost on the next run.
 *
 * WHY A TABLE AND NOT A REQUEST PATH. Same call as ticket prices, climate
 * normals and everything else here: a rate fetched when somebody opens a
 * board would spend a network call, on every render, on a number that moves
 * by tenths of a percent a day and is being used to translate a dinner price.
 * Nothing in the request path fetches this.
 *
 * WHY IT IS SCHEDULED WHERE CLIMATE IS NOT. Climate normals move once a
 * decade, so its generator runs when a human asks. Exchange rates move
 * daily. Monthly is the compromise: frequent enough that the figure is not
 * embarrassing, rare enough that it is not a cost. `AS_OF` carries the ECB's
 * own date, and the UI prints it, so a stale table is visible rather than
 * silent — the same rule the `est.` chip follows.
 *
 * WHAT THIS IS NOT, and it matters enough to say in the file: an exchange
 * rate is NOT a cost-of-living comparison. "$1 buys 7 yuan" says nothing
 * whatsoever about whether a meal in Shanghai is cheaper than one in
 * Orlando — that depends on local prices, not on the rate. Converting a
 * price is a real use and the only one this table is for. Anything that
 * wants to claim one country is cheaper than another has to come from
 * per-resort price data (this project has some: `food` in config.ts), never
 * from here.
 */

/** USD -> local. One US dollar buys this many units of the local currency. */
export type Rate = { code: string; perUsd: number; name: string };

/** Where these came from, and as of when. Rewritten by the generator. */
export const EXCHANGE_SOURCE =
  "HAND-SEEDED PLACEHOLDER — Claude's approximate figures, NOT observed rates. " +
  "Run the \"Parkfare exchange rates\" workflow to replace this with real ECB reference rates.";

/** The ECB reference date these rates are quoted for. Rewritten by the
 *  generator. Printed in the UI so a stale table shows itself. */
export const EXCHANGE_AS_OF: string = "";

/**
 * Keyed by the `currency` field on each resort in config.ts. USD is here as
 * an identity row so callers never need a special case for the two US
 * resorts — the one place a missing row would otherwise mean "no rate" and
 * the other would mean "the rate is one".
 */
export const EXCHANGE_RATES: Record<string, Rate> = {
  USD: { code: "USD", perUsd: 1, name: "US dollar" },
  EUR: { code: "EUR", perUsd: 0.92, name: "euro" },
  JPY: { code: "JPY", perUsd: 150, name: "Japanese yen" },
  CNY: { code: "CNY", perUsd: 7.1, name: "Chinese yuan" },
  HKD: { code: "HKD", perUsd: 7.8, name: "Hong Kong dollar" },
};

/** True while the table is still the hand-seeded placeholder above. The UI
 *  uses this to say so rather than presenting a guess as an observation. */
export const EXCHANGE_IS_PLACEHOLDER = EXCHANGE_AS_OF === "";
