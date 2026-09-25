/**
 * Fares the owner has seen with their own eyes.
 *
 * THE DECISION THIS IMPLEMENTS, in the owner's words: a corrected fare
 * "should become another data point, a weighted data point to help us update
 * our estimated cache price". So this is deliberately NOT an override. You
 * cannot type $500 here and have the board display $500. You are adding an
 * observation to the same route/quarter evidence a bought SerpApi fare
 * already feeds, and the estimate moves toward it — and stays labeled an
 * estimate, because that is what it still is.
 *
 * WHY THAT IS THE RIGHT SHAPE rather than a plain override. A fare is not one
 * number: it is a route, a date, a trip length and a market that moves.
 * Letting one typed figure replace an entire route's curve would be the
 * fabricated-precision trap the `est.` chip exists to avoid — it would look
 * exact and be a guess. Moving the curve toward real evidence is honest about
 * what happened: somebody saw a price, and the model now knows more than it
 * did.
 *
 * THE BANDS. Low / Typical / High map to p25 / median / p75, so "that was the
 * cheap end" and "that is what it usually costs" are different statements
 * rather than both pretending to be the midpoint. A correction moves its own
 * statistic; the others follow the median's movement so the shape stays
 * coherent, and the three are sorted afterwards because a low that lands
 * above a high is nonsense however the arithmetic got there.
 *
 * WHAT STOPS IT GOING STALE. Two guards, not one: a row stops counting after
 * its own `expires_on`, and separately once its travel date has passed. A
 * fare for a trip that has already happened is history, not evidence.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { ALL_ORIGINS, RESORTS } from "./config.js";

export type FareBand = "low" | "typical" | "high";
export const BANDS: FareBand[] = ["low", "typical", "high"];

/** How long a correction counts for, unless the owner sets its own date.
 *  Long enough to be worth typing, short enough that last year's market is
 *  not still steering next year's estimate. */
export const DEFAULT_CORRECTION_DAYS = Number(process.env.FARE_CORRECTION_DAYS ?? 180);

/** Bounds, same spirit as the settings registry: wide enough for a real fare
 *  anywhere in the world, narrow enough to catch a misplaced digit. */
export const MIN_FARE = 20;
export const MAX_FARE = 25000;

export interface FareCorrection {
  id: string;
  origin: string;
  destination: string;
  departDate: string;
  nights: number | null;
  priceUsd: number;
  band: FareBand;
  note: string;
  expiresOn: string;
  createdBy: string;
  createdAt: string;
  /** False once it has expired or its travel date has passed. Shown in the
   *  admin list so a row that has stopped counting says so, rather than
   *  sitting there looking like it still applies. */
  counting: boolean;
}

/** Every airport the app will accept as an origin, and every arrival airport
 *  a resort actually has. Typing a code we cannot price is refused at the
 *  door rather than stored and silently ignored for ever. */
export const KNOWN_ORIGINS = new Set(ALL_ORIGINS.map((o) => o.iata));
export const KNOWN_DESTINATIONS = new Set(
  RESORTS.flatMap((r) => [r.iata, ...r.altArrivalAirports.map((a) => a.iata)]),
);

const isoDate = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

const addDays = (from: string, days: number): string => {
  const d = new Date(from + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface CorrectionInput {
  origin: unknown;
  destination: unknown;
  departDate: unknown;
  nights?: unknown;
  priceUsd: unknown;
  band?: unknown;
  note?: unknown;
  expiresOn?: unknown;
}

export type Validated =
  | { ok: true; value: Omit<FareCorrection, "id" | "createdAt" | "counting"> }
  | { ok: false; reason: string };

/**
 * Check one row. Every message names the thing to fix, because this is the
 * only feedback somebody editing a spreadsheet gets.
 */
export function validateCorrection(input: CorrectionInput, today = new Date().toISOString().slice(0, 10)): Validated {
  const origin = String(input.origin ?? "").trim().toUpperCase();
  const destination = String(input.destination ?? "").trim().toUpperCase();
  if (!KNOWN_ORIGINS.has(origin)) {
    return { ok: false, reason: `"${origin || "(blank)"}" is not a departure airport this app prices` };
  }
  if (!KNOWN_DESTINATIONS.has(destination)) {
    return { ok: false, reason: `"${destination || "(blank)"}" is not an arrival airport for any of the six resorts` };
  }
  if (origin === destination) return { ok: false, reason: `${origin} to ${destination} is not a flight` };

  const departDate = isoDate(input.departDate);
  if (!departDate) return { ok: false, reason: `"${String(input.departDate ?? "")}" is not a date — use YYYY-MM-DD` };
  if (departDate < today) {
    // Not a validation nicety: a fare for a trip that has already happened
    // can never count, so storing it would be storing something inert.
    return { ok: false, reason: `${departDate} has already passed, so it could never count toward an estimate` };
  }

  const raw = typeof input.priceUsd === "number" ? input.priceUsd
    : Number(String(input.priceUsd ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(raw)) return { ok: false, reason: `"${String(input.priceUsd ?? "")}" is not a number` };
  const priceUsd = Math.round(raw * 100) / 100;
  if (priceUsd < MIN_FARE || priceUsd > MAX_FARE) {
    return { ok: false, reason: `${priceUsd} is outside $${MIN_FARE}–$${MAX_FARE}. That range is there to catch a mistyped digit — a real fare outside it needs the range changed, not forcing through` };
  }

  const bandRaw = String(input.band ?? "typical").trim().toLowerCase() || "typical";
  if (!BANDS.includes(bandRaw as FareBand)) {
    return { ok: false, reason: `"${bandRaw}" is not a band — use low, typical or high` };
  }

  let nights: number | null = null;
  if (input.nights !== undefined && input.nights !== null && String(input.nights).trim() !== "") {
    const n = Number(String(input.nights).trim());
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return { ok: false, reason: `"${String(input.nights)}" is not a night count between 1 and 60` };
    }
    nights = n;
  }

  const expiresOn = input.expiresOn && String(input.expiresOn).trim()
    ? isoDate(input.expiresOn)
    : addDays(today, DEFAULT_CORRECTION_DAYS);
  if (!expiresOn) return { ok: false, reason: `"${String(input.expiresOn)}" is not a date — use YYYY-MM-DD, or leave it blank` };
  if (expiresOn <= today) return { ok: false, reason: `an expiry of ${expiresOn} is already in the past` };

  return {
    ok: true,
    value: {
      origin, destination, departDate, nights, priceUsd,
      band: bandRaw as FareBand,
      note: String(input.note ?? "").trim().slice(0, 300),
      expiresOn, createdBy: "",
    },
  };
}

export async function addCorrection(db: Db, input: CorrectionInput, by = ""): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateCorrection(input);
  if (!v.ok) return v;
  const id = randomUUID();
  await db.query(
    `insert into fare_corrections
       (id, origin, destination, depart_date, nights, price_usd, band, note, expires_on, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, v.value.origin, v.value.destination, v.value.departDate, v.value.nights,
     v.value.priceUsd, v.value.band, v.value.note, v.value.expiresOn, by],
  );
  return { ok: true, id };
}

/** Newest first. Expired rows are RETURNED, marked as not counting, rather
 *  than hidden — "where did my correction go?" is a worse question than
 *  seeing it sitting there grayed out. */
export async function listCorrections(db: Db, today = new Date().toISOString().slice(0, 10)): Promise<FareCorrection[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select id, origin, destination, depart_date, nights, price_usd, band, note,
            expires_on, created_by, created_at
       from fare_corrections
      order by created_at desc`,
  );
  const d = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
  return rows.map((r) => {
    const departDate = d(r.depart_date);
    const expiresOn = d(r.expires_on);
    return {
      id: String(r.id), origin: String(r.origin), destination: String(r.destination),
      departDate, nights: r.nights === null ? null : Number(r.nights),
      priceUsd: Number(r.price_usd), band: String(r.band) as FareBand,
      note: String(r.note ?? ""), expiresOn, createdBy: String(r.created_by ?? ""),
      createdAt: new Date(String(r.created_at)).toISOString(),
      counting: departDate >= today && expiresOn > today,
    };
  });
}

export async function deleteCorrection(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`delete from fare_corrections where id = $1 returning id`, [id]);
  return r.rows.length > 0;
}

/* ---------------------------------------------------------------------------
 * What the pricing side reads.
 * ------------------------------------------------------------------------ */

export interface CorrectionObservation {
  destination: string;
  quarter: number;
  band: FareBand;
  price: number;
}

/**
 * Every correction that still counts, for these arrival airports, shaped the
 * way book.ts wants it.
 *
 * Both staleness guards are in the SQL rather than in the caller, so there is
 * no way to read this table and forget one of them.
 */
export async function countingCorrections(db: Db, destinations: string[]): Promise<CorrectionObservation[]> {
  if (!destinations.length) return [];
  const { rows } = await db.query<{ destination: string; quarter: number; band: string; price_usd: string }>(
    `select destination,
            extract(quarter from depart_date)::int as quarter,
            band, price_usd
       from fare_corrections
      where destination = any($1)
        and depart_date >= current_date
        and expires_on  >  current_date`,
    [destinations],
  );
  return rows
    .map((r) => ({
      destination: r.destination, quarter: Number(r.quarter),
      band: r.band as FareBand, price: Number(r.price_usd),
    }))
    .filter((o) => Number.isFinite(o.price) && o.price > 0 && BANDS.includes(o.band));
}

/** The median of a list, or undefined when it is empty. */
export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
