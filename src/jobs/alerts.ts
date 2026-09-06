/**
 * The alert job. Runs after the refresh and re-prices every saved trip.
 *
 * It reads the cache, so it makes ZERO provider calls no matter how many trips
 * are being watched — ten subscribers or ten thousand, the provider sees the
 * same requests the refresh made.
 *
 * Two safety rails, both about not emailing people rubbish:
 *   - a per-user daily cap, and
 *   - anomaly suppression: if a large share of trips move by a large amount in
 *     one run, that is a data error, not a sale, so send nothing.
 */
import { randomUUID } from "node:crypto";
import { RESORT_BY_ID } from "../config.js";
import { addDaysISO, monthBounds, range, todayISO } from "../dates.js";
import { getDb, type Db } from "../db.js";
import { loadBook } from "../book.js";
import { bucketFor } from "../config.js";
import { cheapestIn, poolFor, type Overrides, type TripParams } from "../pricing.js";

export interface Candidate {
  tripId: string; userId: string; resortId: string;
  oldTotal: number; newTotal: number; dropPct: number;
  kind: "total_drop" | "crossed_your_number"; detail: string;
}

const CAP = Number(process.env.ALERT_MAX_PER_USER_PER_DAY ?? 3);
const ANOMALY_SHARE = Number(process.env.ALERT_ANOMALY_SHARE ?? 0.4);
const ANOMALY_MOVE = Number(process.env.ALERT_ANOMALY_MOVE_PCT ?? 25);

export function suppressAnomalies(cands: Candidate[], total: number): { keep: Candidate[]; reason: string } {
  if (total === 0) return { keep: [], reason: "" };
  const wild = cands.filter((c) => c.dropPct >= ANOMALY_MOVE).length;
  if (wild / total >= ANOMALY_SHARE) {
    return { keep: [], reason: `suppressed: ${wild}/${total} trips moved >=${ANOMALY_MOVE}% — looks like bad data` };
  }
  return { keep: cands, reason: "" };
}

export function applyCap(cands: Candidate[], cap = CAP): Candidate[] {
  const byUser = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.dropPct - a.dropPct)) {
    const n = byUser.get(c.userId) ?? 0;
    if (n >= cap) continue;
    byUser.set(c.userId, n + 1);
    out.push(c);
  }
  return out;
}

export async function findAlerts(db: Db, today = todayISO()): Promise<{ candidates: Candidate[]; checked: number }> {
  const { rows } = await db.query(
    `select t.id, t.user_id, t.params, t.overrides, t.baseline_total, t.threshold_pct
       from saved_trips t
       join users u on u.id = t.user_id
      where t.active and (u.plus_until is null or u.plus_until >= $1)`,
    [today],
  );

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const params = row.params as TripParams & { month?: string; resortId?: string };
    const overrides = (row.overrides ?? {}) as Overrides;
    const resortId: string = params.resortId ?? "wdw";
    const resort = RESORT_BY_ID.get(resortId);
    if (!resort) continue;

    const month = params.month ?? todayISO().slice(0, 7);
    const [from, to] = monthBounds(month);
    const book = await loadBook(db, {
      origin: params.origin, destinations: [resort.iata], resortIds: [resort.id],
      from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
    });

    const { best } = cheapestIn(book, resort, params, overrides, range(from, to));
    if (!best) continue;

    const oldTotal = Number(row.baseline_total);
    const dropPct = ((oldTotal - best.total) / oldTotal) * 100;
    const threshold = Number(row.threshold_pct);

    if (dropPct >= threshold) {
      candidates.push({
        tripId: row.id, userId: row.user_id, resortId: resort.id,
        oldTotal, newTotal: best.total, dropPct,
        kind: "total_drop",
        detail: `${resort.name} fell to $${Math.round(best.total)} for arrival ${best.start}`,
      });
      continue;
    }

    // The better alert: a real rate crossed the number the user set themselves.
    const ov = overrides[resort.id];
    if (ov?.nightly) {
      // Only compare against hotels in the category they actually asked for.
      // Emailing someone about a Value resort when they chose Moderate is noise.
      const nights = book.hotelNights(resort.id, best.start);
      const { pool } = poolFor(nights, params.stay, params.tier);
      const cheapest = pool.reduce<number | null>(
        (m, h) => (m === null || h.nightly < m ? h.nightly : m), null);
      if (cheapest !== null && cheapest < ov.nightly) {
        candidates.push({
          tripId: row.id, userId: row.user_id, resortId: resort.id,
          oldTotal, newTotal: best.total,
          dropPct: ((ov.nightly - cheapest) / ov.nightly) * 100,
          kind: "crossed_your_number",
          detail: `You said $${ov.nightly} a night at ${resort.name}. It is now $${Math.round(cheapest)}.`,
        });
      }
    }
  }
  return { candidates, checked: rows.length };
}

export async function runAlerts(db: Db) {
  const runId = randomUUID();
  await db.query(`insert into fetch_runs (id, job) values ($1,'alerts')`, [runId]);

  const { candidates, checked } = await findAlerts(db);
  const { keep, reason } = suppressAnomalies(candidates, checked);
  const final = applyCap(keep);

  for (const c of final) {
    await db.query(
      `insert into price_alerts (id, trip_id, kind, resort_id, old_total, new_total, detail)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), c.tripId, c.kind, c.resortId, c.oldTotal, c.newTotal, c.detail],
    );
    // Hand off to your email provider here; the row above is the durable record,
    // so a send failure can be retried without losing the alert.
  }

  await db.query(
    `update fetch_runs set finished_at = now(), rows_written = $2, note = $3 where id = $1`,
    [runId, final.length, reason || `${checked} trips checked`],
  );
  return { checked, fired: final.length, suppressed: reason };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDb();
  const r = await runAlerts(db);
  console.log(`alerts: ${r.fired} fired from ${r.checked} trips ${r.suppressed}`);
  await db.close();
}
