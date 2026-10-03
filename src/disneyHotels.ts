/**
 * Is this hotel name one of Disney's own hotels at that resort?
 *
 * Google's "hotels near <resort>" search returns Disney's own hotels among
 * the others. Those must not be offered as OFF-property picks (owner,
 * 2026-10-03: "Disney hotels should be out of the off property list"), and
 * their real rates grade our on-property estimates (hotelScoreboard.ts).
 */
import { RESORT_BY_ID } from "./config.js";

/** Words that say nothing about WHICH hotel it is. */
const FILLER = new Set(["disney", "disneys", "s", "resort", "resorts", "hotel", "spa", "the", "and", "at", "a", "walt", "world"]);
/** Place words Google adds in front of a name ("Tokyo DisneySea Hotel MiraCosta"). */
const PLACE = new Set(["tokyo", "disneysea", "disneyland", "paris", "hong", "kong", "shanghai", "orlando", "anaheim", "california", "florida", "lake", "buena", "vista"]);

const tokens = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, "")
    .split(/[^a-z0-9]+/).filter((t) => t && !FILLER.has(t));

/**
 * Which of a resort's on-property Disney hotels a vendor's hotel name is, or
 * null. Strict on purpose: the same words exactly, or ours plus only place
 * words in front. "Copper Creek Villas at Disney's Wilderness Lodge" is NOT
 * Wilderness Lodge, and "Hotel near Disneyland Park" is not the Disneyland
 * Hotel. A miss leaves a Disney hotel ungraded; a false match grades the
 * wrong hotel, which is worse.
 */
export function matchDisneyHotel(resortId: string, vendorName: string): { id: string; name: string } | null {
  const resort = RESORT_BY_ID.get(resortId);
  if (!resort) return null;
  const v = tokens(vendorName);
  for (const h of resort.hotels) {
    if (!h.onProperty) continue;
    // "Coronado Springs · Gran Destino" is the resort, then the tower we price.
    const ours = tokens(h.name.split("·")[0]!);
    if (!ours.length) continue;
    const extra = v.filter((t) => !ours.includes(t));
    if (ours.every((t) => v.includes(t)) && extra.every((t) => PLACE.has(t))) return { id: h.id, name: h.name };
  }
  return null;
}

