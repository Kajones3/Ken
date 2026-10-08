/**
 * Which major city + month makes the best SAMPLE PDF for free visitors:
 * one where the two cheapest resorts are both international (owner,
 * 2026-10-08: "find a scenario from a major city where the domestic parks
 * are not in the top 2").
 *
 * Read-only. Prices every plannable month at all six resorts from each of
 * the nightly metros, exactly as the board prices a month (quoteMonths ->
 * typicalIn), for two parties: 2 adults, and 2 adults + kids 8 and 11. Six
 * nights, on property, Moderate, "some QS some TS" food, flying. No provider
 * calls and NO writes: it does not go through compare(), which records the
 * search as route demand and would steer tonight's paid lookups.
 */
import { ORIGINS, RESORTS, bucketFor, isLocalRoute, plannableMonths } from "../config.js";
import { getDb, type Db } from "../db.js";
import { addDaysISO, monthBounds, todayISO } from "../dates.js";
import { loadBook } from "../book.js";
import { quoteMonths } from "../monthView.js";
import type { TripParams } from "../pricing.js";

const PARTIES: { label: string; adults: number; childAges: number[] }[] = [
  { label: "2 adults", adults: 2, childAges: [] },
  { label: "2 adults + kids 8, 11", adults: 2, childAges: [8, 11] },
];

export async function scan(db: Db): Promise<string> {
  const months = plannableMonths(todayISO());
  const from = monthBounds(months[0]!)[0];
  const to = monthBounds(months[months.length - 1]!)[1];
  const out: string[] = [];
  const hits: string[] = [];
  for (const party of PARTIES) {
    out.push(`\n=== ${party.label}, 6 nights, on property Moderate, mixed food, flying ===`);
    for (const o of ORIGINS) {
      // A short drive to a US resort would be priced as a drive on the
      // board; this scan only flies, so leave those cities out.
      if (RESORTS.some((r) => r.region === "dom" && isLocalRoute(o.iata, r.iata))) continue;
      const base: TripParams = {
        origin: o.iata, adults: party.adults, childAges: party.childAges, nights: 6,
        stay: "on", tier: 1, food: "mix", transportMode: "fly",
      };
      const perResort = new Map<string, (number | null)[]>();
      for (const r of RESORTS) {
        const book = await loadBook(db, {
          origin: o.iata, destinations: [r.iata], resortIds: [r.id],
          from, to: addDaysISO(to, base.nights + 1), tripLength: bucketFor(base.nights),
        });
        const rows = quoteMonths(book, r, { ...base, destination: r.iata }, {}, months);
        perResort.set(r.id, rows.map((x) => x.total));
      }
      months.forEach((m, i) => {
        const ranked = RESORTS
          .map((r) => ({ r, t: perResort.get(r.id)![i] }))
          .filter((x): x is { r: typeof x.r; t: number } => x.t !== null)
          .sort((a, b) => a.t - b.t);
        if (ranked.length < 6) return;
        const line = ranked.map((x) => `${x.r.id} $${x.t.toLocaleString("en-US")}`).join("  ");
        const topIntl = ranked[0]!.r.region !== "dom" && ranked[1]!.r.region !== "dom";
        const firstDom = ranked.findIndex((x) => x.r.region === "dom") + 1;
        out.push(`${o.iata} ${m}  ${topIntl ? "** " : "   "}${line}`);
        if (topIntl) {
          const gap = ranked[firstDom - 1]!.t - ranked[0]!.t;
          hits.push(`${party.label} | ${o.iata} (${o.name}) ${m}: cheapest ${ranked[0]!.r.name} $${ranked[0]!.t.toLocaleString("en-US")}, `
            + `2nd ${ranked[1]!.r.name}; first US park is #${firstDom} (${ranked[firstDom - 1]!.r.name}, $${gap.toLocaleString("en-US")} more than #1)`);
        }
      });
    }
  }
  return `## Scenarios where the two cheapest are both international (${hits.length})\n`
    + (hits.length ? hits.join("\n") : "(none)")
    + "\n\n## Every city and month (** = top two international)" + out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  console.log(await scan(db));
  await db.close();
}
