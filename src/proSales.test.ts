import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryDb } from "./db.js";
import { PRO_PASSES } from "./config.js";
import {
  validateSale, activeSale, salePrice, passesWithSale, saveSale, listSales, currentSale,
  setSaleActive, deleteSale, type Sale,
} from "./proSales.js";

const TODAY = "2026-11-11";
const sale = (o: Partial<Sale>): Sale => ({ id: "x", label: "Launch sale", pctOff: 20, startsOn: "2026-11-01",
  endsOn: "2026-11-30", active: true, createdAt: "2026-11-01T00:00:00Z", status: "live", ...o });

test("a sale needs a name, a whole percent from 1 to 90, and real dates that haven't passed", () => {
  const ok = { label: "Christmas sale", pctOff: "25%", startsOn: "2026-12-01", endsOn: "2026-12-26" };
  assert.deepEqual(validateSale(ok, TODAY), { ok: true, value: { label: "Christmas sale", pctOff: 25, startsOn: "2026-12-01", endsOn: "2026-12-26" } });
  assert.equal(validateSale({ ...ok, label: " " }, TODAY).ok, false);
  for (const pct of ["0", "91", "12.5", "abc"]) assert.equal(validateSale({ ...ok, pctOff: pct }, TODAY).ok, false, pct);
  assert.equal(validateSale({ ...ok, endsOn: "2026-11-30" }, TODAY).ok, false, "last day before first");
  assert.equal(validateSale({ ...ok, startsOn: "2026-10-01", endsOn: "2026-11-10" }, TODAY).ok, false, "already ended");
  assert.equal(validateSale({ ...ok, startsOn: "2026-02-30" }, TODAY).ok, false, "not a real date");
});

test("the sale on today is turned on and covers today; the newest saved wins an overlap", () => {
  assert.equal(activeSale([sale({ startsOn: "2026-11-12" })], TODAY), null, "not started");
  assert.equal(activeSale([sale({ endsOn: "2026-11-10" })], TODAY), null, "ended");
  assert.equal(activeSale([sale({ active: false })], TODAY), null, "turned off");
  assert.equal(activeSale([sale({ startsOn: TODAY, endsOn: TODAY })], TODAY)?.label, "Launch sale", "first and last day count");
  const xmas = sale({ id: "y", label: "Christmas sale", pctOff: 30, createdAt: "2026-11-05T00:00:00Z" });
  assert.equal(activeSale([sale({}), xmas], TODAY)?.label, "Christmas sale");
});

test("sale prices come off every pass, to the cent; no sale leaves the regular price", () => {
  assert.equal(salePrice(15, 20), 12);
  assert.equal(salePrice(9, 25), 6.75);
  const on = passesWithSale(sale({ pctOff: 20 }));
  assert.deepEqual(on.map((p) => [p.id, p.nowUsd, p.salePriceUsd]),
    PRO_PASSES.map((p) => [p.id, salePrice(p.priceUsd, 20), salePrice(p.priceUsd, 20)]));
  assert.ok(on.every((p, i) => p.priceUsd === PRO_PASSES[i]!.priceUsd), "the regular price is kept beside it");
  const off = passesWithSale(null);
  assert.ok(off.every((p) => p.nowUsd === p.priceUsd && p.salePriceUsd === null));
});

test("saving, editing, turning off and deleting a sale in the database", async () => {
  const db = await memoryDb();
  assert.equal(await currentSale(db, TODAY), null);
  const r = await saveSale(db, { label: "Launch sale", pctOff: 20, startsOn: "2026-11-10", endsOn: "2026-11-20" }, TODAY);
  assert.ok(r.ok);
  const id = (r as { id: string }).id;
  assert.equal((await currentSale(db, TODAY))?.pctOff, 20);
  assert.ok((await saveSale(db, { label: "Launch sale", pctOff: 30, startsOn: "2026-11-10", endsOn: "2026-11-20" }, TODAY, id)).ok);
  assert.equal((await currentSale(db, TODAY))?.pctOff, 30, "edited in place");
  assert.equal((await listSales(db, TODAY)).length, 1);
  await setSaleActive(db, id, false);
  assert.equal(await currentSale(db, TODAY), null, "turned off = full price");
  assert.equal((await listSales(db, TODAY))[0]!.status, "off");
  assert.ok(await deleteSale(db, id));
  assert.equal((await listSales(db, TODAY)).length, 0);
  await db.close();
});
