/**
 * How close are our hotel numbers? (owner, 2026-10-03: "I do want a
 * scorecard for the hotels though. I need to keep an eye on both flights and
 * hotels.") The flight scorecard's sibling, read-only, no provider calls.
 *
 * Hotels have no single "real fare we bought" to grade against, so this uses
 * three sources, each said plainly on the page:
 *
 *  1. DISNEY HOTELS GOOGLE RETURNED. The nightly off-property search is
 *     "hotels near <resort>", and Google's results include Disney's own
 *     hotels. Each one is a real rate for a hotel whose price we otherwise
 *     ESTIMATE from config.ts, so it grades the on-property model for free.
 *     (It also means those Disney hotels were sitting in the off-property
 *     list; the page counts them so that can be decided on evidence.)
 *  2. OFF-PROPERTY, PULL TO PULL. An off-property rate is one real night,
 *     stretched across the month by a season curve until the next pull ~10
 *     days later. What we showed for the new pull's night (the old pull,
 *     moved by the curve) against what Google then said is the honest test of
 *     that stretching. Needs history, so `hotel_samples` records every pull
 *     from now on.
 *  3. THE OWNER'S OWN PRICE CHECKS, already stored with what our model said
 *     that day.
 *
 * Signs match the flight scorecard: + means our number was above the real one.
 */
import type { Db } from "./db.js";
import { RESORTS, RESORT_BY_ID } from "./config.js";
import { dateStr } from "./book.js";
import { hotelSeasonFactor } from "./seasonality.js";
import type { ISODate } from "./dates.js";

/* ----------------------------- name matching ----------------------------- */

/** Words that say nothing about WHICH hotel it is. */
const FILLER = new Set(["disney", "disneys", "s", "resort", "resorts", "hotel", "spa", "the", "and", "at", "a", "walt", "world"]);
/** Place words Google adds in front of a name ("Tokyo DisneySea Hotel MiraCosta"). */
const PLACE = new Set(["tokyo", "disneysea", "disneyland", "paris", "hong", "kong", "shanghai", "orlando", "anaheim", "california", "florida", "lake", "buena", "vista"]);

const tokens = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "")
    .split(/[^a-z0-9]+/).filter((t) => t && !FILLER.has(t));

/**
 * Which of a resort's on-property Disney hotels a vendor's hotel name is, or
 * null. Strict on purpose: the same words exactly, or ours plus only place
 * words in front. "Copper Creek Villas at Disney's Wilderness Lodge" is NOT
 * Wilderness Lodge, and "Hotel near Disneyland Park" is not the Disneyland
 * Hotel. A miss leaves a Disney hotel ungraded; a false match grades the
 * wrong hotel, which is worse.
 */
export function matchDisneyHotel(resortId: string, vendorName: string): { id: string; name: string } | null {
  const resort = RESORT_BY_ID.get(resortId);
  if (!resort) return null;
  const v = tokens(vendorName);
  for (const h of resort.hotels) {
    if (!h.onProperty) continue;
    // "Coronado Springs · Gran Destino" is the resort, then the tower we price.
    const ours = tokens(h.name.split("·")[0]!);
    if (!ours.length) continue;
    const extra = v.filter((t) => !ours.includes(t));
    if (ours.every((t) => v.includes(t)) && extra.every((t) => PLACE.has(t))) return { id: h.id, name: h.name };
  }
  return null;
}

/* ------------------------------- the report ------------------------------ */

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct1 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

export interface Summary { n: number; medianPct: number | null; typicalOffPct: number | null; within15Pct: number | null }
/** errs are (ours / real - 1). */
export function summarize(errs: number[]): Summary {
  return {
    n: errs.length,
    medianPct: pct1(median(errs)),
    typicalOffPct: pct1(median(errs.map(Math.abs))),
    within15Pct: errs.length ? Math.round((errs.filter((e) => Math.abs(e) <= 0.15).length / errs.length) * 100) : null,
  };
}

export interface DisneyMatchRow {
  resort: string; hotelId: string; hotel: string; googleName: string; month: string;
  google: number; ours: number; pct: number;
}
export interface PullPair {
  resort: string; month: string; from: ISODate; to: ISODate; shown: number; real: number; pct: number;
}
export interface CheckRow { resort: string; category: string; item: string; checkedOn: string; ours: number; real: number; pct: number }

export interface HotelScoreboard {
  disney: { all: Summary; byResort: { resort: string; name: string; summary: Summary }[]; rows: DisneyMatchRow[];
    /** Disney hotels found sitting in the off-property list, per resort. */
    inOffPropertyList: { resort: string; name: string; hotels: string[] }[] };
  offProperty: { all: Summary; byResort: { resort: string; name: string; summary: Summary }[]; pairs: PullPair[]; pullsRecorded: number };
  checks: { hotels: Summary; tickets: Summary; byResort: { resort: string; name: string; summary: Summary }[]; rows: CheckRow[] };
}

/** One pull of one resort/month: its night, and the real nightly rates Google returned. */
export interface Pull { resort: string; month: string; checkIn: ISODate; pulledAt: Date; rates: { name: string; nightly: number }[] }

/**
 * Pure: consecutive pulls of the same resort/month, compared. The older
 * pull's typical (median) non-Disney rate, moved by the season curve to the
 * newer pull's night, is what a traveler was being shown for that night; the
 * newer pull is what it really was.
 */
export function pullPairs(
  pulls: Pull[],
  season: (resort: string, date: ISODate) => number = hotelSeasonFactor,
): PullPair[] {
  const groups = new Map<string, Pull[]>();
  for (const p of pulls) groups.set(`${p.resort}|${p.month}`, [...(groups.get(`${p.resort}|${p.month}`) ?? []), p]);
  const out: PullPair[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.pulledAt.getTime() - b.pulledAt.getTime());
    const typical = (p: Pull) => median(p.rates.filter((r) => !matchDisneyHotel(p.resort, r.name)).map((r) => r.nightly));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      const ta = typical(a), tb = typical(b);
      if (!ta || !tb) continue;
      const shown = (ta / season(a.resort, a.checkIn)) * season(b.resort, b.checkIn);
      out.push({ resort: a.resort, month: a.month, from: a.checkIn, to: b.checkIn,
        shown: Math.round(shown), real: Math.round(tb), pct: pct1(shown / tb - 1)! });
    }
  }
  return out.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
}

const byResort = <T extends { resort: string }>(rows: T[], err: (r: T) => number) =>
  RESORTS.map((r) => ({ resort: r.id, name: r.name, summary: summarize(rows.filter((x) => x.resort === r.id).map(err)) }))
    .filter((x) => x.summary.n > 0);

export async function loadHotelScoreboard(db: Db): Promise<HotelScoreboard> {
  /* 1. Disney hotels in Google's results, against our own rate for the same hotel and month. */
  const vend = await db.query<{ resort_id: string; hotel_name: string; m: string; med: string }>(
    `select resort_id, hotel_name, to_char(stay_date, 'YYYY-MM') as m,
            percentile_cont(0.5) within group (order by nightly_usd) as med
       from hotel_rates
      where not on_property and source is not null and stay_date >= current_date
      group by resort_id, hotel_name, to_char(stay_date, 'YYYY-MM')`,
  );
  const ours = await db.query<{ hotel_id: string; m: string; med: string }>(
    `select hotel_id, to_char(stay_date, 'YYYY-MM') as m,
            percentile_cont(0.5) within group (order by nightly_usd) as med
       from hotel_rates
      where on_property and stay_date >= current_date
      group by hotel_id, to_char(stay_date, 'YYYY-MM')`,
  );
  const ourMed = new Map(ours.rows.map((r) => [`${r.hotel_id}|${r.m}`, Number(r.med)]));
  const disneyRows: DisneyMatchRow[] = [];
  const inList = new Map<string, Set<string>>();
  for (const r of vend.rows) {
    const hit = matchDisneyHotel(r.resort_id, r.hotel_name);
    if (!hit) continue;
    inList.set(r.resort_id, (inList.get(r.resort_id) ?? new Set()).add(r.hotel_name));
    const o = ourMed.get(`${hit.id}|${r.m}`);
    const g = Number(r.med);
    if (!o || !(g > 0)) continue;
    disneyRows.push({ resort: r.resort_id, hotelId: hit.id, hotel: hit.name, googleName: r.hotel_name, month: r.m,
      google: Math.round(g), ours: Math.round(o), pct: pct1(o / g - 1)! });
  }
  disneyRows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  /* 2. Off-property, pull to pull. */
  const s = await db.query<{ resort_id: string; month: string; check_in: unknown; pulled_at: unknown; hotel_name: string; nightly_usd: string }>(
    `select resort_id, month, check_in, pulled_at, hotel_name, nightly_usd from hotel_samples
      where pulled_at > now() - interval '120 days'`,
  );
  const pullMap = new Map<string, Pull>();
  for (const r of s.rows) {
    const at = r.pulled_at instanceof Date ? r.pulled_at : new Date(String(r.pulled_at));
    const key = `${r.resort_id}|${r.month}|${at.toISOString()}`;
    const p = pullMap.get(key) ?? { resort: r.resort_id, month: r.month, checkIn: dateStr(r.check_in), pulledAt: at, rates: [] };
    p.rates.push({ name: r.hotel_name, nightly: Number(r.nightly_usd) });
    pullMap.set(key, p);
  }
  const pairs = pullPairs([...pullMap.values()]);

  /* 3. The owner's price checks: what our model said that day, against what they saw. */
  const c = await db.query<{ resort_id: string; category: string; item: string; checked_on: unknown; model_usd: string; unit_usd: string }>(
    `select resort_id, category, item, checked_on, model_usd, unit_usd from price_checks
      where category in ('hotel','ticket') and not_counted = ''
        and model_usd > 0 and unit_usd > 0`,
  );
  const checkRows: CheckRow[] = c.rows
    .map((r) => ({ resort: r.resort_id, category: r.category, item: r.item, checkedOn: dateStr(r.checked_on),
      ours: Math.round(Number(r.model_usd)), real: Math.round(Number(r.unit_usd)), pct: pct1(Number(r.model_usd) / Number(r.unit_usd) - 1)! }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const hotelChecks = checkRows.filter((r) => r.category === "hotel");

  return {
    disney: {
      all: summarize(disneyRows.map((r) => r.pct / 100)),
      byResort: byResort(disneyRows, (r) => r.pct / 100),
      rows: disneyRows,
      inOffPropertyList: [...inList].map(([id, set]) => ({ resort: id, name: RESORT_BY_ID.get(id)?.name ?? id, hotels: [...set].sort() })),
    },
    offProperty: {
      all: summarize(pairs.map((p) => p.pct / 100)),
      byResort: byResort(pairs, (p) => p.pct / 100),
      pairs,
      pullsRecorded: pullMap.size,
    },
    checks: {
      hotels: summarize(hotelChecks.map((r) => r.pct / 100)),
      tickets: summarize(checkRows.filter((r) => r.category === "ticket").map((r) => r.pct / 100)),
      byResort: byResort(hotelChecks, (r) => r.pct / 100),
      rows: checkRows,
    },
  };
}

/** Writes one night's off-property pulls, so the next pull has something to be compared with. */
export async function recordHotelSamples(db: Db, pulls: Omit<Pull, "pulledAt">[]): Promise<number> {
  let n = 0;
  for (const p of pulls) {
    // One timestamp per pull, so its rows group back together when read.
    const at = new Date();
    for (const r of p.rates) {
      if (!(r.nightly > 0)) continue;
      await db.query(
        `insert into hotel_samples (resort_id, month, check_in, pulled_at, hotel_name, nightly_usd) values ($1,$2,$3,$4,$5,$6)`,
        [p.resort, p.month, p.checkIn, at, r.name.slice(0, 200), r.nightly],
      );
      n++;
    }
  }
  return n;
}
