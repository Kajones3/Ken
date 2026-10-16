/**
 * Read-only deep dive (owner, 2026-10-16): "We aren't learning anything ...
 * dig deeper", and "focus on the most popular fare in Google for a route,
 * rather than the middle. If 5 fares are $1200 and the rest are spread from
 * $1500 - $3000, we should try to hit the $1200 fare." Nothing here changes
 * a price; it measures.
 */
import type { Db } from "../db.js";
import { unzipBody } from "../rawResponses.js";
import { pricedPool } from "../cheapestFlights.js";
import { loadModelInputs } from "../fareModelDb.js";
import { fitFareModel, leaveOneOut, groupOf, isInternational, type ModelInputs } from "../fareModel.js";

/** Google's most popular fare: the price the most itineraries share (the
 *  cheaper one on a tie). When no price repeats, the middle of the fullest
 *  10%-wide band. */
export function popularFare(sorted: number[]): { price: number; count: number; exact: boolean } | undefined {
  if (!sorted.length) return undefined;
  const counts = new Map<number, number>();
  for (const p of sorted) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = { price: sorted[0]!, count: 0 };
  for (const [p, c] of counts) if (c > best.count || (c === best.count && p < best.price)) best = { price: p, count: c };
  if (best.count >= 2) return { ...best, exact: true };
  let band = { count: 0, at: sorted[0]! };
  for (const p0 of sorted) {
    const inBand = sorted.filter((p) => p >= p0 && p < p0 * 1.1);
    if (inBand.length > band.count) band = { count: inBand.length, at: inBand[Math.floor((inBand.length - 1) / 2)]! };
  }
  return { price: band.at, count: band.count, exact: false };
}

const DAY = 86_400_000;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "-");
const grade = (pairs: [number, number][]) => {
  const e = pairs.map(([p, r]) => p / r - 1);
  return e.length
    ? `${pct(e.filter((x) => Math.abs(x) <= 0.1).length, e.length)} within ±10%, typically off ${(100 * med(e.map(Math.abs))).toFixed(1)}%, leans ${(100 * med(e)).toFixed(1)}% (${e.length})`
    : "no fares";
};
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const ds = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

export async function deepDive(db: Db): Promise<string[]> {
  const out: string[] = ["## DEEP DIVE: the most popular fare, and why we aren't learning (read-only)"];

  // Every kept Google answer: its list, middle (what we buy) and popular fare.
  const ans = (await db.query<{ request: unknown; fetched_at: unknown; body_gz: Uint8Array }>(
    `select request, fetched_at, body_gz from provider_responses where kind = 'google_flights' and status = 200`)).rows;
  type L = { o: string; d: string; dep: string; ret: string; at: Date; pool: number[]; middle: number; popular: number; popCount: number; exact: boolean };
  const lists: L[] = [];
  for (const a of ans) {
    const q = (typeof a.request === "string" ? JSON.parse(a.request) : a.request) as Record<string, string>;
    let pool: number[];
    try { pool = pricedPool(JSON.parse(unzipBody(a.body_gz))); } catch { continue; }
    if (pool.length < 3) continue;
    const pop = popularFare(pool)!;
    lists.push({ o: q.departure_id!, d: q.arrival_id!, dep: q.outbound_date!, ret: q.return_date!, at: asDate(a.fetched_at),
      pool, middle: pool[Math.floor((pool.length - 1) / 2)]!, popular: pop.price, popCount: pop.count, exact: pop.exact });
  }
  const groupName = (d: string) => ({ dom: "US", europe: "Europe", asia: "Asia" } as const)[groupOf(d)];

  // 1. What the popular fare looks like next to the middle.
  out.push("  1. GOOGLE'S MOST POPULAR FARE vs THE MIDDLE ONE (every kept answer)");
  for (const g of ["US", "Europe", "Asia"] as const) {
    const ls = lists.filter((l) => groupName(l.d) === g);
    if (!ls.length) continue;
    out.push(`    ${g}: ${ls.length} lists. A price shared by 3+ itineraries: ${pct(ls.filter((l) => l.exact && l.popCount >= 3).length, ls.length)}; `
      + `popular = the cheapest listed: ${pct(ls.filter((l) => l.popular === l.pool[0]).length, ls.length)}; `
      + `popular = the middle: ${pct(ls.filter((l) => l.popular === l.middle).length, ls.length)}; `
      + `popular 10%+ BELOW the middle: ${pct(ls.filter((l) => l.popular < l.middle * 0.9).length, ls.length)}; 10%+ above: ${pct(ls.filter((l) => l.popular > l.middle * 1.1).length, ls.length)}; `
      + `popular / middle median x${med(ls.map((l) => l.popular / l.middle)).toFixed(2)}`);
  }
  const ex = lists.filter((l) => l.popular < l.middle * 0.9 && l.exact).slice(0, 6);
  for (const l of ex) out.push(`      e.g. ${l.o}->${l.d} ${l.dep}: popular $${l.popular} (${l.popCount} itineraries), middle $${l.middle}, list $${l.pool[0]}-$${l.pool[l.pool.length - 1]} (${l.pool.length})`);

  const find = (o: string, d: string, dep: string, at: Date, ret?: string) => lists
    .filter((l) => l.o === o && l.d === d && l.dep === dep && (!ret || l.ret === ret))
    .map((l) => ({ l, gap: Math.abs(l.at.getTime() - at.getTime()) }))
    .filter((x) => x.gap <= 2 * DAY).sort((a, b) => a.gap - b.gap)[0]?.l;

  // 2. Our numbers (written before buying) against each target.
  out.push("  2. WHAT WE SHOWED (written before buying) against each target");
  const fc = (await db.query<{ origin: string; destination: string; depart_date: unknown; trip_length: number; bought_at: unknown; forecast_at: unknown;
    shown_usd: string | null; candidate_usd: string | null }>(
    `select origin, destination, depart_date, trip_length, bought_at, forecast_at, shown_usd, candidate_usd from fare_forecasts where price_usd > 0`)).rows;
  const matched = fc.map((f) => {
    const dep = ds(f.depart_date);
    const ret = new Date(Date.parse(dep + "T00:00:00Z") + f.trip_length * DAY).toISOString().slice(0, 10);
    return { f, l: find(f.origin.trim(), f.destination.trim(), dep, asDate(f.bought_at), ret) };
  }).filter((x) => x.l);
  for (const intl of [false, true]) {
    const xs = matched.filter((x) => isInternational(x.l!.d) === intl);
    const pairs = (who: "shown_usd" | "candidate_usd", target: "middle" | "popular") =>
      xs.filter((x) => x.f[who] !== null).map((x) => [Number(x.f[who]), x.l![target]] as [number, number]);
    out.push(`    ${intl ? "International" : "US"}: shown vs middle ${grade(pairs("shown_usd", "middle"))}`);
    out.push(`    ${" ".repeat(intl ? 13 : 2)}  shown vs popular ${grade(pairs("shown_usd", "popular"))}`);
    out.push(`    ${" ".repeat(intl ? 13 : 2)}  candidate vs middle ${grade(pairs("candidate_usd", "middle"))}`);
    out.push(`    ${" ".repeat(intl ? 13 : 2)}  candidate vs popular ${grade(pairs("candidate_usd", "popular"))}`);
  }

  // 3. Is the popular fare easier to predict? The candidate, re-fitted on each
  // target, graded leave-one-out on the SAME fares.
  out.push("  3. IS THE POPULAR FARE EASIER TO PREDICT? (candidate fitted on each target, leave-one-out, same fares)");
  const inputs = await loadModelInputs(db, 90);
  const keep = inputs.fares.map((f, i) => ({ f, i, l: find(f.origin, f.destination, f.departDate, f.observedAt) })).filter((x) => x.l);
  const onMiddle: ModelInputs = { ...inputs, fares: keep.map((x) => ({ ...x.f, price: x.l!.middle })) };
  const onPopular: ModelInputs = { ...inputs, fares: keep.map((x) => ({ ...x.f, price: x.l!.popular })) };
  const idx = keep.map((_, i) => i);
  const looM = leaveOneOut(onMiddle, idx), looP = leaveOneOut(onPopular, idx);
  for (const intl of [false, true]) {
    const sel = (m: Map<number, number>, inp: ModelInputs) => [...m].filter(([i]) => isInternational(inp.fares[i]!.destination) === intl)
      .map(([i, p]) => [p, inp.fares[i]!.price] as [number, number]);
    out.push(`    ${intl ? "International" : "US"}: aiming at the middle  ${grade(sel(looM, onMiddle))}`);
    out.push(`    ${intl ? "             " : "  "}  aiming at the popular ${grade(sel(looP, onPopular))}`);
  }
  out.push(`    (${keep.length} of ${inputs.fares.length} bought fares have Google's list kept; the rest predate 2026-10-06)`);

  // 4. Are we learning? Walk forward: fit only on fares bought BEFORE each
  // day, predict that day's fares. If the formula learns, later weeks beat
  // earlier ones.
  out.push("  4. ARE WE LEARNING? (candidate fitted only on fares bought before each day, graded on that day's fares)");
  const days = [...new Set(inputs.fares.map((f) => f.observedAt.toISOString().slice(0, 10)))].sort();
  const byWeek = new Map<string, { intl: boolean; p: number; r: number; trained: number }[]>();
  for (const day of days.slice(2)) {
    const before = inputs.fares.filter((f) => f.observedAt.toISOString().slice(0, 10) < day);
    const today = inputs.fares.filter((f) => f.observedAt.toISOString().slice(0, 10) === day);
    if (before.length < 20) continue;
    const m = fitFareModel({ ...inputs, fares: before });
    const wk = new Date(Date.parse(day) - ((new Date(day).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
    for (const f of today) {
      const p = m.predict(f.origin, f.destination, f.departDate);
      if (p) byWeek.set(wk, [...(byWeek.get(wk) ?? []), { intl: isInternational(f.destination), p: p.value, r: f.price, trained: before.length }]);
    }
  }
  for (const [wk, xs] of [...byWeek].sort()) {
    out.push(`    week of ${wk} (trained on ${Math.min(...xs.map((x) => x.trained))}-${Math.max(...xs.map((x) => x.trained))} fares): `
      + `US ${grade(xs.filter((x) => !x.intl).map((x) => [x.p, x.r]))} | intl ${grade(xs.filter((x) => x.intl).map((x) => [x.p, x.r]))}`);
  }

  // 5. Why what travelers see barely learns: how many bought fares the same
  // route+quarter held in the 45 days before each forecast (3 = full weight).
  out.push("  5. WHY WHAT TRAVELERS SEE BARELY LEARNS: bought fares for the same route + quarter in the 45 days before each forecast (3 needed for full weight)");
  const obs = (await db.query<{ origin: string; destination: string; depart_date: unknown; observed_at: unknown }>(
    `select origin, destination, depart_date, observed_at from flight_observations where source = 'serpapi_flights'`)).rows
    .map((r) => ({ k: `${r.origin.trim()}|${r.destination.trim()}|${Math.ceil(Number(ds(r.depart_date).slice(5, 7)) / 3)}`, at: asDate(r.observed_at) }));
  const tally = [0, 0, 0, 0];
  for (const f of fc) {
    const k = `${f.origin.trim()}|${f.destination.trim()}|${Math.ceil(Number(ds(f.depart_date).slice(5, 7)) / 3)}`;
    const at = asDate(f.forecast_at).getTime();
    const n = obs.filter((o) => o.k === k && o.at.getTime() < at && at - o.at.getTime() <= 45 * DAY).length;
    tally[Math.min(3, n)]!++;
  }
  out.push(`    of ${fc.length} forecasts: 0 fares ${tally[0]}, 1 fare ${tally[1]}, 2 fares ${tally[2]}, 3+ fares ${tally[3]}`);

  // 6. Does the home airport matter abroad? The candidate has no lever for it.
  out.push("  6. DOES THE HOME AIRPORT MATTER FOR INTERNATIONAL FARES? real / candidate (leave-one-out), by home airport");
  const all = inputs.fares.map((_, i) => i).filter((i) => isInternational(inputs.fares[i]!.destination));
  const loo = leaveOneOut(inputs, all);
  const byOrigin = new Map<string, number[]>();
  for (const [i, p] of loo) { const o = inputs.fares[i]!.origin; byOrigin.set(o, [...(byOrigin.get(o) ?? []), inputs.fares[i]!.price / p]); }
  const rowsO = [...byOrigin].filter(([, v]) => v.length >= 3).sort((a, b) => med(a[1]) - med(b[1]));
  out.push(`    ${rowsO.map(([o, v]) => `${o} ${med(v).toFixed(2)} (${v.length})`).join(", ")}`);
  out.push("    (1.00 = the candidate is right on for that airport; below 1 = we price it too high, above = too low)");
  const shownIntl = fc.filter((f) => isInternational(f.destination.trim()) && f.shown_usd !== null);
  const same = new Map<string, Set<string>>();
  for (const f of shownIntl) {
    const k = String(Math.round(Number(f.shown_usd)));
    same.set(k, (same.get(k) ?? new Set()).add(`${f.origin.trim()}->${f.destination.trim()}`));
  }
  const shared = [...same].filter(([, v]) => v.size >= 3).sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  for (const [v, rs] of shared) out.push(`    $${v} was shown for ${rs.size} different routes: ${[...rs].join(", ")}`);
  out.push("");
  return out;
}
