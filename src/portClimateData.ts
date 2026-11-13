/**
 * GENERATED DATA. Do not hand-edit: `npm run port-climate` (or the "Pricing
 * the Magic port weather" workflow) rewrites this whole file.
 *
 * Typical weather at each cruise home port and port of call, by port id
 * (cruiseFacts.ts). Each row is [average daily high °F, average daily low °F,
 * days with measurable rain (>= 0.04in)], January first.
 *
 * Empty until the workflow has run once: a cruise page then shows no weather
 * rather than a guess.
 */
export type PortClimateRow = [highF: number, lowF: number, rainDays: number];

export const PORT_CLIMATE_SOURCE = "not generated yet";

export const PORT_CLIMATE_ROWS: Record<string, PortClimateRow[]> = {
};
