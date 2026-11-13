/**
 * What's on board each Disney ship (owner, 2026-11-13: "put it together for
 * details ... the writing here is probably copyrighted, but we can use the
 * facts ... set up a similar thing like we did for the parks. Where I can
 * adjust the ship and the restaurants and experiences on board each one").
 *
 * Same overlay as the attraction list (ownerAttractions.ts): SHIPPED rows in
 * code are the defaults, and `owner_ship_items` replaces, hides or adds rows.
 * An empty table = the shipped list. Notes are short FACTS in our own words
 * (ages, adults only, what it is), never Disney's copy.
 *
 * Only the Disney Wish is seeded (from Disney's Wish page the owner pasted,
 * 2026-11-13). The other ships start empty until the owner pastes theirs.
 */
import type { Db } from "./db.js";
import { CRUISE_SHIPS } from "./cruiseFacts.js";

export const SHIP_ITEM_KINDS = ["dining", "quick", "show", "adults", "kids", "room"] as const;
export type ShipItemKind = typeof SHIP_ITEM_KINDS[number];
export const SHIP_KIND_LABEL: Record<ShipItemKind, string> = {
  dining: "Dining rooms", quick: "Quick bites", show: "Shows and fun", adults: "Adults only", kids: "Kids clubs", room: "Staterooms",
};

export interface ShipItem { id: string; ship: string; kind: ShipItemKind; name: string; note: string }
export interface ShipItemRow extends ShipItem { hidden: boolean; source: "shipped" | "owner" | "owner-edit" }

export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const W = "Disney Wish";
const w = (kind: ShipItemKind, name: string, note: string): ShipItem => ({ id: `wish-${slug(name)}`, ship: W, kind, name, note });

/** Facts, in our words, from Disney's Disney Wish page (pasted 2026-11-13). */
export const SHIPPED_SHIP_ITEMS: ShipItem[] = [
  w("dining", "Arendelle: A Frozen Dining Adventure", "Frozen dinner show with Anna, Elsa and friends; Norwegian-style menu"),
  w("dining", "Worlds of Marvel", "Marvel dinner with an on-screen Avengers mission and a visit from Spider-Man"),
  w("dining", "1923", "Old Hollywood dining room named for the year the Disney studio began; California flavors"),
  w("quick", "Marceline Market", "10 food stations; breakfast and lunch"),
  w("quick", "Mickey & Friends Festival of Foods", "Open-air quick bites: barbecue, tacos, pizza, grill, ice cream"),
  w("quick", "Inside Out: Joyful Sweets", "Sweet shop: gelato, ice cream, cupcakes, chocolates"),
  w("quick", "The Wishing Star Café and The Enchanted Sword Café", "Two coffee bars near the Grand Hall"),
  w("show", "Disney The Little Mermaid", "Stage musical made for this ship; also Disney Seas the Adventure and Aladdin"),
  w("show", "AquaMouse", "Mickey water ride, 760 feet of tubes, ends in a lazy river"),
  w("show", "Toy Story Splash Zone", "Kids' water play with the Slide-a-saurus Rex family slide; 10 pools and water play areas on board"),
  w("show", "Luna", "Live music, comedy and family game shows"),
  w("show", "Hero Zone", "Sports court, games and game-show competitions"),
  w("show", "Never Land Cinema and Wonderland Cinema", "Disney, Pixar, Marvel and Star Wars films, including new releases"),
  w("show", "Disney Uncharted Adventure", "Game played on your phone around the ship"),
  w("show", "Fireworks at sea", "On most sailings"),
  w("show", "Halloween on the High Seas and Very Merrytime", "Halloween and holiday sailings (holidays: select sailings mid-September to year end); Bluey on select cruises"),
  w("adults", "Palo Steakhouse", "Adults only: steaks and Italian"),
  w("adults", "Enchanté by Chef Arnaud Lallement", "Adults only: fine dining by a 3-Michelin-star chef"),
  w("adults", "Star Wars: Hyperspace Lounge", "Bar; families by day, adults only at night"),
  w("adults", "Quiet Cove", "Adults-only pool, bar and lounge"),
  w("adults", "The Rose, Nightingale's and The Bayou", "Lounges (The Rose: Beauty and the Beast; Nightingale's: piano bar)"),
  w("adults", "Keg & Compass", "Pub with craft beers brewed for this ship"),
  w("adults", "Senses Spa", "Spa with heated loungers, steam room, sauna and outdoor pools"),
  w("adults", "Untangled Salon and Hook's Barbery", "Salon and barber"),
  w("kids", "Marvel Super Hero Academy", "Ages 3 to 10"),
  w("kids", "Star Wars: Cargo Bay", "Ages 3 to 10"),
  w("kids", "Walt Disney Imagineering Lab", "Ages 3 to 10: design and ride your own coaster"),
  w("kids", "Fairytale Hall", "Ages 3 to 10: princess and Frozen crafts and stories"),
  w("kids", "Edge", "Ages 11 to 14"),
  w("kids", "Vibe and The Hideaway", "Vibe ages 14 to 17; The Hideaway ages 18 to 20 at night"),
  w("kids", "\"it's a small world\" nursery", "Ages 6 months to 3 years"),
  w("kids", "Mickey & Minnie Captain's Deck", "Play space for the littlest cruisers"),
  w("kids", "Bibbidi Bobbidi Boutique", "Princess, knight, captain or pirate makeovers"),
  w("room", "Stateroom types", "Inside, Oceanview, Verandah, Concierge, Royal Suites"),
];

/** Per-ship facts that aren't a list item. */
export const SHIP_HOME_NOTES: Record<string, string> = {
  [W]: "Sails from Port Canaveral; sails in Europe from 2027.",
};

export interface ValidShipItem { id: string; ship: string; kind: ShipItemKind; name: string; note: string; hidden: boolean }
export function validateShipItem(i: any): { ok: true; value: ValidShipItem } | { ok: false; reason: string } {
  const ship = typeof i?.ship === "string" ? i.ship.trim() : "";
  if (!(CRUISE_SHIPS as readonly string[]).includes(ship)) return { ok: false, reason: `Unknown ship "${ship}"` };
  const kind = i?.kind;
  if (!(SHIP_ITEM_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `Unknown kind "${kind}"` };
  const name = typeof i?.name === "string" ? i.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!name) return { ok: false, reason: "A name is needed" };
  const note = typeof i?.note === "string" ? i.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const id = typeof i?.id === "string" && /^[a-z0-9-]{1,80}$/.test(i.id) ? i.id
    : `${slug(ship.replace(/^Disney /, ""))}-${slug(name)}`;
  return { ok: true, value: { id, ship, kind, name, note, hidden: i?.hidden === true } };
}

/** The shipped list with the owner's rows laid over it. Pure. */
export function overlayShipItems(owner: ValidShipItem[]): ShipItemRow[] {
  const byId = new Map(owner.map((o) => [o.id, o]));
  const out: ShipItemRow[] = SHIPPED_SHIP_ITEMS.map((s) => {
    const o = byId.get(s.id);
    return o ? { ...o, source: "owner-edit" as const } : { ...s, hidden: false, source: "shipped" as const };
  });
  const shipped = new Set(SHIPPED_SHIP_ITEMS.map((s) => s.id));
  for (const o of owner) if (!shipped.has(o.id)) out.push({ ...o, source: "owner" });
  return out;
}

export async function listShipItems(db: Db): Promise<ShipItemRow[]> {
  try {
    const r = await db.query<any>(`select id, ship, kind, name, note, hidden from owner_ship_items`);
    return overlayShipItems(r.rows.map((x) => ({ id: x.id, ship: x.ship, kind: x.kind, name: x.name, note: x.note, hidden: x.hidden })));
  } catch { return overlayShipItems([]); }
}

/** Save several at once (all checked before any is written). A row identical to the shipped one
 *  is stored as nothing (so "Put back" really puts it back). */
export async function saveShipItems(db: Db, items: unknown[], by: string): Promise<{ ok: true; saved: number } | { ok: false; reason: string }> {
  const valid: ValidShipItem[] = [];
  for (const [k, i] of items.entries()) {
    const v = validateShipItem(i);
    if (!v.ok) return { ok: false, reason: `Item ${k + 1}: ${v.reason}` };
    valid.push(v.value);
  }
  // Every row is checked above before any is written, so a bad one saves nothing.
  {
    for (const v of valid) {
      const s = SHIPPED_SHIP_ITEMS.find((x) => x.id === v.id);
      if (s && !v.hidden && s.ship === v.ship && s.kind === v.kind && s.name === v.name && s.note === v.note) {
        await db.query(`delete from owner_ship_items where id = $1`, [v.id]);
        continue;
      }
      await db.query(
        `insert into owner_ship_items (id, ship, kind, name, note, hidden, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,now())
         on conflict (id) do update set ship = excluded.ship, kind = excluded.kind, name = excluded.name,
           note = excluded.note, hidden = excluded.hidden, updated_by = excluded.updated_by, updated_at = now()`,
        [v.id, v.ship, v.kind, v.name, v.note, v.hidden, by]);
    }
  }
  return { ok: true, saved: valid.length };
}

/** Delete the owner's row: an added item goes, a shipped one goes back to shipped. */
export async function deleteShipItem(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from owner_ship_items where id = $1 returning id`, [id])).rows.length > 0;
}

/** For the cruise card: the visible items of one ship, by kind. */
export function shipSummary(rows: ShipItemRow[], ship: string): { home: string | null; byKind: Partial<Record<ShipItemKind, { name: string; note: string }[]>> } {
  const full = /^disney /i.test(ship) ? ship : `Disney ${ship}`;
  const byKind: Partial<Record<ShipItemKind, { name: string; note: string }[]>> = {};
  for (const r of rows) {
    if (r.hidden || r.ship.toLowerCase() !== full.toLowerCase()) continue;
    (byKind[r.kind] ??= []).push({ name: r.name, note: r.note });
  }
  return { home: SHIP_HOME_NOTES[full] ?? null, byKind };
}
