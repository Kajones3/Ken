/**
 * The owner's own attraction list, as an OVERLAY on the one in config.ts.
 *
 * The owner's ask was short — "make sure I have a way to maintain the
 * attractions list" — and the shipped rows have always been a starter set
 * Claude was confident about rather than a researched catalog. Until now
 * the only way to change one was to edit TypeScript and deploy, which is
 * exactly the dependence the settings registry was built to end: "I don't
 * want to depend on AI to update this site."
 *
 * THE SAFETY PROPERTY, and it is the whole design. The database overrides the
 * shipped list and never replaces it. An empty table, a wiped row, or a row
 * the code no longer considers valid must leave the app behaving exactly as
 * it did before any of this existed. `ownerAttractions.test.ts` pins that
 * directly.
 *
 * A list makes this matter more than a number does, not less. With
 * owner_settings, the worst a lost row does is restore a shipped price. With
 * a list, "the database is the truth" would mean a failed migration or a bad
 * import silently empties the attractions picker for every user — and nothing
 * would report a problem, because an empty list is a legal list.
 *
 * WHAT A ROW CAN DO, decided by its id and its `hidden` flag:
 *   - an id matching a shipped attraction REPLACES its name, resorts and note
 *   - an id matching nothing ADDS an attraction
 *   - hidden = true REMOVES one from the list
 *
 * LANDS (2026-09-26). The owner's list mixes whole themed lands (Cars Land,
 * Zootopia, Pandora) with the rides inside them, so a row has a `kind` and,
 * per resort, the land it sits in. The sheet writes lands as
 * "wdw: Liberty Square; dlr: New Orleans Square" — one cell, resort then
 * land, because clones move between lands from resort to resort. A blank
 * type is worked out from the name (a row named after its own land is a
 * land); the downloaded sheet always writes it out so it can be corrected.
 *
 * HIDDEN ROWS KEEP THEIR DETAILS. The owner's ask was to "choose the
 * lands/attractions that are displayed", so hiding is a display switch, not a
 * delete: a hidden row keeps its name, resorts and lands, stays in the
 * downloaded sheet, and comes back with one click.
 *
 * "Only here" stays derived from the resort list, never asserted. That rule
 * predates this file and survives it: `isOnlyAt` still reads `resortIds`, so
 * an owner who adds Paris to Ratatouille automatically stops the app claiming
 * EPCOT is the only place to ride it.
 */
import type { Db } from "./db.js";
import { ATTRACTIONS, RESORTS, isOnlyAt, type AttractionDef } from "./config.js";

const KNOWN_RESORTS = new Set(RESORTS.map((r) => r.id));

/** Ids are used in URLs, in saved picks and as a primary key. Keep them to
 *  the shape the shipped rows already use so one can never need escaping. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const MAX_NAME = 120;
export const MAX_NOTE = 400;
export const MAX_LAND = 80;

export type AttractionKind = "land" | "attraction";

export interface OwnerAttractionRow {
  id: string;
  name: string;
  resortIds: string[];
  note: string;
  kind: AttractionKind;
  lands: Record<string, string>;
  hidden: boolean;
  /** False when this row cannot be applied — every resort it names has
   *  stopped existing, say. Listed anyway, marked, for the same reason an
   *  expired fare correction is: "where did my row go?" is a worse question
   *  than seeing it grayed out. */
  applied: boolean;
  /** Why it is not applied, for the admin page to print as written. */
  problem?: string;
  /** True when this row overrides one of the shipped attractions rather than
   *  adding a new one — worth showing, since the two are undone differently. */
  overridesShipped: boolean;
  updatedAt: Date | null;
}

export interface AttractionInput {
  id?: unknown; name?: unknown; resortIds?: unknown; note?: unknown; hidden?: unknown;
  /** "land" or "attraction"; blank means work it out from the name. */
  kind?: unknown;
  /** "wdw: Tomorrowland; shdr: Tomorrowland", or an object of the same. */
  lands?: unknown;
}

export interface AttractionValue {
  id: string; name: string; resortIds: string[]; note: string; hidden: boolean;
  kind: AttractionKind; lands: Record<string, string>;
}

export type ValidatedAttraction =
  | { ok: true; value: AttractionValue }
  | { ok: false; reason: string };

/**
 * "wdw: Star Wars: Galaxy's Edge; dlr: Star Wars: Galaxy's Edge" -> a map.
 *
 * Split on ";" between resorts and on the FIRST colon inside each part, since
 * land names carry colons of their own ("Star Wars: Galaxy's Edge").
 */
export function parseLands(raw: unknown): { ok: true; lands: Record<string, string> } | { ok: false; reason: string } {
  const lands: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const land = String(v ?? "").trim();
      if (land) lands[k.trim().toLowerCase()] = land;
    }
    return { ok: true, lands };
  }
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, lands };
  for (const part of text.split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^([a-z]+)\s*:\s*(.+)$/i.exec(piece);
    if (!m) return { ok: false, reason: `"${piece}" should look like "wdw: Tomorrowland" — a resort id, a colon, then the land.` };
    const resort = m[1]!.toLowerCase();
    if (lands[resort]) return { ok: false, reason: `the land column names ${resort} twice.` };
    lands[resort] = m[2]!.trim();
  }
  return { ok: true, lands };
}

/** A row named after its own land is a land ("Cars Land" in "dlr: Cars Land"),
 *  including an area written inside another land's brackets ("Storybook
 *  Circus" in "Fantasyland (Storybook Circus)"). Everything else is a ride. */
export function inferKind(name: string, lands: Record<string, string>): AttractionKind {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(name);
  if (!n) return "attraction";
  for (const land of Object.values(lands)) {
    if (norm(land) === n) return "land";
    const inner = /\(([^)]+)\)/.exec(land);
    if (inner && norm(inner[1]!) === n) return "land";
  }
  return "attraction";
}

function parseKind(raw: unknown): AttractionKind | null | "bad" {
  const k = String(raw ?? "").trim().toLowerCase();
  if (!k) return null;
  if (k === "land" || k === "lands" || k === "area") return "land";
  if (["attraction", "ride", "show", "attractions"].includes(k)) return "attraction";
  return "bad";
}

/**
 * Accept "wdw, dlr", "wdw dlr" and ["wdw","dlr"] alike.
 *
 * WHITESPACE IS A REAL SEPARATOR HERE, not a nicety. The spreadsheet writes
 * this column space-separated (a comma inside a CSV cell is a needless
 * quoting hazard), so a parser that split on commas alone could not read back
 * the file it had just produced — download, change one name, re-upload, and
 * every row is refused for naming a resort called "wdw dlr". Caught by a
 * round-trip test, which is the only place it shows.
 */
function parseResortIds(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : String(raw ?? "").split(/[\s,;|]+/);
  const out: string[] = [];
  for (const p of parts) {
    const id = p.trim().toLowerCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function validateAttraction(input: AttractionInput): ValidatedAttraction {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!id) return { ok: false, reason: "Every attraction needs an id — a short name in lower case with dashes, like \"space-mountain\"." };
  if (!ID_SHAPE.test(id)) {
    return { ok: false, reason: `"${id}" is not a usable id. Use lower-case letters, numbers and dashes, 2 to 64 characters — for example "space-mountain".` };
  }

  const hidden = input.hidden === true || input.hidden === "true" || input.hidden === "yes" || input.hidden === 1;

  // A row that only hides something does not need a name or resorts: there is
  // nothing to show. Requiring them would mean typing out an attraction in
  // order to delete it. But whatever it DOES carry is kept, so un-hiding it
  // later brings the whole row back rather than an empty shell.
  if (hidden) {
    const name = String(input.name ?? "").trim().slice(0, MAX_NAME);
    const resortIds = parseResortIds(input.resortIds).filter((r) => KNOWN_RESORTS.has(r));
    const parsed = parseLands(input.lands);
    const lands = parsed.ok
      ? Object.fromEntries(Object.entries(parsed.lands).filter(([r]) => resortIds.includes(r)))
      : {};
    const k = parseKind(input.kind);
    return { ok: true, value: {
      id, name, resortIds, note: String(input.note ?? "").trim().slice(0, MAX_NOTE), hidden: true,
      kind: k === "land" || k === "attraction" ? k : inferKind(name, lands), lands,
    } };
  }

  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, reason: `"${id}" needs a name — what a traveler would call it.` };
  if (name.length > MAX_NAME) return { ok: false, reason: `That name is ${name.length} characters; keep it under ${MAX_NAME}.` };

  const resortIds = parseResortIds(input.resortIds);
  if (!resortIds.length) {
    return { ok: false, reason: `"${name}" needs at least one resort. List EVERY resort that has it, separated by commas — that is what stops the app claiming one is the only place you can ride it.` };
  }
  const unknown = resortIds.filter((r) => !KNOWN_RESORTS.has(r));
  if (unknown.length) {
    return { ok: false, reason: `"${name}" names ${unknown.length === 1 ? "a resort" : "resorts"} we do not have: ${unknown.join(", ")}. Use ${[...KNOWN_RESORTS].join(", ")}.` };
  }

  const note = String(input.note ?? "").trim();
  if (note.length > MAX_NOTE) return { ok: false, reason: `That note is ${note.length} characters; keep it under ${MAX_NOTE}.` };

  const parsed = parseLands(input.lands);
  if (!parsed.ok) return { ok: false, reason: `"${name}": ${parsed.reason}` };
  for (const [resort, land] of Object.entries(parsed.lands)) {
    if (!resortIds.includes(resort)) {
      return { ok: false, reason: `"${name}" gives a land for ${resort}, but ${resort} isn't in its resorts column. Add ${resort} to the resorts, or take it out of the land column.` };
    }
    if (land.length > MAX_LAND) return { ok: false, reason: `"${name}": the ${resort} land name is ${land.length} characters; keep it under ${MAX_LAND}.` };
  }

  const k = parseKind(input.kind);
  if (k === "bad") return { ok: false, reason: `"${name}": the type should be "land" or "attraction" (or blank to work it out from the name).` };
  const kind = k ?? inferKind(name, parsed.lands);

  return { ok: true, value: { id, name, resortIds, note, hidden: false, kind, lands: parsed.lands } };
}

const SHIPPED_IDS = new Set(ATTRACTIONS.map((a) => a.id));

/** Every owner row, in a shape the admin page can render. Read-only. */
export async function listOwnerAttractions(db: Db): Promise<OwnerAttractionRow[]> {
  const { rows } = await db.query<{
    id: string; name: string; resort_ids: string; note: string; hidden: boolean; updated_at: Date | null;
    kind: string | null; lands: string | null;
  }>(`select id, name, resort_ids, note, hidden, updated_at, kind, lands from owner_attractions order by id`);

  return rows.map((r) => {
    const resortIds = parseResortIds(r.resort_ids);
    let lands: Record<string, string> = {};
    try { const j = JSON.parse(r.lands || "{}"); if (j && typeof j === "object") lands = j; } catch { /* unreadable: no lands */ }
    const kind: AttractionKind = r.kind === "land" ? "land" : "attraction";
    const usable = resortIds.filter((x) => KNOWN_RESORTS.has(x));
    let applied = true;
    let problem: string | undefined;
    if (!r.hidden) {
      if (!r.name.trim()) { applied = false; problem = "No name, so nothing to show."; }
      else if (!usable.length) {
        applied = false;
        problem = resortIds.length
          ? `Names only resorts we do not have (${resortIds.join(", ")}), so it belongs nowhere.`
          : "No resorts listed, so it belongs nowhere.";
      }
    }
    return {
      id: r.id, name: r.name, resortIds, note: r.note, kind, lands, hidden: r.hidden,
      applied, problem, overridesShipped: SHIPPED_IDS.has(r.id), updatedAt: r.updated_at,
    };
  });
}

/**
 * The list the app should actually use: shipped, overlaid with the owner's.
 *
 * Every failure here degrades toward the shipped list rather than away from
 * it. A row with no usable resort is skipped, not applied as an attraction
 * belonging to nowhere — the same rule as a stored setting outside its
 * bounds falling back to the default rather than poisoning a price.
 */
export function overlay(shipped: readonly AttractionDef[], owner: readonly OwnerAttractionRow[]): AttractionDef[] {
  const hidden = new Set(owner.filter((o) => o.hidden).map((o) => o.id));
  const replacing = new Map<string, AttractionDef>();
  const added: AttractionDef[] = [];

  for (const o of owner) {
    if (o.hidden || !o.applied) continue;
    const usable = o.resortIds.filter((x) => KNOWN_RESORTS.has(x));
    if (!usable.length || !o.name.trim()) continue;
    const def: AttractionDef = { id: o.id, name: o.name.trim(), resortIds: usable };
    if (o.note.trim()) def.note = o.note.trim();
    if (o.kind === "land") def.kind = "land";
    const lands = Object.fromEntries(Object.entries(o.lands ?? {}).filter(([r]) => usable.includes(r)));
    if (Object.keys(lands).length) def.lands = lands;
    if (SHIPPED_IDS.has(o.id)) replacing.set(o.id, def);
    else added.push(def);
  }

  const out: AttractionDef[] = [];
  for (const a of shipped) {
    if (hidden.has(a.id)) continue;
    out.push(replacing.get(a.id) ?? a);
  }
  // Added rows go after the shipped ones, sorted, so the order is stable
  // rather than depending on when each was typed.
  added.sort((x, y) => x.name.localeCompare(y.name));
  return markSameNames([...out, ...added]);
}

/**
 * Same name, same kind, different resort: neither row is "only here".
 *
 * "Only here" is derived from the resort list, and that works while one ride
 * is one row. The owner's sheet lists a land once per resort ("Adventureland"
 * at four of them), so each row names a single resort and would otherwise
 * claim to be the only Adventureland anywhere — a confident wrong claim, the
 * exact thing the derived rule exists to prevent. Returns new objects; the
 * inputs are left alone.
 */
export function markSameNames(list: readonly AttractionDef[]): AttractionDef[] {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const where = new Map<string, Set<string>>();
  for (const a of list) {
    const key = `${a.kind ?? "attraction"}|${norm(a.name)}`;
    const set = where.get(key) ?? new Set<string>();
    for (const r of a.resortIds) set.add(r);
    where.set(key, set);
  }
  return list.map((a) => {
    const all = where.get(`${a.kind ?? "attraction"}|${norm(a.name)}`)!;
    const others = [...all].filter((r) => !a.resortIds.includes(r));
    if (!others.length) {
      if (!a.alsoAt) return a;
      const { alsoAt, ...rest } = a;
      void alsoAt;
      return rest;
    }
    return { ...a, alsoAt: others };
  });
}

/** The effective list, loaded. Falls back to the shipped list on any database
 *  trouble: the picker going empty because a query failed would be a far
 *  worse outcome than showing yesterday's list. */
export async function effectiveAttractions(db: Db): Promise<AttractionDef[]> {
  try {
    return overlay(ATTRACTIONS, await listOwnerAttractions(db));
  } catch {
    return [...ATTRACTIONS];
  }
}

/** Does this proposed row say exactly what the shipped one already says? */
function matchesShipped(v: AttractionValue): boolean {
  if (v.hidden) return false;
  const ship = ATTRACTIONS.find((a) => a.id === v.id);
  if (!ship) return false;
  // Shipped rows carry no lands, so any land named is a real change.
  if (Object.keys(v.lands).length || v.kind !== (ship.kind ?? "attraction")) return false;
  return ship.name === v.name
    && (ship.note ?? "") === v.note
    && ship.resortIds.length === v.resortIds.length
    && ship.resortIds.every((r, i) => r === v.resortIds[i]);
}

export async function saveAttraction(
  db: Db, input: AttractionInput, by = "",
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateAttraction(input);
  if (!v.ok) return v;

  // A row that says exactly what the shipped one says is stored as NOTHING.
  //
  // Without this, downloading the spreadsheet and sending it straight back —
  // which is what happens when you change one row out of ten — writes an
  // override for every row, and the admin page then marks all ten "yours"
  // and offers to revert them. The owner's one real edit is buried among
  // nine that only look like edits. Same instinct as a blank settings cell
  // meaning "back to the default" rather than zero: not saying anything is
  // different from saying the same thing.
  if (matchesShipped(v.value)) {
    await deleteOwnerAttraction(db, v.value.id);
    return { ok: true, id: v.value.id };
  }

  const { id, name, resortIds, note, hidden, kind, lands } = v.value;
  await db.query(
    `insert into owner_attractions (id, name, resort_ids, note, hidden, kind, lands, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (id) do update set
       name = excluded.name, resort_ids = excluded.resort_ids, note = excluded.note,
       hidden = excluded.hidden, kind = excluded.kind, lands = excluded.lands,
       updated_by = excluded.updated_by, updated_at = now()`,
    [id, name, resortIds.join(","), note, hidden, kind, JSON.stringify(lands), by],
  );
  return { ok: true, id };
}

/**
 * Remove the owner's row for an id.
 *
 * On a SHIPPED attraction this restores the shipped version rather than
 * deleting the attraction — which is the behavior the safety property
 * requires, and is why the admin page calls this button "Revert" there and
 * "Delete" on a row the owner added.
 */
export async function deleteOwnerAttraction(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`delete from owner_attractions where id = $1 returning id`, [id]);
  return r.rows.length > 0;
}

/** "wdw: Tomorrowland; shdr: Tomorrowland" — the sheet's land cell. */
export function landsCell(lands: Record<string, string> | undefined, resortIds: readonly string[]): string {
  if (!lands) return "";
  return resortIds.filter((r) => lands[r]).map((r) => `${r}: ${lands[r]}`).join("; ");
}

/** Rows for the spreadsheet: the EFFECTIVE list, so the owner edits what the
 *  app is actually using rather than only the overrides they have already
 *  made. A shipped row downloaded and re-uploaded unchanged writes an
 *  override identical to the shipped value, which is harmless. */
export function sheetRows(effective: readonly AttractionDef[], owner: readonly OwnerAttractionRow[]) {
  const hidden = owner.filter((o) => o.hidden);
  const rows = effective.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.kind ?? "attraction",
    resorts: a.resortIds.join(" "),
    land: landsCell(a.lands, a.resortIds),
    note: a.note ?? "",
    hidden: "",
    only_here: isOnlyAt(a) ? "yes" : "",
    source: SHIPPED_IDS.has(a.id) ? (owner.some((o) => o.id === a.id) ? "yours (replaces shipped)" : "shipped") : "yours",
  }));
  // A hidden row is absent from the effective list, so it would vanish from
  // the sheet and be lost on the next import. Carry it with its flag set —
  // and with its own details, so un-hiding it brings the whole row back.
  for (const o of hidden) {
    const ship = ATTRACTIONS.find((a) => a.id === o.id);
    const name = o.name || ship?.name || "";
    const resortIds = o.resortIds.length ? o.resortIds : (ship?.resortIds ?? []);
    rows.push({
      id: o.id, name, type: o.kind, resorts: resortIds.join(" "),
      land: landsCell(o.lands, resortIds),
      note: o.note || ship?.note || "", hidden: "yes", only_here: "", source: "hidden by you",
    });
  }
  return rows;
}

/**
 * Things worth a second look in an uploaded sheet that are NOT reasons to
 * refuse it — the owner's data, the owner's call. Returned with the upload
 * result and printed on the admin page.
 *
 *  - The same name twice at the same resort: almost always one ride typed
 *    twice, and the picker would then show it twice.
 *  - An `only_here` cell that disagrees with the resorts column. That column
 *    is worked out from the resorts and never read, so a "yes" on a row
 *    naming three resorts is ignored — said out loud so it isn't a surprise.
 */
export function sheetWarnings(rows: { row: number; value: AttractionValue; onlyHere: string }[]): string[] {
  const out: string[] = [];
  const byKey = new Map<string, number>();
  for (const { row, value } of rows) {
    if (value.hidden) continue;
    const norm = value.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const r of value.resortIds) {
      const key = `${value.kind}|${r}|${norm}`;
      const first = byKey.get(key);
      if (first !== undefined) {
        out.push(`row ${row}: "${value.name}" at ${r} is already on row ${first} — the picker will show it twice. Hide or delete one.`);
        break;
      }
      byKey.set(key, row);
    }
  }
  for (const { row, value, onlyHere } of rows) {
    if (value.hidden || !onlyHere.trim()) continue;
    const says = /^(yes|y|true|1)$/i.test(onlyHere.trim());
    const is = value.resortIds.length === 1;
    if (says !== is) {
      out.push(`row ${row}: "${value.name}" says only_here = ${onlyHere.trim()}, but lists ${value.resortIds.length} resort${value.resortIds.length === 1 ? "" : "s"}. "Only here" is worked out from the resorts column, so that column wins.`);
    }
  }
  return out;
}
