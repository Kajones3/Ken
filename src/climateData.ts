/**
 * GENERATED DATA — the numbers only. Do not hand-edit rows here.
 *
 * `npm run climate-normals` (or the "Parkfare climate normals" workflow)
 * rewrites this whole file from real daily observations. Anything you type in
 * it is lost on the next run.
 *
 * WHY THIS IS A SEPARATE FILE FROM config.ts. The season notes next to these
 * numbers in config.ts ("Atlantic hurricane season", "spring break is the
 * busiest week") are editorial judgment, not data — no API produces them, and
 * regenerating the numbers must never wipe them. Splitting generated data from
 * hand-written commentary is what makes the generator safe to re-run.
 *
 * Each row is [average daily high °F, average daily low °F, days with
 * measurable rain (>= 0.04in)], January first.
 */
export type ClimateRow = [highF: number, lowF: number, rainDays: number];

/** Where these numbers came from. Rewritten by the generator. */
export const CLIMATE_SOURCE = "Open-Meteo archive (ERA5), daily observations 2006-2025, generated 2026-09-20";

export const CLIMATE_ROWS: Record<string, ClimateRow[]> = {
  wdw: [[70, 53, 7], [74, 56, 7], [78, 59, 6], [83, 64, 8], [87, 69, 11], [88, 73, 20],
        [89, 75, 23], [89, 76, 23], [86, 74, 19], [82, 68, 10], [76, 61, 6], [73, 57, 6]],
  dlr: [[66, 47, 5], [66, 48, 6], [67, 50, 6], [70, 53, 3], [72, 56, 2], [76, 59, 0],
        [80, 63, 0], [82, 64, 1], [82, 64, 1], [78, 59, 2], [72, 53, 3], [65, 48, 6]],
  dlp: [[44, 34, 12], [47, 35, 11], [53, 37, 12], [59, 42, 9], [65, 48, 12], [72, 55, 10],
        [76, 58, 10], [75, 58, 9], [69, 53, 9], [61, 48, 12], [51, 41, 11], [45, 36, 13]],
  tdr: [[48, 33, 7], [50, 35, 9], [56, 42, 13], [64, 50, 12], [72, 58, 12], [77, 65, 14],
        [85, 73, 13], [87, 75, 12], [80, 69, 14], [70, 59, 13], [62, 49, 11], [52, 38, 9]],
  shdr: [[47, 38, 7], [48, 40, 10], [56, 46, 10], [64, 54, 9], [73, 64, 10], [78, 71, 15],
        [86, 79, 14], [87, 80, 13], [80, 74, 13], [72, 65, 7], [63, 54, 8], [51, 42, 6]],
  hkdl: [[66, 56, 5], [68, 59, 6], [73, 64, 11], [78, 70, 13], [82, 76, 20], [85, 79, 23],
        [86, 80, 22], [86, 80, 23], [85, 78, 18], [82, 73, 8], [76, 67, 6], [68, 58, 4]],
};
