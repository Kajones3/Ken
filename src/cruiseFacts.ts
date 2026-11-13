/**
 * What we know about Disney Cruise Line's home ports, ships and port
 * adventures, with where each number came from (owner, 2026-11-13: "DO NOT
 * GUESS. I need to know where we have data holes"). Pure data; nothing here
 * fetches anything.
 *
 * A number with no source is NOT filled in: it is null, and cruiseHoles()
 * (cruisePricing.ts) lists it for the owner in /admin. Travelers never see
 * a hole: a sailing that needs a missing number simply doesn't show.
 */

/** Disney's ships, as the owner's screenshot of Disney's fleet names them
 *  (2026-11-13). Details (age, size, what's on board) come later. */
export const CRUISE_SHIPS = [
  "Disney Adventure", "Disney Believe", "Disney Destiny", "Disney Dream", "Disney Fantasy",
  "Disney Magic", "Disney Treasure", "Disney Wish", "Disney Wonder",
] as const;

/** Gratuities, from Disney's own gratuity page (owner, 2026-11-13): "$16.00
 *  USD per night, per stateroom Guest, including infants and children";
 *  Concierge staterooms and suites $27.25. Also kept as /admin settings
 *  (cruise.gratuityPerNight / cruise.gratuityConciergePerNight). */
export const GRATUITY_SOURCE = "Disney Cruise Line gratuity page (owner, 2026-11-13)";

export interface Parking {
  perDayUsd: number;
  /** "official" = the port's own page; "second-hand" = travel sites only. */
  status: "official" | "second-hand";
  source: string;
}

export interface HomePort {
  id: string;
  name: string;
  /** Words that identify this port in a saved title or departure port. */
  match: RegExp;
  /** The airport Disney's transfers run from. */
  airport: string;
  lat: number; lon: number;
  /** Disney's own airport-to-port transfer, per guest, each way (2026). */
  transferUsd: number | null;
  transferMinutes: string;
  /** Disney's latest flight arrival on embarkation day (2027 guidelines). */
  latestArrival: string | null;
  parking: Parking | null;
}

const TRANSFER_SOURCE = "Disney Cruise Line transfer and flight guidelines, 2026-2027 (pasted by the owner, 2026-11-13)";
export { TRANSFER_SOURCE };

export const HOME_PORTS: HomePort[] = [
  { id: "canaveral", name: "Port Canaveral", match: /canaveral/i, airport: "MCO", lat: 28.43, lon: -81.31,
    transferUsd: 45, transferMinutes: "1 hr", latestArrival: "11:30 AM",
    parking: { perDayUsd: 20, status: "official", source: "Port Canaveral parking page: $20 a day plus tax, arrival and departure days included (effective 2025-10-01)" } },
  { id: "fll", name: "Fort Lauderdale (Port Everglades)", match: /lauderdale|everglades/i, airport: "FLL", lat: 26.07, lon: -80.15,
    transferUsd: 29, transferMinutes: "15 min", latestArrival: "12:30 PM",
    parking: { perDayUsd: 25, status: "official", source: "porteverglades.net cruise parking: $25 maximum daily rate" } },
  { id: "galveston", name: "Galveston", match: /galveston/i, airport: "IAH", lat: 29.98, lon: -95.34,
    transferUsd: 45, transferMinutes: "90 min", latestArrival: "10:45 AM",
    // The port prices parking only inside its booking flow; travel sites
    // disagree ($20-35 a day). Left empty on purpose.
    parking: null },
  { id: "sandiego", name: "San Diego", match: /san diego/i, airport: "SAN", lat: 32.73, lon: -117.19,
    transferUsd: 18, transferMinutes: "15 min", latestArrival: "12:15 PM",
    parking: null },
  { id: "vancouver", name: "Vancouver", match: /vancouver/i, airport: "YVR", lat: 49.19, lon: -123.18,
    transferUsd: 28, transferMinutes: "45 min", latestArrival: "11:15 AM",
    parking: null },
  // Disney's other home ports, kept for when they're added. Flights to them
  // aren't bought, so no sailing from them can price yet.
  { id: "barcelona", name: "Barcelona", match: /barcelona/i, airport: "BCN", lat: 41.3, lon: 2.08,
    transferUsd: 35, transferMinutes: "30 min", latestArrival: "12:45 PM", parking: null },
  { id: "civitavecchia", name: "Civitavecchia (Rome)", match: /civitavecchia|rome/i, airport: "FCO", lat: 41.8, lon: 12.25,
    transferUsd: 66, transferMinutes: "1 hr", latestArrival: "12:00 PM", parking: null },
  { id: "sanjuan", name: "San Juan", match: /san juan/i, airport: "SJU", lat: 18.44, lon: -66.0,
    transferUsd: null, transferMinutes: "20 min", latestArrival: null, parking: null },
  { id: "singapore", name: "Singapore", match: /singapore/i, airport: "SIN", lat: 1.36, lon: 103.99,
    transferUsd: 23, transferMinutes: "20-30 min", latestArrival: null, parking: null },
  { id: "southampton", name: "Southampton", match: /southampton/i, airport: "LHR", lat: 51.47, lon: -0.45,
    transferUsd: 75, transferMinutes: "1 hr 30 min", latestArrival: null, parking: null },
];

/** Second-hand parking figures found 2026-11-13, kept for the owner's
 *  holes list, never priced. */
export const PARKING_NOT_USED: Record<string, string> = {
  galveston: "Official rates only inside the port's booking flow; travel sites say $20-35 a day.",
  sandiego: "No parking at the cruise terminal; nearby lots run about $12-25 a day (travel sites, e.g. Park, Shuttle & Fly $24.95).",
  vancouver: "WestPark at Canada Place about C$23 a day booked ahead (travel sites; the port's own page redirected).",
};

export function homePortOf(text: string | null | undefined): HomePort | null {
  if (!text) return null;
  return HOME_PORTS.find((p) => p.match.test(text)) ?? null;
}

/** One of Disney's own port adventure listings: adult (10+) and child (3-9)
 *  prices, as Disney lists them. Undated: Disney's pages don't say when a
 *  price was set. */
export interface Listing { adult: number; child: number | null }
export interface PortOfCall {
  id: string; name: string; match: RegExp;
  /** Disney's private islands: priced at $0 (our choice: the beach is free). */
  privateIsland?: boolean;
  listings: Listing[];
}
export const EXCURSION_SOURCE = "Disney Cruise Line port adventure pages (search results read 2026-11-13; undated)";
export const PORTS_OF_CALL: PortOfCall[] = [
  { id: "castaway", name: "Castaway Cay", match: /castaway/i, privateIsland: true, listings: [] },
  { id: "lookout", name: "Disney Lookout Cay", match: /lookout cay/i, privateIsland: true, listings: [] },
  { id: "nassau", name: "Nassau", match: /nassau/i,
    listings: [{ adult: 239, child: 139 }, { adult: 99, child: 89 }, { adult: 179, child: 179 }, { adult: 209, child: null }] },
  { id: "cozumel", name: "Cozumel", match: /cozumel/i,
    listings: [{ adult: 134, child: 84 }, { adult: 49, child: 39 }, { adult: 139, child: 119 }] },
  { id: "progreso", name: "Progreso", match: /progreso/i,
    listings: [{ adult: 49, child: 34 }, { adult: 134, child: null }, { adult: 159, child: 129 }, { adult: 79, child: 69 }] },
  { id: "ensenada", name: "Ensenada", match: /ensenada/i,
    listings: [{ adult: 99, child: 79 }, { adult: 49, child: null }, { adult: 109, child: 94 }] },
  { id: "cabo", name: "Cabo San Lucas", match: /cabo/i,
    listings: [{ adult: 74, child: 54 }, { adult: 99, child: 74 }, { adult: 169, child: 134 }] },
  { id: "catalina", name: "Catalina Island", match: /catalina/i, listings: [] },
  { id: "skagway", name: "Skagway", match: /skagway/i, listings: [{ adult: 234, child: 124 }, { adult: 324, child: 204 }] },
  { id: "juneau", name: "Juneau", match: /juneau/i, listings: [{ adult: 349, child: 229 }] },
  { id: "ketchikan", name: "Ketchikan", match: /ketchikan/i, listings: [{ adult: 94, child: 54 }] },
];

/** Words in a ports line that are not ports of call (countries, states,
 *  scenic cruising, sea days, the home ports). */
const NOT_A_PORT = /^(the )?(bahamas|mexico|florida|texas|california|canada|alaska|british columbia|usa|united states|lighthouse point|days? at sea|at sea|sea days?|.*glacier.*|.*fjord.*|tracy arm|endicott arm|stephens passage|inside passage|.*scenic.*|western caribbean|eastern caribbean|caribbean|baja|port canaveral|fort lauderdale|galveston|san diego|vancouver|orlando)$/i;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The typical (median) Disney port adventure at one port: adult and child. */
export function excursionAt(p: PortOfCall): { adult: number; child: number } | null {
  if (p.privateIsland) return { adult: 0, child: 0 };
  const adult = median(p.listings.map((l) => l.adult));
  const child = median(p.listings.flatMap((l) => (l.child === null ? [] : [l.child])));
  return adult === null || child === null ? null : { adult, child };
}

/**
 * The ports of call in a saved ports line ("Disney Lookout Cay at Lighthouse
 * Point, Nassau, Bahamas"): the ones we know, and any piece we couldn't
 * place (a hole for the owner, never guessed). Pure.
 */
export function portsOfCall(text: string | null | undefined): { known: PortOfCall[]; unknown: string[] } {
  const known: PortOfCall[] = [], unknown: string[] = [];
  if (!text) return { known, unknown };
  for (const raw of text.split(/,|;|\band\b|\+|·/i)) {
    const piece = raw.replace(/\s+/g, " ").trim();
    if (!piece) continue;
    const hit = PORTS_OF_CALL.find((p) => p.match.test(piece));
    if (hit) { if (!known.includes(hit)) known.push(hit); continue; }
    if (NOT_A_PORT.test(piece)) continue;
    unknown.push(piece);
  }
  return { known, unknown };
}
