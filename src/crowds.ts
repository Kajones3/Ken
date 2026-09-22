/**
 * How busy a resort typically is, and what to do about it.
 *
 * Pure and synchronous, no I/O — same shape as attractions.ts and pricing.ts.
 * Everything here is a lookup over CROWDS in config.ts plus one judgement:
 * how loudly to say something, given how much the traveller said they care.
 *
 * THE ONE RULE THIS MODULE MUST NOT BREAK: crowd sensitivity never touches the
 * board's order. The board is sorted by price and that is the app's single
 * job. Telling somebody "the cheapest week is also the busiest" is information
 * they should act on knowingly; quietly demoting the cheapest resort because
 * we guessed they would mind is the app making their decision for them. Same
 * call as the attraction matcher, for the same reason.
 */
import {
  CROWDS, CROWD_BANDS, CROWD_LABELS, CROWDS_ARE_PLACEHOLDER,
  type CrowdBand, type CrowdYear,
} from "./config.js";

/** How much low crowds matter to this traveller. */
export type CrowdSensitivity = "none" | "some" | "high";

export const CROWD_SENSITIVITY_LABELS: Record<CrowdSensitivity, string> = {
  none: "Not much",
  some: "Somewhat",
  high: "A lot",
};

/** Rank a band 0..4. Unknown bands sort as moderate rather than throwing — a
 *  band this build does not recognise must not break a board. */
export function crowdRank(band: CrowdBand): number {
  const i = CROWD_BANDS.indexOf(band);
  return i === -1 ? 2 : i;
}

export interface CrowdMonth {
  resortId: string;
  /** 1-based. */
  month: number;
  band: CrowdBand;
  label: string;
  /** 0..4, so a caller can compare or shade without re-deriving the order. */
  rank: number;
  basis: CrowdYear["basis"];
  /** One plain sentence about where this claim comes from, ready to print.
   *  Always says it is a forecast of demand, never a measurement of crowds. */
  basisNote: string;
  /** Why this month is what it is, when there is something to say. */
  why?: string;
  /** True while the shipped rows are placeholders rather than the owner's. */
  provisional: boolean;
}

const BASIS_NOTES: Record<CrowdYear["basis"], string> = {
  dvcPoints:
    "Inferred from how Disney prices its own DVC points across the year — its forecast of demand, published months ahead. That is a price, not a measured wait time, so it carries none of the posted-wait bias. It is still a forecast, not a count of people.",
  estimate:
    "An estimate from school holidays, national holidays and weather — there is no DVC points chart for this resort to read. Treat it as a starting point, not a researched figure.",
};

/** The crowd picture for one resort in one month, or null if we have nothing.
 *  Null rather than a throw: a missing crowd box must never break a board. */
export function crowdFor(resortId: string, month1: number): CrowdMonth | null {
  const year = CROWDS[resortId];
  if (!year || month1 < 1 || month1 > 12) return null;
  const band = year.months[month1 - 1];
  if (!band) return null;
  return {
    resortId,
    month: month1,
    band,
    label: CROWD_LABELS[band] ?? band,
    rank: crowdRank(band),
    basis: year.basis,
    basisNote: BASIS_NOTES[year.basis],
    why: year.why?.[month1],
    provisional: CROWDS_ARE_PLACEHOLDER,
  };
}

/** Every month of this resort's year, quietest first, for "when should we go".
 *  Ties keep calendar order, so January beats September at the same band —
 *  arbitrary but stable, and a stable list is one somebody can re-read. */
export function quietestMonths(resortId: string, limit = 3): CrowdMonth[] {
  const year = CROWDS[resortId];
  if (!year) return [];
  const all: CrowdMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const c = crowdFor(resortId, m);
    if (c) all.push(c);
  }
  return all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.rank - b.c.rank || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

export interface CrowdFlag {
  resortId: string;
  band: CrowdBand;
  /** What to show on the board row. Short — this sits next to a price. */
  chip: string;
  /** The fuller sentence for the detail card. */
  detail: string;
  /** Quieter months at THIS resort, when any are meaningfully quieter.
   *  Empty when the traveller is already going at a good time. */
  alternatives: CrowdMonth[];
}

/**
 * Whether this resort/month is worth flagging, given how much the traveller
 * said crowds matter.
 *
 * The thresholds are the whole design, so they are stated rather than tuned by
 * feel:
 *   none — never flag. They told us not to; showing it anyway is nagging.
 *   some — flag only `peak`. A "high" month is a normal busy week and
 *          everything is busy somewhere; flagging four resorts out of six
 *          teaches people the flag means nothing.
 *   high — flag `high` and `peak`, and offer quieter months at this resort.
 *
 * Returns null when there is nothing to say, so a caller can render nothing
 * without checking three conditions itself.
 */
export function crowdFlag(
  resortId: string,
  month1: number,
  sensitivity: CrowdSensitivity,
): CrowdFlag | null {
  if (sensitivity === "none") return null;
  const c = crowdFor(resortId, month1);
  if (!c) return null;

  const threshold = sensitivity === "high" ? crowdRank("high") : crowdRank("peak");
  if (c.rank < threshold) return null;

  // Only offer a month that is genuinely quieter, not merely different. Two
  // bands is the gap worth moving a holiday for; one band is noise given the
  // rows are bands in the first place.
  const alternatives =
    sensitivity === "high"
      ? quietestMonths(resortId, 3).filter((q) => c.rank - q.rank >= 2)
      : [];

  const why = c.why ? ` ${c.why}.` : "";
  return {
    resortId,
    band: c.band,
    chip: c.band === "peak" ? "Peak crowds" : "Busy",
    detail:
      `${c.label} crowds are typical here in ${MONTH_NAMES[month1 - 1]}.${why}` +
      (alternatives.length
        ? ` Quieter at this resort: ${alternatives.map((a) => MONTH_NAMES[a.month - 1]).join(", ")}.`
        : ""),
    alternatives,
  };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Across the six resorts being compared, which are quietest this month.
 *
 * This is the Thanksgiving case the owner described: the domestic parks are at
 * peak and an overseas park may be perfectly pleasant, and nothing in the app
 * could say so. It returns a comparison, never a recommendation — the caller
 * prints it beside the board, which stays in price order.
 */
export function quietestThisMonth(resortIds: string[], month1: number): CrowdMonth[] {
  return resortIds
    .map((id) => crowdFor(id, month1))
    .filter((c): c is CrowdMonth => c !== null)
    .sort((a, b) => a.rank - b.rank);
}

/** Parse whatever the client sent into a sensitivity, defaulting to "some".
 *  Never throws: an unknown value is a client we do not control. */
export function parseCrowdSensitivity(v: unknown): CrowdSensitivity {
  return v === "none" || v === "some" || v === "high" ? v : "some";
}
