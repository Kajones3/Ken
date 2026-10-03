/**
 * Deals the owner adds in /admin (2026-10-03, owner: "I couldn't find the
 * place to put screenshots in the admin panel. I have some deals I want to
 * try to put in"). Until now a deal could only be typed into seedPromos.ts.
 *
 * These are the same `promos` rows travelers apply on a resort's card, and
 * the same rows the nightly deal email announces to Plus members: a new,
 * active deal that hasn't ended is emailed the next time the alert job runs.
 *
 * What each kind does to a trip is pricing.ts's job (applyPromoEffect); this
 * file only checks a deal makes sense before it is stored.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { RESORT_BY_ID } from "./config.js";
import { dateStr } from "./book.js";
import type { PromoEffectKind } from "./pricing.js";

export const DEAL_KINDS: { kind: PromoEffectKind; label: string; unit: "pct" | "usd" | "none" }[] = [
  { kind: "room_pct_off", label: "% off the room", unit: "pct" },
  { kind: "room_flat_off", label: "$ off the whole room bill", unit: "usd" },
  { kind: "ticket_pct_off", label: "% off park tickets", unit: "pct" },
  { kind: "free_dining", label: "Free dining plan", unit: "none" },
  { kind: "flat_off_total", label: "$ off the whole trip", unit: "usd" },
];

export interface DealInput {
  resortId?: unknown; label?: unknown; effectKind?: unknown; effectValue?: unknown;
  startsOn?: unknown; endsOn?: unknown; sourceNote?: unknown;
}
export interface Deal {
  id: string; resortId: string | null; label: string; effectKind: PromoEffectKind; effectValue: number;
  startsOn: string; endsOn: string; sourceNote: string; active: boolean;
  /** live = on today, upcoming = starts later, ended, off = turned off. */
  status: "live" | "upcoming" | "ended" | "off";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function validateDeal(input: DealInput, today: string):
  { ok: true; value: Omit<Deal, "id" | "active" | "status"> } | { ok: false; reason: string } {
  const r = String(input.resortId ?? "").trim();
  const resortId = r === "" || r === "all" ? null : r;
  if (resortId && !RESORT_BY_ID.has(resortId)) return { ok: false, reason: "Pick a resort, or All resorts." };
  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, reason: "Give the deal a name travelers will recognize, like \"Save up to 25% on rooms\"." };
  if (label.length > 120) return { ok: false, reason: `That name is ${label.length} characters; keep it under 120.` };
  const kind = DEAL_KINDS.find((k) => k.kind === input.effectKind);
  if (!kind) return { ok: false, reason: "Pick what the deal takes off." };
  const raw = String(input.effectValue ?? "").replace(/[$,%\s]/g, "");
  const value = kind.unit === "none" ? 0 : Number(raw);
  if (kind.unit === "pct" && !(value > 0 && value <= 100)) return { ok: false, reason: "The percent off should be between 1 and 100." };
  if (kind.unit === "usd" && !(value > 0 && value <= 20000)) return { ok: false, reason: "The dollars off should be more than 0." };
  const startsOn = String(input.startsOn ?? "").trim();
  const endsOn = String(input.endsOn ?? "").trim();
  if (!validDate(startsOn) || !validDate(endsOn)) return { ok: false, reason: "The deal needs a first and last travel date." };
  if (endsOn < startsOn) return { ok: false, reason: "The last travel date is before the first one." };
  if (endsOn < today) return { ok: false, reason: "That deal has already ended, so nobody could use it." };
  return { ok: true, value: {
    resortId, label, effectKind: kind.kind, effectValue: value, startsOn, endsOn,
    sourceNote: String(input.sourceNote ?? "").trim().slice(0, 400),
  } };
}

export async function listDeals(db: Db, today: string): Promise<Deal[]> {
  const { rows } = await db.query<{ id: string; resort_id: string | null; label: string; effect_kind: PromoEffectKind;
    effect_value: string; starts_on: unknown; ends_on: unknown; source_note: string; active: boolean }>(
    `select id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, source_note, active
       from promos order by ends_on desc, starts_on desc`,
  );
  return rows.map((r) => {
    const startsOn = dateStr(r.starts_on), endsOn = dateStr(r.ends_on);
    const status: Deal["status"] = !r.active ? "off" : endsOn < today ? "ended" : startsOn > today ? "upcoming" : "live";
    return { id: r.id, resortId: r.resort_id, label: r.label, effectKind: r.effect_kind, effectValue: Number(r.effect_value),
      startsOn, endsOn, sourceNote: r.source_note ?? "", active: Boolean(r.active), status };
  });
}

/** Adds a deal, or changes one when `id` is given. Real and dated, so never `historical`. */
export async function saveDeal(db: Db, input: DealInput, today: string, id?: string):
  Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const v = validateDeal(input, today);
  if (!v.ok) return v;
  const d = v.value;
  if (id) {
    const r = await db.query(
      `update promos set resort_id = $2, label = $3, effect_kind = $4, effect_value = $5, starts_on = $6, ends_on = $7,
              source_note = $8, historical = false where id = $1 returning id`,
      [id, d.resortId, d.label, d.effectKind, d.effectValue, d.startsOn, d.endsOn, d.sourceNote],
    );
    return r.rows.length ? { ok: true, id } : { ok: false, reason: "That deal no longer exists." };
  }
  const newId = randomUUID();
  await db.query(
    `insert into promos (id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, historical, source_note, active)
     values ($1,$2,$3,$4,$5,$6,$7,false,$8,true)`,
    [newId, d.resortId, d.label, d.effectKind, d.effectValue, d.startsOn, d.endsOn, d.sourceNote],
  );
  return { ok: true, id: newId };
}

/** Off keeps the row (and its history); on brings it back. */
export async function setDealActive(db: Db, id: string, active: boolean): Promise<boolean> {
  const r = await db.query(`update promos set active = $2 where id = $1 returning id`, [id, active]);
  return r.rows.length > 0;
}

/** For a typo. Anything that was real should be turned off instead. */
export async function deleteDeal(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`delete from promos where id = $1 returning id`, [id]);
  return r.rows.length > 0;
}
