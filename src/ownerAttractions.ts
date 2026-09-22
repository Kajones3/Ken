/**
 * The owner's own attraction list, as an OVERLAY on the one in config.ts.
 *
 * The owner's ask was short — "make sure I have a way to maintain the
 * attractions list" — and the shipped rows have always been a starter set
 * Claude was confident about rather than a researched catalogue. Until now
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

export interface OwnerAttractionRow {
  id: string;
  name: string;
  resortIds: string[];
  note: string;
  hidden: boolean;
  /** False when this row cannot be applied — every resort it names has
   *  stopped existing, say. Listed anyway, marked, for the same reason an
   *  expired fare correction is: "where did my row go?" is a worse question
   *  than seeing it greyed out. */
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
}

export type ValidatedAttraction =
  | { ok: true; value: { id: string; name: string; resortIds: string[]; note: string; hidden: boolean } }
  | { ok: false; reason: string };

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
  // order to delete it.
  if (hidden) return { ok: true, value: { id, name: "", resortIds: [], note: "", hidden: true } };

  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, reason: `"${id}" needs a name — what a traveller would call it.` };
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

  return { ok: true, value: { id, name, resortIds, note, hidden: false } };
}

const SHIPPED_IDS = new Set(ATTRACTIONS.map((a) => a.id));

/** Every owner row, in a shape the admin page can render. Read-only. */
export async function listOwnerAttractions(db: Db): Promise<OwnerAttractionRow[]> {
  const { rows } = await db.query<{
    id: string; name: string; resort_ids: string; note: string; hidden: boolean; updated_at: Date | null;
  }>(`select id, name, resort_ids, note, hidden, updated_at from owner_attractions order by id`);

  return rows.map((r) => {
    const resortIds = parseResortIds(r.resort_ids);
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
      id: r.id, name: r.name, resortIds, note: r.note, hidden: r.hidden,
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
  return [...out, ...added];
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
function matchesShipped(v: { id: string; name: string; resortIds: string[]; note: string; hidden: boolean }): boolean {
  if (v.hidden) return false;
  const ship = ATTRACTIONS.find((a) => a.id === v.id);
  if (!ship) return false;
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

  const { id, name, resortIds, note, hidden } = v.value;
  await db.query(
    `insert into owner_attractions (id, name, resort_ids, note, hidden, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6, now())
     on conflict (id) do update set
       name = excluded.name, resort_ids = excluded.resort_ids, note = excluded.note,
       hidden = excluded.hidden, updated_by = excluded.updated_by, updated_at = now()`,
    [id, name, resortIds.join(","), note, hidden, by],
  );
  return { ok: true, id };
}

/**
 * Remove the owner's row for an id.
 *
 * On a SHIPPED attraction this restores the shipped version rather than
 * deleting the attraction — which is the behaviour the safety property
 * requires, and is why the admin page calls this button "Revert" there and
 * "Delete" on a row the owner added.
 */
export async function deleteOwnerAttraction(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`delete from owner_attractions where id = $1 returning id`, [id]);
  return r.rows.length > 0;
}

/** Rows for the spreadsheet: the EFFECTIVE list, so the owner edits what the
 *  app is actually using rather than only the overrides they have already
 *  made. A shipped row downloaded and re-uploaded unchanged writes an
 *  override identical to the shipped value, which is harmless. */
export function sheetRows(effective: readonly AttractionDef[], owner: readonly OwnerAttractionRow[]) {
  const hidden = new Set(owner.filter((o) => o.hidden).map((o) => o.id));
  const rows = effective.map((a) => ({
    id: a.id,
    name: a.name,
    resorts: a.resortIds.join(" "),
    note: a.note ?? "",
    hidden: "",
    only_here: isOnlyAt(a) ? "yes" : "",
    source: SHIPPED_IDS.has(a.id) ? (owner.some((o) => o.id === a.id) ? "yours (replaces shipped)" : "shipped") : "yours",
  }));
  // A hidden shipped attraction is absent from the effective list, so it
  // would vanish from the sheet and re-appear on the next import. Carry it
  // with its flag set instead.
  for (const id of hidden) {
    const ship = ATTRACTIONS.find((a) => a.id === id);
    rows.push({
      id, name: ship?.name ?? "", resorts: (ship?.resortIds ?? []).join(" "),
      note: ship?.note ?? "", hidden: "yes", only_here: "", source: "hidden by you",
    });
  }
  return rows;
}
