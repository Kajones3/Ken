/**
 * Each resort's "Good to know" notes, owner-editable (owner, 2026-10-29:
 * "Disneyland Paris is closing Indiana Jones ... I need to be able to change
 * these").
 *
 * The notes the code ships with (`goodToKnow` in config.ts) are the starting
 * point; `owner_notes` OVERLAYS them, the same way owner_attractions overlays
 * the attraction list: an empty table shows exactly what the code ships. A
 * row can change a shipped note's words, hide it, or be a note of the
 * owner's own. Any note can carry a "stop showing after" date, so a closure
 * note can retire itself the day a ride reopens.
 *
 * A shipped note's key is a hash of its own words, not its position, so
 * reordering the code's list can't make an edit land on the wrong note. If
 * the code's words change, an old edit of them no longer applies (it is
 * listed in /admin as replaced, so nothing vanishes silently).
 *
 * These are words, not prices, so editing and deleting rows is fine here;
 * the append-only rule covers fares and hotel rates.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { Resort } from "./config.js";

export const NOTE_MAX = 600;

export interface NoteRow {
  key: string;
  resortId: string;
  text: string;
  hidden: boolean;
  showUntil: string | null; // YYYY-MM-DD, last day it shows
  own: boolean;             // the owner's own note (not an edit of a shipped one)
  createdAt: string;
}

export interface AdminNote {
  key: string;
  text: string;
  shippedText: string | null; // the code's words, for a shipped note
  source: "shipped" | "edited" | "yours";
  hidden: boolean;
  showUntil: string | null;
  expired: boolean;           // past its stop-showing date
}

export function shippedKey(resortId: string, text: string): string {
  return `code-${resortId}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

const shows = (row: { hidden: boolean; showUntil: string | null } | undefined, today: string) =>
  !row || (!row.hidden && (!row.showUntil || row.showUntil >= today));

/** The notes travelers see for one resort, today. Pure. */
export function effectiveNotes(resort: Pick<Resort, "id" | "goodToKnow">, rows: NoteRow[], today: string): string[] {
  const mine = rows.filter((r) => r.resortId === resort.id);
  const byKey = new Map(mine.map((r) => [r.key, r]));
  const out: string[] = [];
  for (const text of resort.goodToKnow) {
    const row = byKey.get(shippedKey(resort.id, text));
    if (shows(row, today)) out.push(row ? row.text : text);
  }
  for (const r of mine.filter((x) => x.own).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)) {
    if (shows(r, today)) out.push(r.text);
  }
  return out;
}

/** Every note for one resort as /admin lists it, hidden and expired ones too. Pure. */
export function adminNotes(resort: Pick<Resort, "id" | "goodToKnow">, rows: NoteRow[], today: string): AdminNote[] {
  const mine = rows.filter((r) => r.resortId === resort.id);
  const byKey = new Map(mine.map((r) => [r.key, r]));
  const expired = (u: string | null) => !!u && u < today;
  const out: AdminNote[] = resort.goodToKnow.map((text) => {
    const key = shippedKey(resort.id, text);
    const row = byKey.get(key);
    return {
      key, shippedText: text, text: row ? row.text : text,
      source: row && row.text !== text ? "edited" as const : "shipped" as const,
      hidden: !!row?.hidden, showUntil: row?.showUntil ?? null, expired: expired(row?.showUntil ?? null),
    };
  });
  for (const r of mine.filter((x) => x.own).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)) {
    out.push({ key: r.key, text: r.text, shippedText: null, source: "yours", hidden: r.hidden,
      showUntil: r.showUntil, expired: expired(r.showUntil) });
  }
  return out;
}

export async function listNoteRows(db: Db): Promise<NoteRow[]> {
  const { rows } = await db.query(
    `select key, resort_id, text, hidden, show_until, own, created_at from owner_notes order by created_at, key`);
  return rows.map((r) => ({
    key: String(r.key), resortId: String(r.resort_id), text: String(r.text), hidden: !!r.hidden,
    showUntil: r.show_until ? dateOnly(r.show_until) : null, own: !!r.own,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

function dateOnly(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Each resort with its notes as travelers see them today. Falls back to the
 *  shipped notes if the table can't be read: showing yesterday's notes beats
 *  showing none. */
export async function withEffectiveNotes<R extends Pick<Resort, "id" | "goodToKnow">>(
  db: Db, resorts: readonly R[], today: string,
): Promise<R[]> {
  try {
    const rows = await listNoteRows(db);
    return resorts.map((r) => ({ ...r, goodToKnow: effectiveNotes(r, rows, today) }));
  } catch {
    return [...resorts];
  }
}

export type NoteSave =
  | { action: "save"; resortId: string; key?: string; text: string; showUntil?: string | null; hidden?: boolean }
  | { action: "delete"; resortId: string; key: string };

/** Add, change, hide, show or remove a note. "delete" on a shipped note puts
 *  the code's words back (it can't remove the code); on your own note it
 *  removes it. */
export async function saveNote(db: Db, resorts: readonly Pick<Resort, "id" | "goodToKnow">[], body: NoteSave, by: string):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  const resort = resorts.find((r) => r.id === body.resortId);
  if (!resort) return { ok: false, reason: "Which resort?" };
  const shippedByKey = new Map(resort.goodToKnow.map((t) => [shippedKey(resort.id, t), t]));

  if (body.action === "delete") {
    await db.query(`delete from owner_notes where key = $1 and resort_id = $2`, [body.key, resort.id]);
    return { ok: true };
  }

  const text = String(body.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "Type the note first." };
  if (text.length > NOTE_MAX) return { ok: false, reason: `Keep it under ${NOTE_MAX} characters (this one is ${text.length}).` };
  const until = body.showUntil ? String(body.showUntil) : null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, reason: "The stop-showing date doesn't look like a date." };
  const hidden = !!body.hidden;

  if (body.key && shippedByKey.has(body.key)) {
    // A shipped note left exactly as it shipped is stored as nothing.
    if (text === shippedByKey.get(body.key) && !hidden && !until) {
      await db.query(`delete from owner_notes where key = $1`, [body.key]);
      return { ok: true };
    }
    await db.query(
      `insert into owner_notes (key, resort_id, text, hidden, show_until, own, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, false, $6, now())
       on conflict (key) do update set text = excluded.text, hidden = excluded.hidden,
         show_until = excluded.show_until, updated_by = excluded.updated_by, updated_at = now()`,
      [body.key, resort.id, text, hidden, until, by]);
    return { ok: true };
  }
  if (body.key) {
    const { rows } = await db.query(`select 1 from owner_notes where key = $1 and resort_id = $2 and own`, [body.key, resort.id]);
    if (!rows.length) return { ok: false, reason: "That note isn't there any more. Reload the page." };
    await db.query(
      `update owner_notes set text = $2, hidden = $3, show_until = $4, updated_by = $5, updated_at = now() where key = $1`,
      [body.key, text, hidden, until, by]);
    return { ok: true };
  }
  await db.query(
    `insert into owner_notes (key, resort_id, text, hidden, show_until, own, updated_by)
     values ($1, $2, $3, $4, $5, true, $6)`,
    [`own-${randomBytes(6).toString("hex")}`, resort.id, text, hidden, until, by]);
  return { ok: true };
}
