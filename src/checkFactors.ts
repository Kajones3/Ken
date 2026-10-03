/**
 * How the owner's price checks move an estimate. Pure, apart from the one
 * read at the bottom.
 *
 * THE OWNER'S RULE (2026-09-27): "Everything I bring in should be
 * information. It shouldn't necessarily OVERWRITE anything, but it should
 * help with our estimates. If I bring in a Christmas time for $2,081 and we
 * have $1,081... we don't necessarily need to replace it but every data point
 * should be fed into our database." So a check is never a new price. It is a
 * RATIO — what they saw over what our model said for the same thing that
 * day — and ratios nudge the model.
 *
 * WHY A RATIO AND NOT THE PRICE ITSELF. A Christmas fare and a March fare are
 * different products, and so are a family room and a standard one. Comparing
 * each check against our OWN number for the same date and the same thing
 * cancels the season out: "$2,081 against our $1,081 for that same week" says
 * our model runs 48% low on that route, and that is a statement about the
 * model which a March trip on the same route can use. The price alone could
 * not say that.
 *
 * HOW FAR ONE CHECK MOVES THINGS. The median ratio is shrunk toward "no
 * change" by n / (n + K), where K is `checks.priorWeight` (default 3): one
 * check moves an estimate a quarter of the way to what it says, three checks
 * halfway, nine three-quarters. Our model never disappears entirely, and one
 * unlucky screenshot never swings a price on its own. Same instinct as
 * ROUTE_CORRECTION_MIN_SAMPLES in book.ts, which blends a single bought fare
 * a third of the way rather than trusting it outright.
 *
 * THE GUARDS. A ratio outside 0.2x-5x is almost certainly a currency typed
 * wrong or a whole stay read as one night, so it is kept but not counted.
 * And the finished factor stays within 0.5x-2x whatever the checks say.
 */
import type { Db } from "./db.js";
import { median } from "./fareCorrections.js";

export const CHECKS_USE_KEY = "checks.use";
export const CHECKS_WEIGHT_KEY = "checks.priorWeight";
export const DEFAULT_CHECKS_WEIGHT = 3;
/** How much one Google rate for a Disney hotel counts, against one owner check. */
export const GOOGLE_DISNEY_WEIGHT_KEY = "sources.hotel.googleDisney";
export const DEFAULT_GOOGLE_DISNEY_WEIGHT = 1;

/** Beyond these, a check is kept as a record but not counted. */
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 5;
/** However many checks agree, an estimate moves at most this far. */
export const FACTOR_MIN = 0.5;
export const FACTOR_MAX = 2;

export type CountedCategory = "flight" | "hotel" | "ticket";

export interface CountedCheck {
  category: CountedCategory;
  /** ORIGIN|resort for a flight, a hotel id, a resort id for tickets. */
  matchKey: string;
  unitUsd: number;
  modelUsd: number;
  /** Hotels: the base rate modelUsd was built on. */
  modelBaseUsd: number | null;
  /** Hotels: same hotel, same stay, same day checked. Several room types for one
   *  hotel on one stay collapse to the cheapest, because the cheapest room
   *  is the one our base rate describes — a family room at twice the price
   *  is a different product, not evidence that the hotel costs double. */
  groupKey: string;
  /** How much this data point counts (default 1). An owner's price check is
   *  1; a Google rate for a Disney hotel counts GOOGLE_DISNEY_WEIGHT_KEY. */
  weight?: number;
}

export interface CheckFactor {
  /** Multiply our estimate by this. */
  factor: number;
  /** How many checks it rests on, after collapsing room types. */
  n: number;
  /** What the checks say on their own, before shrinking toward 1. */
  medianRatio: number;
}

/**
 * One check's ratio against the model as it stands NOW.
 *
 * Hotels are rescaled by the base rate: an on-property rate is the base times
 * the season curve, so if the owner has changed the base since the check
 * (quite possibly BECAUSE of the check), measuring against the old base would
 * count the same correction twice. Flights and tickets are measured against
 * the day's snapshot.
 */
export function ratioOf(c: CountedCheck, baseNow?: number): number {
  let model = c.modelUsd;
  if (c.category === "hotel" && c.modelBaseUsd && baseNow && c.modelBaseUsd > 0) {
    model = model * (baseNow / c.modelBaseUsd);
  }
  return model > 0 ? c.unitUsd / model : NaN;
}

export const usableRatio = (r: number) => Number.isFinite(r) && r >= MIN_RATIO && r <= MAX_RATIO;

/** Shrink a median ratio toward 1 by how much evidence backs it. */
export function shrink(medianRatio: number, n: number, priorWeight: number): number {
  const k = Number.isFinite(priorWeight) && priorWeight >= 0 ? priorWeight : DEFAULT_CHECKS_WEIGHT;
  const w = n > 0 ? n / (n + k) : 0;
  const f = 1 + (medianRatio - 1) * w;
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
}

/**
 * Every counted check, turned into one factor per thing we price.
 * Keys are `${category}|${matchKey}`.
 */
export function computeFactors(
  checks: CountedCheck[],
  opts: { priorWeight?: number; hotelBase?: (hotelId: string) => number | undefined } = {},
): Map<string, CheckFactor> {
  // Collapse room types: keep the cheapest per hotel, stay and day checked.
  const byGroup = new Map<string, CountedCheck>();
  for (const c of checks) {
    const g = `${c.category}|${c.groupKey}`;
    const cur = byGroup.get(g);
    if (!cur || c.unitUsd < cur.unitUsd) byGroup.set(g, c);
  }
  const ratios = new Map<string, { r: number; w: number }[]>();
  for (const c of byGroup.values()) {
    const w = c.weight ?? 1;
    if (!(w > 0)) continue;
    const r = ratioOf(c, c.category === "hotel" ? opts.hotelBase?.(c.matchKey) : undefined);
    if (!usableRatio(r)) continue;
    const key = `${c.category}|${c.matchKey}`;
    ratios.set(key, [...(ratios.get(key) ?? []), { r, w }]);
  }
  const out = new Map<string, CheckFactor>();
  for (const [key, rs] of ratios) {
    const med = weightedMedian(rs);
    // Evidence counts by weight: two Google rates at 0.5 move things as far
    // as one owner check. With every weight at 1 this is the plain median
    // and plain count it always was.
    const n = rs.reduce((s, x) => s + x.w, 0);
    out.set(key, {
      factor: Math.round(shrink(med, n, opts.priorWeight ?? DEFAULT_CHECKS_WEIGHT) * 10000) / 10000,
      n: Math.round(n * 100) / 100,
      medianRatio: Math.round(med * 10000) / 10000,
    });
  }
  return out;
}

/** Median of weighted values. With equal weights, the ordinary median. */
export function weightedMedian(xs: { r: number; w: number }[]): number {
  if (xs.every((x) => x.w === xs[0]!.w)) return median(xs.map((x) => x.r))!;
  const sorted = [...xs].sort((a, b) => a.r - b.r);
  const half = sorted.reduce((s, x) => s + x.w, 0) / 2;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i]!.w;
    if (acc > half) return sorted[i]!.r;
    if (acc === half) return (sorted[i]!.r + sorted[i + 1]!.r) / 2;
  }
  return sorted[sorted.length - 1]!.r;
}

/* ---------------------------------------------------------------------------
 * How far ahead a price was checked.
 *
 * The owner's point: "if I price something today, September 27 for March
 * 2027, then next year on September 27, 2027, we should have a good idea of
 * what we expect prices to be relative to everything else." That is a
 * question about LEAD TIME — whether six months out we tend to run low or
 * high — and it can only be answered from rows that kept both dates, which
 * is why every check does.
 * ------------------------------------------------------------------------ */

export const LEAD_BUCKETS = [
  { label: "Under 2 months", maxDays: 60 },
  { label: "2–4 months", maxDays: 121 },
  { label: "4–6 months", maxDays: 182 },
  { label: "6–9 months", maxDays: 273 },
  { label: "9 months or more", maxDays: Infinity },
] as const;

export function leadBucket(days: number): string {
  return (LEAD_BUCKETS.find((b) => days <= b.maxDays) ?? LEAD_BUCKETS[LEAD_BUCKETS.length - 1]!).label;
}

/**
 * One row per hotel stay (same hotel, same dates, same day checked), keeping
 * the cheapest room, and every other row as it is. The listing keeps every
 * room type; the math reads this.
 */
export function cheapestRoomPerStay<T extends {
  category: string; matchKey: string | null; startDate: string | null; endDate: string | null;
  checkedOn: string; unitUsd: number | null;
}>(rows: T[]): T[] {
  const best = new Map<string, T>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.category !== "hotel" || !r.matchKey) { out.push(r); continue; }
    const key = `${r.matchKey}|${r.startDate}|${r.endDate}|${r.checkedOn}`;
    const cur = best.get(key);
    if (!cur || (r.unitUsd ?? Infinity) < (cur.unitUsd ?? Infinity)) best.set(key, r);
  }
  return [...out, ...best.values()];
}

export interface LeadSummary { category: string; bucket: string; n: number; medianRatio: number }

/** Median ratio per category and lead-time bucket, in bucket order. */
export function summarizeByLead(rows: { category: string; leadDays: number | null; ratio: number | null }[]): LeadSummary[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (r.leadDays === null || r.ratio === null || !usableRatio(r.ratio)) continue;
    const key = `${r.category}|${leadBucket(Math.max(0, r.leadDays))}`;
    groups.set(key, [...(groups.get(key) ?? []), r.ratio]);
  }
  const order = LEAD_BUCKETS.map((b) => b.label as string);
  return [...groups.entries()]
    .map(([key, rs]) => {
      const [category, bucket] = key.split("|") as [string, string];
      return { category, bucket, n: rs.length, medianRatio: Math.round(median(rs)! * 1000) / 1000 };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

/**
 * Every check that can move an estimate. A database without the table yet
 * (a deploy whose migration hasn't run) prices exactly as if nobody had
 * checked anything, rather than failing — same safety property as the
 * owner's settings and attraction list.
 */
export async function countedChecks(db: Db): Promise<CountedCheck[]> {
  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `select id, category, match_key, unit_usd, model_usd, model_base_usd,
              start_date, end_date, checked_on
         from price_checks
        where not_counted = '' and match_key is not null
          and unit_usd > 0 and model_usd > 0
          and category in ('flight','hotel','ticket')`,
    );
    const d = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
    return rows.map((r) => ({
      category: String(r.category) as CountedCategory,
      matchKey: String(r.match_key),
      unitUsd: Number(r.unit_usd),
      modelUsd: Number(r.model_usd),
      modelBaseUsd: r.model_base_usd === null || r.model_base_usd === undefined ? null : Number(r.model_base_usd),
      // Only hotels collapse (see CountedCheck.groupKey); every flight or
      // ticket a person looked at is its own data point.
      groupKey: r.category === "hotel"
        ? `${r.match_key}|${d(r.start_date)}|${d(r.end_date)}|${d(r.checked_on)}`
        : String(r.id),
    }));
  } catch {
    return [];
  }
}
