/**
 * Rates & settings, part 2 of the /admin rework (owner, 2026-10-16): each
 * dial the owner sets says what it does, where it is now, and what the data
 * says about it. Nothing here changes a setting; the owner moves the dial.
 *
 * Evidence per dial, and where it comes from:
 *  - US / international lean: the scoreboard re-grades every bought fare's
 *    estimate (before route corrections, the part the lean moves) at leans
 *    0 / 25 / 50 / 75 / 100 (`fareScoreboard.ts` byLean).
 *  - Use the candidate formula: its typical-trip grade against what
 *    travelers see, on the same fares written down before buying
 *    (`userGrades.ts`).
 *  - Google's weight on Disney hotels, and how much a price check counts:
 *    Disney hotels re-graded leave-one-out at other values (`gradeDisney`).
 *  - The free feed's weight and the typical-day trim: nothing to grade them
 *    against yet, said plainly rather than guessed.
 * Planner Pro what the formulas learned on their own, read-only.
 */
import type { Db } from "./db.js";
import { settingsMap } from "./settings.js";
import { loadScoreboard, type GroupScore } from "./fareScoreboard.js";
import { loadUserGrades, loadDisneyInputs, gradeDisney, luckPoints, type Grade, type HotelSide } from "./userGrades.js";
import { ESTIMATE_LEAN_KEY, INTL_ESTIMATE_LEAN_KEY, DEFAULT_ESTIMATE_LEAN, TYPICAL_TRIM_KEY, DEFAULT_TYPICAL_TRIM } from "./pricing.js";
import { USE_CANDIDATE_KEY, ZONE_PCT_KEY, DEFAULT_ZONE_PCT } from "./fareModel.js";
import { GOOGLE_DISNEY_WEIGHT_KEY, DEFAULT_GOOGLE_DISNEY_WEIGHT, CHECKS_WEIGHT_KEY, DEFAULT_CHECKS_WEIGHT } from "./checkFactors.js";
import { FLIGHT_WEIGHT_KEYS, DEFAULT_FLIGHT_WEIGHTS } from "./observations.js";
import { loadFareModel } from "./fareModelDb.js";
import { loadCheapestListed } from "./cheapestFlights.js";
import { loadHotelLearning } from "./hotelLearning.js";

/** Fewer graded numbers than this and we don't recommend anything. */
export const ADVICE_MIN = 20;
/** A change has to win by this many points to be worth recommending. */
export const ADVICE_MARGIN = 3;

export type Verdict = "change" | "keep" | "can't tell";
export interface Advice {
  key: string;
  name: string;
  /** One sentence: what moving it does. */
  does: string;
  current: string;
  /** The value the data points to (only when verdict = change). */
  suggest: string | null;
  verdict: Verdict;
  /** One short line backing the verdict. */
  evidence: string;
}
export interface Learned { name: string; value: string; note: string }
export interface Recommendations { advice: Advice[]; learned: Learned[] }

const pct = (g: Grade) => (g.n ? Math.round((g.right / g.n) * 100) : null);

/** A lean, from the scoreboard's re-grade at each lean. Lower "typically off" wins. */
export function adviseLean(key: string, name: string, current: number, g: GroupScore): Advice {
  const does = "Where a fare estimate sits in its route's range: 0 the cheap end, 50 the middle, 100 the dear end. Real fares we hold are not moved.";
  const base = { key, name, does, current: String(current) };
  if (g.n < ADVICE_MIN || g.typicalOffPct === null) {
    return { ...base, suggest: null, verdict: "can't tell", evidence: `Only ${g.n} bought fares to test it on; ${ADVICE_MIN} needed.` };
  }
  const best = g.byLean.filter((b) => b.typicalOffPct !== null).sort((a, b) => a.typicalOffPct! - b.typicalOffPct!)[0];
  const now = `now (${current}) typically off ${g.typicalOffPct}%`;
  if (!best || best.lean === current || g.typicalOffPct - best.typicalOffPct! < ADVICE_MARGIN) {
    return { ...base, suggest: null, verdict: "keep", evidence: `${cap(now)}; no lean does more than ${ADVICE_MARGIN} points better (${g.n} fares).` };
  }
  return { ...base, suggest: String(best.lean), verdict: "change",
    evidence: `At ${best.lean}: typically off ${best.typicalOffPct}%; ${now} (${g.n} fares).` };
}

/** The candidate switch: its typical-trip grade against what travelers see, same fares. */
export function adviseCandidate(on: boolean, sides: { name: string; shown: Grade; cand: Grade }[]): Advice {
  const base = { key: USE_CANDIDATE_KEY, name: "Use the candidate formula",
    does: "Prices flight estimates with the learned candidate formula instead of the live one. Real fares we hold are not moved.",
    current: on ? "On" : "Off" };
  const enough = sides.filter((s) => s.shown.n >= ADVICE_MIN && s.cand.n >= ADVICE_MIN);
  const line = sides.map((s) => `${s.name}: candidate ${pct(s.cand) ?? "—"}% vs shown ${pct(s.shown) ?? "—"}%`).join("; ");
  if (!enough.length) return { ...base, suggest: null, verdict: "can't tell", evidence: `Too few fares graded yet. ${line}.` };
  const diffs = enough.map((s) => pct(s.cand)! - pct(s.shown)!);
  const better = diffs.every((d) => d >= ADVICE_MARGIN) && enough.length === sides.length;
  const worse = diffs.every((d) => d <= -ADVICE_MARGIN);
  const want = better ? true : worse ? false : null;
  const evidence = `Typical trip, last 30 days. ${line}.${want === null ? " Better on one, worse on the other." : ""}`;
  if (want === null || want === on) return { ...base, suggest: null, verdict: want === null ? "can't tell" : "keep", evidence };
  return { ...base, suggest: want ? "On" : "Off", verdict: "change", evidence };
}

/** A weight graded at a few values: highest share right wins, ties go to the current value. */
export function adviseByGrade(base: Omit<Advice, "suggest" | "verdict" | "evidence">, current: number,
  tried: { value: number; grade: Grade }[], what: string): Advice {
  const cur = tried.find((t) => t.value === current);
  if (!cur || cur.grade.n < ADVICE_MIN) {
    return { ...base, suggest: null, verdict: "can't tell", evidence: `Only ${cur?.grade.n ?? 0} ${what} to test it on; ${ADVICE_MIN} needed.` };
  }
  const best = [...tried].sort((a, b) => (pct(b.grade) ?? -1) - (pct(a.grade) ?? -1))[0]!;
  const line = tried.map((t) => `${t.value}: ${pct(t.grade)}%`).join(" · ");
  if (best.value === current || pct(best.grade)! - pct(cur.grade)! < ADVICE_MARGIN) {
    return { ...base, suggest: null, verdict: "keep", evidence: `Typical trip right: ${line} (${cur.grade.n} ${what}).` };
  }
  return { ...base, suggest: String(best.value), verdict: "change", evidence: `Typical trip right: ${line} (${cur.grade.n} ${what}).` };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const both = (s: { us: HotelSide; intl: HotelSide }): Grade => {
  const a = s.us.typical.month, b = s.intl.typical.month;
  const n = a.n + b.n, right = a.right + b.right;
  return { n, right, pct: n ? Math.round((right / n) * 100) : null, luck: luckPoints(right, n) };
};
const x2 = (n: number) => `×${n.toFixed(2)}`;

export async function loadRecommendations(db: Db, now: Date = new Date()): Promise<Recommendations> {
  const settings = await settingsMap(db);
  const zone = (settings.get(ZONE_PCT_KEY) ?? DEFAULT_ZONE_PCT) / 100;
  const [sb, grades, d] = await Promise.all([
    loadScoreboard(db, 30), loadUserGrades(db, now), loadDisneyInputs(db, settings, zone, now),
  ]);
  const advice: Advice[] = [
    adviseLean(ESTIMATE_LEAN_KEY, "US flight lean", sb.lean, sb.domestic),
    adviseLean(INTL_ESTIMATE_LEAN_KEY, "International flight lean", sb.leanIntl, sb.international),
    adviseCandidate(sb.useCandidate, [
      { name: "US", shown: grades.flights.us.typical.month, cand: grades.flights.us.candidateTypical },
      { name: "International", shown: grades.flights.intl.typical.month, cand: grades.flights.intl.candidateTypical },
    ]),
  ];
  const regrade = (o: Partial<typeof d.opts>) => both(gradeDisney(d.rates, { ...d.opts, ...o }));
  const gw = d.opts.googleWeight;
  advice.push(adviseByGrade({ key: GOOGLE_DISNEY_WEIGHT_KEY, name: "Google's rates for Disney hotels",
    does: "How much one Google rate for a Disney hotel counts against our price, next to one of your price checks (0 = ignore Google).",
    current: String(gw) }, gw,
    [...new Set([0, 1, 2, gw])].sort((a, b) => a - b).map((value) => ({ value, grade: regrade({ googleWeight: value }) })),
    "Disney hotel-months"));
  const pw = d.opts.priorWeight;
  advice.push(adviseByGrade({ key: CHECKS_WEIGHT_KEY, name: "How slowly checks move a price",
    does: "How much evidence it takes to move a Disney hotel's price all the way: higher = each check moves it less.",
    current: String(pw) }, pw,
    [...new Set([1, 3, 6, pw])].sort((a, b) => a - b).map((value) => ({ value, grade: regrade({ priorWeight: value }) })),
    "Disney hotel-months"));
  advice.push({
    key: FLIGHT_WEIGHT_KEYS.travelpayouts, name: "Free flight feed weight",
    does: "How much the free feed's fares count beside the fares we buy (0 = only when it's the only fare for that date).",
    current: String(settings.get(FLIGHT_WEIGHT_KEYS.travelpayouts) ?? DEFAULT_FLIGHT_WEIGHTS.travelpayouts),
    suggest: null, verdict: "can't tell",
    evidence: "The free feed covers trips 0-90 days out and we buy 2-11 months out, so they almost never price the same date.",
  });
  advice.push({
    key: TYPICAL_TRIM_KEY, name: "Typical-day trim",
    does: "How much of the cheapest and dearest days are dropped before picking a month's typical day.",
    current: `${settings.get(TYPICAL_TRIM_KEY) ?? DEFAULT_TYPICAL_TRIM}%`,
    suggest: null, verdict: "can't tell",
    evidence: "We don't know which day travelers actually book, so there is nothing to grade it against.",
  });

  const learned: Learned[] = [];
  const [model, cheapest, hotels] = await Promise.all([
    loadFareModel(db).catch(() => null), loadCheapestListed(db).catch(() => null), loadHotelLearning(db).catch(() => null),
  ]);
  if (model?.plain && (model.plain.dom || model.plain.intl)) {
    // The plain formula (the candidate since 2026-10-16): a typical fare per
    // group, then one learned effect per piece.
    const P = model.plain;
    const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    learned.push({ name: "Candidate: typical fare before the pieces",
      value: [P.dom ? `US ${usd(P.dom.typical)}` : "", P.intl ? `international ${usd(P.intl.typical)}` : ""].filter(Boolean).join(" · "),
      note: `Learned from our own bought fares only: ${P.dom?.fares ?? 0} US, ${P.intl?.fares ?? 0} international.` });
    const moves = (lv: Record<string, { factor: number; fares: number }> | undefined, min = 3) => Object.entries(lv ?? {})
      .filter(([, v]) => v.fares >= min).sort((a, b) => Math.abs(Math.log(b[1].factor)) - Math.abs(Math.log(a[1].factor))).slice(0, 6)
      .map(([k, v]) => `${k} ${x2(v.factor)}`).join(" · ");
    const dest = [moves(P.dom?.dest), moves(P.intl?.dest)].filter(Boolean).join(" · ");
    if (dest) learned.push({ name: "Candidate: by destination", value: dest, note: "How far each airport sits from its group's typical fare." });
    const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthLine = (g: typeof P.dom) => Object.entries(g?.month ?? {}).sort()
      .map(([k, v]) => `${MONTHS[Number(k)]} ${x2(v.factor)}`).join(" · ");
    if (P.dom) learned.push({ name: "Candidate: travel month (US)", value: monthLine(P.dom), note: "Each month against the typical US fare." });
    if (P.intl) learned.push({ name: "Candidate: travel month (international)", value: monthLine(P.intl), note: "Each month against the typical international fare." });
    if (P.dom?.origin) learned.push({ name: "Candidate: home airport (US)", value: moves(P.dom.origin) || "nothing yet",
      note: "US only: abroad, the home airport did not help (2026-10-16 test)." });
    learned.push({ name: "Candidate: government airfare index (fare age)",
      value: `US ${(P.dom?.fareAge.weight ?? 0).toFixed(2)} · international ${(P.intl?.fareAge.weight ?? 0).toFixed(2)}`,
      note: "0 = it teaches nothing yet; it needs our fares to span months the government has published." });
  } else if (model) {
    const L = model.levers;
    learned.push({ name: "Candidate: overall level", value: `US ${x2(L.calibration.dom)} · Europe ${x2(L.calibration.europe)} · Asia ${x2(L.calibration.asia)}`,
      note: `Fitted on ${model.fitted.domestic} US and ${model.fitted.international} international fares.` });
    const dest = Object.entries(L.destination).filter(([, v]) => v.fares >= 3)
      .sort((a, b) => Math.abs(Math.log(b[1].factor)) - Math.abs(Math.log(a[1].factor))).slice(0, 6);
    if (dest.length) learned.push({ name: "Candidate: by destination", value: dest.map(([k, v]) => `${k} ${x2(v.factor)}`).join(" · "),
      note: "The airports that move most from the overall level." });
    learned.push({ name: "Candidate: day of week", value: L.dayOfWeekFrom === "none" ? "not learned" : `learned from ${L.dayOfWeekFrom}`,
      note: Object.values(L.dayOfWeek).length
        ? `Ranges ${x2(Math.min(...Object.values(L.dayOfWeek).map((v) => v.factor)))}-${x2(Math.max(...Object.values(L.dayOfWeek).map((v) => v.factor)))}.` : "" });
    learned.push({ name: "Candidate: budget airlines", value: `${L.budget.slope.toFixed(2)} per 100% share`,
      note: `US routes; ${L.budget.fares} fares behind it.` });
    learned.push({ name: "Candidate: government airfare index", value: `survey age ${L.index.surveyAge.weight.toFixed(2)}`,
      note: `${L.index.surveyAge.fares} fares behind it.` });
  }
  if (cheapest) {
    // One main airport per group is enough: the ratio is learned per group.
    const parts = ([["US", "MCO"], ["Europe", "CDG"], ["Asia", "HND"]] as const).flatMap(([name, a]) => {
      const r = cheapest.ratio(a);
      return r ? [`${name} ${x2(r.ratio)}`] : [];
    });
    learned.push({ name: "Cheapest flight vs the middle one", value: parts.length ? parts.join(" · ") : "not learned yet",
      note: "Prices the cheapest trip on dates we haven't bought." });
  }
  if (hotels) {
    learned.push({ name: "Hotels: weight on Google's usual price", value: hotels.usualWeight.toFixed(2),
      note: `${hotels.dealPairs} deal pairs; 0 means the price we saw held.` });
  }
  return { advice, learned };
}
