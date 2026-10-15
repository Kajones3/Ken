import { test } from "node:test";
import assert from "node:assert/strict";
import { foodDay, mealPrice, mealKey, taxKey, tipKey, shippedMealRange, CHILD_MEAL_SHARE_KEY, MEALS } from "./meals.js";
import { foodMultiplier } from "./pricing.js";
import { RESORTS } from "./config.js";
import { SETTING_BY_KEY } from "./settings.js";

const none = () => undefined;
const with_ = (m: Record<string, number>) => (k: string) => m[k];

test("every resort has a range for every meal, low below high", () => {
  for (const r of RESORTS) {
    for (const k of ["qs", "ts", "character", "snack", "groceries"] as const) {
      const s = shippedMealRange(r.id, k);
      assert.ok(s && s.low > 0 && s.high >= s.low, `${r.id} ${k}`);
    }
  }
});

test("the MIDDLE of the range is priced, for the owner's own range too", () => {
  // Owner: "most character dining in Disney World will be between 50 - 75".
  const own = with_({ [mealKey("wdw", "character", "low")]: 50, [mealKey("wdw", "character", "high")]: 75,
    [taxKey("wdw")]: 0, [tipKey("wdw")]: 0 });
  assert.equal(mealPrice(own, "wdw", "character"), 62.5);
});

test("US table-service and character meals carry tax AND the tip; quick service only tax", () => {
  const p = with_({ [mealKey("wdw", "ts", "low")]: 40, [mealKey("wdw", "ts", "high")]: 60,
    [mealKey("wdw", "qs", "low")]: 20, [mealKey("wdw", "qs", "high")]: 20 });
  assert.equal(mealPrice(p, "wdw", "ts"), Math.round(50 * (1 + 0.065 + 0.18) * 100) / 100);
  assert.equal(mealPrice(p, "wdw", "qs"), Math.round(20 * 1.065 * 100) / 100);
});

test("overseas menus include tax and nobody tips (Paris, Tokyo)", () => {
  for (const id of ["dlp", "tdr"]) {
    const s = shippedMealRange(id, "ts")!;
    assert.equal(mealPrice(none, id, "ts"), Math.round(((s.low + s.high) / 2) * 100) / 100);
    assert.equal(foodDay(none, id, "ts").tipPct, 0);
  }
});

test("groceries are never taxed or tipped", () => {
  const s = shippedMealRange("wdw", "groceries")!;
  assert.equal(mealPrice(none, "wdw", "groceries"), (s.low + s.high) / 2);
});

test("a day of meals adds up, and 'plan' prices as quick service", () => {
  const d = foodDay(none, "wdw", "mix");
  const sum = d.meals.reduce((s, m) => s + m.count * m.each, 0);
  assert.ok(Math.abs(d.perAdult - sum) < 0.01);
  assert.deepEqual(d.meals.map((m) => [m.kind, m.count]), [["qs", 2], ["ts", 1], ["snack", 1]]);
  assert.equal(foodDay(none, "wdw", "plan").perAdult, foodDay(none, "wdw", "qs").perAdult);
});

test("children eat the owner-set share; teenagers eat as adults; under-3s free", () => {
  assert.equal(foodDay(none, "wdw", "qs").childSharePct, 63);
  assert.equal(foodDay(with_({ [CHILD_MEAL_SHARE_KEY]: 60 }), "wdw", "qs").childSharePct, 60);
  assert.equal(foodMultiplier("child", 63), 0.63);
  assert.equal(foodMultiplier("junior"), 1);
  assert.equal(foodMultiplier("infant"), 0);
});

test("every meal price is an owner setting whose default is the shipped seed", () => {
  for (const id of Object.keys(MEALS)) {
    const def = SETTING_BY_KEY.get(mealKey(id, "character", "high"));
    assert.equal(def?.default, shippedMealRange(id, "character")!.high);
  }
  assert.ok(SETTING_BY_KEY.get(tipKey("wdw")));
  assert.ok(!SETTING_BY_KEY.get(tipKey("tdr")), "no tip setting where nobody tips");
});
