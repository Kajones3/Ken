/**
 * Annual passes and DVC point rental — the two things that make a Disney
 * regular's real trip cost look nothing like the gate price.
 *
 * THE OWNER'S ASK, in their words: for a pass holder, "we need them to be
 * able to see what happens if they don't buy their AP"; for DVC, a box for
 * "how many points they would rent and what the TAKE HOME would be (not the
 * rental actual)", added as "actual costs/savings".
 *
 * WHY A PASS IS A COUNTERFACTUAL AND NOT A COST LINE. An annual pass is not
 * bought for one trip. Charging its full price to whichever trip happens to
 * be on screen would make a four-night visit look absurd; spreading it over a
 * guessed number of trips a year would mean inventing the one number that
 * decides the answer. So this does neither. A pass you already hold zeroes
 * what you pay at the gate — which is simply true — and the pass's own price
 * is reported beside it, together with what these same days would have cost
 * without it. The traveller compares the two themselves. That is exactly the
 * comparison the owner described: four passes at Walt Disney World against
 * the same money spent on tickets somewhere else.
 *
 * THE FLATTERING ASSUMPTION, SAID OUT LOUD. Passes are assumed to cover the
 * most expensive tickets in the party first (adults before children). Nothing
 * in the app knows which member of a family holds which pass, and a family
 * that buys three passes for three adults is the ordinary case — but it is
 * the optimistic reading, so the card says so rather than letting it pass as
 * a fact.
 *
 * WHY DVC IS TAKE-HOME AND NOT THE RENTAL PRICE. What a renter pays a broker
 * and what an owner receives are different numbers, and only the second one
 * is money in the member's pocket. Asking for the rental price and quietly
 * assuming a commission would be the app inventing the part that matters.
 *
 * EVERY PRICE HERE WAS CHECKED BY WEB SEARCH, NOT FETCHED. Same standing as
 * the hotel baselines and the visa notes: the broker and Disney pages are
 * refused by this sandbox's egress proxy. All of them are in the settings
 * registry so the owner can correct any of them without a code change.
 */
import { RESORTS } from "./config.js";

export interface PassTier {
  id: string;
  /** What the owner and the traveller both see. */
  label: string;
  /** Shipped price per pass per year, in USD. Overridable — see settings.ts. */
  priceUsd: number;
  /** Share of the resort's parking-and-transfers line this pass covers, 0-100.
   *  Whole-number percent because that is how Disney publishes the perk. */
  parkingPct: number;
  /** True when park hopping is part of the pass, so a hopper add-on is not
   *  charged again for whoever holds one. Every current pass at both resorts
   *  includes it; the field exists so a future tier that doesn't can say so. */
  hopperIncluded: boolean;
  /** Who is allowed to buy it. Shown, never enforced — the app does not know
   *  where anybody lives and should not pretend to. */
  eligibility: string;
  /** False where the perk figures are our reading rather than a published
   *  number we found stated plainly. The price itself is search-checked for
   *  every tier; this flags the trimmings. */
  perksVerified: boolean;
}

export interface PassProgram {
  resortId: string;
  /** Disney's own name for the programme, because "annual pass" is not what
   *  Disneyland calls it and a traveller looking for "Magic Key" should find
   *  the word they know. */
  label: string;
  tiers: PassTier[];
}

/**
 * The two resorts with a pass programme this app can price.
 *
 * The four international resorts sell annual passes too. They are deliberately
 * absent rather than guessed: the tiers, prices and perks are published in
 * other languages and other currencies, and a made-up pass price would flow
 * straight into the six-resort comparison the whole app exists to get right.
 */
export const PASS_PROGRAMS: PassProgram[] = [
  {
    resortId: "wdw",
    label: "Annual Pass",
    tiers: [
      { id: "incredi", label: "Incredi-Pass", priceUsd: 1629, parkingPct: 100, hopperIncluded: true,
        eligibility: "Anyone", perksVerified: true },
      { id: "sorcerer", label: "Sorcerer Pass", priceUsd: 1099, parkingPct: 100, hopperIncluded: true,
        eligibility: "Florida residents and DVC members", perksVerified: true },
      { id: "pirate", label: "Pirate Pass", priceUsd: 869, parkingPct: 100, hopperIncluded: true,
        eligibility: "Florida residents", perksVerified: true },
      { id: "pixie", label: "Pixie Dust Pass", priceUsd: 489, parkingPct: 100, hopperIncluded: true,
        eligibility: "Florida residents", perksVerified: true },
    ],
  },
  {
    resortId: "dlr",
    label: "Magic Key",
    tiers: [
      { id: "inspire", label: "Inspire Key", priceUsd: 1899, parkingPct: 100, hopperIncluded: true,
        eligibility: "Anyone", perksVerified: true },
      { id: "believe", label: "Believe Key", priceUsd: 1474, parkingPct: 50, hopperIncluded: true,
        eligibility: "Anyone", perksVerified: true },
      { id: "explore", label: "Explore Key", priceUsd: 999, parkingPct: 25, hopperIncluded: true,
        eligibility: "Anyone", perksVerified: false },
      { id: "imagine", label: "Imagine Key", priceUsd: 599, parkingPct: 25, hopperIncluded: true,
        eligibility: "Southern California residents", perksVerified: true },
    ],
  },
];

export const PASS_PROGRAM_BY_RESORT = new Map(PASS_PROGRAMS.map((p) => [p.resortId, p]));

/** The settings key holding the owner's price for one tier. */
export const passPriceKey = (resortId: string, tierId: string) => `pass.${resortId}.${tierId}`;

export function findTier(resortId: string, tierId: string): PassTier | undefined {
  return PASS_PROGRAM_BY_RESORT.get(resortId)?.tiers.find((t) => t.id === tierId);
}

/* ---------------------------------------------------------------------------
 * DVC points
 * ------------------------------------------------------------------------ */

/**
 * What an owner actually receives per point, before the owner of THIS site
 * changes it and before the traveller types their own figure over the top.
 *
 * Checked by web search 2026-09-21, not fetched — dvcrequest.com and the
 * other broker sites are refused by this sandbox's egress proxy. Renters pay
 * roughly $19-21 a point; brokers pay the member roughly $18-20, varying by
 * home resort (David's Vacation Club Rentals publishes $18 / $20 / $23
 * depending on resort; DVC Rental Store advertises "up to $24"). The owner's
 * own research said $20 rented and $16 taken home, which was the market a
 * year or two ago and is now conservative — hence $18 here, and hence the
 * traveller's own box, because a member renting privately keeps more than one
 * going through a broker and only they know which they are doing.
 */
export const DVC_TAKE_HOME_PER_POINT = 18;
export const DVC_TAKE_HOME_KEY = "dvc.takeHomePerPoint";
/** A bound to catch a typo, not a claim about the market. */
export const DVC_MAX_POINTS = 2000;
export const DVC_MAX_PER_POINT = 60;

export interface PassHolding {
  resortId: string;
  tierId: string;
  count: number;
}

/**
 * Read pass holdings off whatever the client sent.
 *
 * Unknown resorts and tiers are DROPPED, never thrown — saved trips outlive
 * edits to the catalogue, and a pass tier Disney retires (the Enchant Key
 * became the Explore Key in January) must not break the board of everyone who
 * had picked it. Same rule as an unknown attraction id.
 */
export function parsePassHoldings(raw: unknown): PassHolding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PassHolding[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const r = String((item as Record<string, unknown>).resortId ?? "");
    const t = String((item as Record<string, unknown>).tierId ?? "");
    const n = Math.floor(Number((item as Record<string, unknown>).count ?? 0));
    if (!findTier(r, t)) continue;
    if (!Number.isFinite(n) || n < 1) continue;
    // One holding per resort. Somebody genuinely holding two different tiers
    // is real, but the first one wins rather than the app silently stacking
    // two pass costs against one trip.
    if (seen.has(r)) continue;
    seen.add(r);
    out.push({ resortId: r, tierId: t, count: Math.min(n, 20) });
  }
  return out;
}

/** The traveller's DVC intent, or null when they did not say. */
export interface DvcRental {
  points: number;
  takeHomePerPointUsd: number;
}

export function parseDvcRental(points: unknown, perPoint: unknown, fallbackPerPoint = DVC_TAKE_HOME_PER_POINT): DvcRental | null {
  const p = Number(String(points ?? "").replace(/[,\s]/g, ""));
  if (!Number.isFinite(p) || p <= 0) return null;
  const rawPer = Number(String(perPoint ?? "").replace(/[$,\s]/g, ""));
  const per = Number.isFinite(rawPer) && rawPer > 0 ? rawPer : fallbackPerPoint;
  return {
    points: Math.min(Math.floor(p), DVC_MAX_POINTS),
    takeHomePerPointUsd: Math.min(Math.round(per * 100) / 100, DVC_MAX_PER_POINT),
  };
}

/** Rounded to cents, because this is money somebody is going to check. */
export const dvcCredit = (d: DvcRental): number =>
  Math.round(d.points * d.takeHomePerPointUsd * 100) / 100;

/** Every resort that has a pass programme, for the trip form. */
export const PASS_RESORTS = PASS_PROGRAMS.map((p) => ({
  resortId: p.resortId,
  resortName: RESORTS.find((r) => r.id === p.resortId)?.name ?? p.resortId,
  label: p.label,
  tiers: p.tiers,
}));
