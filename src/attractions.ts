/**
 * Matching a traveller's picks against the six resorts.
 *
 * Pure and synchronous, no I/O, same discipline as `pricing.ts` and for the
 * same reason: this decides something a user acts on, so it has to be
 * testable without a database and impossible to drift between the API and
 * the tests.
 *
 * What it deliberately does NOT do: score, rank, or recommend. It reports
 * which of the things you said you care about each resort actually has, and
 * which of those exist nowhere else. A resort matching three of your five
 * picks is a fact; "Shanghai is your best fit" is a claim about you, and the
 * project's whole posture is to explain a number rather than assert a
 * conclusion (see the dataConfidence badges and the "why is X cheaper?"
 * explainer). Cost still decides the ordering of the board. This just says
 * what you would be giving up by picking the cheaper one.
 */
import { ATTRACTIONS, ATTRACTION_BY_ID, isOnlyAt, type AttractionDef } from "./config.js";
import type { Db } from "./db.js";

export interface AttractionMatch {
  id: string;
  name: string;
  /** True when this resort is the only place that has it. */
  onlyHere: boolean;
  note?: string;
}

export interface ResortAttractionMatches {
  /** The picks this resort has, exclusives first — those are the ones that
   *  change a decision, so they should not be buried under shared ones. */
  matched: AttractionMatch[];
  /** Picks this resort does NOT have. Named rather than counted: "no
   *  Zootopia" is the useful half of the answer for the five resorts that
   *  don't have it. */
  missing: AttractionMatch[];
  /** Of `matched`, how many exist nowhere else. */
  onlyHereCount: number;
}

/**
 * Resolves raw picked ids into attractions we actually know about.
 *
 * Unknown ids are dropped rather than throwing. Saved picks outlive edits to
 * the list — an attraction that closes and is removed from `ATTRACTIONS`
 * would otherwise break every board of every user who had picked it, which
 * is a far worse failure than quietly ignoring one row.
 */
export function resolvePicks(
  pickedIds: readonly string[],
  /** The list to resolve against. Defaults to the one the app ships with, so
   *  every existing caller and every test keeps exercising the shipped rows.
   *  The server passes the owner's effective list instead — an overlay, not a
   *  replacement; see ownerAttractions.ts. Passed in rather than read from a
   *  module-level cache so this stays pure and synchronous, the same rule
   *  pricing.ts follows. */
  catalogue: readonly AttractionDef[] = ATTRACTIONS,
): AttractionDef[] {
  const byId = catalogue === ATTRACTIONS
    ? ATTRACTION_BY_ID
    : new Map(catalogue.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const out: AttractionDef[] = [];
  for (const id of pickedIds) {
    if (seen.has(id)) continue;
    const a = byId.get(id);
    if (!a) continue;
    seen.add(id);
    out.push(a);
  }
  return out;
}

function toMatch(a: AttractionDef): AttractionMatch {
  return { id: a.id, name: a.name, onlyHere: isOnlyAt(a), note: a.note };
}

/** What one resort offers against one traveller's picks. */
export function matchesForResort(
  resortId: string, pickedIds: readonly string[],
  catalogue: readonly AttractionDef[] = ATTRACTIONS,
): ResortAttractionMatches {
  const picks = resolvePicks(pickedIds, catalogue);
  const matched: AttractionMatch[] = [];
  const missing: AttractionMatch[] = [];
  for (const a of picks) {
    (a.resortIds.includes(resortId) ? matched : missing).push(toMatch(a));
  }
  // Exclusives first, then alphabetical so the order never depends on the
  // order the traveller happened to tick the boxes in.
  matched.sort((x, y) =>
    Number(y.onlyHere) - Number(x.onlyHere) || x.name.localeCompare(y.name));
  missing.sort((x, y) => x.name.localeCompare(y.name));
  return { matched, missing, onlyHereCount: matched.filter((m) => m.onlyHere).length };
}

/**
 * The one line worth putting on a board row.
 *
 * Phrased around what is at stake rather than a score. "Only place with
 * Zootopia" is a reason to look twice at a resort; "3/5" is trivia.
 */
export function matchSummary(m: ResortAttractionMatches, totalPicks: number): string | null {
  if (totalPicks === 0) return null;
  if (m.matched.length === 0) return `None of your ${totalPicks} picks`;
  const exclusive = m.matched.filter((x) => x.onlyHere);
  if (exclusive.length === 1) return `Only place with ${exclusive[0]!.name}`;
  if (exclusive.length > 1) {
    return `Only place with ${exclusive.length} of your picks`;
  }
  return `${m.matched.length} of your ${totalPicks} picks`;
}

/* ----------------------------- persistence -----------------------------
 * Reading and writing a traveller's picks. Separate from the pure matching
 * above so the matching stays trivially testable with no database.
 * -------------------------------------------------------------------- */

/** How many picks one account may keep. A guard against an unbounded list
 *  arriving in one request, not a product limit anyone will reach — the
 *  whole curated list is smaller than this. */
export const MAX_PICKS = 40;

export async function picksFor(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ attraction_id: string }>(
    `select attraction_id from user_attractions where user_id = $1 order by added_at, attraction_id`,
    [userId],
  );
  return rows.map((r) => r.attraction_id);
}

/**
 * Replaces the whole set in one go — the UI is a list of checkboxes, so
 * "here is what I want now" is the honest shape, and it makes unticking the
 * last box work without a separate delete route.
 *
 * Ids are validated against `ATTRACTIONS` before anything is written: an
 * unknown id would sit in the table forever doing nothing, since
 * resolvePicks drops it on the way back out, and a silently-ignored save is
 * worse than a refused one.
 */
export async function setPicks(
  db: Db, userId: string, ids: readonly string[],
): Promise<string[]> {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (!ATTRACTION_BY_ID.has(id)) throw new Error(`unknown attraction ${id}`);
    seen.add(id);
    clean.push(id);
  }
  if (clean.length > MAX_PICKS) throw new Error(`too many picks (max ${MAX_PICKS})`);

  // Delete-then-insert rather than a diff: the set is tiny, and a diff is
  // three more ways to leave the table half-updated.
  await db.query(`delete from user_attractions where user_id = $1`, [userId]);
  for (const id of clean) {
    await db.query(
      `insert into user_attractions (user_id, attraction_id) values ($1,$2)
       on conflict do nothing`,
      [userId, id],
    );
  }
  return clean;
}
