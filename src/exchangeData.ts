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
  "European Central Bank reference rates via Frankfurter, generated 2026-09-22";

/** The ECB reference date these rates are quoted for. Rewritten by the
 *  generator. Printed in the UI so a stale table shows itself. */
export const EXCHANGE_AS_OF: string = "2026-09-22";

/**
 * Keyed by the `currency` field on each resort in config.ts. USD is here as
 * an identity row so callers never need a special case for the two US
 * resorts — the one place a missing row would otherwise mean "no rate" and
 * the other would mean "the rate is one".
 */
export const EXCHANGE_RATES: Record<string, Rate> = {
  USD: { code: "USD", perUsd: 1, name: "US dollar" },
  CNY: { code: "CNY", perUsd: 6.7, name: "Chinese yuan" },
  EUR: { code: "EUR", perUsd: 0.8724, name: "euro" },
  HKD: { code: "HKD", perUsd: 7.843, name: "Hong Kong dollar" },
  JPY: { code: "JPY", perUsd: 157.2, name: "Japanese yen" },
};

/** True while the table is still the hand-seeded placeholder. The UI uses
 *  this to say so rather than presenting a guess as an observation. */
/* The annotation on EXCHANGE_AS_OF above is load-bearing, not style. Without
   it TypeScript infers the LITERAL type of whatever date is written here, so
   the moment this generator succeeds the comparison below is provably false
   and tsc rejects it — the job could only pass while it had nothing to show.
   That is exactly how the first real run failed: it fetched real ECB rates,
   wrote them, and then broke its own build before it could commit them.
   Widening to the plain string type keeps this a runtime question, which
   is what it always was. */
export const EXCHANGE_IS_PLACEHOLDER = EXCHANGE_AS_OF === "";
