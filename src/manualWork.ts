/**
 * /admin -> Manual work: everything the owner keeps up by hand, with when it
 * was last updated (owner, 2026-10-29: "Given that I am doing so much manual.
 * I need ... a tab that says 'Manual work' and shows me the data and the last
 * time it was updated").
 *
 * READ-ONLY. It reads the owner's own tables (price checks, ticket calendar
 * screenshots, deals, notes, park ratings, settings) and the review dates
 * kept in code. It never touches what the nightly jobs fetch: no fare, hotel
 * rate, raw Google answer or BLS/BTS row is read or written here.
 */
import type { Db } from "./db.js";
import { RESORTS, plannableMonths, mileageRateStatus } from "./config.js";
import { REVIEWABLE } from "./ownerTasks.js";
import { loadParkRatings } from "./parkRatings.js";
import { loadMileageRates, IRS_MILEAGE_URL } from "./mileageRates.js";

export interface ManualItem {
  id: string;
  title: string;
  /** What it is and why it matters, one or two sentences. */
  what: string;
  /** ISO timestamp or YYYY-MM-DD, or null for never. */
  lastUpdated: string | null;
  /** How often it should be looked at, in days; null = when something changes. */
  everyDays: number | null;
  status: "ok" | "due" | "missing";
  /** One line on the current state ("8 of 11 months saved"). */
  detail: string;
  /** Where to fix it: an /admin page (#hash) or an outside page. */
  where?: { label: string; href: string };
  /** A button on the page that reads fresh data for the owner to confirm. */
  action?: "mileage-check";
}

const daysSince = (iso: string, today: string) =>
  Math.floor((Date.parse(today) - Date.parse(iso.slice(0, 10))) / 86_400_000);

/** Older than `every` days = due; never = missing. */
function statusOf(last: string | null, every: number | null, today: string): ManualItem["status"] {
  if (!last) return "missing";
  if (every !== null && daysSince(last, today) > every) return "due";
  return "ok";
}

async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  try { return ((await db.query<T>(sql, params)).rows[0]) ?? null; } catch { return null; }
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function loadManualWork(db: Db, today: string): Promise<ManualItem[]> {
  const items: ManualItem[] = [];

  // Park ratings (the "Top rated first" sort).
  const ratings = await loadParkRatings(db, RESORTS);
  const parks = ratings.flatMap((r) => r.parks);
  const rated = parks.filter((p) => p.stars !== null);
  const lastRated = parks.map((p) => p.enteredAt).filter(Boolean).sort().pop() ?? null;
  items.push({
    id: "park-ratings", title: "Park ratings", everyDays: 182,
    what: "The stars you give each park. They decide \"Top rated first\" on the search page; travelers only ever see \"Top rated\".",
    lastUpdated: lastRated, status: rated.length ? statusOf(lastRated, 182, today) : "missing",
    detail: `${rated.length} of ${parks.length} parks rated`,
    where: { label: "Rate the parks below", href: "#ratingsForm" },
  });

  // Ticket calendars (Walt Disney World's N-day calendars, Disneyland's 1-day).
  for (const resortId of ["wdw", "dlr"] as const) {
    const months = plannableMonths(today);
    const row = await one<{ last: Date | null }>(db,
      `select max(observed_at) as last from ticket_calendar where resort_id = $1`, [resortId]);
    let have: string[] = [];
    try {
      have = (await db.query<{ m: string }>(
        `select distinct to_char(park_date, 'YYYY-MM') as m from ticket_calendar where resort_id = $1`, [resortId])).rows.map((r) => r.m);
    } catch { have = []; }
    const missing = months.filter((m) => !have.includes(m));
    const last = iso(row?.last);
    items.push({
      id: `ticket-calendar-${resortId}`,
      title: resortId === "wdw" ? "Walt Disney World ticket calendars" : "Disneyland 1-day ticket calendar (optional)",
      what: resortId === "wdw"
        ? "Screenshots of Disney's own N-day ticket calendar, one month each. Disney's prices move by date, so each month you add prices that month exactly."
        : "Disneyland's 2-5 day tickets are one price any date (already right). Only 1-day trips use this calendar.",
      lastUpdated: last, everyDays: resortId === "wdw" ? 60 : null,
      status: resortId === "dlr" ? "ok" : missing.length ? (last ? "due" : "missing") : statusOf(last, 60, today),
      detail: `${months.length - missing.length} of ${months.length} plannable months saved${missing.length ? `; missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "..." : ""}` : ""}`,
      where: { label: "Ticket calendars", href: "#tickets" },
    });
  }

  // Disneyland Paris tickets: still our estimate, not Disney's table.
  const parisChecks = await one<{ n: string; last: string | null }>(db,
    `select count(*) as n, max(checked_on)::text as last from price_checks where resort_id = 'dlp' and category = 'ticket'`);
  items.push({
    id: "paris-tickets", title: "Disneyland Paris ticket prices", everyDays: null,
    what: "Paris tickets are still our own estimate and read about 43% low. Screenshots of the 1-5 day prices (adult 12+ and child 3-11) for one arrival date from tickets.disneylandparis.com would give us Disney's real table, like Walt Disney World's.",
    lastUpdated: parisChecks?.last ?? null, status: "missing",
    detail: `${Number(parisChecks?.n ?? 0)} Paris ticket price check(s) saved; the 1-5 day table is still needed`,
    where: { label: "Disneyland Paris tickets", href: "https://tickets.disneylandparis.com/" },
  });

  // Tickets checked by hand in the code (Tokyo, Shanghai, Hong Kong; WDW/DLR tables).
  items.push({
    id: "ticket-tables", title: "Ticket prices for Tokyo, Shanghai and Hong Kong", everyDays: 365,
    what: "Checked by hand against each resort's own ticket page and kept in the code. Disney raises them about once a year.",
    lastUpdated: "2026-09-23", status: statusOf("2026-09-23", 365, today), detail: "Last checked against each resort's purchase page",
  });

  // IRS mileage rate (driving trips).
  const saved = await loadMileageRates(db);
  const mileage = mileageRateStatus(today, 365, saved);
  const lastMileage = await one<{ last: Date | null }>(db, `select max(updated_at) as last from owner_mileage_rates`);
  items.push({
    id: "irs-mileage", title: "IRS mileage rate", everyDays: 365, action: "mileage-check",
    what: "What a mile of driving costs (fuel, wear and tear) on driving trips. The IRS publishes next year's rate each December.",
    lastUpdated: iso(lastMileage?.last), status: mileage.uncoveredYears.length ? "due" : "ok",
    detail: mileage.uncoveredYears.length
      ? `No rate yet for ${mileage.uncoveredYears.join(", ")}; trips then use ${mileage.newestYearOnFile}'s`
      : `Covered through ${mileage.newestYearOnFile}`,
    where: { label: "IRS page", href: IRS_MILEAGE_URL },
  });

  // Deals: one line, each resort's live count beside it.
  const deals: { name: string; live: number; last: string | null }[] = [];
  for (const r of RESORTS) {
    const d = await one<{ live: string; last: Date | null }>(db,
      `select count(*) filter (where active and not historical and ends_on >= $2::date) as live, max(created_at) as last
         from promos where resort_id = $1 or resort_id is null`, [r.id, today]);
    deals.push({ name: r.name, live: Number(d?.live ?? 0), last: iso(d?.last) });
  }
  const lastDeal = deals.map((d) => d.last).filter(Boolean).sort().pop() ?? null;
  const none = deals.filter((d) => !d.live).map((d) => d.name);
  items.push({
    id: "deals", title: "Deals", everyDays: 14,
    what: "Official offers from each resort's own offers page. A new one emails Plus members and comes off matching trips.",
    lastUpdated: lastDeal, status: !lastDeal ? "missing" : statusOf(lastDeal, 14, today),
    detail: deals.map((d) => `${d.name.replace(/ (Resort|Disneyland|Disney Resort)$/, "")} ${d.live}`).join(" · ")
      + (none.length ? ` (none live at ${none.length})` : ""),
    where: { label: "Deals", href: "#deals" },
  });

  // Price checks.
  const checks = await one<{ n: string; last: string | null }>(db,
    `select count(*) filter (where checked_on >= $1::date - 90) as n, max(checked_on)::text as last from price_checks`, [today]);
  items.push({
    id: "price-checks", title: "Prices you've checked", everyDays: 30,
    what: "Real prices you found (screenshots or typed). Each one nudges our estimate for that thing.",
    lastUpdated: checks?.last ?? null, status: statusOf(checks?.last ?? null, 30, today),
    detail: `${Number(checks?.n ?? 0)} in the last 90 days`, where: { label: "Prices you've checked", href: "#checks" },
  });

  // Words and lists.
  const notes = await one<{ last: Date | null }>(db, `select max(updated_at) as last from owner_notes`);
  items.push({
    id: "notes", title: "Good to know notes", everyDays: 90,
    what: "Closures, visa rules and booking quirks on each resort's page and in the PDF.",
    lastUpdated: iso(notes?.last), status: notes?.last ? statusOf(iso(notes.last), 90, today) : "due",
    detail: notes?.last ? "Edited in /admin" : "Still the notes the site shipped with", where: { label: "Good to know", href: "#notes" },
  });
  const attr = await one<{ last: Date | null; n: string }>(db, `select max(updated_at) as last, count(*) as n from owner_attractions`);
  items.push({
    id: "attractions", title: "Attractions and lands", everyDays: 180,
    what: "The rides, shows and lands travelers can pick, and each resort's land list.",
    lastUpdated: iso(attr?.last), status: Number(attr?.n ?? 0) ? statusOf(iso(attr?.last), 180, today) : "missing",
    detail: `${Number(attr?.n ?? 0)} row(s) of yours`, where: { label: "Attractions", href: "#attractions" },
  });
  const passes = await one<{ last: Date | null }>(db, `select max(updated_at) as last from owner_settings where key like 'pass.%'`);
  items.push({
    id: "pass-prices", title: "Annual pass prices", everyDays: 365,
    what: "Walt Disney World and Disneyland pass prices, used by \"Is an annual pass worth it?\". Disney raises them about once a year.",
    lastUpdated: iso(passes?.last) ?? "2026-10-08", status: statusOf(iso(passes?.last) ?? "2026-10-08", 365, today),
    detail: passes?.last ? "Your prices" : "The prices the site shipped with (checked 2026-10-08)",
    where: { label: "Rates & settings", href: "#numbers" },
  });

  // Hand-kept data with a review date in the code (crowd bands, price levels).
  for (const d of REVIEWABLE) {
    items.push({
      id: d.id, title: d.title, everyDays: d.everyDays,
      what: d.why.split(". ")[0]!.replace(/\.?$/, "."),
      lastUpdated: d.reviewedOn, status: statusOf(d.reviewedOn, d.everyDays, today), detail: "Kept in the code; Claude updates it from what you bring",
    });
  }

  const order = { missing: 0, due: 1, ok: 2 } as const;
  return items.sort((a, b) => order[a.status] - order[b.status]);
}

