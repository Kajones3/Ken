import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { RESORTS } from "./config.js";
import { loadParkRatings, saveParkRatings, ratingOrder, parseStars, type ResortRatings } from "./parkRatings.js";

const r = (id: string, stars: (number | null)[]): ResortRatings =>
  ({ id, name: id, parks: stars.map((s, i) => ({ park: `${id}${i}`, stars: s, enteredAt: null })) });

test("top rated: a resort ranks by its BEST park, then its next best (owner: Tokyo before Disney World)", () => {
  // Tokyo: DisneySea 4.9, Disneyland 4.6. WDW: Magic Kingdom 4.8 and three 4.7s.
  assert.deepEqual(ratingOrder([r("wdw", [4.8, 4.7, 4.7, 4.7]), r("tdr", [4.6, 4.9])]), ["tdr", "wdw"]);
  // Same best park: the next one decides, and a second strong park beats none.
  assert.deepEqual(ratingOrder([r("hkdl", [4.5]), r("dlr", [4.5, 4.4]), r("shdr", [4.5, null])]), ["dlr", "hkdl", "shdr"]);
  // Unrated resorts are left out, so the board can put them last.
  assert.deepEqual(ratingOrder([r("dlp", [null, null]), r("wdw", [4.1])]), ["wdw"]);
});

test("park ratings: stars are 0-5, blank clears, rounded to one decimal", () => {
  assert.deepEqual(parseStars("4.55"), { ok: true, stars: 4.6 });
  assert.deepEqual(parseStars(""), { ok: true, stars: null });
  assert.equal(parseStars("6").ok, false);
  assert.equal(parseStars("great").ok, false);
});

test("park ratings: saving keeps every change and only writes what moved", async () => {
  const db = await memoryDb();
  const before = await loadParkRatings(db, RESORTS);
  assert.ok(before.every((x) => x.parks.every((p) => p.stars === null)), "nothing rated on an empty table");
  const mk = { resortId: "wdw", park: "Magic Kingdom" };
  assert.deepEqual(await saveParkRatings(db, RESORTS, [{ ...mk, stars: "4.8" }, { resortId: "tdr", park: "Tokyo DisneySea", stars: 4.9 }], "o"), { ok: true, changed: 2 });
  // The same stars again write nothing; a change and a clear each write one row.
  assert.deepEqual(await saveParkRatings(db, RESORTS, [{ ...mk, stars: 4.8 }], "o"), { ok: true, changed: 0 });
  await saveParkRatings(db, RESORTS, [{ ...mk, stars: 4.7 }], "o");
  await saveParkRatings(db, RESORTS, [{ resortId: "tdr", park: "Tokyo DisneySea", stars: "" }], "o");
  const after = await loadParkRatings(db, RESORTS);
  assert.equal(after.find((x) => x.id === "wdw")!.parks.find((p) => p.park === "Magic Kingdom")!.stars, 4.7);
  assert.equal(after.find((x) => x.id === "tdr")!.parks.find((p) => p.park === "Tokyo DisneySea")!.stars, null);
  const { rows } = await db.query<{ n: string }>(`select count(*) as n from park_ratings`);
  assert.equal(Number(rows[0]!.n), 4, "append-only: every change is its own row");
  assert.equal((await saveParkRatings(db, RESORTS, [{ resortId: "wdw", park: "Epcot Center", stars: 3 }], "o")).ok, false);
  await db.close();
});
