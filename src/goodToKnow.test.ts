import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { RESORTS, RESORT_BY_ID } from "./config.js";
import { effectiveNotes, adminNotes, listNoteRows, saveNote, shippedKey, withEffectiveNotes } from "./goodToKnow.js";

const dlp = RESORT_BY_ID.get("dlp")!;
const today = "2026-10-29";

test("good to know: an empty table shows exactly the shipped notes", async () => {
  const db = await memoryDb();
  const rows = await listNoteRows(db);
  assert.deepEqual(effectiveNotes(dlp, rows, today), dlp.goodToKnow);
  const all = await withEffectiveNotes(db, RESORTS, today);
  assert.deepEqual(all.map((r) => r.goodToKnow), RESORTS.map((r) => r.goodToKnow));
});

test("good to know: add, edit, hide, schedule and put back", async () => {
  const db = await memoryDb();
  const ij = "Indiana Jones and the Temple of Peril closes in January 2027.";
  assert.equal((await saveNote(db, RESORTS, { action: "save", resortId: "dlp", text: ij }, "o")).ok, true);
  let rows = await listNoteRows(db);
  assert.deepEqual(effectiveNotes(dlp, rows, today), [...dlp.goodToKnow, ij], "your note comes after the shipped ones");
  const mine = rows.find((r) => r.own)!;

  // A stop-showing date retires it the day after.
  await saveNote(db, RESORTS, { action: "save", resortId: "dlp", key: mine.key, text: ij, showUntil: "2027-06-30" }, "o");
  rows = await listNoteRows(db);
  assert.ok(effectiveNotes(dlp, rows, "2027-06-30").includes(ij));
  assert.ok(!effectiveNotes(dlp, rows, "2027-07-01").includes(ij));
  assert.equal(adminNotes(dlp, rows, "2027-07-01").find((n) => n.key === mine.key)!.expired, true, "still listed in /admin");

  // Edit a shipped note's words, then hide it, then put the original back.
  const space = dlp.goodToKnow[1]!;
  const key = shippedKey("dlp", space);
  await saveNote(db, RESORTS, { action: "save", resortId: "dlp", key, text: "Hyperspace Mountain closes late 2027." }, "o");
  rows = await listNoteRows(db);
  assert.ok(effectiveNotes(dlp, rows, today).includes("Hyperspace Mountain closes late 2027."));
  assert.ok(!effectiveNotes(dlp, rows, today).includes(space));
  assert.equal(adminNotes(dlp, rows, today).find((n) => n.key === key)!.source, "edited");
  await saveNote(db, RESORTS, { action: "save", resortId: "dlp", key, text: space, hidden: true }, "o");
  rows = await listNoteRows(db);
  assert.ok(!effectiveNotes(dlp, rows, today).some((t) => /Hyperspace/.test(t)), "hidden");
  await saveNote(db, RESORTS, { action: "save", resortId: "dlp", key, text: space, hidden: false }, "o");
  rows = await listNoteRows(db);
  assert.ok(!rows.some((r) => r.key === key), "back to the shipped words = nothing stored");
  assert.ok(effectiveNotes(dlp, rows, today).includes(space));

  // Delete your own; other resorts never see a dlp note.
  await saveNote(db, RESORTS, { action: "delete", resortId: "dlp", key: mine.key }, "o");
  rows = await listNoteRows(db);
  assert.deepEqual(effectiveNotes(dlp, rows, today), dlp.goodToKnow);
});

test("good to know: refuses an empty, too-long or unknown-resort note", async () => {
  const db = await memoryDb();
  assert.equal((await saveNote(db, RESORTS, { action: "save", resortId: "dlp", text: "  " }, "o")).ok, false);
  assert.equal((await saveNote(db, RESORTS, { action: "save", resortId: "dlp", text: "x".repeat(601) }, "o")).ok, false);
  assert.equal((await saveNote(db, RESORTS, { action: "save", resortId: "nope", text: "hi" }, "o")).ok, false);
  assert.equal((await saveNote(db, RESORTS, { action: "save", resortId: "dlp", text: "hi", showUntil: "June" }, "o")).ok, false);
});
