/**
 * Anonymous action counts: how many comparisons were run, which resorts'
 * details were opened, which booking links were clicked and which Plus
 * passes were picked (owner, 2026-10-02: "Build the click counter").
 *
 * The point is to measure what visitors DO rather than what they say they'd
 * pay for. The "Get Plus" button already works as a test; it just wasn't
 * being counted.
 *
 * WHAT IS STORED, AND WHAT IS NOT. One row per day + action + resort +
 * detail, holding only a number: "2026-10-02, book, tdr, flights, 4". No
 * user, session, cookie, IP address or anything else that could tell two
 * visitors apart or follow one across visits. That is a deliberate privacy
 * choice, the same one `route_searches` makes, and it is why this needs no
 * consent banner (see docs/legal/privacy-policy.md). The cost: it counts
 * actions, not people. One person clicking Kayak three times is three.
 *
 * The owner's own clicks are not counted (server.ts checks before calling
 * recordEvent), so testing the site doesn't skew the numbers.
 */
import type { Db } from "./db.js";
import { RESORT_BY_ID, PLUS_PASSES } from "./config.js";

/** Every action that can be counted, and what its `detail` may be. */
export const EVENT_KINDS = {
  /** "Compare six resorts" was run. */
  compare: { resort: false, details: [""] },
  /** A resort's details were opened from the board. */
  detail: { resort: true, details: [""] },
  /** A booking link was clicked; `detail` is where it went. */
  book: { resort: true, details: ["flights", "tickets", "hotel_disney", "hotel_kayak", "hotel_booking"] },
  /** The Plus paywall was shown. */
  paywall: { resort: false, details: [""] },
  /** A Plus pass was picked in the paywall; `detail` is the pass id. */
  plus: { resort: false, details: PLUS_PASSES.map((p) => p.id) },
} as const;
export type EventKind = keyof typeof EVENT_KINDS;

export interface SiteEvent { kind: EventKind; resort: string; detail: string }

/**
 * What a browser sent, checked against the list above. Anything unknown is
 * refused (null) rather than stored, so the table can only ever hold the
 * handful of values this file names, never free text a visitor typed.
 */
export function parseEvent(body: unknown): SiteEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const kind = String(b.kind ?? "") as EventKind;
  const spec = EVENT_KINDS[kind];
  if (!spec) return null;
  const resort = spec.resort ? String(b.resort ?? "") : "";
  if (spec.resort && !RESORT_BY_ID.has(resort)) return null;
  const detail = String(b.detail ?? "");
  if (!(spec.details as readonly string[]).includes(detail)) return null;
  return { kind, resort, detail };
}

/** Adds one to today's count for this action. */
export async function recordEvent(db: Db, ev: SiteEvent, day = new Date().toISOString().slice(0, 10)): Promise<void> {
  await db.query(
    `insert into event_counts (day, kind, resort_id, detail, n) values ($1, $2, $3, $4, 1)
     on conflict (day, kind, resort_id, detail) do update set n = event_counts.n + 1`,
    [day, ev.kind, ev.resort, ev.detail],
  );
}

/**
 * A short in-memory brake so one script can't inflate the counts. Kept in
 * memory only and forgotten on restart: an IP is used to count requests for
 * a few minutes, never written anywhere.
 */
export function eventRateLimiter(max = 120, windowMs = 10 * 60_000) {
  const seen = new Map<string, { n: number; since: number }>();
  return (key: string, now = Date.now()): boolean => {
    if (seen.size > 5000) seen.clear();
    const s = seen.get(key);
    if (!s || now - s.since > windowMs) { seen.set(key, { n: 1, since: now }); return true; }
    s.n++;
    return s.n <= max;
  };
}

export interface SiteStats {
  days: number;
  from: string;
  to: string;
  totals: Record<EventKind, number>;
  /** Per 100 detail views: how many booking clicks and Plus picks followed. */
  perHundredDetails: { book: number | null; plus: number | null; paywall: number | null };
  byResort: { resort: string; name: string; details: number; book: number }[];
  bookBy: { detail: string; n: number }[];
  plusBy: { pass: string; label: string; priceUsd: number; n: number }[];
  daily: ({ day: string } & Record<EventKind, number>)[];
}

const per100 = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

/** Everything the Visitors page in /admin shows, for the last `days` days. */
export async function loadStats(db: Db, days: number, today = new Date().toISOString().slice(0, 10)): Promise<SiteStats> {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  const from = d.toISOString().slice(0, 10);
  const { rows } = await db.query<{ day: unknown; kind: EventKind; resort_id: string; detail: string; n: number }>(
    `select day, kind, resort_id, detail, n from event_counts where day between $1 and $2`,
    [from, today],
  );
  const dayOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const kinds = Object.keys(EVENT_KINDS) as EventKind[];
  const zero = () => Object.fromEntries(kinds.map((k) => [k, 0])) as Record<EventKind, number>;

  const totals = zero();
  const resorts = new Map<string, { details: number; book: number }>();
  const book = new Map<string, number>();
  const plus = new Map<string, number>();
  const daily = new Map<string, Record<EventKind, number>>();
  for (const r of rows) {
    const n = Number(r.n);
    if (!(r.kind in totals)) continue;
    totals[r.kind] += n;
    const day = dayOf(r.day);
    if (!daily.has(day)) daily.set(day, zero());
    daily.get(day)![r.kind] += n;
    if (r.resort_id) {
      const s = resorts.get(r.resort_id) ?? { details: 0, book: 0 };
      if (r.kind === "detail") s.details += n;
      if (r.kind === "book") s.book += n;
      resorts.set(r.resort_id, s);
    }
    if (r.kind === "book") book.set(r.detail, (book.get(r.detail) ?? 0) + n);
    if (r.kind === "plus") plus.set(r.detail, (plus.get(r.detail) ?? 0) + n);
  }

  // Every day in the window, including quiet ones, newest first.
  const dailyRows: SiteStats["daily"] = [];
  for (let i = 0; i < days; i++) {
    const x = new Date(`${today}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() - i);
    const key = x.toISOString().slice(0, 10);
    dailyRows.push({ day: key, ...(daily.get(key) ?? zero()) });
  }

  return {
    days, from, to: today, totals,
    perHundredDetails: {
      book: per100(totals.book, totals.detail),
      plus: per100(totals.plus, totals.detail),
      paywall: per100(totals.paywall, totals.detail),
    },
    byResort: [...RESORT_BY_ID.values()].map((r) => ({
      resort: r.id, name: r.name,
      details: resorts.get(r.id)?.details ?? 0,
      book: resorts.get(r.id)?.book ?? 0,
    })).sort((a, b) => b.details - a.details || a.name.localeCompare(b.name)),
    bookBy: EVENT_KINDS.book.details.map((detail) => ({ detail, n: book.get(detail) ?? 0 })),
    plusBy: PLUS_PASSES.map((p) => ({ pass: p.id, label: p.label, priceUsd: p.priceUsd, n: plus.get(p.id) ?? 0 })),
    daily: dailyRows,
  };
}
