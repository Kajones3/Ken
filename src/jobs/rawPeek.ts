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
