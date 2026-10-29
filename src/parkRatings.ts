/**
 * The owner's own park ratings, for the "Top rated first" sort (owner,
 * 2026-10-29: "I can just manually enter the stars ... park ratings rarely
 * change. It can really be once or twice a year as a check ... it can just
 * say 'top rated' and I can combine whatever I want").
 *
 * One star figure per PARK (Magic Kingdom, Tokyo DisneySea, ...), typed in
 * /admin -> Manual work. A RESORT ranks by its best park, then its next best
 * (owner: "Tokyo Disney Sea may be #1 but Magic Kingdom may be #2. So does
 * Tokyo go first or Disney World? My preference would be tokyo"). An average
 * was rejected as unfair to resorts with one great park and a weaker second.
 *
 * Travelers never see the stars or a source, only the order and "Top rated".
 * Append-only: every save is a new row, the newest per resort + park wins,
 * and a null clears it.
 */
import type { Db } from "./db.js";
import type { Resort } from "./config.js";

export interface ParkRating {
  park: string;
  stars: number | null;
  enteredAt: string | null;
}

export interface ResortRatings {
  id: string;
  name: string;
  parks: ParkRating[];
}

/** Every resort's parks with the newest stars typed for each. Parks come from
 *  the code's park list, so a new park shows up here without a migration. */
export async function loadParkRatings(db: Db, resorts: readonly Resort[]): Promise<ResortRatings[]> {
  let rows: { resort_id: string; park: string; stars: string | null; entered_at: Date }[] = [];
  try {
    rows = (await db.query<{ resort_id: string; park: string; stars: string | null; entered_at: Date }>(
      `select distinct on (resort_id, park) resort_id, park, stars, entered_at
         from park_ratings order by resort_id, park, entered_at desc`)).rows;
  } catch { rows = []; }   // a missing table means nothing rated yet, never a broken board
  const byKey = new Map(rows.map((r) => [`${r.resort_id}|${r.park}`, r]));
  return resorts.map((r) => ({
    id: r.id, name: r.name,
    parks: r.parkList.map((p) => {
      const row = byKey.get(`${r.id}|${p.name}`);
      return {
        park: p.name,
        stars: row && row.stars !== null ? Number(row.stars) : null,
        enteredAt: row ? new Date(row.entered_at).toISOString() : null,
      };
    }),
  }));
}

/** Stars from a form box: blank clears it; 0-5, rounded to one decimal. */
export function parseStars(raw: unknown): { ok: true; stars: number | null } | { ok: false; reason: string } {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true, stars: null };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > 5) return { ok: false, reason: `"${raw}" isn't a rating from 0 to 5.` };
  return { ok: true, stars: Math.round(n * 10) / 10 };
}

/** Save the whole form: only parks whose stars changed get a new row. */
export async function saveParkRatings(
  db: Db, resorts: readonly Resort[], entries: { resortId: string; park: string; stars: unknown }[], by: string,
): Promise<{ ok: true; changed: number } | { ok: false; reason: string }> {
  const current = await loadParkRatings(db, resorts);
  const now = new Map<string, number | null>(current.flatMap((r) => r.parks.map((p) => [`${r.id}|${p.park}`, p.stars] as [string, number | null])));
  const writes: { resortId: string; park: string; stars: number | null }[] = [];
  for (const e of entries) {
    const key = `${e.resortId}|${e.park}`;
    if (!now.has(key)) return { ok: false, reason: `${e.park} isn't a park we list at that resort.` };
    const s = parseStars(e.stars);
    if (!s.ok) return { ok: false, reason: `${e.park}: ${s.reason}` };
    if (s.stars !== now.get(key)) writes.push({ resortId: e.resortId, park: e.park, stars: s.stars });
  }
  for (const w of writes) {
    await db.query(`insert into park_ratings (resort_id, park, stars, entered_by) values ($1, $2, $3, $4)`,
      [w.resortId, w.park, w.stars, by]);
  }
  return { ok: true, changed: writes.length };
}

/**
 * Resorts in "top rated" order: best park first, then the next best, and so
 * on (a resort with more strong parks wins a tie). Resorts with no ratings
 * are left out, so the board can put them last. Pure.
 */
export function ratingOrder(ratings: readonly ResortRatings[]): string[] {
  const scored = ratings
    .map((r) => ({ id: r.id, stars: r.parks.map((p) => p.stars).filter((s): s is number => s !== null).sort((a, b) => b - a) }))
    .filter((r) => r.stars.length > 0);
  scored.sort((a, b) => {
    for (let i = 0; i < Math.max(a.stars.length, b.stars.length); i++) {
      const d = (b.stars[i] ?? -1) - (a.stars[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  });
  return scored.map((r) => r.id);
}
