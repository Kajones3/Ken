/**
 * Read-only peek at what Google actually sends us (owner, 2026-10-16:
 * "show me the actual data we get from Google. I feel like we are wasting
 * money"). Prints, from `provider_responses`: what we paid for and what came
 * back, repeats of the same search, and a few whole answers in readable form.
 */
import type { Db } from "../db.js";
import { unzipBody } from "../rawResponses.js";

type Row = { id: string; kind: string; request: unknown; status: number; bytes: number; fetched_at: unknown; body_gz: Uint8Array };
const req = (r: Row) => (typeof r.request === "string" ? JSON.parse(r.request) : r.request) as Record<string, string>;
const when = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 16).replace("T", " ");
const money = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US")}` : String(n ?? "-"));

export async function rawPeek(db: Db): Promise<string[]> {
  const out: string[] = [];
  out.push("## RAW GOOGLE ANSWERS, as they came (read-only peek)");

  // 1. What we paid for in the last 30 days, and what came back.
  const sum = await db.query<{ kind: string; status: number; n: string; mb: string }>(
    `select kind, status, count(*) n, round(sum(bytes) / 1e6, 1) mb from provider_responses
      where fetched_at > now() - interval '30 days' group by 1, 2 order by 1, 2`);
  out.push("  Searches kept, last 30 days (each one is a paid SerpApi search):");
  for (const r of sum.rows) out.push(`    ${r.kind} status ${r.status}: ${r.n} searches, ${r.mb} MB as sent`);

  const rows = (await db.query<Row>(
    `select id, kind, request, status, bytes, fetched_at, body_gz from provider_responses
      where fetched_at > now() - interval '30 days' order by fetched_at`)).rows;
  let emptyF = 0, emptyH = 0, errors = 0;
  const flightSizes: number[] = [], hotelSizes: number[] = [];
  const repeats = new Map<string, string[]>();
  for (const r of rows) {
    const q = req(r);
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(unzipBody(r.body_gz)); } catch { /* unreadable */ }
    if (j.error) errors++;
    if (r.kind === "google_flights") {
      const n = ((j.best_flights as unknown[]) ?? []).length + ((j.other_flights as unknown[]) ?? []).length;
      if (!n) emptyF++; else flightSizes.push(n);
      const k = `flights ${q.departure_id}->${q.arrival_id} ${q.outbound_date}/${q.return_date}`;
      repeats.set(k, [...(repeats.get(k) ?? []), when(r.fetched_at)]);
    } else {
      const n = ((j.properties as unknown[]) ?? []).length;
      if (!n) emptyH++; else hotelSizes.push(n);
      const k = `hotels "${q.q}" ${q.check_in_date}/${q.check_out_date}`;
      repeats.set(k, [...(repeats.get(k) ?? []), when(r.fetched_at)]);
    }
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  out.push(`  Came back with nothing: flights ${emptyF}, hotels ${emptyH}; answers carrying an error message: ${errors}`);
  out.push(`  Itineraries per flight answer: median ${med(flightSizes)} (min ${Math.min(...flightSizes, 0) || 0}, max ${Math.max(...flightSizes, 0)})`);
  out.push(`  Hotels per hotel answer: median ${med(hotelSizes)} (min ${Math.min(...hotelSizes, 0) || 0}, max ${Math.max(...hotelSizes, 0)})`);
  const dup = [...repeats].filter(([, v]) => v.length > 1);
  out.push(`  The SAME search bought more than once in 30 days: ${dup.length} searches, ${dup.reduce((s, [, v]) => s + v.length - 1, 0)} extra purchases`);
  for (const [k, v] of dup.slice(0, 15)) out.push(`    ${k}: ${v.join(", ")}`);

  // 1b. Owner, 2026-10-16: "I think Google's range for typical flight is
  // still based on ONE WAY." Test: Google labels each search low / typical /
  // high. If the range is in the same units as our round-trip price, the
  // label should match where that price sits in the range AS GIVEN; if the
  // range is one-way, it should match the range DOUBLED.
  type Ins = { lowest_price?: number; price_level?: string; typical_price_range?: [number, number]; price_history?: [number, number][] };
  const tally = { asGiven: 0, doubled: 0, n: 0 };
  const byLevel = new Map<string, { n: number; asGiven: Record<string, number>; doubled: Record<string, number> }>();
  const histRatio: number[] = [];
  const examples: string[] = [];
  const where = (p: number, lo: number, hi: number) => (p < lo ? "below" : p > hi ? "above" : "inside");
  const expect: Record<string, string> = { low: "below", typical: "inside", high: "above" };
  for (const r of rows) {
    if (r.kind !== "google_flights" || r.status !== 200) continue;
    let j: { price_insights?: Ins; best_flights?: { price?: number }[]; other_flights?: { price?: number }[] };
    try { j = JSON.parse(unzipBody(r.body_gz)); } catch { continue; }
    const ins = j.price_insights;
    const range = ins?.typical_price_range;
    const prices = [...(j.best_flights ?? []), ...(j.other_flights ?? [])].map((x) => x.price).filter((x): x is number => typeof x === "number" && x > 0);
    const lowest = ins?.lowest_price ?? (prices.length ? Math.min(...prices) : undefined);
    if (!ins || !range || !lowest || !ins.price_level) continue;
    const a = where(lowest, range[0], range[1]), d = where(lowest, 2 * range[0], 2 * range[1]);
    tally.n++;
    if (a === expect[ins.price_level]) tally.asGiven++;
    if (d === expect[ins.price_level]) tally.doubled++;
    const b = byLevel.get(ins.price_level) ?? { n: 0, asGiven: {}, doubled: {} };
    b.n++; b.asGiven[a] = (b.asGiven[a] ?? 0) + 1; b.doubled[d] = (b.doubled[d] ?? 0) + 1;
    byLevel.set(ins.price_level, b);
    const h = ins.price_history ?? [];
    if (h.length) histRatio.push(h[h.length - 1]![1] / lowest);
    if (examples.length < 12) {
      const q = req(r);
      examples.push(`    ${q.departure_id}->${q.arrival_id} ${q.outbound_date}/${q.return_date}: cheapest listed ${money(lowest)}, Google typical ${money(range[0])}-${money(range[1])}, says "${ins.price_level}"; `
        + `history's newest point ${h.length ? money(h[h.length - 1]![1]) : "-"}; cheapest ${prices.length ? money(Math.min(...prices)) : "-"} middle ${prices.length ? money([...prices].sort((x, y) => x - y)[Math.floor(prices.length / 2)]) : "-"}`);
    }
  }
  out.push("");
  out.push("  IS GOOGLE'S TYPICAL RANGE ONE-WAY OR ROUND TRIP? (every kept flight answer with Google's read)");
  out.push(`    ${tally.n} answers. Google's own label (low/typical/high) matches our round-trip cheapest against:`);
  out.push(`      the range as Google gives it: ${tally.asGiven} of ${tally.n}`);
  out.push(`      the range doubled (one-way x2):  ${tally.doubled} of ${tally.n}`);
  for (const [lvl, b] of byLevel) out.push(`      "${lvl}" (${b.n}): as given ${JSON.stringify(b.asGiven)} · doubled ${JSON.stringify(b.doubled)}`);
  const hs = [...histRatio].sort((x, y) => x - y);
  out.push(`    Google's price-history newest point / cheapest listed now: median ${hs.length ? hs[Math.floor(hs.length / 2)]!.toFixed(2) : "-"} (1.00 = same units, ~0.50 = one-way)`);
  out.push(...examples);

  // 1c. Owner, 2026-10-16: "what was our prediction for these flights? Were
  // we even close?" Every forecast written BEFORE buying, beside Google's list.
  const fc = await db.query<{ origin: string; destination: string; depart_date: unknown; trip_length: number; forecast_at: unknown;
    shown_usd: string | null; candidate_usd: string | null; price_usd: string | null; shown_kind: string | null }>(
    `select origin, destination, depart_date, trip_length, forecast_at, shown_usd, candidate_usd, price_usd, null::text shown_kind
       from fare_forecasts order by forecast_at`).catch(() => ({ rows: [] as never[] }));
  const lists = new Map<string, { pool: number[]; ins?: Ins }>();
  for (const r of rows) {
    if (r.kind !== "google_flights" || r.status !== 200) continue;
    const q = req(r);
    try {
      const j = JSON.parse(unzipBody(r.body_gz)) as { price_insights?: Ins; best_flights?: { price?: number; type?: string }[]; other_flights?: { price?: number; type?: string }[] };
      const pool = [...(j.best_flights ?? []), ...(j.other_flights ?? [])].map((x) => x.price).filter((x): x is number => typeof x === "number" && x > 0).sort((a, b) => a - b);
      lists.set(`${q.departure_id}|${q.arrival_id}|${q.outbound_date}|${q.return_date}`, { pool, ins: j.price_insights });
    } catch { /* unreadable */ }
  }
  const qt = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]!;
  const ds = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  out.push("");
  out.push("  OUR NUMBER vs GOOGLE'S LIST, every forecast written before buying (oldest first)");
  out.push("    route  dates | WE SHOWED · candidate | Google: cheapest · p25 · MIDDLE (what we bought) · p75 · dearest (n) | Google's usual cheapest range, label | shown vs middle");
  let total = 0;
  for (const f of fc.rows) {
    const dep = ds(f.depart_date), ret = addDays(dep, Number(f.trip_length));
    const l = lists.get(`${f.origin.trim()}|${f.destination.trim()}|${dep}|${ret}`);
    const shown = Number(f.shown_usd), cand = f.candidate_usd === null ? null : Number(f.candidate_usd), bought = Number(f.price_usd);
    const g = l?.pool.length ? `${money(l.pool[0])} · ${money(qt(l.pool, 0.25))} · ${money(bought)} · ${money(qt(l.pool, 0.75))} · ${money(l.pool[l.pool.length - 1])} (${l.pool.length})` : `bought ${money(bought)}, no list kept`;
    const r = l?.ins?.typical_price_range;
    const off = bought > 0 && shown > 0 ? `${shown >= bought ? "+" : ""}${Math.round((shown / bought - 1) * 100)}%` : "-";
    out.push(`    ${f.origin.trim()}->${f.destination.trim()} ${dep.slice(5)}..${ret.slice(5)} | ${money(Math.round(shown))} · ${cand === null ? "-" : money(Math.round(cand))} | ${g} | ${r ? `${money(r[0])}-${money(r[1])} ${l?.ins?.price_level ?? ""}` : "-"} | ${off}`);
    total++;
  }
  out.push(`    ${total} forecasts`);

  // 2. The newest flight answer, whole, in readable form.
  const lastF = [...rows].reverse().find((r) => r.kind === "google_flights" && r.status === 200);
  if (lastF) {
    const j = JSON.parse(unzipBody(lastF.body_gz)) as Record<string, unknown>;
    out.push("");
    out.push(`  ONE FLIGHT ANSWER (newest), fetched ${when(lastF.fetched_at)}, ${lastF.bytes.toLocaleString()} bytes`);
    out.push(`    What we asked (API key removed): ${JSON.stringify(req(lastF))}`);
    out.push(`    Top-level sections Google sent: ${Object.keys(j).join(", ")}`);
    for (const sec of ["best_flights", "other_flights"] as const) {
      const list = (j[sec] as Record<string, unknown>[]) ?? [];
      out.push(`    ${sec}: ${list.length} itineraries`);
      for (const it of list) {
        const legs = (it.flights as Record<string, unknown>[]) ?? [];
        const path = legs.map((l) => `${(l.departure_airport as { id?: string })?.id}->${(l.arrival_airport as { id?: string })?.id} ${l.airline ?? ""} ${l.flight_number ?? ""}`).join(" | ");
        out.push(`      ${money(it.price)} ${it.type ?? ""} · ${legs.length - 1} stop(s) · ${it.total_duration ?? "?"} min · ${path}`);
        out.push(`        has a booking/return token: ${it.departure_token ? "departure_token (return flights cost ANOTHER search)" : it.booking_token ? "booking_token" : "none"}`);
      }
    }
    if (j.price_insights) out.push(`    price_insights: ${JSON.stringify(j.price_insights).slice(0, 600)}`);
    out.push(`    search_parameters: ${JSON.stringify(j.search_parameters ?? {})}`);
    out.push(`    raw start: ${JSON.stringify(j).slice(0, 2500)}`);
  }

  // 3. The newest hotel answer, whole, in readable form.
  const lastH = [...rows].reverse().find((r) => r.kind === "google_hotels" && r.status === 200);
  if (lastH) {
    const j = JSON.parse(unzipBody(lastH.body_gz)) as Record<string, unknown>;
    const props = (j.properties as Record<string, unknown>[]) ?? [];
    out.push("");
    out.push(`  ONE HOTEL ANSWER (newest), fetched ${when(lastH.fetched_at)}, ${lastH.bytes.toLocaleString()} bytes`);
    out.push(`    What we asked (API key removed): ${JSON.stringify(req(lastH))}`);
    out.push(`    Top-level sections Google sent: ${Object.keys(j).join(", ")}`);
    out.push(`    ${props.length} properties; more pages offered: ${j.serpapi_pagination ? "yes (each page is another paid search)" : "no"}`);
    for (const p of props) {
      const rate = p.rate_per_night as { extracted_lowest?: number } | undefined;
      const total = p.total_rate as { extracted_lowest?: number } | undefined;
      const sites = ((p.prices as { source?: string; rate_per_night?: { extracted_lowest?: number } }[]) ?? [])
        .map((s) => `${s.source} ${money(s.rate_per_night?.extracted_lowest)}`).join(", ");
      out.push(`      ${p.type ?? "?"} · ${p.name} · ${money(rate?.extracted_lowest)}/night, ${money(total?.extracted_lowest)} total · class ${p.extracted_hotel_class ?? "-"} · rating ${p.overall_rating ?? "-"} (${p.reviews ?? 0})${p.deal ? ` · deal: ${p.deal}` : ""}${sites ? ` · sites: ${sites}` : ""}`);
    }
    out.push(`    raw start: ${JSON.stringify(j).slice(0, 2500)}`);
  }
  out.push("");
  return out;
}
