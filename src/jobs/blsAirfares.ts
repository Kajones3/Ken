/**
 * Fetch the government's airfare price indexes (airfareIndex.ts says what
 * each is) from the Bureau of Labor Statistics' free public API and keep
 * them in bls_series_values, APPEND-ONLY: a month is written again only when
 * BLS published a different value for it (a revision) or it stopped being
 * preliminary. Nothing is updated or deleted (governing rule 1).
 *
 * No key needed (BLS API v1: 25 requests a day, 10 years). A free key in
 * BLS_API_KEY switches to v2 (500 a day). One request a run.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { BLS_SERIES } from "../airfareIndex.js";

export interface BlsValue { seriesId: string; period: string; value: number; preliminary: boolean }

/** Pure: BLS's JSON -> values. Skips "-" (no data, e.g. October 2025 during
 *  the shutdown) and anything that is not a monthly figure (M13 = annual). */
export function parseBls(payload: unknown): { ok: true; values: BlsValue[] } | { ok: false; reason: string } {
  const p = payload as { status?: string; message?: string[]; Results?: { series?: { seriesID: string; data: {
    year: string; period: string; value: string; footnotes?: { code?: string }[] }[] }[] } };
  if (!p || p.status !== "REQUEST_SUCCEEDED") {
    return { ok: false, reason: `BLS said ${p?.status ?? "nothing"}: ${(p?.message ?? []).join(" ")}` };
  }
  const values: BlsValue[] = [];
  for (const s of p.Results?.series ?? []) {
    for (const d of s.data ?? []) {
      if (!/^M(0[1-9]|1[0-2])$/.test(d.period)) continue;
      const v = Number(d.value);
      if (!(v > 0)) continue;
      values.push({ seriesId: s.seriesID, period: `${d.year}-${d.period.slice(1)}`, value: v,
        preliminary: (d.footnotes ?? []).some((f) => f.code === "P") });
    }
  }
  return { ok: true, values };
}

export async function fetchBls(seriesIds: string[], startYear: number, endYear: number): Promise<unknown> {
  const key = process.env.BLS_API_KEY;
  const url = `https://api.bls.gov/publicAPI/${key ? "v2" : "v1"}/timeseries/data/`;
  const body: Record<string, unknown> = { seriesid: seriesIds, startyear: String(startYear), endyear: String(endYear) };
  if (key) body.registrationkey = key;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BLS answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Keep every value BLS gave us that differs from what we last stored for
 *  that series and month. Returns how many new rows were written. */
export async function storeBlsValues(db: Db, values: BlsValue[]): Promise<number> {
  const have = new Map((await db.query<{ series_id: string; period: string; value: string; preliminary: boolean }>(
    `select distinct on (series_id, period) series_id, period, value, preliminary
       from bls_series_values order by series_id, period, fetched_at desc, id desc`,
  )).rows.map((r) => [`${r.series_id.trim()}|${r.period.trim()}`, r] as const));
  let written = 0;
  for (const v of values) {
    const h = have.get(`${v.seriesId}|${v.period}`);
    if (h && Math.abs(Number(h.value) - v.value) < 0.0005 && h.preliminary === v.preliminary) continue;
    await db.query(
      `insert into bls_series_values (series_id, period, value, preliminary) values ($1,$2,$3,$4)`,
      [v.seriesId, v.period, v.value, v.preliminary],
    );
    written++;
  }
  return written;
}

export async function runBlsAirfares(db: Db, fetcher: typeof fetchBls = fetchBls, now = new Date()) {
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job, note) values ($1,'bls_airfares','')`, [runId]);
  const y = now.getUTCFullYear();
  try {
    // Back to 2023: the oldest BTS route survey we price from is 2024 Q3.
    const parsed = parseBls(await fetcher(Object.values(BLS_SERIES), y - 3, y));
    if (!parsed.ok) throw new Error(parsed.reason);
    const missing = Object.values(BLS_SERIES).filter((id) => !parsed.values.some((v) => v.seriesId === id));
    const written = await storeBlsValues(db, parsed.values);
    const note = `${parsed.values.length} values read, ${written} new or revised kept`
      + (missing.length ? `; BLS sent nothing for ${missing.join(", ")}` : "");
    await db.query(
      `update fetch_runs set finished_at = now(), calls = 1, rows_written = $2, errors = $3, note = $4 where id = $1`,
      [runId, written, missing.length ? 1 : 0, note],
    );
    return { read: parsed.values.length, written, missing };
  } catch (e) {
    await db.query(`update fetch_runs set finished_at = now(), calls = 1, rows_written = 0, errors = 1, note = $2 where id = $1`,
      [runId, String((e as Error).message).slice(0, 500)]);
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import("../db.js");
  const { loadIndexSeries, summarize } = await import("../airfareIndex.js");
  const db = await getDb();
  const r = await runBlsAirfares(db);
  console.log(`bls airfares: ${r.read} values read, ${r.written} new or revised kept`
    + (r.missing.length ? `; MISSING ${r.missing.join(", ")}` : ""));
  for (const l of summarize(await loadIndexSeries(db)).lines) console.log("  " + l);
  await db.close?.();
  if (r.missing.length) process.exit(1);
}
