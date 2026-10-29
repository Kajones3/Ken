import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memoryDb } from "./db.js";
import { irsMileageRate, mileageRateStatus, newestMileageRateYear } from "./config.js";
import { parseIrsMileageTable, checkIrsMileage, saveMileageRate, loadMileageRates, listMileageRates } from "./mileageRates.js";

const page = readFileSync(new URL("./testdata/irs-mileage-rates-2026-10-29.html", import.meta.url), "utf8");

test("IRS page: the real table (2026-10-29) reads into one row per year, both halves", () => {
  const rows = parseIrsMileageTable(page);
  assert.deepEqual(rows.find((r) => r.year === 2026), { year: 2026, janToJunPerMile: 0.725, julToDecPerMile: 0.76 });
  assert.deepEqual(rows.find((r) => r.year === 2025), { year: 2025, janToJunPerMile: 0.7, julToDecPerMile: 0.7 });
  assert.deepEqual(rows.find((r) => r.year === 2022), { year: 2022, janToJunPerMile: 0.585, julToDecPerMile: 0.625 });
  assert.deepEqual(parseIrsMileageTable("<p>no table</p>"), []);
});

test("IRS check: reads and compares, writes nothing; a new year shows as new", async () => {
  const db = await memoryDb();
  const withNext = page.replace("<tbody>", "<tbody><tr><td>2027</td><td>79</td><td>14</td><td>21</td><td>x</td></tr>");
  const fakeFetch = (async () => new Response(withNext, { status: 200 })) as unknown as typeof fetch;
  const r = await checkIrsMileage(db, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(r.years.find((y) => y.year === 2027)?.status, "new");
  assert.equal(r.years.find((y) => y.year === 2026)?.status, "same");
  assert.deepEqual(await loadMileageRates(db), [], "checking writes nothing");
  const down = await checkIrsMileage(db, (async () => new Response("", { status: 503 })) as unknown as typeof fetch);
  assert.equal(down.ok, false);
  await db.close();
});

test("a saved year prices driving trips as that year's own rate, not one carried forward", async () => {
  const db = await memoryDb();
  const next = newestMileageRateYear() + 1;
  const before = irsMileageRate(`${next}-03-10`);
  assert.equal(before.ok && before.carriedForward, true);
  assert.equal((await saveMileageRate(db, { year: next, janToJunPerMile: 0.79, julToDecPerMile: 0.81 }, "o")).ok, true);
  const saved = await loadMileageRates(db);
  const after = irsMileageRate(`${next}-08-10`, saved);
  assert.deepEqual(after, { ok: true, ratePerMile: 0.81, rateYear: next, tripYear: next, carriedForward: false });
  assert.ok(!mileageRateStatus(`${next}-01-05`, 300, saved).uncoveredYears.includes(next));
  assert.equal((await listMileageRates(db))[0]!.from, "yours");
  assert.equal((await saveMileageRate(db, { year: next, janToJunPerMile: 79, julToDecPerMile: 0.8 }, "o")).ok, false, "cents typed as dollars is refused");
  await db.close();
});
