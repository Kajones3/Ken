import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import {
  validateAttraction, overlay, effectiveAttractions, saveAttraction,
  deleteOwnerAttraction, listOwnerAttractions, sheetRows,
  effectiveParkList, effectiveParkLists, sheetWarnings, type OwnerAttractionRow,
  adminLandLists, removeLand, restoreLand, addLand,
} from "./ownerAttractions.js";
import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.js";
import { ATTRACTIONS, RESORTS, isOnlyAt } from "./config.js";

/** memoryDb applies db/schema.sql itself. */
const db = () => memoryDb();

/**
 * The rule these all circle, and the reason a list needs it more than a
 * number does: the database OVERRIDES the shipped list and never replaces it.
 * With owner_settings the worst a lost row does is restore a shipped price.
 * Here, "the database is the truth" would mean a failed migration or a bad
 * import silently empties the picker for everybody — and an empty list is a
 * legal list, so nothing would report a problem.
 */

test("an empty table leaves the shipped list EXACTLY as it is", async () => {
  const d = await db();
  const eff = await effectiveAttractions(d);
  assert.deepEqual(eff, [...ATTRACTIONS]);
});

test("a database that throws degrades to the shipped list, never to empty", async () => {
  // The picker going blank because a query failed is a far worse outcome
  // than showing the list the app shipped with.
  const broken = { query: async () => { throw new Error("no such table"); } } as any;
  assert.deepEqual(await effectiveAttractions(broken), [...ATTRACTIONS]);
});

test("an owner row with a new id ADDS an attraction", async () => {
  const d = await db();
  const r = await saveAttraction(d, { id: "space-mountain", name: "Space Mountain", resortIds: "wdw, dlr, dlp, tdr, hkdl" });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const eff = await effectiveAttractions(d);
  assert.equal(eff.length, ATTRACTIONS.length + 1);
  const added = eff.find((a) => a.id === "space-mountain")!;
  assert.deepEqual(added.resortIds, ["wdw", "dlr", "dlp", "tdr", "hkdl"]);
  assert.equal(isOnlyAt(added), false, "five resorts is not an exclusive");
});

test("an owner row with a SHIPPED id replaces it, in place", async () => {
  const d = await db();
  const before = ATTRACTIONS.findIndex((a) => a.id === "ratatouille");
  const saved = await saveAttraction(d, { id: "ratatouille", name: "Ratatouille", resortIds: "wdw dlp", note: "Two versions." });
  assert.ok(saved.ok, saved.ok ? "" : saved.reason);
  const eff = await effectiveAttractions(d);
  assert.equal(eff.length, ATTRACTIONS.length, "replacing must not also add");
  assert.equal(eff[before]!.id, "ratatouille", "a replacement keeps its position");
  assert.equal(eff[before]!.note, "Two versions.");
});

test("hidden = true removes a shipped attraction, and reverting brings it back", async () => {
  const d = await db();
  await saveAttraction(d, { id: "zootopia", hidden: true });
  let eff = await effectiveAttractions(d);
  assert.ok(!eff.some((a) => a.id === "zootopia"));
  assert.equal(eff.length, ATTRACTIONS.length - 1);

  // Deleting the OWNER's row restores the shipped one rather than deleting
  // the attraction — the safety property, from the other direction.
  assert.equal(await deleteOwnerAttraction(d, "zootopia"), true);
  eff = await effectiveAttractions(d);
  assert.deepEqual(eff, [...ATTRACTIONS]);
});

test("'only here' stays DERIVED — adding a resort stops the exclusivity claim", async () => {
  // The rule this feature was corrected on before it was built. An owner who
  // learns that Mystic Manor has a twin somewhere should not have to find a
  // separate "exclusive" flag to turn off.
  const d = await db();
  const shipped = ATTRACTIONS.find((a) => a.id === "mystic-manor")!;
  assert.equal(isOnlyAt(shipped), true, "shipped as Hong Kong only");
  await saveAttraction(d, { id: "mystic-manor", name: "Mystic Manor", resortIds: "hkdl, tdr" });
  const eff = await effectiveAttractions(d);
  assert.equal(isOnlyAt(eff.find((a) => a.id === "mystic-manor")!), false);
});

test("a row naming only resorts we do not have is NOT applied, and says why", async () => {
  // Written straight to the table, because validation refuses this on the way
  // in — this is the "a resort id stopped existing later" case, which is the
  // same shape as a setting stored under bounds that were later tightened.
  const d = await db();
  await d.query(
    `insert into owner_attractions (id, name, resort_ids, hidden) values ('ghost','Ghost Ride','atlantis',false)`);
  const eff = await effectiveAttractions(d);
  assert.ok(!eff.some((a) => a.id === "ghost"), "must not reach travelers");
  const listed = await listOwnerAttractions(d);
  const row = listed.find((r) => r.id === "ghost")!;
  assert.equal(row.applied, false);
  assert.match(row.problem!, /atlantis/, "the admin page has to be able to say what is wrong");
});

test("a row with SOME unknown resorts keeps the ones that exist", async () => {
  const d = await db();
  await d.query(
    `insert into owner_attractions (id, name, resort_ids, hidden) values ('half','Half Known','wdw,atlantis',false)`);
  const found = (await effectiveAttractions(d)).find((a) => a.id === "half")!;
  assert.deepEqual(found.resortIds, ["wdw"]);
});

/* ------------------------------ validation ------------------------------ */

test("an attraction must name at least one resort, and the message says why", () => {
  const r = validateAttraction({ id: "xy", name: "X", resortIds: "" });
  assert.ok(!r.ok);
  assert.match(r.reason, /EVERY resort/, "the reason is the exclusivity rule, not a schema complaint");
});

test("an unknown resort id is refused on the way in, and listed", () => {
  const r = validateAttraction({ id: "xy", name: "X", resortIds: "wdw, narnia" });
  assert.ok(!r.ok);
  assert.match(r.reason, /narnia/);
  for (const resort of RESORTS) assert.match(r.reason, new RegExp(resort.id));
});

test("a hiding row needs no name or resorts", () => {
  // Requiring them would mean typing out an attraction in order to delete it.
  const r = validateAttraction({ id: "zootopia", hidden: true });
  assert.ok(r.ok);
  assert.equal(r.value.hidden, true);
});

test("ids are constrained to the shape the shipped rows already use", () => {
  for (const bad of ["", "A", "Space Mountain", "space/mountain", "x", "sp ace", "-x"]) {
    assert.ok(!validateAttraction({ id: bad, name: "X", resortIds: "wdw" }).ok, `"${bad}" was accepted`);
  }
  assert.ok(validateAttraction({ id: "space-mountain-2", name: "X", resortIds: "wdw" }).ok);
});

test("resort ids are accepted as a list or as pasted text, and de-duplicated", () => {
  const a = validateAttraction({ id: "xy", name: "X", resortIds: ["wdw", "DLR"] });
  const b = validateAttraction({ id: "xy", name: "X", resortIds: "wdw; dlr" });
  const c = validateAttraction({ id: "xy", name: "X", resortIds: "wdw, wdw, dlr" });
  assert.ok(a.ok && b.ok && c.ok);
  assert.deepEqual(a.value.resortIds, ["wdw", "dlr"]);
  assert.deepEqual(b.value.resortIds, ["wdw", "dlr"]);
  assert.deepEqual(c.value.resortIds, ["wdw", "dlr"]);
});

/* ------------------------------- the sheet ------------------------------- */

test("the spreadsheet carries the EFFECTIVE list, so you edit what is live", async () => {
  const d = await db();
  await saveAttraction(d, { id: "tron", name: "TRON", resortIds: "wdw shdr dlp" });
  const rows = sheetRows(await effectiveAttractions(d), await listOwnerAttractions(d));
  assert.equal(rows.length, ATTRACTIONS.length);
  const tron = rows.find((r) => r.id === "tron")!;
  assert.equal(tron.resorts, "wdw shdr dlp");
  assert.equal(tron.source, "yours (replaces shipped)");
  assert.equal(rows.find((r) => r.id === "zootopia")!.source, "shipped");
});

test("a hidden attraction still appears in the sheet, flagged", async () => {
  // It is absent from the effective list by definition, so without this it
  // would vanish from the spreadsheet and come back on the next import —
  // the owner's deletion silently undoing itself.
  const d = await db();
  await saveAttraction(d, { id: "zootopia", hidden: true });
  const rows = sheetRows(await effectiveAttractions(d), await listOwnerAttractions(d));
  const z = rows.find((r) => r.id === "zootopia")!;
  assert.equal(z.hidden, "yes");
  assert.equal(z.name, "Zootopia", "with the shipped name, so it is recognisable");
});

test("overlay is pure and does not mutate the shipped list", () => {
  const snapshot = JSON.parse(JSON.stringify(ATTRACTIONS));
  overlay(ATTRACTIONS, [{
    id: "zootopia", name: "Changed", resortIds: ["wdw"], note: "", hidden: false, kind: "attraction", lands: {}, parks: {},
    applied: true, overridesShipped: true, updatedAt: null,
  }]);
  assert.deepEqual(ATTRACTIONS, snapshot);
});

test("a downloaded spreadsheet can be read back — the round trip", async () => {
  // The bug this caught: the sheet writes resorts space-separated (a comma
  // inside a CSV cell is a needless quoting hazard) while the parser split on
  // commas alone. Download, change one name, re-upload, and every row is
  // refused for naming a resort called "wdw dlr". It shows nowhere but here.
  const d = await db();
  for (const row of sheetRows(await effectiveAttractions(d), await listOwnerAttractions(d))) {
    const back = validateAttraction({ id: row.id, name: row.name, resortIds: row.resorts, note: row.note });
    assert.ok(back.ok, `${row.id} could not be read back: ${back.ok ? "" : back.reason}`);
    const shipped = ATTRACTIONS.find((a) => a.id === row.id)!;
    assert.deepEqual(back.value.resortIds, shipped.resortIds, `${row.id}'s resorts changed on the round trip`);
  }
});

test("a row identical to the shipped one is stored as NOTHING", async () => {
  // Downloading the spreadsheet and sending it straight back is what happens
  // when you change one row out of ten. Storing all ten would mark every one
  // "yours" and offer to revert them, burying the single real edit among
  // nine that only look like edits.
  const d = await db();
  const z = ATTRACTIONS.find((a) => a.id === "zootopia")!;
  const r = await saveAttraction(d, { id: z.id, name: z.name, resortIds: z.resortIds.join(" "), note: z.note });
  assert.ok(r.ok);
  assert.equal((await listOwnerAttractions(d)).length, 0, "nothing should have been written");
  assert.deepEqual(await effectiveAttractions(d), [...ATTRACTIONS]);
});

test("re-uploading the whole sheet unchanged leaves no overrides at all", async () => {
  const d = await db();
  for (const row of sheetRows(await effectiveAttractions(d), await listOwnerAttractions(d))) {
    const r = await saveAttraction(d, { id: row.id, name: row.name, resortIds: row.resorts, note: row.note });
    assert.ok(r.ok, `${row.id}: ${r.ok ? "" : r.reason}`);
  }
  assert.equal((await listOwnerAttractions(d)).length, 0);
  assert.deepEqual(await effectiveAttractions(d), [...ATTRACTIONS]);
});

test("editing back to the shipped value clears the override rather than pinning it", async () => {
  const d = await db();
  const z = ATTRACTIONS.find((a) => a.id === "zootopia")!;
  await saveAttraction(d, { id: z.id, name: "Zootopia Land", resortIds: "shdr" });
  assert.equal((await listOwnerAttractions(d)).length, 1);
  await saveAttraction(d, { id: z.id, name: z.name, resortIds: z.resortIds.join(" "), note: z.note });
  assert.equal((await listOwnerAttractions(d)).length, 0, "typing the shipped value back is not an override");
});

/* ---------------------------------- lands --------------------------------- */

test("a land cell keeps the colons inside a land's own name", async () => {
  const { parseLands } = await import("./ownerAttractions.js");
  const r = parseLands("wdw: Star Wars: Galaxy's Edge; dlr: Star Wars: Galaxy's Edge");
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.lands, { wdw: "Star Wars: Galaxy's Edge", dlr: "Star Wars: Galaxy's Edge" });
  assert.equal(parseLands("Tomorrowland").ok, false, "a land with no resort is refused, with the shape to use");
});

test("a row named after its own land is a land; everything else is a ride", async () => {
  const { inferKind } = await import("./ownerAttractions.js");
  assert.equal(inferKind("Cars Land", { dlr: "Cars Land" }), "land");
  assert.equal(inferKind("Storybook Circus", { wdw: "Fantasyland (Storybook Circus)" }), "land");
  assert.equal(inferKind("Toy Story Land", { shdr: "Disney•Pixar Toy Story Land", wdw: "Toy Story Land" }), "land");
  assert.equal(inferKind("Radiator Springs Racers", { dlr: "Cars Land" }), "attraction");
  assert.equal(inferKind("Frozen", {}), "attraction", "no land named, no reason to call it one");
});

test("a land for a resort the row doesn't list is refused, and says how to fix it", () => {
  const v = validateAttraction({ id: "x-ride", name: "X", resortIds: "wdw", lands: "wdw: Tomorrowland; dlr: Tomorrowland" });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /dlr isn't in its resorts/);
  const typed = validateAttraction({ id: "x-ride", name: "X", resortIds: "wdw", kind: "stadium" });
  assert.equal(typed.ok, false);
});

test("lands and type survive a save, the overlay and a download", async () => {
  const db = await memoryDb();
  await saveAttraction(db, { id: "cars-land", name: "Cars Land", resortIds: "dlr", lands: "dlr: Cars Land" });
  await saveAttraction(db, { id: "haunted", name: "Haunted Mansion", resortIds: "wdw dlr",
    lands: "wdw: Liberty Square; dlr: New Orleans Square", kind: "attraction" });
  const eff = await effectiveAttractions(db);
  const cars = eff.find((a) => a.id === "cars-land")!;
  assert.equal(cars.kind, "land", "worked out from the name");
  const hm = eff.find((a) => a.id === "haunted")!;
  assert.deepEqual(hm.lands, { wdw: "Liberty Square", dlr: "New Orleans Square" });
  const sheet = sheetRows(eff, await listOwnerAttractions(db));
  const row = sheet.find((r) => r.id === "haunted")!;
  assert.equal(row.land, "wdw: Liberty Square; dlr: New Orleans Square");
  assert.equal(sheet.find((r) => r.id === "cars-land")!.type, "land");
  await db.close();
});

test("hiding keeps the row: its details come back in the sheet and on un-hiding", async () => {
  const db = await memoryDb();
  const full = { id: "grizzly-gulch", name: "Grizzly Gulch", resortIds: "hkdl", lands: "hkdl: Grizzly Gulch", note: "World exclusive." };
  await saveAttraction(db, { ...full, hidden: true });
  assert.equal((await effectiveAttractions(db)).find((a) => a.id === "grizzly-gulch"), undefined, "hidden means not shown");
  const sheet = sheetRows(await effectiveAttractions(db), await listOwnerAttractions(db));
  const row = sheet.find((r) => r.id === "grizzly-gulch")!;
  assert.equal(row.hidden, "yes");
  assert.equal(row.name, "Grizzly Gulch");
  assert.equal(row.land, "hkdl: Grizzly Gulch", "a hidden row is not reduced to an empty shell");
  await saveAttraction(db, { ...full, hidden: false });
  const back = (await effectiveAttractions(db)).find((a) => a.id === "grizzly-gulch")!;
  assert.equal(back.note, "World exclusive.");
  await db.close();
});

test("the same name twice at one resort is flagged, not refused", async () => {
  const { sheetWarnings } = await import("./ownerAttractions.js");
  const v = (id: string, name: string, resorts: string) => {
    const r = validateAttraction({ id, name, resortIds: resorts });
    assert.ok(r.ok);
    return r.ok ? r.value : (null as never);
  };
  const w = sheetWarnings([
    { row: 2, value: v("pirates-a", "Pirates of the Caribbean", "wdw dlr"), onlyHere: "" },
    { row: 3, value: v("pirates-b", "Pirates of the Caribbean", "wdw"), onlyHere: "" },
    { row: 4, value: v("cars", "Radiator Springs Racers", "dlr"), onlyHere: "no" },
  ]);
  assert.equal(w.length, 2);
  assert.match(w[0]!, /row 3: .*already on row 2/);
  assert.match(w[1]!, /only_here/);
});

test("the owner's reviewed 2026-09-26 sheet uploads with no errors", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseCsv } = await import("./csv.js");
  const rows = parseCsv(readFileSync(new URL("../docs/attractions/parkfare-attractions-reviewed-2026-09-26.csv", import.meta.url), "utf8"));
  const h = rows[0]!.map((x) => x.trim().toLowerCase());
  const c = (r: string[], n: string) => (r[h.indexOf(n)] ?? "").trim();
  const bad = rows.slice(1).filter((r) => r.some((x) => x.trim())).map((r) => validateAttraction({
    id: c(r, "id"), name: c(r, "name"), resortIds: c(r, "resorts"), note: c(r, "note"),
    hidden: /^yes$/i.test(c(r, "hidden")), kind: c(r, "type"), lands: c(r, "land"),
  })).filter((v) => !v.ok);
  assert.deepEqual(bad, []);
  const ids = rows.slice(1).map((r) => c(r, "id")).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "no id twice — the upload refuses a repeated id");
});

test("a land listed once per resort never claims to be the only one", async () => {
  const db = await memoryDb();
  await saveAttraction(db, { id: "wdw-adv", name: "Adventureland", resortIds: "wdw", lands: "wdw: Adventureland" });
  await saveAttraction(db, { id: "dlp-adv", name: "Adventureland", resortIds: "dlp", lands: "dlp: Adventureland" });
  await saveAttraction(db, { id: "cars", name: "Cars Land", resortIds: "dlr", lands: "dlr: Cars Land" });
  const eff = await effectiveAttractions(db);
  assert.equal(isOnlyAt(eff.find((a) => a.id === "wdw-adv")!), false, "Paris has one too");
  assert.deepEqual(eff.find((a) => a.id === "wdw-adv")!.alsoAt, ["dlp"]);
  assert.equal(isOnlyAt(eff.find((a) => a.id === "cars")!), true, "a name nobody else uses is still only here");
  await db.close();
});

/* --------------------- lands per park (2026-09-29) --------------------- */

const WDW = RESORTS.find((r) => r.id === "wdw")!;
const HKDL = RESORTS.find((r) => r.id === "hkdl")!;
const AK = "Disney's Animal Kingdom";
const landsIn = (v: { parkList: { name: string; lands: string[] }[] }, park: string) =>
  v.parkList.find((p) => p.name === park)!.lands;

/** An owner row as listOwnerAttractions would hand it back. */
function row(input: Parameters<typeof validateAttraction>[0]): OwnerAttractionRow {
  const v = validateAttraction(input);
  if (!v.ok) throw new Error(v.reason);
  return { ...v.value, applied: true, overridesShipped: false, updatedAt: null };
}
const viewWith = (resort: typeof WDW, rows: OwnerAttractionRow[]) =>
  effectiveParkList(resort, overlay(ATTRACTIONS, rows), rows);

test("DinoLand U.S.A. is no longer listed at Animal Kingdom (owner, 2026-09-29)", () => {
  assert.ok(!landsIn(WDW, AK).some((l) => /dinoland/i.test(l)));
  assert.deepEqual(viewWith(WDW, []).parkList, WDW.parkList, "an empty sheet shows the code's list exactly");
  assert.deepEqual(viewWith(WDW, []).otherLands, []);
});

test("hiding a land row takes that land off the resort's list", () => {
  const v = viewWith(WDW, [row({ id: "ak-asia", name: "Asia", resortIds: "wdw", kind: "land", hidden: true })]);
  assert.ok(!landsIn(v, AK).includes("Asia"));
  assert.ok(landsIn(v, AK).includes("Africa"), "and nothing else");
  // Only at that resort: Hong Kong's lists are untouched.
  assert.deepEqual(viewWith(HKDL, [row({ id: "ak-asia", name: "Asia", resortIds: "wdw", kind: "land", hidden: true })]).parkList, HKDL.parkList);
});

test("hiding a REPEAT does not remove a land another visible row still covers", () => {
  const rows = [
    row({ id: "hs-toy-story", name: "Toy Story Land", resortIds: "wdw shdr hkdl", kind: "land" }),
    row({ id: "hkdl-toy-story-land", name: "Toy Story Land", resortIds: "hkdl", kind: "land", hidden: true }),
  ];
  assert.ok(landsIn(viewWith(HKDL, rows), "Hong Kong Disneyland").includes("Toy Story Land"));
});

test("a new land goes under the park its park column names, spelled loosely", () => {
  const v = viewWith(WDW, [row({
    id: "ak-tropical-americas", name: "Tropical Americas", resortIds: "wdw", kind: "land", parks: "wdw: Animal Kingdom",
  })]);
  assert.ok(landsIn(v, AK).includes("Tropical Americas"), `"Animal Kingdom" finds "${AK}"`);
  assert.deepEqual(v.otherLands, []);
});

test("a new land with no park, or a park we don't know, is shown under 'also' — never dropped", () => {
  const none = viewWith(WDW, [row({ id: "x-new", name: "Brand New Land", resortIds: "wdw", kind: "land" })]);
  assert.deepEqual(none.otherLands, ["Brand New Land"]);
  const typo = viewWith(WDW, [row({ id: "x-new", name: "Brand New Land", resortIds: "wdw", kind: "land", parks: "wdw: Animl Kngdom" })]);
  assert.deepEqual(typo.otherLands, ["Brand New Land"]);
  assert.deepEqual(typo.parkList, WDW.parkList);
});

test("a park on a land the code already lists moves it; without one it stays put", () => {
  const moved = viewWith(WDW, [row({ id: "x-asia", name: "Asia", resortIds: "wdw", kind: "land", parks: "wdw: EPCOT" })]);
  assert.ok(!landsIn(moved, AK).includes("Asia"));
  assert.ok(landsIn(moved, "EPCOT").includes("Asia"));
  const stays = viewWith(WDW, [row({ id: "x-asia", name: "Asia", resortIds: "wdw", kind: "land" })]);
  assert.deepEqual(stays.parkList, WDW.parkList);
});

test("the park column is refused on a ride, and for a resort the row doesn't list", () => {
  const ride = validateAttraction({ id: "x-ride", name: "Some Ride", resortIds: "wdw", kind: "attraction", parks: "wdw: EPCOT" });
  assert.equal(ride.ok, false);
  const other = validateAttraction({ id: "x-land", name: "Some Land", resortIds: "wdw", kind: "land", parks: "dlr: Disneyland Park" });
  assert.equal(other.ok, false);
  const bad = validateAttraction({ id: "x-land", name: "Some Land", resortIds: "wdw", kind: "land", parks: "EPCOT" });
  assert.ok(!bad.ok && /wdw: Disney's Animal Kingdom/.test(bad.reason), "the example names a park, not a land");
});

test("an unknown park is warned about on upload, not refused", () => {
  const v = validateAttraction({ id: "x-land", name: "Some Land", resortIds: "wdw", kind: "land", parks: "wdw: Animl Kngdom" });
  assert.ok(v.ok);
  const w = sheetWarnings([{ row: 2, value: v.value, onlyHere: "" }]);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /Animl Kngdom/);
});

test("a park is stored, read back and written to the sheet", async () => {
  const d = await db();
  const saved = await saveAttraction(d, { id: "ak-tropical-americas", name: "Tropical Americas", resortIds: "wdw", kind: "land", parks: "wdw: Animal Kingdom" });
  assert.ok(saved.ok);
  const owner = await listOwnerAttractions(d);
  assert.deepEqual(owner[0]!.parks, { wdw: "Animal Kingdom" });
  const sheet = sheetRows(await effectiveAttractions(d), owner);
  assert.equal(sheet.find((r) => r.id === "ak-tropical-americas")!.park, "wdw: Animal Kingdom");
  const all = await effectiveParkLists(d, RESORTS);
  assert.ok(landsIn(all.find((r) => r.id === "wdw")!, AK).includes("Tropical Americas"));
});

test("uploading the reviewed sheet removes only DinoLand and adds nothing to 'also'", () => {
  // The reviewed sheet hides exact repeats. A hide meant as "this is a
  // duplicate" must not take a real land off a resort's list, so run the
  // whole file through the same rules the app uses.
  const text = readFileSync(new URL("../docs/attractions/parkfare-attractions-reviewed-2026-09-26.csv", import.meta.url), "utf8");
  const [head, ...body] = parseCsv(text);
  const at = (r: string[], n: string) => (r[head!.indexOf(n)] ?? "").trim();
  const rows = body.filter((r) => r.some((c) => c.trim())).map((r) => row({
    id: at(r, "id"), name: at(r, "name"), resortIds: at(r, "resorts"), note: at(r, "note"),
    hidden: /^(yes|true|1|y)$/i.test(at(r, "hidden")), kind: at(r, "type"), lands: at(r, "land"), parks: at(r, "park"),
  }));
  const effective = overlay(ATTRACTIONS, rows);
  for (const resort of RESORTS) {
    const v = effectiveParkList(resort, effective, rows);
    const before = resort.parkList.flatMap((p) => p.lands).sort();
    const after = v.parkList.flatMap((p) => p.lands).sort();
    assert.deepEqual(after.filter((l) => !before.includes(l)), [], `${resort.id}: nothing new lands in a park`);
    assert.deepEqual(before.filter((l) => !after.includes(l)), [], `${resort.id}: no land is lost`);
  }
});

/* ------------------------------ the Lands page ------------------------------ */

const wdwLands = async (d: Awaited<ReturnType<typeof db>>) => (await adminLandLists(d, [WDW]))[0]!;

test("Remove takes a code-only land off one resort, and Put back returns it", async () => {
  const d = await db();
  assert.ok((await removeLand(d, "wdw", "Discovery Island")).ok);
  let v = await wdwLands(d);
  assert.ok(!landsIn(v, AK).includes("Discovery Island"));
  assert.deepEqual(v.removed, ["Discovery Island"]);
  // The removal is a hidden row, so the attraction picker is untouched.
  assert.deepEqual(await effectiveAttractions(d), [...ATTRACTIONS]);
  assert.ok((await restoreLand(d, "wdw", "Discovery Island")).ok);
  v = await wdwLands(d);
  assert.ok(landsIn(v, AK).includes("Discovery Island"));
  assert.deepEqual(v.removed, []);
  assert.equal((await listOwnerAttractions(d)).length, 0, "Put back leaves nothing behind");
});

test("Remove hides a one-resort land row instead of adding a second row", async () => {
  const d = await db();
  await addLand(d, WDW, "Tropical Americas", "Animal Kingdom");
  assert.ok(landsIn(await wdwLands(d), AK).includes("Tropical Americas"));
  await removeLand(d, "wdw", "tropical americas");
  const owner = await listOwnerAttractions(d);
  assert.equal(owner.length, 1);
  assert.ok(owner[0]!.hidden);
  assert.ok(!landsIn(await wdwLands(d), AK).includes("Tropical Americas"));
  // Adding it again is a Put back, not a duplicate.
  await addLand(d, WDW, "Tropical Americas", "Animal Kingdom");
  const after = await listOwnerAttractions(d);
  assert.equal(after.length, 1);
  assert.ok(!after[0]!.hidden);
});

test("Remove at one resort leaves a shared land row at the others, and Put back restores it", async () => {
  const d = await db();
  await saveAttraction(d, { id: "tsl", name: "Toy Story Land", resortIds: "wdw hkdl", kind: "land", parks: "wdw: Hollywood Studios" });
  await removeLand(d, "wdw", "Toy Story Land");
  const all = await adminLandLists(d, RESORTS);
  const has = (id: string) => { const r = all.find((x) => x.id === id)!; return [...r.parkList.flatMap((p) => p.lands), ...r.otherLands].includes("Toy Story Land"); };
  assert.ok(!has("wdw"));
  assert.ok(has("hkdl"));
  await restoreLand(d, "wdw", "Toy Story Land");
  const row = (await listOwnerAttractions(d)).find((o) => o.id === "tsl")!;
  assert.deepEqual([...row.resortIds].sort(), ["hkdl", "wdw"]);
});

test("Add refuses a park the resort doesn't have, and a blank name", async () => {
  const d = await db();
  assert.ok(!(await addLand(d, WDW, "Somewhere", "Tokyo DisneySea")).ok);
  assert.ok(!(await addLand(d, WDW, "  ", "")).ok);
  const r = await addLand(d, WDW, "Somewhere", "");
  assert.ok(r.ok);
  assert.deepEqual((await wdwLands(d)).otherLands, ["Somewhere"]);
  // Adding one that is already listed makes no second row.
  assert.ok(!(await addLand(d, WDW, "somewhere", "")).ok);
  assert.ok(!(await addLand(d, WDW, "Asia", "")).ok);
  assert.equal((await listOwnerAttractions(d)).length, 1);
});
