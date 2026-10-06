/**
 * Every answer Google sends us, kept whole (owner, 2026-10-06: "can we keep
 * all the data we pull from Google. Don't drop anything.").
 *
 * The parsers read a few fields from each paid search (a fare, a hotel's
 * nightly rate, Google's typical range); everything else Google said (every
 * itinerary, every airline, layovers, durations, every hotel's amenities,
 * photos, reviews, per-site prices) used to be thrown away. Now the whole
 * response body is kept in `provider_responses`, gzip-compressed, with the
 * request that produced it (the API key removed) and its HTTP status, so a
 * question nobody has thought of yet can still be answered from what we
 * already paid for. Error answers are kept too. Append-only: no code updates
 * or deletes these rows.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import type { Db } from "./db.js";

export interface RawResponse {
  /** e.g. serpapi_flights, serpapi_hotels */
  source: string;
  /** e.g. google_flights, google_hotels */
  kind: string;
  /** The query sent, without the API key. */
  request: Record<string, string>;
  status: number;
  body: string;
  fetchedAt: Date;
}

/** Capture one answer. The API key never leaves this function. */
export function captureRaw(url: URL, status: number, body: string, source: string, kind: string): RawResponse {
  const request: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k !== "api_key") request[k] = v;
  return { source, kind, request, status, body, fetchedAt: new Date() };
}

export async function recordRawResponses(db: Db, list: RawResponse[]): Promise<number> {
  for (const r of list) {
    const gz = gzipSync(Buffer.from(r.body, "utf8"));
    await db.query(
      `insert into provider_responses (source, kind, request, status, body_gz, bytes, fetched_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [r.source, r.kind, JSON.stringify(r.request), r.status, gz, Buffer.byteLength(r.body, "utf8"), r.fetchedAt],
    );
  }
  return list.length;
}

/** Write and clear whatever a provider has captured so far. Safe on providers that capture nothing. */
export async function flushRaw(db: Db, holder: unknown): Promise<number> {
  const raw = (holder as { raw?: RawResponse[] } | null | undefined)?.raw;
  if (!Array.isArray(raw) || !raw.length) return 0;
  return recordRawResponses(db, raw.splice(0, raw.length));
}

/** Read one kept answer back as text. */
export function unzipBody(gz: Uint8Array): string {
  return gunzipSync(Buffer.from(gz)).toString("utf8");
}
