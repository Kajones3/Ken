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

/** Trip shapes to try (owner, 2026-10-08: "What about one where Walt Disney
 *  World is only like $100 cheaper. I've seen those a few times"). The
 *  first is the board's default; the rest are the settings most likely to
 *  close the gap (Deluxe rooms, staying off property, a longer stay). */
const SHAPES: { label: string; nights: number; stay: TripParams["stay"]; tier: TripParams["tier"]; food: TripParams["food"] }[] = [
  { label: "6 nights, on property Moderate, mixed food", nights: 6, stay: "on", tier: 1, food: "mix" },
  { label: "6 nights, on property Deluxe, mixed food", nights: 6, stay: "on", tier: 2, food: "mix" },
  { label: "6 nights, on property Value, quick service", nights: 6, stay: "on", tier: 0, food: "qs" },
  { label: "6 nights, off property mid-range, mixed food", nights: 6, stay: "off", tier: 1, food: "mix" },
  { label: "9 nights, on property Moderate, mixed food", nights: 9, stay: "on", tier: 1, food: "mix" },
  { label: "9 nights, on property Deluxe, table service", nights: 9, stay: "on", tier: 2, food: "ts" },
];

interface Row { party: string; shape: string; origin: string; month: string; ranked: { id: string; name: string; dom: boolean; t: number }[] }

export async function scan(db: Db): Promise<string> {
  const months = plannableMonths(todayISO());
  const from = monthBounds(months[0]!)[0];
  const to = monthBounds(months[months.length - 1]!)[1];
  const rows: Row[] = [];
  for (const o of ORIGINS) {
    // A short drive to a US resort would be priced as a drive on the
    // board; this scan only flies, so leave those cities out.
    if (RESORTS.some((r) => r.region === "dom" && isLocalRoute(o.iata, r.iata))) continue;
    // One book per resort and trip length, reused across every shape and
    // party (the book holds fares and rooms; who travels is applied later).
    const books = new Map<string, Awaited<ReturnType<typeof loadBook>>>();
    for (const nights of [...new Set(SHAPES.map((x) => x.nights))]) {
      for (const r of RESORTS) {
        books.set(`${r.id}|${nights}`, await loadBook(db, {
          origin: o.iata, destinations: [r.iata], resortIds: [r.id],
          from, to: addDaysISO(to, nights + 1), tripLength: bucketFor(nights),
        }));
      }
    }
    for (const party of PARTIES) for (const shape of SHAPES) {
      const base: TripParams = {
        origin: o.iata, adults: party.adults, childAges: party.childAges, nights: shape.nights,
        stay: shape.stay, tier: shape.tier, food: shape.food, transportMode: "fly",
      };
      const per = new Map<string, (number | null)[]>();
      for (const r of RESORTS) {
        const q = quoteMonths(books.get(`${r.id}|${shape.nights}`)!, r, { ...base, destination: r.iata }, {}, months);
        per.set(r.id, q.map((x) => x.total));
      }
      months.forEach((m, i) => {
        const ranked = RESORTS
          .map((r) => ({ id: r.id, name: r.name, dom: r.region === "dom", t: per.get(r.id)![i]! }))
          .filter((x) => x.t !== null && x.t !== undefined)
          .sort((a, b) => a.t - b.t);
        if (ranked.length === 6) rows.push({ party: party.label, shape: shape.label, origin: o.iata, month: m, ranked });
      });
    }
  }
  const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const line = (r: Row) => `${r.party} | ${r.shape} | ${r.origin} ${r.month}: `
    + r.ranked.map((x) => `${x.id} ${usd(x.t)}`).join("  ");
  // How far Walt Disney World is below the cheapest international resort
  // (negative = an international resort is cheaper than Walt Disney World).
  const gap = (r: Row) => r.ranked.find((x) => x.id === "wdw")!.t - Math.min(...r.ranked.filter((x) => !x.dom).map((x) => x.t));
  const bothIntl = rows.filter((r) => !r.ranked[0]!.dom && !r.ranked[1]!.dom);
  const byGap = [...rows].map((r) => ({ r, g: gap(r) })).sort((a, b) => b.g - a.g);
  const within = byGap.filter((x) => x.g >= -150);
  return `${rows.length} scenarios priced (${PARTIES.length} parties x ${SHAPES.length} trip shapes x cities x months)\n`
    + `\n## Two cheapest both international (${bothIntl.length})\n` + (bothIntl.slice(0, 60).map(line).join("\n") || "(none)")
    + `\n\n## Walt Disney World within $150 of (or above) the cheapest international resort (${within.length})\n`
    + (within.slice(0, 60).map((x) => `${x.g >= 0 ? "WDW dearer by " : "WDW cheaper by "}${usd(Math.abs(x.g))} | ${line(x.r)}`).join("\n") || "(none)")
    + `\n\n## The 30 closest overall\n`
    + byGap.slice(0, 30).map((x) => `${x.g >= 0 ? "WDW dearer by " : "WDW cheaper by "}${usd(Math.abs(x.g))} | ${line(x.r)}`).join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  console.log(await scan(db));
  await db.close();
}
