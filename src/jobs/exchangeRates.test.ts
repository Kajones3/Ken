import test from "node:test";
import assert from "node:assert/strict";
import { buildTable, neededCurrencies, renderFile, roundRate } from "./exchangeRates.js";
import { RESORTS } from "../config.js";
import { EXCHANGE_RATES } from "../exchangeData.js";

const WANTED = neededCurrencies();

test("every currency our resorts use is asked for, and USD is not", () => {
  // Derived from RESORTS rather than listed twice: a seventh resort must not
  // be able to ship with its currency silently unfetched.
  for (const r of RESORTS) {
    if (r.currency === "USD") continue;
    assert.ok(WANTED.includes(r.currency), `${r.id} uses ${r.currency}, which nothing asks for`);
  }
  assert.ok(!WANTED.includes("USD"), "USD is the base, not a symbol to request");
});

test("the committed table has a row for every currency, USD included", () => {
  // The identity row is the whole reason callers need no special case for
  // the two US resorts.
  for (const r of RESORTS) {
    assert.ok(EXCHANGE_RATES[r.currency], `no rate row for ${r.currency} (${r.id})`);
  }
  assert.equal(EXCHANGE_RATES.USD?.perUsd, 1, "one dollar must buy one dollar");
});

test("a complete response builds a table", () => {
  const payload = { base: "USD", date: "2026-09-18", rates: { EUR: 0.9123, JPY: 149.87, CNY: 7.0912, HKD: 7.7801 } };
  const r = buildTable(payload, WANTED);
  assert.ok(r.ok);
  assert.equal(r.asOf, "2026-09-18");
  assert.equal(r.rates.CNY, 7.0912);
});

test("a response missing one currency writes NOTHING, not a partial table", () => {
  // The rule that matters. A table missing Shanghai would drop one resort's
  // conversion line while every other resort kept one — the six-resort
  // comparison degrading unevenly, which is the failure this project cares
  // about most.
  const payload = { base: "USD", date: "2026-09-18", rates: { EUR: 0.91, JPY: 149.87, HKD: 7.78 } };
  const r = buildTable(payload, WANTED);
  assert.ok(!r.ok);
  assert.match(r.reason, /CNY/);
});

test("a zero, a negative or a non-number is not a rate", () => {
  for (const bad of [0, -3, "7.1", null, NaN]) {
    const payload = { base: "USD", date: "2026-09-18", rates: { EUR: 0.91, JPY: 149.87, CNY: bad, HKD: 7.78 } };
    const r = buildTable(payload, WANTED);
    assert.ok(!r.ok, `${JSON.stringify(bad)} was accepted as a rate`);
  }
});

test("a response based on something other than USD is refused", () => {
  // Reading EUR-based rates as USD-based would quietly misprice every
  // conversion by ~10% with nothing reporting a problem.
  const payload = { base: "EUR", date: "2026-09-18", rates: { JPY: 164, CNY: 7.8, HKD: 8.5 } };
  const r = buildTable(payload, WANTED);
  assert.ok(!r.ok);
  assert.match(r.reason, /EUR/);
});

test("a missing or malformed date is refused", () => {
  for (const d of [undefined, "", "18/09/2026", 20260918]) {
    const payload = { base: "USD", date: d, rates: { EUR: 0.91, JPY: 149.87, CNY: 7.09, HKD: 7.78 } };
    assert.ok(!buildTable(payload, WANTED).ok, `${JSON.stringify(d)} was accepted as a date`);
  }
});

test("rates round to their own scale", () => {
  assert.equal(roundRate(149.8712), 149.9);  // yen: tenths are already noise
  assert.equal(roundRate(7.09123), 7.091);
  assert.equal(roundRate(0.912345), 0.9123);
});

test("the generated file is real TypeScript and stops claiming to be a placeholder", () => {
  const out = renderFile("2026-09-18", { EUR: 0.9123, JPY: 149.87, CNY: 7.0912, HKD: 7.7801 });
  assert.match(out, /EXCHANGE_AS_OF = "2026-09-18"/);
  assert.match(out, /USD: \{ code: "USD", perUsd: 1,/);
  assert.match(out, /CNY: \{ code: "CNY", perUsd: 7\.091,/);
  // The seeded file says loudly that it is a guess. A generated one must not.
  assert.doesNotMatch(out, /HAND-SEEDED/);
  assert.match(out, /European Central Bank/);
});

test("the file says what an exchange rate is NOT", () => {
  // Load-bearing prose, not decoration: the owner asked for this figure to
  // show that "your dollar goes further", which is precisely what a rate
  // cannot tell you. The warning must survive regeneration, so it lives in
  // the generator's template rather than in the file it writes.
  const out = renderFile("2026-09-18", { EUR: 0.9, JPY: 150, CNY: 7, HKD: 7.8 });
  assert.match(out, /NOT a cost-of-living comparison/);
});
