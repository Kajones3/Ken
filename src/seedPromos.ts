/**
 * A handful of illustrative promo rows so the friends demo has something to
 * show without the owner hand-writing SQL first. Not wired into the daily
 * refresh job — promos are sparse, owner-curated content, not a
 * continuously-refreshed input like tickets or airport transport.
 *
 *   npm run seed-promos
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.js";

interface SeedPromo {
  resortId: string | null; label: string;
  effectKind: "room_pct_off" | "room_flat_off" | "free_dining" | "ticket_pct_off" | "flat_off_total";
  effectValue: number; startsOn: string; endsOn: string; historical: boolean; sourceNote: string;
}

const EXAMPLES: SeedPromo[] = [
  {
    resortId: "wdw", label: "Summer room discount",
    effectKind: "room_pct_off", effectValue: 20,
    startsOn: "2027-06-01", endsOn: "2027-08-15", historical: true,
    sourceNote: "Disney has run a room discount most summers in recent years — not confirmed for this year.",
  },
  {
    resortId: "wdw", label: "Free Disney Dining Plan",
    effectKind: "free_dining", effectValue: 0,
    startsOn: "2027-09-01", endsOn: "2027-11-15", historical: true,
    sourceNote: "A free-dining-with-package offer has appeared in past falls — not confirmed for this year.",
  },
  {
    resortId: null, label: "Multi-day ticket discount",
    effectKind: "ticket_pct_off", effectValue: 10,
    startsOn: "2027-01-01", endsOn: "2027-12-31", historical: true,
    sourceNote: "Illustrative example — replace with a real, dated offer before relying on this.",
  },
];

export async function seedPromos(db: Db): Promise<number> {
  for (const p of EXAMPLES) {
    // Re-running this after editing EXAMPLES shouldn't pile up duplicates —
    // replace any existing row with the same label for the same resort.
    await db.query(
      `delete from promos where label = $1 and resort_id is not distinct from $2`,
      [p.label, p.resortId],
    );
    await db.query(
      `insert into promos (id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, historical, source_note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), p.resortId, p.label, p.effectKind, p.effectValue, p.startsOn, p.endsOn, p.historical, p.sourceNote],
    );
  }
  return EXAMPLES.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const n = await seedPromos(db);
  console.log(`seeded ${n} example promo(s) — hand-maintain the promos table with real, dated offers`);
  await db.close();
}
