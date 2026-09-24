/**
 * Real, dated Disney room-discount promos — replacing the illustrative demo
 * rows (2026-09-24). Found by web search against each resort's own official
 * offers page (disneyworld.disney.go.com/special-offers,
 * disneyland.disney.go.com/offers-discounts) rather than fetched directly —
 * this sandbox's egress proxy blocks Disney's own site, same wall as every
 * other Disney page in this project. Re-verify dates against the live page
 * before a season change; `historical: false` on every row here means "real
 * and dated", not "confirmed by a direct fetch".
 *
 * Deliberately NOT included, so the gap is visible rather than papered over:
 *   - WDW's free-dining-with-package offer — real pattern, but the search
 *     that found it didn't surface exact start/end dates. Add it once you
 *     have real dates rather than guessing a window.
 *   - Disneyland Paris's ~€20-off ticket offer — doesn't fit the promo
 *     vocabulary (`ticket_pct_off`/`room_pct_off`/etc. below): it's a flat
 *     amount off ONE ticket, and nothing here models "flat X off a ticket"
 *     (only `room_flat_off` and `flat_off_total`, neither of which is that).
 *     Same known gap CLAUDE.md already names under "the promo effect
 *     vocabulary is deliberately small".
 *   - Tokyo, Hong Kong, Shanghai — nothing official turned up, only
 *     third-party reseller voucher codes (Klook, NST), which aren't Disney's
 *     own price and don't belong in a table meant to model what Disney
 *     itself charges. Their official offer pages exist but can't be fetched
 *     from here — same "paste the page" pattern as the ticket tables.
 *
 * Not wired into the daily refresh job — promos are sparse, owner-curated
 * content, not a continuously-refreshed input like tickets or airport
 * transport.
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
    resortId: "wdw", label: "Save up to 25% on rooms (Feb–Apr)",
    effectKind: "room_pct_off", effectValue: 25,
    startsOn: "2026-02-22", endsOn: "2026-04-30", historical: false,
    sourceNote: "Official WDW offer, found via web search of disneyworld.disney.go.com/special-offers on 2026-09-24 — most nights, not every night. Re-verify against the live page.",
  },
  {
    resortId: "wdw", label: "Save up to 20% on rooms, Sun–Thu (Jan–Feb)",
    effectKind: "room_pct_off", effectValue: 20,
    startsOn: "2026-01-04", endsOn: "2026-02-19", historical: false,
    sourceNote: "Official WDW offer, found via web search on 2026-09-24 — Sunday through Thursday nights only. Re-verify against the live page.",
  },
  {
    resortId: "wdw", label: "Save up to 30% at select Disney Resorts Collection hotels (summer)",
    effectKind: "room_pct_off", effectValue: 30,
    startsOn: "2026-07-30", endsOn: "2026-10-03", historical: false,
    sourceNote: "Official WDW offer, found via web search on 2026-09-24 — select hotels only, most arrivals. Re-verify against the live page.",
  },
  {
    resortId: "wdw", label: "Save up to 10% on rooms, Sun–Thu (Oct–Nov)",
    effectKind: "room_pct_off", effectValue: 10,
    startsOn: "2026-10-04", endsOn: "2026-11-19", historical: false,
    sourceNote: "Official WDW offer, found via web search on 2026-09-24 — Sunday through Thursday nights only. A second leg of the same offer (Nov 22–Dec 24, all nights) is the next row.",
  },
  {
    resortId: "wdw", label: "Save up to 10% on rooms, all nights (Nov–Dec)",
    effectKind: "room_pct_off", effectValue: 10,
    startsOn: "2026-11-22", endsOn: "2026-12-24", historical: false,
    sourceNote: "Official WDW offer, found via web search on 2026-09-24 — including weekends, unlike the Oct–Nov leg above.",
  },
  {
    resortId: "dlr", label: "Save up to 20% at select hotels, 3+ nights, Sun–Thu (Oct–Dec)",
    effectKind: "room_pct_off", effectValue: 20,
    startsOn: "2026-10-11", endsOn: "2026-12-18", historical: false,
    sourceNote: "Official Disneyland Resort offer, found via web search of disneyland.disney.go.com/offers-discounts on 2026-09-24 — Disneyland Hotel, Grand Californian, Pixar Place, Villas at Disneyland Hotel; 3-night minimum, Sunday through Thursday. Re-verify against the live page.",
  },
  {
    resortId: "dlp", label: "20% off hotel+ticket package for Disney+ subscribers (Jan–Feb)",
    effectKind: "room_pct_off", effectValue: 20,
    startsOn: "2026-01-07", endsOn: "2026-02-12", historical: false,
    sourceNote: "Real offer, found via web search on 2026-09-24 — it is actually a Disney+ subscriber discount on a combined hotel+ticket PACKAGE rate, modeled here as room_pct_off since Paris hotel and ticket are priced as two separate lines in this app (a known gap — see dataConfidence on dlp in config.ts). Requires proof of Disney+ subscription and booking by Jan 13, which this app has no way to verify or enforce.",
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
