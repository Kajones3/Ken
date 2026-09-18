import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { memoryDb, type Db } from "./db.js";
import {
  matchesForResort, matchSummary, resolvePicks, picksFor, setPicks, MAX_PICKS,
} from "./attractions.js";
import { ATTRACTIONS, ATTRACTION_BY_ID, attractionsFor, isOnlyAt, RESORTS } from "./config.js";

/* ---------------------------------------------------------------------------
 * The data model. The one rule: "only here" is derived from the resort list,
 * never asserted, because clones across resorts are normal and a wrong
 * exclusivity claim sends someone to the wrong side of the planet.
 * ------------------------------------------------------------------------ */

test("an attraction at two resorts is not exclusive to either", () => {
  // The correction that shaped this whole file: Ratatouille runs at EPCOT
  // AND at Walt Disney Studios. A per-row "onlyAt" flag would have been free
  // to disagree with the list; a derived one cannot.
  const rat = ATTRACTION_BY_ID.get("ratatouille")!;
  assert.deepEqual([...rat.resortIds].sort(), ["dlp", "wdw"]);
  assert.equal(isOnlyAt(rat), false);
  assert.equal(matchesForResort("wdw", ["ratatouille"]).onlyHereCount, 0);
  assert.equal(matchesForResort("dlp", ["ratatouille"]).onlyHereCount, 0);
});

test("an attraction at one resort is exclusive to it", () => {
  const zoo = ATTRACTION_BY_ID.get("zootopia")!;
  assert.deepEqual(zoo.resortIds, ["shdr"]);
  assert.equal(isOnlyAt(zoo), true);
  assert.equal(matchesForResort("shdr", ["zootopia"]).onlyHereCount, 1);
});

test("adding a clone makes an attraction stop being exclusive, with no other edit", () => {
  // The property the shape exists for, checked directly: exclusivity is a
  // fact about the list. Nobody has to remember to clear a flag when a
  // second resort opens its own version.
  const one = { id: "x", name: "X", resortIds: ["shdr"] };
  const two = { ...one, resortIds: ["shdr", "wdw"] };
  assert.equal(isOnlyAt(one), true);
  assert.equal(isOnlyAt(two), false);
});

test("every attraction names at least one real resort", () => {
  // A typo'd resort id would make an attraction invisible everywhere while
  // still looking fine in the file.
  const ids = new Set(RESORTS.map((r) => r.id));
  for (const a of ATTRACTIONS) {
    assert.ok(a.resortIds.length > 0, `${a.id} lists no resort`);
    assert.equal(new Set(a.resortIds).size, a.resortIds.length, `${a.id} repeats a resort`);
    for (const rid of a.resortIds) assert.ok(ids.has(rid), `${a.id} names unknown resort ${rid}`);
  }
});

test("attraction ids are unique", () => {
  // A user's saved picks reference the id, so a duplicate would make one
  // person's choice silently mean the other attraction.
  const ids = ATTRACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("attractionsFor is consistent with the resort lists", () => {
  for (const r of RESORTS) {
    for (const a of attractionsFor(r.id)) {
      assert.ok(a.resortIds.includes(r.id), `${a.id} returned for ${r.id} it doesn't list`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * Matching.
 * ------------------------------------------------------------------------ */

test("matched and missing split a traveller's picks with nothing lost", () => {
  const picks = ["zootopia", "ratatouille", "mystic-manor"];
  const m = matchesForResort("shdr", picks);
  assert.deepEqual(m.matched.map((x) => x.id), ["zootopia"]);
  assert.deepEqual(m.missing.map((x) => x.id).sort(), ["mystic-manor", "ratatouille"]);
  assert.equal(m.matched.length + m.missing.length, picks.length, "every pick is accounted for");
});

test("exclusives sort ahead of shared ones", () => {
  // The ones that change a decision must not be buried under the ones that
  // don't.
  const m = matchesForResort("wdw", ["ratatouille", "guardians-cosmic-rewind", "tron"]);
  assert.equal(m.matched[0]!.id, "guardians-cosmic-rewind", "the exclusive comes first");
  assert.ok(m.matched[0]!.onlyHere);
});

test("the order of matches doesn't depend on the order boxes were ticked", () => {
  const a = matchesForResort("wdw", ["tron", "ratatouille", "guardians-cosmic-rewind"]);
  const b = matchesForResort("wdw", ["guardians-cosmic-rewind", "ratatouille", "tron"]);
  assert.deepEqual(a.matched.map((x) => x.id), b.matched.map((x) => x.id));
});

test("an unknown pick is dropped, never thrown", () => {
  // Saved picks outlive edits to the list. An attraction that closes and is
  // removed would otherwise break the board of everyone who picked it —
  // far worse than quietly ignoring one row.
  assert.deepEqual(resolvePicks(["zootopia", "was-removed-last-year"]).map((a) => a.id), ["zootopia"]);
  const m = matchesForResort("shdr", ["zootopia", "nope"]);
  assert.deepEqual(m.matched.map((x) => x.id), ["zootopia"]);
  assert.equal(m.missing.length, 0, "an unknown id is not reported as missing either");
});

test("a duplicate pick is counted once", () => {
  assert.equal(resolvePicks(["zootopia", "zootopia"]).length, 1);
});

test("no picks means no matching at all", () => {
  const m = matchesForResort("wdw", []);
  assert.deepEqual(m.matched, []);
  assert.deepEqual(m.missing, []);
  assert.equal(matchSummary(m, 0), null, "nothing to say, so say nothing");
});

test("the summary leads with what is at stake, not a score", () => {
  // "Only place with Zootopia" is a reason to look twice. "1/3" is trivia.
  const shdr = matchesForResort("shdr", ["zootopia", "ratatouille", "mystic-manor"]);
  assert.equal(matchSummary(shdr, 3), "Only place with Zootopia");

  const wdw = matchesForResort("wdw", ["ratatouille", "tron"]);
  assert.equal(matchSummary(wdw, 2), "2 of your 2 picks", "no exclusives, so just the count");

  const dlr = matchesForResort("dlr", ["zootopia"]);
  assert.equal(matchSummary(dlr, 1), "None of your 1 picks");
});

/* ---------------------------------------------------------------------------
 * Persistence.
 * ------------------------------------------------------------------------ */

async function makeUser(db: Db): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into users (id, email) values ($1,$2)`, [id, `${id}@example.test`]);
  return id;
}

test("picks round-trip, and replacing the set removes what was unticked", async () => {
  // The UI is checkboxes, so "here is what I want now" is the honest shape —
  // and it makes unticking the LAST box work without a separate delete route.
  const db = await memoryDb();
  const id = await makeUser(db);
  await setPicks(db, id, ["zootopia", "tron"]);
  assert.deepEqual((await picksFor(db, id)).sort(), ["tron", "zootopia"]);

  await setPicks(db, id, ["zootopia"]);
  assert.deepEqual(await picksFor(db, id), ["zootopia"]);

  await setPicks(db, id, []);
  assert.deepEqual(await picksFor(db, id), [], "the last one can be removed");
  await db.close();
});

test("an unknown attraction id is refused rather than stored", async () => {
  // It would sit in the table doing nothing — resolvePicks drops it on the
  // way out — and a save that silently does nothing is worse than a refusal.
  const db = await memoryDb();
  const id = await makeUser(db);
  await setPicks(db, id, ["zootopia"]);
  await assert.rejects(() => setPicks(db, id, ["zootopia", "not-a-ride"]), /unknown attraction/);
  assert.deepEqual(await picksFor(db, id), ["zootopia"], "the earlier set is untouched");
  await db.close();
});

test("an absurd number of picks is refused", async () => {
  const db = await memoryDb();
  const id = await makeUser(db);
  const many = Array.from({ length: MAX_PICKS + 1 }, (_, i) => `x${i}`);
  await assert.rejects(() => setPicks(db, id, many));
  await db.close();
});

test("one account's picks are not another's", async () => {
  const db = await memoryDb();
  const a = await makeUser(db);
  const b = await makeUser(db);
  await setPicks(db, a, ["zootopia"]);
  assert.deepEqual(await picksFor(db, a), ["zootopia"]);
  assert.deepEqual(await picksFor(db, b), []);
  await db.close();
});

test("picks survive being saved twice with the same content", async () => {
  // Delete-then-insert must not trip its own primary key on a no-op save.
  const db = await memoryDb();
  const id = await makeUser(db);
  await setPicks(db, id, ["zootopia", "tron"]);
  await setPicks(db, id, ["zootopia", "tron"]);
  assert.deepEqual((await picksFor(db, id)).sort(), ["tron", "zootopia"]);
  await db.close();
});
