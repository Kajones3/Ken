import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLevelsVsOrlando, vsOrlandoPhrase } from "./priceLevels.js";
import { EXCHANGE_RATES } from "./exchangeData.js";
import { RESORTS } from "./config.js";

test("every resort but Walt Disney World is compared with Orlando", () => {
  const p = priceLevelsVsOrlando();
  const ids = RESORTS.map((r) => r.id).filter((id) => id !== "wdw").sort();
  assert.deepEqual(Object.keys(p).sort(), ids);
  assert.equal(p.wdw, undefined, "Orlando is the yardstick, not a row");
  for (const l of Object.values(p)) {
    assert.ok(l.eatingOut > 0.2 && l.eatingOut < 3, `${l.place} eating out ${l.eatingOut}`);
    assert.ok(l.groceries > 0.2 && l.groceries < 3, `${l.place} groceries ${l.groceries}`);
  }
});

test("each overseas figure uses that resort's own currency", () => {
  for (const r of RESORTS) {
    if (r.region === "dom") continue;
    assert.ok(EXCHANGE_RATES[r.currency], `${r.id} has no exchange rate`);
  }
});

test("today's exchange rate moves the answer — a weaker yen makes Tokyo cheaper", () => {
  const now = priceLevelsVsOrlando().tdr!;
  const weaker = priceLevelsVsOrlando({ ...EXCHANGE_RATES, JPY: { ...EXCHANGE_RATES.JPY!, perUsd: EXCHANGE_RATES.JPY!.perUsd * 1.25 } }).tdr!;
  assert.ok(Math.abs(weaker.eatingOut - now.eatingOut / 1.25) < 0.002);
  // Disneyland is a US metro and has nothing to convert.
  assert.equal(priceLevelsVsOrlando({ ...EXCHANGE_RATES, JPY: { ...EXCHANGE_RATES.JPY!, perUsd: 999 } }).dlr!.eatingOut,
    priceLevelsVsOrlando().dlr!.eatingOut);
});

test("a missing exchange rate drops that resort rather than inventing a number", () => {
  const { JPY: _drop, ...rest } = EXCHANGE_RATES;
  const p = priceLevelsVsOrlando(rest);
  assert.equal(p.tdr, undefined);
  assert.ok(p.dlp);
});

test("the Los Angeles area runs above Orlando (BEA regional prices)", () => {
  const l = priceLevelsVsOrlando().dlr!;
  assert.ok(l.eatingOut > 1 && l.groceries > 1);
});

test("phrases round to 5% and call anything within 5% the same", () => {
  assert.equal(vsOrlandoPhrase(0.694), "about 30% less than");
  assert.equal(vsOrlandoPhrase(1.124), "about 10% more than");
  assert.equal(vsOrlandoPhrase(1.029), "about the same as");
  assert.equal(vsOrlandoPhrase(0.963), "about the same as");
  assert.equal(vsOrlandoPhrase(1.05), "about 5% more than");
  assert.equal(vsOrlandoPhrase(NaN), "about the same as");
});
