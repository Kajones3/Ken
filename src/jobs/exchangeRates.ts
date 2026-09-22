/**
 * Regenerate src/exchangeData.ts from the European Central Bank's published
 * reference rates, via Frankfurter (api.frankfurter.dev) — free, no key, no
 * account, and a thin wrapper over the ECB's own daily publication rather
 * than a commercial aggregator with its own opinions.
 *
 * WHY THIS RUNS IN ACTIONS AND NOT HERE. Every exchange-rate host tested from
 * Claude's sandbox is refused by the egress proxy, the same wall that blocks
 * Disney, Open-Meteo and NOAA. Actions is not restricted that way. Same shape
 * as the climate-normals generator, for the same reason.
 *
 * WHY THE ECB AND NOT A "LIVE FX" FEED. This number translates a menu price
 * for a traveller, not a trade. The ECB publishes one reference rate per
 * currency per working day, it is authoritative, and it is free forever with
 * no key to leak. A real-time bid/ask would be more precise about something
 * nobody here is doing, and would cost money.
 *
 * IT REFUSES TO WRITE A PARTIAL TABLE. Every currency our six resorts use
 * must come back, or nothing is written and the previous file stands. Same
 * rule as the refresh job's upsert-on-success-only and the climate
 * generator's all-twelve-months check: yesterday's rate beats no rate, and a
 * table missing Shanghai would silently drop one resort's conversion line
 * while every other resort kept one.
 */
import { writeFileSync } from "node:fs";
import { RESORTS } from "../config.js";

const ENDPOINT = "https://api.frankfurter.dev/v1/latest";

/** Human names, so the UI can say "Chinese yuan" rather than "CNY". Not
 *  fetched: the ECB publishes codes and rates, not names, and a name is
 *  editorial anyway — the same split as climate's season notes. */
const CURRENCY_NAMES: Record<string, string> = {
  USD: "US dollar",
  EUR: "euro",
  JPY: "Japanese yen",
  CNY: "Chinese yuan",
  HKD: "Hong Kong dollar",
};

export type FetchedRates = { asOf: string; rates: Record<string, number> };

/** Which currencies we actually need, derived from the resorts rather than
 *  listed a second time — adding a seventh resort must not silently leave
 *  its currency unfetched. USD is dropped: it is the base. */
export function neededCurrencies(resorts = RESORTS): string[] {
  return [...new Set(resorts.map(r => r.currency))].filter(c => c !== "USD").sort();
}

/**
 * Pure: turn a Frankfurter payload into the table, or explain why not.
 * Separated from the fetch so the awkward cases have tests — this project has
 * shipped four providers written to a documented shape and never run, and the
 * one that was finally exercised failed on first contact.
 */
export function buildTable(
  payload: unknown,
  wanted: string[],
): { ok: true; asOf: string; rates: Record<string, number> } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "response was not an object" };
  const p = payload as { base?: string; date?: string; rates?: Record<string, unknown> };
  if (p.base && p.base !== "USD") return { ok: false, reason: `response is based on ${p.base}, not USD` };
  if (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
    return { ok: false, reason: `missing or unparseable date (${JSON.stringify(p.date)})` };
  }
  if (!p.rates || typeof p.rates !== "object") return { ok: false, reason: "no rates in response" };

  const rates: Record<string, number> = {};
  const missing: string[] = [];
  for (const code of wanted) {
    const v = p.rates[code];
    // A zero or a negative is not a rate, and NaN reaches here as a number.
    // Checking the value rather than its presence is the difference between
    // catching this and writing Infinity into a traveller's dinner estimate.
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) { missing.push(code); continue; }
    rates[code] = v;
  }
  if (missing.length) return { ok: false, reason: `no usable rate for ${missing.join(", ")}` };
  return { ok: true, asOf: p.date, rates };
}

/** Round to a sensible number of places for the currency's own scale: yen
 *  quoted to four decimals is noise, and a euro quoted to none is wrong. */
export function roundRate(v: number): number {
  if (v >= 100) return Math.round(v * 10) / 10;
  if (v >= 1) return Math.round(v * 1000) / 1000;
  return Math.round(v * 10000) / 10000;
}

export function renderFile(asOf: string, rates: Record<string, number>): string {
  const rows = ["USD", ...Object.keys(rates).sort()]
    .map(code => {
      // `rates` is checked complete by buildTable before this runs; the
      // fallback is here for the type, not for a case that can occur.
      const perUsd = code === "USD" ? 1 : roundRate(rates[code] ?? 1);
      const name = CURRENCY_NAMES[code] ?? code;
      return `  ${code}: { code: "${code}", perUsd: ${perUsd}, name: ${JSON.stringify(name)} },`;
    })
    .join("\n");

  return `/**
 * GENERATED DATA — the rates only. Do not hand-edit rows here.
 *
 * \`npm run exchange-rates\` (or the "Parkfare exchange rates" workflow)
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
 * embarrassing, rare enough that it is not a cost. \`AS_OF\` carries the ECB's
 * own date, and the UI prints it, so a stale table is visible rather than
 * silent — the same rule the \`est.\` chip follows.
 *
 * WHAT THIS IS NOT, and it matters enough to say in the file: an exchange
 * rate is NOT a cost-of-living comparison. "$1 buys 7 yuan" says nothing
 * whatsoever about whether a meal in Shanghai is cheaper than one in
 * Orlando — that depends on local prices, not on the rate. Converting a
 * price is a real use and the only one this table is for. Anything that
 * wants to claim one country is cheaper than another has to come from
 * per-resort price data (this project has some: \`food\` in config.ts), never
 * from here.
 */

/** USD -> local. One US dollar buys this many units of the local currency. */
export type Rate = { code: string; perUsd: number; name: string };

/** Where these came from, and as of when. Rewritten by the generator. */
export const EXCHANGE_SOURCE =
  "European Central Bank reference rates via Frankfurter, generated ${new Date().toISOString().slice(0, 10)}";

/** The ECB reference date these rates are quoted for. Rewritten by the
 *  generator. Printed in the UI so a stale table shows itself. */
export const EXCHANGE_AS_OF = "${asOf}";

/**
 * Keyed by the \`currency\` field on each resort in config.ts. USD is here as
 * an identity row so callers never need a special case for the two US
 * resorts — the one place a missing row would otherwise mean "no rate" and
 * the other would mean "the rate is one".
 */
export const EXCHANGE_RATES: Record<string, Rate> = {
${rows}
};

/** True while the table is still the hand-seeded placeholder. The UI uses
 *  this to say so rather than presenting a guess as an observation. */
export const EXCHANGE_IS_PLACEHOLDER = EXCHANGE_AS_OF === "";
`;
}

async function main() {
  const wanted = neededCurrencies();
  const url = `${ENDPOINT}?base=USD&symbols=${wanted.join(",")}`;
  console.log(`exchange-rates: asking for ${wanted.join(", ")} against USD`);

  let payload: unknown;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      // Name the status and the body. The climate generator's first real run
      // failed on a rate limit and the only reason it was diagnosable in
      // minutes rather than hours is that the error said which limit.
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
    }
    payload = JSON.parse(text);
  } catch (e) {
    console.error(`exchange-rates: fetch failed — ${(e as Error).message}`);
    console.error("Nothing written. The previous table still stands.");
    process.exit(1);
  }

  const built = buildTable(payload, wanted);
  if (!built.ok) {
    console.error(`exchange-rates: refusing to write — ${built.reason}`);
    console.error("Nothing written. The previous table still stands.");
    process.exit(1);
  }

  const file = renderFile(built.asOf, built.rates);
  if (process.env.EXCHANGE_DRY_RUN === "true") {
    console.log(file);
    return;
  }
  writeFileSync(new URL("../exchangeData.ts", import.meta.url), file);
  console.log(`exchange-rates: wrote src/exchangeData.ts — ECB rates as of ${built.asOf}`);
  for (const [code, v] of Object.entries(built.rates)) console.log(`  USD 1 = ${roundRate(v)} ${code}`);
}

// Only when run directly, so the tests can import the pure parts.
if (import.meta.url === `file://${process.argv[1]}`) main();
