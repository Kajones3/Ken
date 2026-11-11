/**
 * Planner Pro sales (owner, 2026-11-11: "I want the site to be able to go
 * 'on sale' for like a Launch or for Christmas ... so I can update that in
 * the admin panel").
 *
 * A sale is a name travelers see ("Launch sale", "Christmas sale"), a
 * percent off every pass, and the first and last day it runs. The owner
 * adds, edits, turns off or deletes them in /admin -> Planner Pro sales.
 * Nothing about the passes themselves changes: PRO_PASSES in config.ts keeps
 * the regular prices, and the sale is worked out on top whenever a price is
 * shown or quoted (/api/meta, the "wants Planner Pro" email, and Stripe
 * checkout once it is built: always the SERVER's sale price, never one a
 * page sends).
 *
 * Which sale is on: one that is turned on and whose dates include today.
 * If two overlap, the newest one saved wins, so a Christmas sale added on
 * top of a long launch sale takes over for its own dates.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { dateStr } from "./book.js";
import { PRO_PASSES, type ProPass } from "./config.js";

export interface Sale {
  id: string;
  label: string;
  pctOff: number;
  startsOn: string;
  endsOn: string;
  active: boolean;
  createdAt: string;
  /** live = on today, upcoming = starts later, ended, off = turned off. */
  status: "live" | "upcoming" | "ended" | "off";
}
export interface SaleInput { label?: unknown; pctOff?: unknown; startsOn?: unknown; endsOn?: unknown }

/** The most a sale may take off. Past this it is a typo, not a sale. */
export const MAX_SALE_PCT = 90;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function validateSale(input: SaleInput, today: string):
  { ok: true; value: Pick<Sale, "label" | "pctOff" | "startsOn" | "endsOn"> } | { ok: false; reason: string } {
  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, reason: "Give the sale a name travelers will see, like \"Launch sale\" or \"Christmas sale\"." };
  if (label.length > 60) return { ok: false, reason: `That name is ${label.length} characters; keep it under 60.` };
  const pct = Number(String(input.pctOff ?? "").replace(/[%\s]/g, ""));
  if (!Number.isInteger(pct) || pct < 1 || pct > MAX_SALE_PCT)
    return { ok: false, reason: `The percent off should be a whole number from 1 to ${MAX_SALE_PCT}.` };
  const startsOn = String(input.startsOn ?? "").trim(), endsOn = String(input.endsOn ?? "").trim();
  if (!validDate(startsOn) || !validDate(endsOn)) return { ok: false, reason: "Pick the first and last day of the sale." };
  if (endsOn < startsOn) return { ok: false, reason: "The last day is before the first day." };
  if (endsOn < today) return { ok: false, reason: "That sale has already ended." };
  return { ok: true, value: { label, pctOff: pct, startsOn, endsOn } };
}

export function saleStatus(s: Pick<Sale, "active" | "startsOn" | "endsOn">, today: string): Sale["status"] {
  if (!s.active) return "off";
  if (today < s.startsOn) return "upcoming";
  if (today > s.endsOn) return "ended";
  return "live";
}

/** The sale running today: turned on, dates include today, newest saved wins. */
export function activeSale(sales: Sale[], today: string): Sale | null {
  return sales
    .filter((s) => saleStatus(s, today) === "live")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** A pass's price with the sale taken off, to the cent. */
export function salePrice(priceUsd: number, pctOff: number): number {
  return Math.round(priceUsd * (100 - pctOff)) / 100;
}

export interface PricedPass extends ProPass {
  /** What it costs today: the sale price during a sale, else the regular one. */
  nowUsd: number;
  /** The sale price, only while a sale is on. */
  salePriceUsd: number | null;
}
export function passesWithSale(sale: Sale | null, passes: ProPass[] = PRO_PASSES): PricedPass[] {
  return passes.map((p) => {
    const s = sale ? salePrice(p.priceUsd, sale.pctOff) : null;
    return { ...p, salePriceUsd: s, nowUsd: s ?? p.priceUsd };
  });
}

type Row = { id: string; label: string; pct_off: number; starts_on: unknown; ends_on: unknown; active: boolean; created_at: unknown };
const tsStr = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ""));

export async function listSales(db: Db, today: string): Promise<Sale[]> {
  const { rows } = await db.query<Row>(
    `select id, label, pct_off, starts_on, ends_on, active, created_at from pro_sales order by starts_on desc, created_at desc`);
  return rows.map((r) => {
    const base = { id: r.id, label: r.label, pctOff: Number(r.pct_off), startsOn: dateStr(r.starts_on as never),
      endsOn: dateStr(r.ends_on as never), active: r.active, createdAt: tsStr(r.created_at) };
    return { ...base, status: saleStatus(base, today) };
  });
}

/** Today's sale, or null. A database without the table (or any error)
 *  means no sale: full price is the safe answer, never a guessed discount. */
export async function currentSale(db: Db, today: string): Promise<Sale | null> {
  try { return activeSale(await listSales(db, today), today); } catch { return null; }
}

export async function saveSale(db: Db, input: SaleInput, today: string, id?: string):
  Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateSale(input, today);
  if (!v.ok) return v;
  const { label, pctOff, startsOn, endsOn } = v.value;
  if (id) {
    const r = await db.query(`update pro_sales set label = $2, pct_off = $3, starts_on = $4, ends_on = $5 where id = $1 returning id`,
      [id, label, pctOff, startsOn, endsOn]);
    if (!r.rows.length) return { ok: false, reason: "That sale no longer exists." };
    return { ok: true, id };
  }
  const newId = randomUUID();
  await db.query(`insert into pro_sales (id, label, pct_off, starts_on, ends_on) values ($1,$2,$3,$4,$5)`,
    [newId, label, pctOff, startsOn, endsOn]);
  return { ok: true, id: newId };
}

export async function setSaleActive(db: Db, id: string, active: boolean): Promise<boolean> {
  return (await db.query(`update pro_sales set active = $2 where id = $1 returning id`, [id, active])).rows.length > 0;
}
export async function deleteSale(db: Db, id: string): Promise<boolean> {
  return (await db.query(`delete from pro_sales where id = $1 returning id`, [id])).rows.length > 0;
}
