/**
 * Hotels learn from everything Google tells us (owner, 2026-10-12: "WHY ARE
 * WE NOT USING DATA?!?! That goes against our rule to use all data points").
 *
 * Every Google Hotels answer we buy carries, per hotel, besides the lead
 * nightly rate we used to price from:
 *  - each booking site's own price (`extra.prices`), and
 *  - Google's "X% less than usual" note, which implies the hotel's usual
 *    nightly (`extra.usualNightly`).
 * Both were kept in the record (hotel_samples.extra) since 2026-10-06 and
 * used for nothing. Now:
 *
 *  1. The starting price for a hotel is the CHEAPEST place to book it
 *     (lead rate or any booking site, whichever is lower), because we send
 *     travelers to the cheapest place (owner, 2026-10-12).
 *  2. When Google says tonight is a deal, one sampled night is stretched
 *     across a whole month, so a deal night would make the whole month look
 *     cheap. The price is blended toward Google's usual price by a weight
 *     the record TEACHES (governing rule 2: learned, never hand-set): for
 *     every hotel Google showed us twice for the same month, which would
 *     have predicted the second price better, the first night's price or
 *     its usual price? The best blend, shrunk toward "trust the night we
 *     saw" (n/(n+K)) until enough pairs back it.
 *  3. The same blend feeds Google's rates for Disney's own hotels, which
 *     already move on-property prices (disneyEvidence.ts).
 *
 * Pure functions plus one loader. Nothing here writes anything.
 */
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { matchDisneyHotel } from "./disneyHotels.js";
import { isRental } from "./rentals.js";
import { hotelSeasonFactor } from "./seasonality.js";
import type { ISODate } from "./dates.js";

/** How far back pairs are read. */
export const HOTEL_LEARNING_DAYS = 120;
/** Shrink: the learned weight counts fully only with many more pairs than this. */
export const USUAL_SHRINK_K = 20;
/** Two pulls closer than this are the same moment, not a later price. */
export const MIN_PAIR_GAP_DAYS = 2;
/** Weights tried when learning. */
export const USUAL_WEIGHT_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export interface HotelExtraLite { usualNightly?: number; prices?: { source: string; nightly: number }[] }

/** The cheapest place to book: the lead rate or any booking site's, whichever is lower. */
export function cheapestPlace(lead: number, extra?: HotelExtraLite | null): number {
  const sites = (extra?.prices ?? []).map((p) => p.nightly).filter((n) => n > 0);
  return sites.length ? Math.min(lead, ...sites) : lead;
}

/**
 * The price we start from for one hotel: the cheapest place to book it,
 * blended toward Google's usual price (geometric, by weight `w`) when Google
 * flagged a deal. Google's usual is quoted against the lead rate, so it is
 * moved to the same booking-site footing first.
 */
export function hotelAnchor(lead: number, extra: HotelExtraLite | null | undefined, w: number): number {
  const base = cheapestPlace(lead, extra);
  const usual = extra?.usualNightly;
  if (!(usual && usual > 0) || !(w > 0) || !(lead > 0)) return base;
  const usualOnBase = usual * (base / lead);
  return Math.round(Math.exp((1 - w) * Math.log(base) + w * Math.log(usualOnBase)) * 100) / 100;
}

export interface SampleRow {
  resortId: string; month: string; checkIn: ISODate; pulledAt: Date;
  hotelName: string; nightly: number; kind?: string | null; extra?: HotelExtraLite | null;
}

/** One hotel, seen in two pulls of the same month at least two days apart. */
export interface HotelPair { resortId: string; hotelName: string; first: SampleRow; next: SampleRow }

/** Off-property hotels (no Disney, no rentals), consecutive pulls per resort+month+hotel. */
export function hotelPairs(rows: SampleRow[], minGapDays = MIN_PAIR_GAP_DAYS): HotelPair[] {
  const groups = new Map<string, SampleRow[]>();
  for (const r of rows) {
    if (!(r.nightly > 0)) continue;
    if (matchDisneyHotel(r.resortId, r.hotelName) || isRental(r.hotelName, r.kind)) continue;
    const k = `${r.resortId}|${r.month}|${r.hotelName}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: HotelPair[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.pulledAt.getTime() - b.pulledAt.getTime());
    let prev: SampleRow | undefined;
    for (const r of list) {
      if (prev && (r.pulledAt.getTime() - prev.pulledAt.getTime()) / 86_400_000 >= minGapDays) {
        out.push({ resortId: r.resortId, hotelName: r.hotelName, first: prev, next: r });
        prev = r;
      } else if (!prev) prev = r;
    }
  }
  return out;
}

/** What we would have shown for the later night, from the earlier pull at weight `w`. */
export function predictPair(p: HotelPair, w: number): number {
  const a = hotelAnchor(p.first.nightly, p.first.extra, w);
  return a / hotelSeasonFactor(p.first.resortId, p.first.checkIn) * hotelSeasonFactor(p.next.resortId, p.next.checkIn);
}
/** The later price a traveler would find: the cheapest place to book it. */
export function actualPair(p: HotelPair): number {
  return cheapestPlace(p.next.nightly, p.next.extra);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct1 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

export interface MissSummary { n: number; within10Pct: number | null; typicalOffPct: number | null; leanPct: number | null }
export function missSummary(errs: number[]): MissSummary {
  return {
    n: errs.length,
    within10Pct: errs.length ? Math.round(errs.filter((e) => Math.abs(e) <= 0.1 + 1e-9).length / errs.length * 100) : null,
    typicalOffPct: pct1(median(errs.map(Math.abs))),
    leanPct: pct1(median(errs)),
  };
}

export interface HotelLearning {
  /** The weight on Google's usual price that pricing uses (learned, shrunk). */
  usualWeight: number;
  /** The best weight on the pairs alone, before shrinking. */
  bestWeight: number;
  /** Pairs where the first pull carried a usual price (the ones that teach the weight). */
  dealPairs: number;
  pairs: number;
  /** Miss on every pair at a few weights: 0 = the night we saw, 1 = Google's usual. */
  byWeight: { w: number; all: MissSummary; deals: MissSummary }[];
  /** The same at the learned weight, per resort. */
  byResort: { resortId: string; before: MissSummary; after: MissSummary }[];
  /** How often Google flags a deal, and by how much. */
  deals: { samples: number; withUsual: number; medianLessThanUsualPct: number | null };
  /** Booking sites against Google's lead rate. */
  sites: { samples: number; withSites: number; cheaperThanLeadPct: number | null; medianCheapestVsLeadPct: number | null; medianSites: number | null };
}

/** Pure: everything above from the record's rows. */
export function learnHotels(rows: SampleRow[], k = USUAL_SHRINK_K): HotelLearning {
  const pairs = hotelPairs(rows);
  const err = (p: HotelPair, w: number) => predictPair(p, w) / actualPair(p) - 1;
  const dealPairs = pairs.filter((p) => (p.first.extra?.usualNightly ?? 0) > 0);
  let bestWeight = 0, bestOff = Infinity;
  for (const w of USUAL_WEIGHT_GRID) {
    const off = median(dealPairs.map((p) => Math.abs(err(p, w))));
    if (off !== null && off < bestOff - 1e-9) { bestOff = off; bestWeight = w; }
  }
  const n = dealPairs.length;
  const usualWeight = Math.round(bestWeight * (n / (n + k)) * 1000) / 1000;
  const byWeight = [...new Set([0, usualWeight, bestWeight, 0.5, 1])].sort((a, b) => a - b).map((w) => ({
    w, all: missSummary(pairs.map((p) => err(p, w))), deals: missSummary(dealPairs.map((p) => err(p, w))),
  }));
  const resorts = [...new Set(pairs.map((p) => p.resortId))].sort();
  const byResort = resorts.map((resortId) => {
    const ps = pairs.filter((p) => p.resortId === resortId);
    return { resortId, before: missSummary(ps.map((p) => err(p, 0))), after: missSummary(ps.map((p) => err(p, usualWeight))) };
  });
  const hotels = rows.filter((r) => r.nightly > 0 && !matchDisneyHotel(r.resortId, r.hotelName) && !isRental(r.hotelName, r.kind));
  const withUsual = hotels.filter((r) => (r.extra?.usualNightly ?? 0) > 0);
  const withSites = hotels.filter((r) => (r.extra?.prices?.length ?? 0) > 0);
  return {
    usualWeight, bestWeight, dealPairs: n, pairs: pairs.length, byWeight, byResort,
    deals: {
      samples: hotels.length, withUsual: withUsual.length,
      medianLessThanUsualPct: pct1(median(withUsual.map((r) => 1 - r.nightly / r.extra!.usualNightly!))),
    },
    sites: {
      samples: hotels.length, withSites: withSites.length,
      cheaperThanLeadPct: withSites.length
        ? Math.round(withSites.filter((r) => cheapestPlace(r.nightly, r.extra) < r.nightly - 0.5).length / withSites.length * 100) : null,
      medianCheapestVsLeadPct: pct1(median(withSites.map((r) => cheapestPlace(r.nightly, r.extra) / r.nightly - 1))),
      medianSites: median(withSites.map((r) => r.extra!.prices!.length)),
    },
  };
}

/** Read the record's hotel rows from the last `days` days. Read-only. */
export async function loadHotelSampleRows(db: Db, days = HOTEL_LEARNING_DAYS): Promise<SampleRow[]> {
  try {
    const res = await db.query<{ resort_id: string; month: string; check_in: unknown; pulled_at: unknown;
      hotel_name: string; nightly_usd: string; kind: string | null; extra: unknown }>(
      `select resort_id, month, check_in, pulled_at, hotel_name, nightly_usd, kind, extra
         from hotel_samples where pulled_at > now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return res.rows.map((r) => ({
      resortId: r.resort_id, month: String(r.month).trim(), checkIn: dateStr(r.check_in),
      pulledAt: r.pulled_at instanceof Date ? r.pulled_at : new Date(String(r.pulled_at)),
      hotelName: r.hotel_name, nightly: Number(r.nightly_usd), kind: r.kind,
      extra: (typeof r.extra === "string" ? JSON.parse(r.extra) : r.extra) as HotelExtraLite | null,
    }));
  } catch {
    return []; // Not migrated: learn nothing, price as before.
  }
}

export async function loadHotelLearning(db: Db): Promise<HotelLearning> {
  return learnHotels(await loadHotelSampleRows(db));
}

/** Plain-language lines for the coverage report and /admin. */
export function hotelLearningLines(l: HotelLearning): string[] {
  const s = (m: MissSummary) => m.n
    ? `${m.within10Pct}% within ±10%, typically off ${m.typicalOffPct}%, leans ${m.leanPct === null ? "—" : (m.leanPct > 0 ? "high " : m.leanPct < 0 ? "low " : "") + Math.abs(Math.round(m.leanPct)) + "%"} (${m.n})`
    : "none yet";
  const out = [
    `Off-property hotels Google showed us twice for the same month: ${l.pairs} pairs (${l.dealPairs} where the first was flagged a deal).`,
    `Google's "usual price": weight learned ${l.usualWeight} (best on the pairs alone ${l.bestWeight}, shrunk by ${l.dealPairs}/(${l.dealPairs}+${USUAL_SHRINK_K})). 0 = trust the night we saw, 1 = trust Google's usual.`,
  ];
  for (const b of l.byWeight) out.push(`  at weight ${b.w}: all pairs ${s(b.all)}; deal pairs ${s(b.deals)}`);
  out.push("By resort (the later price predicted from the earlier pull), before -> after:");
  for (const r of l.byResort) out.push(`  ${r.resortId}: ${s(r.before)} -> ${s(r.after)}`);
  out.push(`Deals: ${l.deals.withUsual} of ${l.deals.samples} hotel prices carried "less than usual", typically ${l.deals.medianLessThanUsualPct ?? "—"}% below usual.`);
  out.push(`Booking sites: ${l.sites.withSites} of ${l.sites.samples} carried per-site prices (median ${l.sites.medianSites ?? "—"} sites); `
    + `a site beat Google's lead price on ${l.sites.cheaperThanLeadPct ?? "—"}% of those, cheapest place vs lead typically ${l.sites.medianCheapestVsLeadPct ?? "—"}%.`);
  return out;
}
