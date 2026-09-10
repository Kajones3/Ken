import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RESORTS, RESORT_BY_ID } from "./config.js";

/**
 * `dataConfidence` is the "we are least sure about this resort's ticket
 * pricing" badge. It exists so the six-resort comparison can stay complete
 * without overclaiming — the same honesty rule the flight estimates follow.
 *
 * These tests pin WHICH resorts carry it. That is a launch decision, not an
 * implementation detail: adding or removing a badge should be a deliberate
 * edit that fails a test first, never something that drifts.
 */
test("only the two resorts with real ticket-model gaps carry a confidence badge", () => {
  const flagged = RESORTS.filter((r) => r.dataConfidence).map((r) => r.id).sort();
  assert.deepEqual(flagged, ["hkdl", "shdr"]);
});

test("Shanghai's badge names the actual gap: height bands, which are not modelled", () => {
  const shdr = RESORT_BY_ID.get("shdr")!;
  assert.ok(shdr.dataConfidence);
  assert.match(shdr.dataConfidence!.note, /height/i);
  // The badge must stay true to the model. If height banding is ever
  // implemented, `bands` grows a height field and this assertion is the
  // reminder to drop the badge rather than leave it lying to people.
  assert.ok(
    !("height" in (shdr.bands as object)),
    "height banding appears to be modelled now — remove Shanghai's badge",
  );
});

test("Hong Kong's badge names the actual gap: unverified age bands", () => {
  const hkdl = RESORT_BY_ID.get("hkdl")!;
  assert.ok(hkdl.dataConfidence);
  assert.match(hkdl.dataConfidence!.note, /age/i);
});

test("every badge renders and gives the reader somewhere to check", () => {
  for (const r of RESORTS) {
    const dc = r.dataConfidence;
    if (!dc) continue;
    // Short enough to sit in a chip next to the resort name.
    assert.ok(dc.level.length > 0 && dc.level.length <= 24,
      `${r.id}: badge label "${dc.level}" is ${dc.level.length} chars, too long for a chip`);
    // A real, actionable sentence — not "we're still working on it".
    assert.ok(dc.note.length >= 60, `${r.id}: note is too short to explain anything`);
    assert.match(dc.note, /[.!]$/, `${r.id}: note should end as a sentence`);
    assert.doesNotMatch(dc.note, /working on it|coming soon|TBD/i,
      `${r.id}: say what is actually unmodelled, not that it is in progress`);
    // The detail view links here so someone can check the real price.
    assert.match(r.ticketUrl, /^https:\/\//, `${r.id}: badge needs a real ticket URL to link to`);
  }
});

test("a badged resort is still fully priced — badging is not hiding", () => {
  // The whole point of choosing badges over a staged launch: all six resorts
  // still price. A badge that quietly disabled a resort would defeat it.
  for (const id of ["shdr", "hkdl"]) {
    const r = RESORT_BY_ID.get(id)!;
    assert.ok(r.ticket.base > 0, `${id} must still have real ticket pricing`);
    assert.ok(r.hotels.length > 0, `${id} must still have hotels to price`);
    assert.ok(r.food.qs > 0, `${id} must still have food rates`);
  }
});
