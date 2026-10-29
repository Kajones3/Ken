/**
 * IRS standard mileage rates the owner can bring in from /admin, so a new
 * year no longer needs a code change (owner, 2026-10-29: "the government
 * mileage data ... a button I can push to try and get new data. THIS SHOULD
 * NOT AFFECT OUR AUTOMATED DATA!").
 *
 * The button only READS the IRS page and shows what it says. Nothing is
 * saved until the owner presses Save on a year, and what is saved is one row
 * per year in owner_mileage_rates, which beats the code's IRS_MILEAGE_RATES
 * for that year (mileageRatesWith in config.ts). No nightly job reads or
 * writes any of this.
 */
import type { Db } from "./db.js";
import { IRS_MILEAGE_RATES, mileageRatesWith, type MileageRateRow } from "./config.js";

export const IRS_MILEAGE_URL = "https://www.irs.gov/tax-professionals/standard-mileage-rates";

/** The owner's saved years. A missing table or a failure is "none saved". */
export async function loadMileageRates(db: Db): Promise<MileageRateRow[]> {
  try {
    const { rows } = await db.query<{ year: number; jan_to_jun: string; jul_to_dec: string }>(
      `select year, jan_to_jun, jul_to_dec from owner_mileage_rates order by year`);
    return rows.map((r) => ({ year: Number(r.year), janToJunPerMile: Number(r.jan_to_jun), julToDecPerMile: Number(r.jul_to_dec) }));
  } catch { return []; }
}

export interface SavedMileageRate extends MileageRateRow { source: string; updatedAt: string | null; from: "code" | "yours" }

/** Every year on file, the code's and the owner's, newest first, for /admin. */
export async function listMileageRates(db: Db): Promise<SavedMileageRate[]> {
  let saved: { year: number; jan_to_jun: string; jul_to_dec: string; source: string; updated_at: Date }[] = [];
  try {
    saved = (await db.query<{ year: number; jan_to_jun: string; jul_to_dec: string; source: string; updated_at: Date }>(
      `select year, jan_to_jun, jul_to_dec, source, updated_at from owner_mileage_rates`)).rows;
  } catch { saved = []; }
  const mine = new Map(saved.map((r) => [Number(r.year), r]));
  return mileageRatesWith(saved.map((r) => ({ year: Number(r.year), janToJunPerMile: Number(r.jan_to_jun), julToDecPerMile: Number(r.jul_to_dec) })))
    .map((r) => {
      const m = mine.get(r.year);
      return { ...r, source: m?.source ?? "Shipped with the site", updatedAt: m ? new Date(m.updated_at).toISOString() : null, from: m ? "yours" as const : "code" as const };
    })
    .sort((a, b) => b.year - a.year);
}

const cell = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * The IRS's "Mileage rates for all years" table, read into one row per year
 * (business rate, dollars per mile). Periods read: "2025", "2026 (Jan. 1 –
 * June 30)", "2026 (July 1 – Dec. 31)", "1/1/2022-6/30/2022",
 * "7/1/2022-12/31/2022". A year with only one half published gets that figure
 * for both halves (the IRS sets one rate for a year and only sometimes
 * changes it in July). Pure; [] when the table isn't found.
 */
export function parseIrsMileageTable(html: string): MileageRateRow[] {
  const at = html.indexOf("Mileage rates for all years");
  if (at < 0) return [];
  const end = html.indexOf("</table>", at);
  const table = html.slice(at, end < 0 ? undefined : end);
  const halves = new Map<number, { h1?: number; h2?: number }>();
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cell(m[1]!));
    if (tds.length < 2) continue;
    const period = tds[0]!, cents = Number(tds[1]!.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const year = Number((period.match(/(20\d\d)/) ?? [])[1]);
    if (!Number.isFinite(year)) continue;
    const secondHalf = /\bjul|^7\/1\//i.test(period);
    const firstHalf = /\bjan|^1\/1\//i.test(period);
    const h = halves.get(year) ?? {};
    const usd = Math.round(cents * 10) / 1000;
    if (secondHalf) h.h2 = usd;
    else if (firstHalf) h.h1 = usd;
    else { h.h1 = usd; h.h2 = usd; }
    halves.set(year, h);
  }
  return [...halves.entries()]
    .map(([year, h]) => ({ year, janToJunPerMile: (h.h1 ?? h.h2)!, julToDecPerMile: (h.h2 ?? h.h1)! }))
    .sort((a, b) => b.year - a.year);
}

export interface MileageCheck {
  ok: boolean;
  message: string;
  url: string;
  /** Years the page lists from the newest one we hold onward, each compared with ours. */
  years: (MileageRateRow & { status: "new" | "same" | "different"; ours: MileageRateRow | null })[];
}

/** Read the IRS page and compare it with what we hold. Writes nothing. */
export async function checkIrsMileage(db: Db, fetchFn: typeof fetch = fetch): Promise<MileageCheck> {
  let html: string;
  try {
    const res = await fetchFn(IRS_MILEAGE_URL, { headers: { "user-agent": "Mozilla/5.0 (Pricing the Magic owner check)" } });
    if (!res.ok) return { ok: false, message: `The IRS page answered ${res.status}. Try again later, or look it up by hand.`, url: IRS_MILEAGE_URL, years: [] };
    html = await res.text();
  } catch (e) {
    return { ok: false, message: `Couldn't reach the IRS page (${(e as Error).message}).`, url: IRS_MILEAGE_URL, years: [] };
  }
  const read = parseIrsMileageTable(html);
  if (!read.length) return { ok: false, message: "The IRS page didn't have the table we read. It may have changed; look it up by hand.", url: IRS_MILEAGE_URL, years: [] };
  const ours = mileageRatesWith(await loadMileageRates(db));
  const oldestShipped = Math.min(...IRS_MILEAGE_RATES.map((r) => r.year));
  const years = read.filter((r) => r.year >= oldestShipped).map((r) => {
    const mine = ours.find((o) => o.year === r.year) ?? null;
    const status = !mine ? "new" as const
      : mine.janToJunPerMile === r.janToJunPerMile && mine.julToDecPerMile === r.julToDecPerMile ? "same" as const : "different" as const;
    return { ...r, status, ours: mine };
  });
  const fresh = years.filter((y) => y.status !== "same");
  return {
    ok: true, url: IRS_MILEAGE_URL, years,
    message: fresh.length ? `The IRS page has ${fresh.map((y) => y.year).join(", ")} that we don't match. Check it and press Save.` : "Nothing new: what we hold matches the IRS page.",
  };
}

/** Save one year, as the owner confirmed it. Dollars per mile. */
export async function saveMileageRate(
  db: Db, r: { year: unknown; janToJunPerMile: unknown; julToDecPerMile: unknown }, by: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const year = Number(r.year), h1 = Number(r.janToJunPerMile), h2 = Number(r.julToDecPerMile);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return { ok: false, reason: "Which year?" };
  for (const v of [h1, h2]) if (!Number.isFinite(v) || v < 0.1 || v > 2) return { ok: false, reason: `${v} isn't a believable rate (dollars per mile, like 0.76).` };
  await db.query(
    `insert into owner_mileage_rates (year, jan_to_jun, jul_to_dec, source, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (year) do update set jan_to_jun = excluded.jan_to_jun, jul_to_dec = excluded.jul_to_dec,
       source = excluded.source, updated_by = excluded.updated_by, updated_at = now()`,
    [year, h1, h2, `IRS page, saved by the owner`, by]);
  return { ok: true };
}
