/**
 * The on-property hotel season/day-of-week model.
 *
 * THIS IS THE REAL PRICING PATH, not a mock stand-in — `onProperty.ts` uses it
 * for every on-property nightly rate the site ever shows (Disney publishes no
 * rate API, so these rows are generated, not fetched), and `providers/serpapi.ts`
 * uses it to spread one real bought off-property fare across the rest of its
 * month. An earlier version of this file's docstring said "used only by the
 * mock provider" — that was wrong the whole time; the mock provider (`providers/
 * mock.ts`) is a THIRD caller, not the only one.
 *
 * Calibrated 2026-09-23 from real Disney Vacation Club point charts the owner
 * supplied (Disneyland Hotel / Grand Californian / Pixar Place: full 2026
 * daily; Animal Kingdom Villas: 2027 Sun-Thu/Fri-Sat by period; Tokyo Disney
 * Resort hotels: Jul-Sep 2026 daily; Hong Kong Disneyland Hotel: Apr-Dec 2026
 * daily; Disneyland Paris Hotel New York: Jan-Mar 2027 daily). DVC points move
 * with real guest demand the same way a cash rate does, so the RATIOS in a
 * point chart (weekday vs weekend, cheap month vs peak week) carry over to a
 * dollar rate even though the point-to-dollar conversion itself doesn't.
 *
 * Both curves below are calibrated so a resort's own WEIGHTED-AVERAGE
 * multiplier across a full year is ~1.0. That is load-bearing, not cosmetic:
 * `config.ts`'s hotel `base` figures are the owner's own researched typical
 * rates, and `config.test.ts` pins them. A curve that isn't mean-1.0 would
 * silently inflate or deflate every quoted price away from that researched
 * number the day it shipped, with nothing anywhere reporting it — the same
 * "www trap" shape CLAUDE.md already warns about elsewhere in this project.
 *
 * The old flat 0.86 floor (from the $70/night-Orlando-room bug, see CLAUDE.md
 * "Mistakes made" #2) is gone. It was a defensive guess bounding an unmeasured
 * curve; now that the floor of each resort's own season is a real, measured
 * number (WDW's cheapest real month is 0.75x its own annual average, per the
 * Animal Kingdom Villas chart), reintroducing a flat guessed floor on top of
 * measured data would just be the same backwards-from-real-data mistake again.
 */
import { parseISO, type ISODate } from "./dates.js";

type Window = [string, string, number, string];

/**
 * Season bands, MM-DD to MM-DD, multiplier, and a note on where the number
 * came from. "REAL" means read directly off a supplied DVC chart for that
 * resort. Everything else is either an "override" (a known real-world event —
 * Golden Week, Chinese New Year, French school holidays — estimated from
 * general knowledge because no chart covers it) or "extrapolated" (this
 * resort's own unmeasured months, filled in using Disneyland's measured
 * year-round shape, since Disneyland is the one resort with a complete real
 * daily chart for all twelve months). Overrides and extrapolations are
 * exactly the numbers to correct first if the owner gets a chart that covers
 * them.
 */
const SEASON_BANDS: Record<string, Window[]> = {
  // WDW: from Animal Kingdom Villas' 2027 chart, which splits every one of
  // its 7 real seasonal periods into a Value-room Sun-Thu rate. That is a
  // full, real, year-round seasonal curve — the cleanest evidence in this
  // whole calibration. Its Fri-Sat/Sun-Thu split also directly measures the
  // day-of-week premium per season (see DOW_CURVES below): 1.375x in the
  // cheapest period down to 1.12x in the most expensive, i.e. the weekend
  // premium COMPRESSES as the season gets more expensive (everybody pays a
  // peak-week price regardless of day, so there's less room left for a
  // weekday discount). This file keeps one flat WDW day-of-week curve rather
  // than modeling that compression — a real second-order effect, noted here
  // rather than silently dropped, and a good next refinement.
  wdw: [
    ["09-01","09-30", 0.754, "REAL -- Animal Kingdom Villas chart (cheapest period)"],
    ["01-01","01-31", 0.848, "REAL -- Animal Kingdom Villas chart"],
    ["05-01","05-14", 0.848, "REAL -- Animal Kingdom Villas chart"],
    ["05-15","06-10", 0.848, "REAL -- Animal Kingdom Villas chart"],
    ["12-01","12-23", 0.848, "REAL -- Animal Kingdom Villas chart"],
    ["02-01","02-15", 0.943, "REAL -- Animal Kingdom Villas chart"],
    ["06-11","08-31", 0.943, "REAL -- Animal Kingdom Villas chart (summer)"],
    ["10-01","11-23", 1.037, "REAL -- Animal Kingdom Villas chart"],
    ["11-27","11-30", 1.037, "REAL -- Animal Kingdom Villas chart"],
    ["02-16","03-20", 1.225, "REAL -- Animal Kingdom Villas chart"],
    ["03-29","04-30", 1.225, "REAL -- Animal Kingdom Villas chart"],
    ["11-24","11-26", 1.225, "REAL -- Animal Kingdom Villas chart (Thanksgiving)"],
    ["03-21","03-28", 1.603, "REAL -- Animal Kingdom Villas chart (spring break/Easter peak)"],
    ["12-24","12-31", 1.603, "REAL -- Animal Kingdom Villas chart (Christmas/NYE peak)"],
  ],
  // Disneyland Resort: full 2026 daily points for 3 hotels (Disneyland Hotel,
  // Grand Californian, Pixar Place), averaged. Real Disney value floor and
  // holiday spikes are visible directly in the daily numbers, not inferred:
  // Aug is the cheapest month (summer heat + back-to-school, not a "value"
  // month by the usual assumption); Thanksgiving runs as one flat elevated
  // week (not just the weekend); Christmas/NYE (Dec 22-31) is the single
  // most expensive stretch of the year; July 4th and Labor Day barely move
  // the price at all, unlike the illustrative example in the original ask.
  dlr: [
    ["01-01","01-01", 1.12, "REAL -- New Year's Day, single-day spike"],
    ["01-02","02-12", 0.934, "REAL -- January/early-Feb value lull (cheapest ordinary stretch)"],
    ["02-13","02-16", 1.053, "REAL -- Presidents weekend"],
    ["02-17","03-27", 1.002, "REAL -- late winter"],
    ["03-28","04-12", 1.019, "REAL -- spring break/Easter window"],
    ["04-13","06-30", 1.002, "REAL -- spring/early summer"],
    ["07-01","09-21", 0.968, "REAL -- summer (includes recurring off-peak-weekday floor)"],
    ["09-22","11-21", 1.019, "REAL -- fall/Halloween season"],
    ["11-22","11-28", 1.12, "REAL -- Thanksgiving week (flat, full week)"],
    ["11-29","12-19", 1.019, "REAL -- early December"],
    ["12-20","12-21", 1.12, "REAL -- pre-Christmas"],
    ["12-22","12-31", 1.205, "REAL -- Christmas/NYE peak"],
  ],
  // Tokyo Disney Resort: real daily chart for Jul-Sep 2026 only (Tokyo
  // Disneyland Hotel). Oct-Jun is Disneyland's measured shape rescaled onto
  // Tokyo's own Jul level -- FLAG: Japan's actual calendar is not America's,
  // and three known Japan-specific peaks are estimated from general
  // knowledge rather than measured: Oshogatsu (New Year, Jan 1-3, Japan's
  // biggest domestic travel holiday), Golden Week (Apr 29-May 6, widely
  // considered Japan's single busiest travel week of the year), and Silver
  // Week -- this last one IS real, read straight off the chart (Sep 19-23,
  // 2026's Respect-for-the-Aged-Day long weekend): 79 points against a ~50
  // baseline, a 1.5x spike bigger than anything Disneyland shows all year.
  tdr: [
    ["01-01","01-03", 1.236, "override, NOT measured -- Oshogatsu (Japanese New Year)"],
    ["01-04","01-31", 0.879, "extrapolated from Disneyland's shape"],
    ["02-01","02-28", 0.944, "extrapolated from Disneyland's shape"],
    ["03-01","03-31", 0.972, "extrapolated from Disneyland's shape"],
    ["04-01","04-28", 0.934, "extrapolated from Disneyland's shape"],
    ["04-29","05-06", 1.378, "override, NOT measured -- Golden Week"],
    ["05-07","05-31", 0.913, "extrapolated from Disneyland's shape"],
    ["06-01","06-30", 0.996, "extrapolated from Disneyland's shape"],
    ["07-01","07-31", 0.950, "REAL -- Tokyo Disneyland Hotel chart"],
    ["08-01","08-31", 0.985, "REAL -- Tokyo Disneyland Hotel chart"],
    ["09-01","09-18", 1.051, "REAL -- Tokyo Disneyland Hotel chart"],
    ["09-19","09-23", 1.502, "REAL -- Tokyo Disneyland Hotel chart (Silver Week)"],
    ["09-24","09-30", 1.051, "REAL -- Tokyo Disneyland Hotel chart"],
    ["10-01","10-31", 1.022, "extrapolated from Disneyland's shape"],
    ["11-01","11-30", 0.981, "extrapolated from Disneyland's shape"],
    ["12-01","12-24", 1.067, "extrapolated from Disneyland's shape"],
    ["12-25","12-31", 1.388, "override, NOT measured -- Japanese New Year's Eve/year-end travel"],
  ],
  // Hong Kong Disneyland: real daily chart for Apr-Dec 2026 (Hong Kong
  // Disneyland Hotel) -- note the real shape is its OWN, not a copy of any
  // US resort: HK's cheapest month is September and its real peak is
  // Jul-Aug summer (school holidays across HK/mainland China), the opposite
  // of Disneyland's Aug-is-cheapest finding. Jan-Mar is unmeasured; the one
  // thing that must NOT be guessed away here is Chinese New Year, typically
  // Hong Kong Disneyland's single highest-demand stretch of the year --
  // FLAG: the window below (Feb 1-14) is a placeholder for whichever 10-14
  // days the lunar calendar puts CNY on in a given year; check the actual
  // date before relying on this for a specific trip.
  hkdl: [
    ["01-01","01-31", 0.896, "shoulder, extrapolated"],
    ["02-01","02-14", 1.255, "override, NOT measured -- Chinese New Year, DATE VARIES by lunar calendar"],
    ["02-15","02-28", 0.941, "post-CNY shoulder, extrapolated"],
    ["03-01","03-31", 0.914, "shoulder, extrapolated"],
    ["04-01","04-30", 0.909, "REAL -- Hong Kong Disneyland Hotel chart"],
    ["05-01","05-31", 0.915, "REAL -- Hong Kong Disneyland Hotel chart"],
    ["06-01","06-30", 0.964, "REAL -- Hong Kong Disneyland Hotel chart"],
    ["07-01","07-31", 1.133, "REAL -- Hong Kong Disneyland Hotel chart (summer peak)"],
    ["08-01","08-31", 1.172, "REAL -- Hong Kong Disneyland Hotel chart (summer peak)"],
    ["09-01","09-30", 0.896, "REAL -- Hong Kong Disneyland Hotel chart (cheapest real month)"],
    ["10-01","10-31", 1.009, "REAL -- Hong Kong Disneyland Hotel chart"],
    ["11-01","11-30", 0.974, "REAL -- Hong Kong Disneyland Hotel chart"],
    ["12-01","12-31", 1.119, "REAL -- Hong Kong Disneyland Hotel chart"],
  ],
  // Disneyland Paris: real daily chart for Jan-Mar 2027 (Hotel New York -
  // The Art of Marvel) only. Jan is the cheapest real month; the chart's
  // last week (Mar 26-31) already shows a real ramp into Easter/spring
  // break (61 -> 92 points), widened here using the known French
  // school-holiday calendar. Apr-Dec is unmeasured; Disneyland's shape is
  // rescaled onto Paris's own Jan-Mar level, with three known French-specific
  // events estimated rather than measured: French summer holidays (Jul-Aug,
  // France's biggest annual travel period), Toussaint (the All Saints'
  // school break, mid/late Oct-early Nov), and Christmas.
  dlp: [
    ["01-01","01-31", 0.866, "REAL -- Hotel New York chart (cheapest real month)"],
    ["02-01","02-28", 0.930, "REAL -- Hotel New York chart"],
    ["03-01","03-25", 0.995, "REAL -- Hotel New York chart"],
    ["03-26","04-12", 1.255, "REAL ramp (chart) widened using the French school-holiday calendar"],
    ["04-13","06-30", 0.952, "shoulder, extrapolated from Disneyland's shape"],
    ["07-01","08-31", 1.168, "override, NOT measured -- French summer holidays"],
    ["09-01","10-18", 0.926, "shoulder, extrapolated from Disneyland's shape"],
    ["10-19","11-03", 1.039, "override, NOT measured -- Toussaint school holidays"],
    ["11-04","12-19", 0.866, "shoulder, extrapolated from Disneyland's shape"],
    ["12-20","12-31", 1.342, "override, NOT measured -- Christmas"],
  ],
  // Shanghai Disney Resort has NO chart at all -- it isn't part of Disney
  // Vacation Club's exchange collection, so there is nothing to calibrate
  // from directly. Borrowed wholesale from Hong Kong (same region, and
  // CLAUDE.md already flags both as this app's weakest-confidence resorts)
  // rather than left on a flat multiplier, on the owner's instruction
  // 2026-09-23. Replace the day this resort gets its own real screenshots --
  // the owner has offered to supply Hong Kong pricing screenshots to refine
  // this further, which would refine Shanghai's borrowed curve too.
  shdr: [
    ["01-01","01-31", 0.896, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["02-01","02-14", 1.255, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["02-15","02-28", 0.941, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["03-01","03-31", 0.914, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["04-01","04-30", 0.909, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["05-01","05-31", 0.915, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["06-01","06-30", 0.964, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["07-01","07-31", 1.133, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["08-01","08-31", 1.172, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["09-01","09-30", 0.896, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["10-01","10-31", 1.009, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["11-01","11-30", 0.974, "borrowed from Hong Kong -- no Shanghai DVC data"],
    ["12-01","12-31", 1.119, "borrowed from Hong Kong -- no Shanghai DVC data"],
  ],
};

/**
 * Day-of-week multiplier, [Sun, Mon, Tue, Wed, Thu, Fri, Sat] to match
 * `Date.getUTCDay()`. Two real shapes, not one guessed flat curve:
 *
 * - WDW and Disneyland show a MILD, smooth curve (+-3%) that peaks
 *   Thu-Fri-Sat and dips Mon-Tue -- and Sunday is actually a shade CHEAPER
 *   than the weekday floor, not a weekend premium day. Measured across all
 *   three Disneyland hotels' full 2026 daily charts (n=52 of each weekday).
 * - Tokyo, Hong Kong and Paris show a SHARPER, weekend-concentrated curve:
 *   weekdays sit essentially flat, and the real premium is Friday/Saturday
 *   (Saturday hardest at Tokyo specifically -- Fri sits almost exactly at
 *   the weekday baseline there, all the premium lands on Saturday night).
 *   Each resort's own chart, not a shared guess: Tokyo Jul-Sep, Hong Kong
 *   Apr-Dec, Paris Jan-Mar (n=12-14 of each weekday per resort).
 * - Shanghai has no chart; it borrows Hong Kong's curve, same reasoning as
 *   its season bands above.
 */
const DOW_CURVES: Record<string, number[]> = {
  wdw:  [0.98, 0.97, 0.99, 1.00, 1.01, 1.03, 1.03],
  dlr:  [0.98, 0.97, 0.99, 1.00, 1.01, 1.03, 1.03],
  tdr:  [1.02, 0.98, 0.95, 0.95, 0.95, 0.99, 1.16],
  hkdl: [0.99, 0.98, 0.98, 0.97, 0.97, 1.05, 1.08],
  dlp:  [0.97, 0.96, 0.96, 0.96, 0.96, 1.05, 1.14],
  shdr: [0.99, 0.98, 0.98, 0.97, 0.97, 1.05, 1.08], // borrowed from Hong Kong
};

export function seasonOf(resortId: string, date: ISODate): { m: number; label: string } {
  const md = date.slice(5);
  for (const [a, b, m, label] of SEASON_BANDS[resortId] ?? []) {
    if (md >= a && md <= b) return { m, label };
  }
  return { m: 1, label: "" };
}

export function dowFactor(resortId: string, date: ISODate): number {
  const curve = DOW_CURVES[resortId] ?? DOW_CURVES.wdw!;
  return curve[parseISO(date).getUTCDay()]!;
}

export function hotelSeasonFactor(resortId: string, date: ISODate): number {
  return seasonOf(resortId, date).m * dowFactor(resortId, date);
}

/** Deterministic jitter in [-1, 1] so mock data is stable across runs. */
export function jitter(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
