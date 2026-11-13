/**
 * Typical weather at Disney Cruise Line's home ports and ports of call
 * (owner, 2026-11-14: "Why aren't we including ship details and weather").
 * Same source and method as the parks' weather box (climateNormals.ts):
 * Open-Meteo ERA5 daily observations, averaged per calendar month. Writes
 * src/portClimateData.ts. Runs in Actions ("Pricing the Magic port weather"),
 * because Claude's sandbox can't reach Open-Meteo.
 */
import { writeFileSync } from "node:fs";
import { HOME_PORTS, PORTS_OF_CALL } from "../cruiseFacts.js";
import {
  fetchDaily, monthlyNormals, validateYear, LAST_COMPLETE_YEAR, FIRST_PAUSE_MS, RAIN_DAY_INCHES,
  type FetchTuning, type NormalRow,
} from "./climateNormals.js";

/** Every place a cruise card can show weather for: where you board, and each
 *  stop. Home ports use the cruise terminal. */
export function portPlaces(): { id: string; name: string; lat: number; lon: number }[] {
  return [
    ...HOME_PORTS.map((p) => ({ id: p.id, name: p.name, lat: p.terminal.lat, lon: p.terminal.lon })),
    ...PORTS_OF_CALL.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon })),
  ];
}

export function renderPortFile(rows: Record<string, NormalRow[]>, source: string): string {
  const body = Object.entries(rows).map(([id, r]) =>
    `  ${JSON.stringify(id)}: [${r.map((x) => `[${x[0]}, ${x[1]}, ${x[2]}]`).join(", ")}]`).join(",\n");
  return `/**
 * GENERATED DATA. Do not hand-edit: \`npm run port-climate\` (or the "Pricing
 * the Magic port weather" workflow) rewrites this whole file.
 *
 * Typical weather at each cruise home port and port of call, by port id
 * (cruiseFacts.ts). Each row is [average daily high °F, average daily low °F,
 * days with measurable rain (>= ${RAIN_DAY_INCHES}in)], January first.
 */
export type PortClimateRow = [highF: number, lowF: number, rainDays: number];

export const PORT_CLIMATE_SOURCE = ${JSON.stringify(source)};

export const PORT_CLIMATE_ROWS: Record<string, PortClimateRow[]> = {
${body}${body ? "," : ""}
};
`;
}

export async function runPortClimate(opts: { years?: number; outPath?: string; fetchImpl?: typeof fetch; tuning?: FetchTuning } = {}) {
  const years = opts.years ?? Number(process.env.CLIMATE_YEARS ?? 20);
  const fromYear = LAST_COMPLETE_YEAR - years + 1;
  const pace = { pauseMs: FIRST_PAUSE_MS };
  const tuning: FetchTuning = { onWait: (ms, why) => console.log(`\n      waiting ${Math.round(ms / 1000)}s (${why})`), ...opts.tuning };
  const out: Record<string, NormalRow[]> = {};
  const places = portPlaces();
  console.log(`${places.length} ports x ${years} years`);
  for (const p of places) {
    process.stdout.write(`${p.id.padEnd(14)} ${p.name} … `);
    const days = await fetchDaily(p.lat, p.lon, fromYear, LAST_COMPLETE_YEAR, opts.fetchImpl, tuning, pace);
    const check = validateYear(monthlyNormals(days));
    if (!check.ok) throw new Error(`${p.id}: ${check.reason}`);
    out[p.id] = check.rows;
    console.log(`July ${check.rows[6]![0]}/${check.rows[6]![1]}°F`);
  }
  const source = `Open-Meteo archive (ERA5), daily observations ${fromYear}-${LAST_COMPLETE_YEAR}, generated ${new Date().toISOString().slice(0, 10)}`;
  const file = renderPortFile(out, source);
  writeFileSync(opts.outPath ?? new URL("../portClimateData.ts", import.meta.url).pathname, file, "utf8");
  console.log(source);
  return { rows: out, source, file };
}

if (import.meta.url === `file://${process.argv[1]}`) await runPortClimate();
