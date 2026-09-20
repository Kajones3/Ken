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
 * measurable rain], January first.
 *
 * PROVENANCE: hand-seeded by Claude and NOT yet regenerated from observations.
 * These are informed figures, sanity-checked against web-search summaries of
 * NOAA 1991-2020 normals where one existed, not fetched — this sandbox's
 * egress proxy blocks every weather source, which was tested rather than
 * assumed. Run the workflow to replace them with real ones; the header below
 * is rewritten with the source and date when you do.
 */
export type ClimateRow = [highF: number, lowF: number, rainDays: number];

/** Where these numbers came from. Rewritten by the generator. */
export const CLIMATE_SOURCE = "hand-seeded by Claude — not yet regenerated from observations";

export const CLIMATE_ROWS: Record<string, ClimateRow[]> = {
  wdw: [[71, 50, 6], [74, 53, 6], [78, 57, 7], [83, 61, 5], [88, 67, 8], [91, 72, 15], [92, 74, 17], [92, 74, 17], [90, 73, 13], [85, 67, 9], [79, 59, 6], [73, 53, 6]],
  dlr: [[68, 48, 6], [68, 49, 6], [71, 51, 5], [74, 54, 3], [76, 58, 2], [80, 61, 1], [85, 65, 0], [86, 66, 1], [84, 64, 1], [79, 59, 2], [73, 52, 3], [68, 47, 5]],
  dlp: [[45, 36, 10], [47, 36, 9], [54, 39, 10], [60, 43, 9], [68, 50, 10], [73, 55, 9], [77, 58, 8], [77, 58, 8], [71, 53, 8], [61, 47, 11], [51, 40, 11], [46, 37, 11]],
  tdr: [[49, 36, 5], [51, 37, 6], [57, 43, 10], [65, 51, 10], [73, 60, 10], [78, 67, 12], [85, 74, 10], [88, 76, 9], [82, 70, 12], [72, 60, 10], [63, 50, 8], [53, 41, 5]],
  shdr: [[47, 34, 9], [50, 36, 9], [57, 42, 12], [67, 51, 11], [76, 60, 11], [81, 68, 13], [89, 76, 11], [88, 76, 10], [81, 69, 9], [73, 60, 7], [63, 49, 7], [52, 38, 7]],
  hkdl: [[65, 56, 6], [66, 57, 9], [70, 61, 11], [76, 68, 12], [82, 75, 15], [86, 79, 19], [88, 80, 18], [88, 79, 17], [86, 78, 15], [82, 73, 8], [75, 66, 6], [68, 59, 5]],
};
