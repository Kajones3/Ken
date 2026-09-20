/**
 * GENERATED DATA — the numbers only. Do not hand-edit rows here.
 *
 * `npm run climate-normals` (or the "Parkfare climate normals" workflow)
 * rewrites this whole file from real daily observations. Anything you type in
 * it is lost on the next run.
 *
 * WHY THIS IS A SEPARATE FILE FROM config.ts. The season notes next to these
 * numbers in config.ts ("Atlantic hurricane season", "spring break is the
 * busiest week") are editorial judgement, not data — no API produces them, and
 * regenerating the numbers must never wipe them. Splitting generated data from
 * hand-written commentary is what makes the generator safe to re-run.
 *
 * Each row is [average daily high °F, average daily low °F, days with
 * measurable rain (>= 0.01in)], January first.
 */
export type ClimateRow = [highF: number, lowF: number, rainDays: number];

/** Where these numbers came from. Rewritten by the generator. */
export const CLIMATE_SOURCE = "Open-Meteo archive (ERA5), daily observations 2006-2025, generated 2026-09-20";

export const CLIMATE_ROWS: Record<string, ClimateRow[]> = {
  wdw: [[70, 53, 10], [74, 56, 10], [78, 59, 9], [83, 64, 11], [87, 69, 16], [88, 73, 24],
        [89, 75, 27], [89, 76, 27], [86, 74, 24], [82, 68, 15], [76, 61, 10], [73, 57, 9]],
  dlr: [[66, 47, 6], [66, 48, 7], [67, 50, 8], [70, 53, 5], [72, 56, 4], [76, 59, 2],
        [80, 63, 1], [82, 64, 1], [82, 64, 3], [78, 59, 4], [72, 53, 4], [65, 48, 7]],
  dlp: [[44, 34, 16], [47, 35, 14], [53, 37, 15], [59, 42, 13], [65, 48, 16], [72, 55, 15],
        [76, 58, 14], [75, 58, 14], [69, 53, 12], [61, 48, 15], [51, 41, 15], [45, 36, 17]],
  tdr: [[48, 33, 10], [50, 35, 12], [56, 42, 17], [64, 50, 16], [72, 58, 15], [77, 65, 18],
        [85, 73, 19], [87, 75, 17], [80, 69, 19], [70, 59, 17], [62, 49, 14], [52, 38, 11]],
  shdr: [[47, 38, 10], [48, 40, 12], [56, 46, 13], [64, 54, 12], [73, 64, 12], [78, 71, 18],
        [86, 79, 18], [87, 80, 19], [80, 74, 17], [72, 65, 10], [63, 54, 11], [51, 42, 8]],
  hkdl: [[66, 56, 8], [68, 59, 11], [73, 64, 15], [78, 70, 18], [82, 76, 24], [85, 79, 28],
        [86, 80, 27], [86, 80, 27], [85, 78, 22], [82, 73, 12], [76, 67, 10], [68, 58, 6]],
};
