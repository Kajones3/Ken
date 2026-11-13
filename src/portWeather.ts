/**
 * Typical weather where a cruise boards and at each stop, for the month it
 * sails (owner, 2026-11-14). Pure; reads the generated portClimateData.ts.
 * A port with no rows is left out, never guessed.
 */
import { HOME_PORTS, PORTS_OF_CALL } from "./cruiseFacts.js";
import { PORT_CLIMATE_ROWS, type PortClimateRow } from "./portClimateData.js";
import { PORT_STORIES } from "./portInfo.js";

export interface PortWeather { name: string; stop: boolean; highF: number; lowF: number; rainDays: number }

export function cruiseWeather(sailDate: string, homePortId: string | null, stopNames: string[],
  rows: Record<string, PortClimateRow[]> = PORT_CLIMATE_ROWS): PortWeather[] {
  const m = Number(sailDate.slice(5, 7)) - 1;
  const out: PortWeather[] = [];
  const add = (id: string, name: string, stop: boolean) => {
    const r = rows[id]?.[m];
    if (r) out.push({ name, stop, highF: r[0], lowF: r[1], rainDays: r[2] });
  };
  const home = HOME_PORTS.find((p) => p.id === homePortId);
  if (home) add(home.id, home.name, false);
  for (const n of stopNames) {
    const p = PORTS_OF_CALL.find((x) => x.name === n);
    if (p) add(p.id, p.name, true);
  }
  return out;
}

/** Where the cruise boards and each stop, with our write-up (portInfo.ts).
 *  A place with no write-up is left out, never filled in by guesswork. */
export function cruisePorts(homePortId: string | null, stopNames: string[]) {
  const out: { name: string; stop: boolean; about: string; ideas: string[] }[] = [];
  const home = HOME_PORTS.find((p) => p.id === homePortId);
  if (home && PORT_STORIES[home.id]) out.push({ name: home.name, stop: false, ...PORT_STORIES[home.id]! });
  for (const n of stopNames) {
    const p = PORTS_OF_CALL.find((x) => x.name === n);
    if (p && PORT_STORIES[p.id]) out.push({ name: p.name, stop: true, ...PORT_STORIES[p.id]! });
  }
  return out;
}
