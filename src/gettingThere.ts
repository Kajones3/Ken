/**
 * Resolves the "Getting there" preset the trip form offers into a per-resort
 * transport mode. The board prices all six resorts in one request, and a
 * preset can mean different resorts get there differently (e.g. drive to
 * WDW, fly to the other five) — this is the one place that split happens,
 * kept pure and tiny so it's trivially testable on its own.
 */
export type GettingThereMode = "fly" | "flyMiles" | "driveWdw" | "driveDlr" | "driveDomestic";

export const GETTING_THERE_MODES: GettingThereMode[] = [
  "fly", "flyMiles", "driveWdw", "driveDlr", "driveDomestic",
];

export function resortTransportMode(
  mode: GettingThereMode,
  resort: { id: string; region: string },
): "fly" | "drive" | "miles" {
  if (mode === "flyMiles") return "miles";
  if (mode === "driveWdw") return resort.id === "wdw" ? "drive" : "fly";
  if (mode === "driveDlr") return resort.id === "dlr" ? "drive" : "fly";
  if (mode === "driveDomestic") return resort.region === "dom" ? "drive" : "fly";
  return "fly";
}
