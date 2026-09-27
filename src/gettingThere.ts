/**
 * Resolves the "Getting there" preset the trip form offers into a per-resort
 * transport mode. The board prices all six resorts in one request, and a
 * preset can mean different resorts get there differently (e.g. drive to
 * WDW, fly to the other five) — this is the one place that split happens,
 * kept pure and tiny so it's trivially testable on its own.
 */
import { localResortFor, isLocalRoute, RESORT_BY_ID } from "./config.js";

export type GettingThereMode = "fly" | "flyMiles" | "driveWdw" | "driveDlr" | "driveDomestic";

export const GETTING_THERE_MODES: GettingThereMode[] = [
  "fly", "flyMiles", "driveWdw", "driveDlr", "driveDomestic",
];

export function resortTransportMode(
  mode: GettingThereMode,
  resort: { id: string; region: string },
  /** The departure airport. When given, the 100-mile rule is ENFORCED here:
   *  a resort too close to fly to (isLocalRoute — LAX to Disneyland, or an
   *  owner-named pair like JAX to Disney World) is always a drive, whatever
   *  preset is chosen. It used to be only the form's default, so anyone who
   *  had touched "Getting there", or reopened a saved "fly to all" search,
   *  got LAX to Disneyland priced as a flight (owner, 2026-09-27: "That
   *  isn't supposed to happen in our 100 mile radius rule"). */
  origin?: string,
): "fly" | "drive" | "miles" {
  const r = RESORT_BY_ID.get(resort.id);
  if (origin && r && resort.region === "dom" && isLocalRoute(origin, r.iata)) return "drive";
  if (mode === "flyMiles") return "miles";
  if (mode === "driveWdw") return resort.id === "wdw" ? "drive" : "fly";
  if (mode === "driveDlr") return resort.id === "dlr" ? "drive" : "fly";
  if (mode === "driveDomestic") return resort.region === "dom" ? "drive" : "fly";
  return "fly";
}

/**
 * The "Getting there" preset to offer someone departing from this airport,
 * before they touch anything.
 *
 * "Flying to all" is the right default for almost everyone and stays the
 * default for almost everyone. It is wrong for exactly one group: people who
 * already live next to one of the two US resorts. Someone departing LAX is
 * not going to fly to Disneyland, and the board should not make them work
 * that out — it used to show them a blank where the nearest resort's price
 * belonged, which reads as "this app doesn't have data" rather than "you
 * would drive this one".
 *
 * So the local resort switches to its drive preset and the other five keep
 * flying, which is exactly what the existing `driveWdw`/`driveDlr` presets
 * already express — no new mode, no new pricing path.
 *
 * A suggestion, never a lock: the form pre-selects it and says why, and the
 * moment the traveler picks something else themselves it stops second-
 * guessing them. Some people really do fly LAX->SNA on points, or are
 * dropping a car off; the app should not claim to know better than they do.
 */
export function defaultGettingThere(originIata: string): GettingThereMode {
  const local = localResortFor(originIata);
  if (local?.id === "wdw") return "driveWdw";
  if (local?.id === "dlr") return "driveDlr";
  return "fly";
}
