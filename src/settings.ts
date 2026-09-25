/**
 * Owner-editable settings: the numbers this app runs on, changeable without
 * anyone touching code.
 *
 * THE PROBLEM THIS SOLVES. Almost every maintained figure in Parkfare — hotel
 * rates, the IRS mileage rate, park-hopper differentials, parking and
 * transfers — lived in config.ts, so changing one meant editing TypeScript and
 * pushing a commit. That makes the owner dependent on a developer for routine
 * upkeep, which is not a business. These now live in the database and are
 * editable from the site.
 *
 * DEFAULTS STAY IN CODE, AND THAT IS THE LOAD-BEARING PART. Every key below
 * has a default taken from config.ts, and the database only ever *overrides*
 * it. So an empty table, a failed migration or a wiped row degrades to exactly
 * what the app shipped with rather than to zero or undefined. It also means
 * the tests that pin hotel category medians keep testing the shipped values,
 * which is what they are for.
 *
 * ONE REGISTRY, NOT ONE COLUMN PER SETTING. The registry is what lets the
 * admin page render itself — label, group, kind and bounds come from here, so
 * adding an editable number is one entry, not a migration plus a form plus a
 * validator in three files.
 *
 * VALIDATION LIVES HERE TOO, once, so the single-value form and the bulk CSV
 * import cannot disagree about what a legal value is.
 *
 * WHAT THIS STILL DOES NOT SOLVE, stated plainly: the registry is built FROM
 * config.ts, so the owner can change the value of anything that already
 * exists, but adding a new thing — a new resort, a new hotel, a year of IRS
 * rates that isn't on file yet — is still a code change. Editing is solved;
 * creating is not. The IRS year is the one that will bite first, every
 * December, and the owner's nightly job list already warns about it.
 */
import type { Db } from "./db.js";
import { RESORTS, IRS_MILEAGE_RATES } from "./config.js";
import { PASS_PROGRAMS, passPriceKey, DVC_TAKE_HOME_PER_POINT, DVC_TAKE_HOME_KEY } from "./memberships.js";
import { ESTIMATE_LEAN_KEY, DEFAULT_ESTIMATE_LEAN, TYPICAL_TRIM_KEY, DEFAULT_TYPICAL_TRIM } from "./pricing.js";
import {
  THANKSGIVING_PREMIUM_KEY, DEFAULT_THANKSGIVING_PREMIUM_PCT,
  CHRISTMAS_PREMIUM_KEY, DEFAULT_CHRISTMAS_PREMIUM_PCT,
} from "./holidayWindows.js";

export type SettingKind = "money" | "number" | "percent";

export interface SettingDef {
  key: string;
  /** What the owner sees. Sentence case, no trailing colon. */
  label: string;
  /** Groups the admin page renders as sections. */
  group: string;
  kind: SettingKind;
  /** The shipped value. The database overrides this; it never replaces it. */
  default: number;
  min: number;
  max: number;
  /** One line of plain language: what this number does, and what it does not. */
  help: string;
}

const money = (key: string, label: string, group: string, def: number, min: number, max: number, help: string): SettingDef =>
  ({ key, label, group, kind: "money", default: def, min, max, help });

/**
 * Every value the owner can change. Bounds are deliberately wide enough for a
 * real correction and narrow enough to catch a typo — $6,000 a night is not a
 * Disney hotel, it is a misplaced digit, and the point of a bound is to catch
 * the second kind of mistake without arguing about the first.
 */
export const SETTINGS: SettingDef[] = [
  ...RESORTS.flatMap((r) => [
    ...r.hotels.map((h) =>
      money(`hotel.${h.id}.base`, h.name, `Hotel rates — ${r.name}`, h.base, 20, 3000,
        `Typical nightly rate before the seasonal adjustment. ${h.onProperty ? "On property" : "Off property"} · ${h.descriptor}.`)),
    money(`transport.${r.id}.off`, `${r.name} — parking and transfers, off property`,
      "Parking and transfers", r.transport.off, 0, 200,
      "Per day, added to every off-property stay. This is the cost people forget when they assume off property is cheaper."),
    money(`transport.${r.id}.on`, `${r.name} — parking and transfers, on property`,
      "Parking and transfers", r.transport.on, 0, 200,
      "Per day, added to every on-property stay. Usually zero, because Disney transport is included."),
    ...(r.ticket.hopperAdultUsd === undefined ? [] : [
      money(`hopper.${r.id}.adult`, `${r.name} — Park Hopper, adult`, "Park Hopper", r.ticket.hopperAdultUsd, 0, 400,
        "What Park Hopper adds to ONE ticket. Walt Disney World and Disneyland "
        + "publish an add-on that grows with ticket length ($70 for a one-day up to "
        + "$135 at Disneyland's five-day), and the app uses those real figures by "
        + "default. Setting a number here replaces that whole table with your flat "
        + "figure for every trip length — your number is your number. Never scaled "
        + "by season."),
      money(`hopper.${r.id}.child`, `${r.name} — Park Hopper, child`, "Park Hopper", r.ticket.hopperChildUsd ?? 0, 0, 400,
        "The same, for a child ticket. Both US resorts charge a child the same "
        + "hopper as an adult; leaving this alone keeps the published figures."),
    ]),
  ]),
  // Annual passes. Every tier is here because Disney raises them roughly once
  // a year and the owner should never have to wait for a code change to be
  // right about a number a traveller can look up in thirty seconds.
  ...PASS_PROGRAMS.flatMap((prog) => {
    const resort = RESORTS.find((r) => r.id === prog.resortId);
    return prog.tiers.map((t) =>
      money(passPriceKey(prog.resortId, t.id), `${t.label} — per pass, per year`,
        `Annual passes — ${resort?.name ?? prog.resortId}`, t.priceUsd, 100, 5000,
        `${prog.label} price for one person for a year. ${t.eligibility}. Checked by web search, not fetched from Disney.`));
  }),
  money(DVC_TAKE_HOME_KEY, "DVC points rented — take-home per point", "DVC",
    DVC_TAKE_HOME_PER_POINT, 1, 60,
    "What a member RECEIVES per point, not what a renter pays. Brokers paid roughly $18-20 a point when this was last checked. Travellers can type their own figure over it."),
  // Not money and not really a percentage of anything — it picks a point in a
  // range. `percent` is the closest kind the admin page renders, and 0-100
  // reads naturally for "how far up the range".
  {
    key: ESTIMATE_LEAN_KEY,
    label: "Estimated flights — where in the range to show",
    group: "Flight estimates",
    kind: "percent",
    default: DEFAULT_ESTIMATE_LEAN,
    min: 0,
    max: 100,
    help: "0 shows the cheap end of what people actually paid on that route, 50 the middle, "
      + "100 the dear end. Higher is the safer mistake: an estimate that comes in low is the one "
      + "that costs somebody at the checkout. It can only ever pick a number people really paid — "
      + "it cannot push a fare above or below the observed range.",
  },
  {
    key: TYPICAL_TRIM_KEY,
    label: "Typical price — how much of each end to ignore",
    group: "Flight estimates",
    kind: "percent",
    default: DEFAULT_TYPICAL_TRIM,
    min: 0,
    max: 45,
    help: "A month's cheapest days are cheap because nobody wants them (a 4am flight on Halloween) and its dearest days are the week everybody travels. Both ends describe trips people do not take, so this share of each end is dropped before averaging. 0 uses every day, which pulls the quote toward whichever end is more extreme.",
  },
  {
    key: THANKSGIVING_PREMIUM_KEY,
    label: "Flight estimate — Thanksgiving week premium",
    group: "Flight estimates",
    kind: "percent",
    default: DEFAULT_THANKSGIVING_PREMIUM_PCT,
    min: 0,
    max: 200,
    help: "Added to the FLIGHT ESTIMATE only (never a real cached fare) for a date in Thanksgiving week. "
      + "BTS's own data can't measure this — it's reported by quarter, with no month or day at all — so this "
      + "comes from a real, cited third-party fare study instead (Upgraded Points, 2025 season: real Google "
      + "Flights data across the 10 busiest US routes) and is a judgement call about how much to trust a "
      + "national average against any one route, same standing as the IRS mileage rate.",
  },
  {
    key: CHRISTMAS_PREMIUM_KEY,
    label: "Flight estimate — Christmas week premium",
    group: "Flight estimates",
    kind: "percent",
    default: DEFAULT_CHRISTMAS_PREMIUM_PCT,
    min: 0,
    max: 200,
    help: "Added to the FLIGHT ESTIMATE only (never a real cached fare) for a date in the Dec 24-31 window. "
      + "Same sourcing and same caveat as the Thanksgiving premium above.",
  },
  // Two per year, because the IRS sets a January-June rate and a July-December
  // one and has changed it mid-year before. Adding a new year is still a code
  // change (the registry has to know the key exists) — see the note below.
  ...IRS_MILEAGE_RATES.flatMap((r) => ([
    {
      key: `mileage.${r.year}.h1`, label: `IRS mileage rate, ${r.year} — January to June`, group: "Driving",
      kind: "number" as const, default: r.janToJunPerMile, min: 0.1, max: 2,
      help: "Dollars per mile, covering fuel, maintenance, insurance and depreciation. Look up \"IRS standard mileage rates\" at irs.gov.",
    },
    {
      key: `mileage.${r.year}.h2`, label: `IRS mileage rate, ${r.year} — July to December`, group: "Driving",
      kind: "number" as const, default: r.julToDecPerMile, min: 0.1, max: 2,
      help: "Dollars per mile. Often the same as the January figure; the IRS has changed it mid-year when fuel prices moved sharply.",
    },
  ])),
];

export const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export interface SettingValue {
  key: string;
  value: number;
  /** True when a database row is overriding the shipped default. */
  overridden: boolean;
  note: string;
  updatedAt: string | null;
}

/** Why a value was refused, in words the owner can act on. */
export function validateSetting(key: string, raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const def = SETTING_BY_KEY.get(key);
  if (!def) return { ok: false, reason: `"${key}" is not a setting this app has` };
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return { ok: false, reason: `"${raw}" is not a number` };
  if (n < def.min || n > def.max) {
    return { ok: false, reason: `${def.label}: ${n} is outside ${def.min}–${def.max}. That range is there to catch a mistyped digit — if the real value is genuinely outside it, the range needs changing, not the value forcing through.` };
  }
  return { ok: true, value: n };
}

/**
 * Every setting with its current value, overrides applied.
 *
 * Always returns a row for every registered key, override or not, because the
 * admin page has to show what a number IS as well as what it was changed to —
 * a page listing only the overridden ones would hide everything the owner has
 * not yet touched, which is most of them.
 */
export async function loadSettings(db: Db): Promise<SettingValue[]> {
  const { rows } = await db.query<{ key: string; value: unknown; note: string; updated_at: Date }>(
    `select key, value, note, updated_at from owner_settings`,
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return SETTINGS.map((def) => {
    const row = byKey.get(def.key);
    const raw = row ? Number(row.value) : NaN;
    // A stored value that no longer validates (the registry's bounds changed,
    // or the row predates a rename) falls back to the default rather than
    // poisoning a price. Loud in the admin page, silent to travellers.
    const usable = row && Number.isFinite(raw) && raw >= def.min && raw <= def.max;
    return {
      key: def.key,
      value: usable ? raw : def.default,
      overridden: !!usable,
      note: row?.note ?? "",
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

/* ---------------------------------------------------------------------------
 * A process-wide cache, for the code that generates prices synchronously.
 *
 * Wanted reluctantly and kept deliberately small. `pricing.ts` gets the
 * owner's values the clean way — loaded into the PriceBook with everything
 * else the request needs — but the on-property rate generator runs inside a
 * provider, deep in a synchronous loop over every night of a month, and
 * threading a Map through that would mean changing the provider interface for
 * one field.
 *
 * The rules that keep it honest:
 *   - An unprimed cache is not an error. Every read names its own fallback,
 *     which is the shipped default, so forgetting to prime degrades to exactly
 *     what the app ships with rather than to zero or undefined.
 *   - Only short-lived jobs prime it. The refresh and the re-seed each load it
 *     once at the top and exit; nothing long-running reads it, so there is no
 *     way for a stale value to serve a traveller for hours.
 * ------------------------------------------------------------------------ */
let cache: Map<string, number> | null = null;

/** Load the owner's values for the life of this process. */
export async function primeSettingsCache(db: Db): Promise<number> {
  cache = await settingsMap(db);
  return cache.size;
}

/** The owner's value if one is loaded, the caller's own default otherwise. */
export function cachedSetting(key: string, fallback: number): number {
  const v = cache?.get(key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Tests only: forget what was primed, so one test can't leak into the next. */
export function clearSettingsCache(): void {
  cache = null;
}

/** A plain key → number map for code that just wants the value. */
export async function settingsMap(db: Db): Promise<Map<string, number>> {
  return new Map((await loadSettings(db)).map((s) => [s.key, s.value]));
}

/**
 * Write one setting. Returns what changed so the caller can report it.
 *
 * Deleting the row is how you go back to the shipped default — passing null,
 * rather than typing the default in by hand, so "I have not changed this" and
 * "I changed this to the same number" stay different facts.
 */
export async function setSetting(
  db: Db, key: string, raw: unknown | null, opts: { note?: string; by?: string } = {},
): Promise<{ key: string; value: number; overridden: boolean }> {
  const def = SETTING_BY_KEY.get(key);
  if (!def) throw new Error(`"${key}" is not a setting this app has`);
  if (raw === null || raw === "") {
    await db.query(`delete from owner_settings where key = $1`, [key]);
    return { key, value: def.default, overridden: false };
  }
  const check = validateSetting(key, raw);
  if (!check.ok) throw new Error(check.reason);
  await db.query(
    `insert into owner_settings (key, value, note, updated_by, updated_at)
     values ($1, $2::jsonb, $3, $4, now())
     on conflict (key) do update set value = excluded.value, note = excluded.note,
       updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(check.value), opts.note ?? "", opts.by ?? ""],
  );
  return { key, value: check.value, overridden: true };
}

/**
 * Apply a whole spreadsheet at once — all of it or none of it.
 *
 * All-or-nothing on purpose: a half-applied import leaves the owner with no
 * idea which rows landed, and pricing that is a mix of two intended states.
 * Better to reject the file, name every bad row at once so one pass through
 * the spreadsheet fixes them all, and change nothing.
 */
export async function applySettings(
  db: Db, entries: { key: string; value: unknown }[], opts: { note?: string; by?: string } = {},
): Promise<{ ok: true; applied: number; cleared: number } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    const where = `row ${i + 2}`;   // +2: a header line, and humans count from 1
    if (!SETTING_BY_KEY.has(e.key)) { errors.push(`${where}: "${e.key}" is not a setting this app has`); continue; }
    if (seen.has(e.key)) { errors.push(`${where}: "${e.key}" appears more than once`); continue; }
    seen.add(e.key);
    if (e.value === null || e.value === "") continue;   // a blank means "back to the default"
    const check = validateSetting(e.key, e.value);
    if (!check.ok) errors.push(`${where}: ${check.reason}`);
  }
  if (errors.length) return { ok: false, errors };

  let applied = 0, cleared = 0;
  for (const e of entries) {
    const r = await setSetting(db, e.key, e.value === "" ? null : e.value, opts);
    if (r.overridden) applied++; else cleared++;
  }
  return { ok: true, applied, cleared };
}
