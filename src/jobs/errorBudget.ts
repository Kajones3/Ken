/**
 * The error budget (owner, 2026-10-16: "think deeper. this is basic math.
 * Why aren't we getting better."). Read-only. Answers, with the fares we
 * bought:
 *  1. What the data looks like: fares per route, how many routes we have
 *     ever seen twice.
 *  2. How much of the difference between fares each piece explains:
 *     destination, travel month, home airport, the government survey for
 *     the route, and what is left.
 *  3. Head to head on the same fares, each graded on fares it never saw:
 *     plain additive models (log fare = destination + month + home airport)
 *     against the candidate formula.
 *  4. Route memory: when we HAVE bought a route before, how well does that
 *     fare predict the next one?
 *  5. A real learning curve: one fixed set of test fares, trained on more
 *     and more of the earlier fares.
 *  6. Which target is predictable at all: Google's middle itinerary, the
 *     cheapest, the quarter-way fare, the average of the middle half.
 */
import type { Db } from "../db.js";
import { unzipBody } from "../rawResponses.js";
import { pricedPool } from "../cheapestFlights.js";
import { loadModelInputs } from "../fareModelDb.js";
import { fitFareModel, fitLeverModel, leaveOneOut, plainTuningOf, groupOf, isInternational, fitAdditive, predictAdditive,
  type ModelInputs, type Obs, type Additive } from "../fareModel.js";
import { dateStr } from "../book.js";

/* ---------------------------- pure arithmetic ---------------------------- */

// The additive fitter now lives with the formula it became (fareModel.ts,
// the plain candidate since 2026-10-16); re-exported for this report.
export { fitAdditive, predictAdditive, type Obs, type Additive } from "../fareModel.js";

/** Each row predicted by a fit WITHOUT it (and without other rows of the
 *  same route and date, which are the same search). */
export function looAdditive(rows: Obs[], factors: string[], k = 2): number[] {
  return rows.map((r) => {
    const same = r.keys.searchId;
    const train = rows.filter((x) => x !== r && (!same || x.keys.searchId !== same));
    return predictAdditive(fitAdditive(train, factors, k), r);
  });
}

export interface Score { n: number; within10: number; off: number; lean: number }
/** Grade predictions (log space) against actuals (log space). */
export function score(pred: number[], y: number[]): Score {
  const e = pred.map((p, i) => Math.exp(p - y[i]!) - 1).filter((x) => Number.isFinite(x));
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
  return {
    n: e.length,
    within10: e.length ? Math.round((100 * e.filter((x) => Math.abs(x) <= 0.1).length) / e.length) : NaN,
    off: Math.round(1000 * med(e.map(Math.abs))) / 10,
    lean: Math.round(1000 * med(e)) / 10,
  };
}
export const fmt = (s: Score) => (s.n ? `${String(s.within10).padStart(3)}% within ±10%, typically off ${s.off.toFixed(1)}%, leans ${s.lean >= 0 ? "+" : ""}${s.lean.toFixed(1)}% (${s.n})` : "no fares");

/** Share of the spread that sits with the ROUTE (shows up again on the
 *  same route's other fares) rather than with the day: the correlation of
 *  residuals between two fares of the same route. */
export function routeShare(resid: { route: string; r: number }[]): { pairs: number; corr: number | null } {
  const by = new Map<string, number[]>();
  for (const x of resid) by.set(x.route, [...(by.get(x.route) ?? []), x.r]);
  const a: number[] = [], b: number[] = [];
  for (const list of by.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { a.push(list[i]!); b.push(list[j]!); a.push(list[j]!); b.push(list[i]!); }
  if (a.length < 6) return { pairs: a.length / 2, corr: null };
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return { pairs: a.length / 2, corr: saa && sbb ? Math.round((100 * sab) / Math.sqrt(saa * sbb)) / 100 : null };
}

/* ---------------------------------- loader ---------------------------------- */

const DAY = 86_400_000;
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function errorBudget(db: Db): Promise<string[]> {
  const out: string[] = ["## ERROR BUDGET: why the guesses aren't getting better (read-only, every bought fare in the last 90 days)"];
  const inputs = await loadModelInputs(db, 90);
  // The caution/recency the replay picks today, handed to every refit below
  // (re-running the replay per refit would take hours).
  const tuneOnce = plainTuningOf(inputs);
  const tl = (await db.query<{ origin: string; destination: string; depart_date: unknown; observed_at: unknown; trip_length: number }>(
    `select origin, destination, depart_date, observed_at, trip_length from flight_observations
      where source = 'serpapi_flights' and observed_at > now() - interval '90 days'`)).rows;
  const tripLen = new Map(tl.map((r) => [`${r.origin.trim()}|${r.destination.trim()}|${dateStr(r.depart_date)}|${asDate(r.observed_at).getTime()}`, Number(r.trip_length)]));

  // Google's whole list for each bought fare (same search, closest fetch).
  const ans = (await db.query<{ request: unknown; fetched_at: unknown; body_gz: Uint8Array }>(
    `select request, fetched_at, body_gz from provider_responses where kind = 'google_flights' and status = 200`)).rows;
  const lists = new Map<string, { at: number; pool: number[] }[]>();
  for (const a of ans) {
    const q = (typeof a.request === "string" ? JSON.parse(a.request) : a.request) as Record<string, string>;
    let pool: number[];
    try { pool = pricedPool(JSON.parse(unzipBody(a.body_gz))); } catch { continue; }
    if (pool.length < 3) continue;
    const k = `${q.departure_id}|${q.arrival_id}|${q.outbound_date}`;
    lists.set(k, [...(lists.get(k) ?? []), { at: asDate(a.fetched_at).getTime(), pool }]);
  }

  type Row = { i: number; o: string; d: string; dep: string; at: Date; price: number; intl: boolean; grp: string; month: string;
    route: string; trip: number; pool?: number[]; prior?: number };
  const bts = new Map(inputs.baselines.filter((b) => b.source === "bts_db1b").map((b) => [`${b.origin}|${b.destination}|${b.quarter}`, b.med]));
  const mon = new Map((inputs.monthly ?? []).map((m) => [`${m.origin}|${m.destination}|${m.month}`, m.med]));
  const rows: Row[] = inputs.fares.map((f, i) => {
    const mm = Number(f.departDate.slice(5, 7));
    const l = (lists.get(`${f.origin}|${f.destination}|${f.departDate}`) ?? [])
      .map((x) => ({ x, gap: Math.abs(x.at - f.observedAt.getTime()) })).filter((x) => x.gap <= 2 * DAY).sort((a, b) => a.gap - b.gap)[0]?.x;
    const intl = isInternational(f.destination);
    return { i, o: f.origin, d: f.destination, dep: f.departDate, at: f.observedAt, price: f.price, intl, grp: groupOf(f.destination),
      month: `${intl ? "intl" : "us"}-${mm}`, route: `${f.origin}|${f.destination}`,
      trip: tripLen.get(`${f.origin}|${f.destination}|${f.departDate}|${f.observedAt.getTime()}`) ?? 7, pool: l?.pool,
      prior: intl ? undefined : mon.get(`${f.origin}|${f.destination}|${mm}`) ?? bts.get(`${f.origin}|${f.destination}|${Math.ceil(mm / 3)}`) };
  });

  // 1. What the data looks like.
  out.push("  1. WHAT WE HAVE");
  for (const intl of [false, true]) {
    const rs = rows.filter((r) => r.intl === intl);
    const per = new Map<string, number>();
    for (const r of rs) per.set(r.route, (per.get(r.route) ?? 0) + 1);
    const counts = [...per.values()];
    out.push(`    ${intl ? "International" : "US"}: ${rs.length} fares on ${per.size} routes from ${new Set(rs.map((r) => r.o)).size} home airports to ${new Set(rs.map((r) => r.d)).size} airports; `
      + `routes bought once ${counts.filter((c) => c === 1).length}, twice ${counts.filter((c) => c === 2).length}, 3+ times ${counts.filter((c) => c >= 3).length}; `
      + `trip lengths ${[...new Set(rs.map((r) => r.trip))].sort((a, b) => a - b).join("/")} nights; Google's list kept for ${rs.filter((r) => r.pool).length}`);
  }

  // 2 + 3. Spread explained, and head to head (graded on fares each never saw).
  out.push("  2. HOW MUCH EACH PIECE EXPLAINS, graded on fares the model never saw (log fare = the pieces added up)");
  const obs = (rs: Row[], opts: { prior?: boolean } = {}): Obs[] => rs.map((r) => ({
    y: Math.log(r.price), offset: opts.prior && r.prior ? Math.log(r.prior) : 0,
    keys: { all: "x", dest: r.d, month: r.month, origin: r.o, route: r.route, searchId: `${r.route}|${r.dep}`, trip: String(r.trip) },
  }));
  const candidate = leaveOneOut(inputs, rows.map((r) => r.i));
  for (const intl of [false, true]) {
    const rs = rows.filter((r) => r.intl === intl);
    if (rs.length < 10) continue;
    const ob = obs(rs), y = ob.map((o) => o.y);
    out.push(`    ${intl ? "International" : "US"} (${rs.length} fares):`);
    const line = (name: string, factors: string[], o: Obs[] = ob) => out.push(`      ${name.padEnd(46)} ${fmt(score(looAdditive(o, factors), y))}`);
    line("one number for all", ["all"]);
    line("+ destination airport", ["all", "dest"]);
    line("+ destination + travel month", ["all", "dest", "month"]);
    line("+ destination + month + HOME AIRPORT", ["all", "dest", "month", "origin"]);
    line("+ destination + month + home airport + trip length", ["all", "dest", "month", "origin", "trip"]);
    if (!intl) {
      const withPrior = rs.filter((r) => r.prior);
      const op = obs(withPrior, { prior: true }), yp = op.map((o) => o.y);
      out.push(`      (${withPrior.length} of ${rs.length} US fares have a government survey figure for the route)`);
      out.push(`      ${"survey figure x one learned scale".padEnd(46)} ${fmt(score(looAdditive(op, ["all"]), yp))}`);
      out.push(`      ${"survey figure + destination + month".padEnd(46)} ${fmt(score(looAdditive(op, ["all", "dest", "month"]), yp))}`);
      out.push(`      ${"survey figure + dest + month + home airport".padEnd(46)} ${fmt(score(looAdditive(op, ["all", "dest", "month", "origin"]), yp))}`);
      out.push(`      ${"same fares WITHOUT the survey: dest+month+home".padEnd(46)} ${fmt(score(looAdditive(obs(withPrior), ["all", "dest", "month", "origin"]), yp))}`);
    }
    const cand = rs.flatMap((r) => (candidate.has(r.i) ? [[Math.log(candidate.get(r.i)!), Math.log(r.price)]] : []));
    out.push(`      ${"THE CANDIDATE FORMULA (same test)".padEnd(46)} ${fmt(score(cand.map((x) => x[0]!), cand.map((x) => x[1]!)))}`);

    // 3. Is what's left about the ROUTE (learnable by buying it again) or
    // about the DAY (noise)? Residuals of the full model, per route.
    const full = fitAdditive(ob, ["all", "dest", "month", "origin"]);
    const res = rs.map((r, k) => ({ route: r.route, r: ob[k]!.y - predictAdditive(full, ob[k]!) }));
    const rsh = routeShare(res);
    out.push(`      what's left after destination + month + home airport: ${rsh.corr === null ? `too few repeat routes (${rsh.pairs} pairs)` : `two fares on the SAME route share ${Math.round(rsh.corr * 100)}% of it (${rsh.pairs} pairs): the rest is the day itself`}`);
  }

  // 4. Route memory: a fare predicted from the SAME route's earlier fare
  // (moved by the month difference), against the candidate on those fares.
  out.push("  4. ROUTE MEMORY: predicting a fare from the same route's EARLIER fare (moved by the month shape)");
  for (const intl of [false, true]) {
    const rs = rows.filter((r) => r.intl === intl).sort((a, b) => a.at.getTime() - b.at.getTime());
    const pm: number[] = [], pc: number[] = [], ya: number[] = [];
    for (const r of rs) {
      const prev = rs.filter((x) => x.route === r.route && x.at < r.at && x.dep !== r.dep).pop();
      if (!prev) continue;
      const train = obs(rs.filter((x) => x !== r));
      const m = fitAdditive(train, ["all", "dest", "month", "origin"]);
      const shape = (row: Row) => m.effects.get("month")!.get(row.month) ?? 0;
      pm.push(Math.log(prev.price) + shape(r) - shape(prev));
      ya.push(Math.log(r.price));
      pc.push(candidate.has(r.i) ? Math.log(candidate.get(r.i)!) : NaN);
    }
    out.push(`    ${intl ? "International" : "US"}: the route's earlier fare ${fmt(score(pm, ya))}`);
    out.push(`    ${intl ? "             " : "  "}  the candidate, same fares  ${fmt(score(pc, ya))}`);
  }

  // 5. A real learning curve: the newest quarter of fares is the test; the
  // models learn from the first 25/50/75/100% of the older ones.
  out.push("  5. LEARNING CURVE: one fixed test (the newest 25% of fares), trained on more and more of the older fares");
  const byTime = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const cut = Math.floor(byTime.length * 0.75);
  const test = byTime.slice(cut), older = byTime.slice(0, cut);
  const seenRoutes = new Set(older.map((r) => r.route));
  out.push(`    test: ${test.length} fares bought ${test[0]?.at.toISOString().slice(0, 10)} to ${test[test.length - 1]?.at.toISOString().slice(0, 10)}; only ${test.filter((r) => seenRoutes.has(r.route)).length} are on a route bought before`);
  for (const share of [0.25, 0.5, 0.75, 1]) {
    const train = older.slice(0, Math.max(10, Math.floor(older.length * share)));
    const cm = fitFareModel({ ...inputs, tune: tuneOnce, fares: train.map((r) => inputs.fares[r.i]!) } as ModelInputs);
    const parts: string[] = [];
    for (const intl of [false, true]) {
      const tr = train.filter((r) => r.intl === intl), te = test.filter((r) => r.intl === intl);
      if (!te.length || tr.length < 5) continue;
      const am = fitAdditive(obs(tr), ["all", "dest", "month", "origin"]);
      const ta = obs(te);
      const cp = te.map((r) => cm.predict(r.o, r.d, r.dep as never)?.value).map((v) => (v ? Math.log(v) : NaN));
      parts.push(`${intl ? "intl" : "US"}: additive ${fmt(score(ta.map((o) => predictAdditive(am, o)), ta.map((o) => o.y)))} | candidate ${fmt(score(cp, ta.map((o) => o.y)))}`);
    }
    out.push(`    trained on ${String(train.length).padStart(3)} fares -> ${parts.join(" || ")}`);
  }

  // 6. Which target can be predicted at all? Same additive model, each
  // statistic of Google's list as the thing to hit.
  out.push("  6. WHICH NUMBER FROM GOOGLE'S LIST IS PREDICTABLE? (destination + month + home airport, graded on unseen fares)");
  const q = (s: number[], f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * f)))]!;
  const stats: [string, (p: number[]) => number][] = [
    ["the middle itinerary (what we aim at now)", (p) => p[Math.floor((p.length - 1) / 2)]!],
    ["the cheapest listed", (p) => p[0]!],
    ["the quarter-way fare (p25)", (p) => q(p, 0.25)],
    ["average of the middle half (p25-p75)", (p) => { const a = p.filter((x) => x >= q(p, 0.25) && x <= q(p, 0.75)); return a.reduce((s, x) => s + x, 0) / a.length; }],
  ];
  for (const intl of [false, true]) {
    const rs = rows.filter((r) => r.intl === intl && r.pool);
    if (rs.length < 10) continue;
    for (const [name, f] of stats) {
      const ob = rs.map((r) => ({ y: Math.log(f(r.pool!)), keys: { all: "x", dest: r.d, month: r.month, origin: r.o, searchId: `${r.route}|${r.dep}` } }));
      out.push(`    ${(intl ? "Intl " : "US   ") + name.padEnd(44)} ${fmt(score(looAdditive(ob, ["all", "dest", "month", "origin"]), ob.map((o) => o.y)))}`);
    }
    // Does the size of Google's list move the middle? (more itineraries =
    // more 2-stop, dearer options pulling the middle up)
    const ob = rs.map((r) => ({ y: Math.log(r.pool![Math.floor((r.pool!.length - 1) / 2)]!), keys: { all: "x", dest: r.d, month: r.month, origin: r.o } }));
    const m = fitAdditive(ob, ["all", "dest", "month", "origin"]);
    const xs = rs.map((r) => Math.log(r.pool!.length)), ys = ob.map((o) => o.y - predictAdditive(m, o));
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length;
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
    out.push(`    ${intl ? "Intl" : "US  "} a list twice as long has a middle ${sxx ? ((Math.exp((sxy / sxx) * Math.log(2)) - 1) * 100).toFixed(1) : "-"}% different (after destination, month and home airport)`);
  }
  // 7. The honest head to head: the fares where we wrote our number down
  // BEFORE buying. Every model learns only from fares bought before that
  // moment, exactly like the live board did.
  out.push("  7. HONEST HEAD TO HEAD: the fares we wrote down BEFORE buying; every model learns only from earlier fares");
  const fc = (await db.query<{ origin: string; destination: string; depart_date: unknown; forecast_at: unknown;
    shown_usd: string | null; candidate_usd: string | null; price_usd: string }>(
    `select origin, destination, depart_date, forecast_at, shown_usd, candidate_usd, price_usd
       from fare_forecasts where price_usd > 0 order by forecast_at`).catch(() => ({ rows: [] as never[] }))).rows;
  type P = { intl: boolean; y: number; shown: number; cand: number; a: number; b: number; c: number; r: number; now: number; lev: number };
  const preds: P[] = [];
  const fitCache = new Map<number, { fits: Map<string, Additive>; cm: ReturnType<typeof fitFareModel> | null; lm: ReturnType<typeof fitFareModel> | null }>();
  for (const f of fc) {
    const at = asDate(f.forecast_at).getTime();
    const hour = Math.floor(at / 3_600_000);
    if (!fitCache.has(hour)) {
      const earlier = rows.filter((r) => r.at.getTime() < at - 60_000);
      const fits = new Map<string, Additive>();
      for (const intl of [false, true]) {
        const tr = earlier.filter((r) => r.intl === intl);
        fits.set(`${intl}|a`, fitAdditive(obs(tr), ["all", "dest", "month"]));
        fits.set(`${intl}|b`, fitAdditive(obs(tr), ["all", "dest", "month", "origin"]));
        fits.set(`${intl}|r`, fitAdditive(obs(tr), ["all", "dest", "month", "origin", "route"]));
        const wp = tr.filter((r) => r.prior);
        fits.set(`${intl}|c`, fitAdditive(obs(wp, { prior: true }), ["all", "dest", "month", "origin"]));
      }
      const tin = { ...inputs, tune: tuneOnce, fares: earlier.map((r) => inputs.fares[r.i]!) } as ModelInputs;
      const cm = earlier.length >= 20 ? fitFareModel(tin) : null;
      const lm = earlier.length >= 20 ? fitLeverModel(tin) : null;
      fitCache.set(hour, { fits, cm, lm });
    }
    const { fits, cm, lm } = fitCache.get(hour)!;
    const o = f.origin.trim(), d = f.destination.trim(), dep = dateStr(f.depart_date);
    const intl = isInternational(d), mm = Number(dep.slice(5, 7));
    const prior = intl ? undefined : mon.get(`${o}|${d}|${mm}`) ?? bts.get(`${o}|${d}|${Math.ceil(mm / 3)}`);
    const ob: Obs = { y: 0, keys: { all: "x", dest: d, month: `${intl ? "intl" : "us"}-${mm}`, origin: o, route: `${o}|${d}` } };
    const nowP = cm?.predict(o, d, dep as never)?.value;
    const levP = lm?.predict(o, d, dep as never)?.value;
    preds.push({
      intl, y: Math.log(Number(f.price_usd)),
      shown: f.shown_usd ? Math.log(Number(f.shown_usd)) : NaN, cand: f.candidate_usd ? Math.log(Number(f.candidate_usd)) : NaN,
      a: predictAdditive(fits.get(`${intl}|a`)!, ob), b: predictAdditive(fits.get(`${intl}|b`)!, ob),
      r: predictAdditive(fits.get(`${intl}|r`)!, ob),
      c: prior ? predictAdditive(fits.get(`${intl}|c`)!, { ...ob, offset: Math.log(prior) }) : NaN,
      now: nowP ? Math.log(nowP) : NaN, lev: levP ? Math.log(levP) : NaN,
    });
  }
  for (const intl of [false, true]) {
    const ps = preds.filter((p) => p.intl === intl);
    if (!ps.length) continue;
    const y = ps.map((p) => p.y);
    const L = (name: string, k: keyof P) => out.push(`    ${(intl ? "Intl " : "US   ") + name.padEnd(52)} ${fmt(score(ps.map((p) => p[k] as number), y))}`);
    L("what travelers saw (the live formula)", "shown");
    L("the candidate as it was that night", "cand");
    L("the old lever formula (candidate until 10-16), earlier fares", "lev");
    L("the candidate, today's code (the plain one), earlier fares", "now");
    L("destination + month", "a");
    L("destination + month + home airport", "b");
    L("destination + month + home airport + the route itself", "r");
    if (!intl) L("survey figure + destination + month + home airport", "c");
  }

  out.push("");
  return out;
}
