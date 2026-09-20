import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import {
  SETTINGS, SETTING_BY_KEY, validateSetting, loadSettings, setSetting, applySettings, settingsMap,
} from "./settings.js";
import { RESORTS, CAR_RENTAL } from "./config.js";

/**
 * The rule these all circle: the database OVERRIDES the shipped defaults and
 * never replaces them. An empty table, a bad row or a wiped setting must leave
 * the app pricing exactly as it did before any of this existed.
 */

test("every resort's hotels, transfers and hopper are editable", () => {
  for (const r of RESORTS) {
    for (const h of r.hotels) {
      const def = SETTING_BY_KEY.get(`hotel.${h.id}.base`);
      assert.ok(def, `${h.id} has no editable rate`);
      assert.equal(def!.default, h.base, "the shipped value is the default");
    }
    assert.ok(SETTING_BY_KEY.has(`transport.${r.id}.off`), `${r.id} off-property transfers`);
  }
  assert.equal(SETTING_BY_KEY.get("carRental.dailyRateUsd")!.default, CAR_RENTAL.dailyRateUsd);
  // Hong Kong and Shanghai have one park each and sell no hopper, so offering
  // the owner a box for it would be offering a number that does nothing.
  assert.ok(!SETTING_BY_KEY.has("hopper.hkdl.adult"));
  assert.ok(!SETTING_BY_KEY.has("hopper.shdr.adult"));
});

test("every key is unique, and every default is inside its own bounds", () => {
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "a duplicate key would silently shadow one");
  for (const s of SETTINGS) {
    assert.ok(s.default >= s.min && s.default <= s.max,
      `${s.key}: shipped default ${s.default} is outside its own ${s.min}-${s.max} range`);
    assert.ok(s.help.length > 20, `${s.key}: help text too thin to be useful`);
    assert.ok(!s.label.endsWith(":"), `${s.key}: label should not end in a colon`);
  }
});

test("validation catches a mistyped digit but accepts a typed dollar sign", () => {
  const key = `hotel.${RESORTS[0]!.hotels[0]!.id}.base`;
  assert.deepEqual(validateSetting(key, "$1,250"), { ok: true, value: 1250 },
    "people paste currency; stripping it is kinder than refusing it");
  assert.equal(validateSetting(key, 12500).ok, false, "a misplaced digit is what bounds are for");
  assert.equal(validateSetting(key, "abc").ok, false);
  assert.equal(validateSetting("not.a.key", 5).ok, false);
});

test("an empty table prices exactly as the shipped defaults", async () => {
  const db = await memoryDb();
  const loaded = await loadSettings(db);
  assert.equal(loaded.length, SETTINGS.length, "every setting is listed, not just overridden ones");
  for (const s of loaded) {
    assert.equal(s.value, SETTING_BY_KEY.get(s.key)!.default);
    assert.equal(s.overridden, false);
  }
});

test("an override wins, and clearing it goes back to the default", async () => {
  const db = await memoryDb();
  const key = "carRental.dailyRateUsd";
  const def = SETTING_BY_KEY.get(key)!.default;

  await setSetting(db, key, 95, { note: "checked against a real Orlando booking", by: "owner" });
  let map = await settingsMap(db);
  assert.equal(map.get(key), 95);

  const row = (await loadSettings(db)).find((s) => s.key === key)!;
  assert.equal(row.overridden, true);
  assert.equal(row.note, "checked against a real Orlando booking", "a number with no reason is a typo later");
  assert.ok(row.updatedAt, "and it is stamped");

  // null, not "type the default back in" — "I never changed this" and "I set
  // it to the same number" are different facts.
  await setSetting(db, key, null);
  map = await settingsMap(db);
  assert.equal(map.get(key), def);
});

test("a stored value outside its bounds falls back to the default rather than poisoning a price", async () => {
  const db = await memoryDb();
  const key = "carRental.dailyRateUsd";
  // Written directly, bypassing setSetting — this is the shape of a row left
  // behind when the registry's bounds are tightened later.
  await db.query(`insert into owner_settings (key, value) values ($1, $2::jsonb)`, [key, JSON.stringify(99999)]);
  const row = (await loadSettings(db)).find((s) => s.key === key)!;
  assert.equal(row.value, SETTING_BY_KEY.get(key)!.default, "a traveller never sees the bad number");
  assert.equal(row.overridden, false, "and the admin page shows it as not applied");
});

test("a spreadsheet applies completely or not at all", async () => {
  const db = await memoryDb();
  const good = "carRental.dailyRateUsd";
  const hotel = `hotel.${RESORTS[0]!.hotels[0]!.id}.base`;

  // One bad row among good ones must change NOTHING — a half-applied import
  // leaves pricing in a state nobody intended and nobody can identify.
  const bad = await applySettings(db, [
    { key: good, value: 80 },
    { key: hotel, value: 999999 },
    { key: "nonsense.key", value: 1 },
  ]);
  assert.equal(bad.ok, false);
  if (bad.ok === false) {
    assert.equal(bad.errors.length, 2, "every bad row is named at once, so one pass fixes them all");
    assert.ok(bad.errors.some((e) => e.includes("row 3")), "and named by spreadsheet row number");
    assert.ok(bad.errors.some((e) => e.includes("row 4")));
  }
  assert.equal((await settingsMap(db)).get(good), SETTING_BY_KEY.get(good)!.default, "nothing was written");

  const ok = await applySettings(db, [{ key: good, value: 80 }, { key: hotel, value: 300 }]);
  assert.equal(ok.ok, true);
  const map = await settingsMap(db);
  assert.equal(map.get(good), 80);
  assert.equal(map.get(hotel), 300);
});

test("a duplicated key in a spreadsheet is refused rather than last-one-wins", async () => {
  const db = await memoryDb();
  const r = await applySettings(db, [
    { key: "carRental.dailyRateUsd", value: 70 },
    { key: "carRental.dailyRateUsd", value: 90 },
  ]);
  assert.equal(r.ok, false, "silently taking the last one hides a real editing mistake");
});

test("a blank cell in a spreadsheet means back to the default, not zero", async () => {
  const db = await memoryDb();
  const key = "carRental.dailyRateUsd";
  await setSetting(db, key, 120);
  const r = await applySettings(db, [{ key, value: "" }]);
  assert.equal(r.ok, true);
  assert.equal((await settingsMap(db)).get(key), SETTING_BY_KEY.get(key)!.default);
});
