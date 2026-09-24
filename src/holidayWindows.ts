/**
 * Named holiday weeks — for the search form's month-narrowing control, and
 * for the flight estimate's holiday premium. Pure, no I/O, same shape as
 * pricing.ts and crowds.ts.
 *
 * The whole reason this exists rather than a per-resort "exact dates"
 * picker (2026-09-25, the owner's call): "Paris doesn't move during
 * Thanksgiving. That's the point. A week in Paris during Thanksgiving might
 * beat a week in Disneyland in May." One canonical date range is priced
 * identically across all six resorts, and each resort's OWN real season data
 * (seasonality.ts) decides whether that week is actually a premium week for
 * it — Disneyland's real chart says Thanksgiving is a flat, elevated week;
 * Paris's chart says nothing moves. Faking a bump for every resort would
 * erase exactly the comparison this app exists to make.
 *
 * Only December and Thanksgiving are built. Two were deliberately left out,
 * both checked against real data rather than guessed:
 *   - July 4th / Labor Day: Disneyland's own real 2026 daily chart explicitly
 *     says these "barely move the price at all" (see seasonality.ts's `dlr`
 *     comment) — building a window for a premium that isn't real would be
 *     the ERA5 rain-day mistake in another costume.
 *   - Spring break: real, but genuinely resort-shaped rather than one
 *     calendar week — WDW spikes hard for exactly one week then stays
 *     elevated through April, Disneyland's real data barely moves, Paris
 *     ramps differently again. It also spans two calendar months, which the
 *     single-month picker isn't shaped for yet. Left for a follow-up rather
 *     than forcing a bad fit into this one.
 */
import { addDaysISO, iso, monthBounds, type ISODate } from "./dates.js";

export interface HolidayWindow {
  id: string;
  label: string;
  from: ISODate;
  to: ISODate;
}

/** The Nth occurrence of `weekday` (0=Sun..6=Sat) in a given month, 1-based `n`. */
function nthWeekdayOfMonth(year: number, month1: number, weekday: number, n: number): ISODate {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return iso(new Date(Date.UTC(year, month1 - 1, day)));
}

/** US Thanksgiving: the 4th Thursday of November. A real, computed date, not
 *  a fixed MM-DD — unlike Christmas, this one moves every year. */
export function thanksgivingDate(year: number): ISODate {
  return nthWeekdayOfMonth(year, 11, 4, 4);
}

/** The named sub-windows for one `YYYY-MM` month, or [] when this month has
 *  none. `holidayWindowsFor("2026-11")` and `holidayWindowsFor("2026-12")`
 *  are the only non-empty cases today. */
export function holidayWindowsFor(yyyymm: string): HolidayWindow[] {
  const [yearStr, monthStr] = yyyymm.split("-");
  const year = Number(yearStr), month1 = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month1)) return [];

  if (month1 === 12) {
    return [
      { id: "before-christmas", label: "Before Christmas (Dec 1–23)", from: `${yyyymm}-01`, to: `${yyyymm}-23` },
      { id: "around-christmas", label: "Around Christmas (Dec 24–31)", from: `${yyyymm}-24`, to: `${yyyymm}-31` },
    ];
  }
  if (month1 === 11) {
    const t = thanksgivingDate(year);
    const from = addDaysISO(t, -2), to = addDaysISO(t, 4);
    const dd = (d: ISODate) => Number(d.slice(8, 10));
    return [
      { id: "thanksgiving-week", label: `Thanksgiving week (Nov ${dd(from)}–${dd(to)})`, from, to },
    ];
  }
  return [];
}

/** The whole-month bounds a search falls back to when no window (or an
 *  unrecognised one) is selected — same as monthBounds(), named for the
 *  call site's clarity. */
export function wholeMonthWindow(yyyymm: string): { from: ISODate; to: ISODate } {
  const [from, to] = monthBounds(yyyymm);
  return { from, to };
}

/**
 * Which holiday premium (if any) applies to flights on this exact calendar
 * date — independent of how the search got here (whole-month scan or a
 * picked window), because a Dec 26 flight really is pricier either way.
 *
 * Deliberately NOT sourced from Parkfare's own BTS pipeline. BTS DB1B is
 * reported by QUARTER only, with no month or day field at all, so "is
 * Thanksgiving week pricier than an ordinary November day" is a question the
 * app's own flight data structurally cannot answer, however cleverly it's
 * measured — Q4 contains both, indistinguishably. What's used instead is a
 * real, sourced third-party study (Upgraded Points, Nov 2025 season: Google
 * Flights data across the 10 busiest US domestic routes, 40,000+ flights,
 * comparing an early-November control week against the Thanksgiving and
 * Christmas travel windows) — the same standing as the IRS mileage rate or
 * the hopper differentials: a real, cited number, owner-editable because
 * it's a judgement call about how much to trust a national average against
 * any one route, not something this app measured itself.
 * https://upgradedpoints.com/news/best-day-fly-during-holidays/
 */
export interface HolidayFlightPremium {
  settingKey: string;
  defaultPct: number;
  label: string;
}
export const THANKSGIVING_PREMIUM_KEY = "flight.thanksgivingPremiumPct";
export const CHRISTMAS_PREMIUM_KEY = "flight.christmasPremiumPct";
/** +55% one-way, Thanksgiving window vs. an early-November control week. */
export const DEFAULT_THANKSGIVING_PREMIUM_PCT = 55;
/** +58% one-way, Christmas window vs. the same control week. */
export const DEFAULT_CHRISTMAS_PREMIUM_PCT = 58;

export function holidayFlightPremium(date: ISODate): HolidayFlightPremium | null {
  const year = Number(date.slice(0, 4));
  const t = thanksgivingDate(year);
  const twFrom = addDaysISO(t, -2), twTo = addDaysISO(t, 4);
  if (date >= twFrom && date <= twTo) {
    return { settingKey: THANKSGIVING_PREMIUM_KEY, defaultPct: DEFAULT_THANKSGIVING_PREMIUM_PCT, label: "Thanksgiving travel week" };
  }
  if (date >= `${year}-12-24` && date <= `${year}-12-31`) {
    return { settingKey: CHRISTMAS_PREMIUM_KEY, defaultPct: DEFAULT_CHRISTMAS_PREMIUM_PCT, label: "Christmas travel week" };
  }
  return null;
}
