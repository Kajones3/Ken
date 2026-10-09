/**
 * The API. Deliberately dependency-free — node:http and nothing else — because
 * every dependency is a thing that can break at 3am.
 *
 * Every endpoint reads the cache. None of them calls a provider.
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { SETTINGS, loadSettings, setSetting, applySettings, settingsMap } from "./settings.js";
import { reseedForKeys } from "./reseed.js";
import { csvCell, entriesFromCsv, parseCsv } from "./csv.js";
import { addCorrection, listCorrections, deleteCorrection, validateCorrection,
         KNOWN_ORIGINS, KNOWN_DESTINATIONS, DEFAULT_CORRECTION_DAYS } from "./fareCorrections.js";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseEvent, recordEvent, loadStats, eventRateLimiter } from "./siteEvents.js";
import { plannableMonths, PLUS_PASSES, PLUS_PASS_DEFAULT, RESORTS, RESORT_BY_ID, SUGGESTED_PARK_DAYS, suggestedParkDaysKey, ORIGINS, PLUS_ORIGINS, ORIGINS_BY_CITY, ORIGIN_BY_IATA, bucketFor, ATTRACTIONS, isOnlyAt, CLIMATE, CROWDS, CROWD_LABELS, CROWDS_ARE_PLACEHOLDER, CROWDS_REVIEWED, type TierIndex, type FoodStyle, type Stay } from "./config.js";
import { EXCHANGE_RATES, EXCHANGE_AS_OF, EXCHANGE_IS_PLACEHOLDER } from "./exchangeData.js";
import { priceLevelsVsOrlando, vsOrlandoPhrase, PRICE_LEVELS_SOURCE } from "./priceLevels.js";
import { picksFor, setPicks, matchesForResort, matchSummary } from "./attractions.js";
import { crowdFor, crowdFlag, quietestThisMonth, parseCrowdSensitivity } from "./crowds.js";
import {
  effectiveAttractions, effectiveParkLists, listOwnerAttractions, adminLandLists, removeLand, restoreLand, addLand, saveAttraction, deleteOwnerAttraction, sheetRows,
  validateAttraction, sheetWarnings, type AttractionValue,
} from "./ownerAttractions.js";
import { addDaysISO, monthBounds, range, todayISO } from "./dates.js";
import { holidayWindowsFor } from "./holidayWindows.js";
import { quoteMonths } from "./monthView.js";
import { waitTimesSummary, rideSummary, waitTimeRows } from "./waitTimesView.js";
import { setDealEmailsByToken, setDealEmailsForUser, dealEmailsOn } from "./dealEmails.js";
import { getDb, type Db } from "./db.js";
import { loadBook, dateStr } from "./book.js";
import { validateCheck, addChecks, listChecks, deleteCheck, describeKey, CSV_COLUMNS as CHECK_COLUMNS } from "./priceChecks.js";
import { computeFactors, countedChecks, summarizeByLead, cheapestRoomPerStay, CHECKS_USE_KEY, CHECKS_WEIGHT_KEY, DEFAULT_CHECKS_WEIGHT } from "./checkFactors.js";
import { recordSearch, loadRouteDemand } from "./routeDemand.js";
import { loadScoreboard } from "./fareScoreboard.js";
import { loadForecastScores } from "./fareForecasts.js";
import { loadHotelScoreboard } from "./hotelScoreboard.js";
import { loadHotelList, rentalLines } from "./hotelList.js";
import { DEAL_KINDS, listDeals, saveDeal, setDealActive, deleteDeal } from "./adminPromos.js";
import { haversineMiles } from "./geo.js";
import { fetchExactFare, limitsFromEnv, remainingForUser } from "./exactFare.js";
import { cheapestIn, typicalIn, priceTrip, MAX_HOTEL_ROOMS, type Overrides, type TripParams } from "./pricing.js";
import { parsePassHoldings, parseDvcRental, PASS_RESORTS, passPriceKey, DVC_TAKE_HOME_PER_POINT, DVC_TAKE_HOME_KEY } from "./memberships.js";
import { resortTransportMode, GETTING_THERE_MODES, defaultGettingThere, type GettingThereMode } from "./gettingThere.js";
import { pickGeocodeProvider, pickIpLocateProvider } from "./geo/pick.js";
import { cachedGeocode } from "./geo/cache.js";
import {
  currentUser, createSession, sessionTokenFrom, destroySession,
  sessionCookieHeader, clearCookieHeader, isPlus, signUp, signIn, AuthError,
  setHomeAirport, HomeAirportError, MIN_PASSWORD_LENGTH, secureCookies, type SessionUser,
} from "./auth.js";
import {
  sitePassword, isUnlocked, gateOpenPath, gateCookieHeader, passwordMatches, safeNext,
  comingSoonHtml, gateLocked, recordGateFailure, clearGateFailures,
} from "./siteGate.js";
import { pickEmailSender } from "./email/pick.js";
import {
  scopesFor, clientIp as callerIp, checkSigninAllowed, recordSigninFailure, clearSigninFailures,
  lockoutMessage,
} from "./signinThrottle.js";
import { requestReset, lookupReset, consumeReset, RESET_TOKEN_HOURS } from "./passwordReset.js";
import { sendVerification, verifyEmailToken, VERIFY_TOKEN_HOURS } from "./verifyEmail.js";

const db = await getDb();
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = new URL("../public/", import.meta.url);

/** The address goes into a page we render, and an address is user input. */
function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
};

/**
 * Free for everyone — how you get there isn't a Plus feature, just a different
 * way to answer "what does this trip cost". Gas-price *monitoring* (an alert
 * when the price moves after you save a trip) is the actual Plus feature.
 *
 * A "Getting there" preset can mean different resorts get there differently
 * in the *same* six-resort comparison (e.g. drive to WDW, fly to the other
 * five) — resortTransportMode() resolves which, per resort. This builds the
 * two possible param baselines up front; compare()/calendar() pick whichever
 * one applies to a given resort. Both a driving leg and the flying legs can
 * independently have their own rental-car choice, since a mixed preset can
 * have both at once.
 */
function gettingThereParams(q: URLSearchParams): {
  gettingThere: GettingThereMode; flyBase: Partial<TripParams>; driveBase: Partial<TripParams>;
} {
  const raw = q.get("gettingThere");
  const gettingThere = (GETTING_THERE_MODES as string[]).includes(raw ?? "") ? (raw as GettingThereMode) : "fly";

  const flyBase: Partial<TripParams> = {};
  if (gettingThere === "flyMiles") {
    flyBase.transportMode = "miles";
    flyBase.milesPct = clamp(Number(q.get("milesPct") ?? 0), 0, 100);
  } else {
    flyBase.transportMode = "fly";
  }

  const driveBase: Partial<TripParams> = { transportMode: "drive" };
  const label = (q.get("overnightLabel") ?? "").slice(0, 80);
  const nights = clamp(Number(q.get("overnightNights") ?? 0), 0, 10);
  const costPerNight = Number(q.get("overnightCostPerNight") ?? 0);
  driveBase.overnightStop = label && nights > 0 && Number.isFinite(costPerNight) && costPerNight > 0
    ? { label, nights, costPerNightUsd: costPerNight } : null;
  // A geocoded arbitrary starting city (from the search box), never trusted
  // beyond a lat/lon pair — the label is display-only, the number crunching
  // uses only lat/lon, same as any other coordinate in this codebase.
  const lat = Number(q.get("originLat"));
  const lon = Number(q.get("originLon"));
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
    driveBase.originPoint = { label: (q.get("originLabel") ?? "").slice(0, 120), lat, lon };
  }
  // Default (unset) is true — only an explicit "0" turns it off.
  if (q.get("driveWearAndTear") === "0") driveBase.includeWearAndTear = false;

  return { gettingThere, flyBase, driveBase };
}

/** How far a drive may stand in for a route with no flight price at all.
 *  JAX->Disney World (~144 miles) is the case it exists for; 300 covers
 *  every short Florida/California hop without inventing cross-country drives. */
const DRIVE_STAND_IN_MILES = 300;

function paramsFrom(q: URLSearchParams): TripParams {
  const ages = (q.get("childAges") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const nights = clamp(Number(q.get("nights") ?? 6), 1, 30);
  return {
    origin: (q.get("origin") ?? "ATL").toUpperCase().slice(0, 3),
    adults: clamp(Number(q.get("adults") ?? 2), 1, 12),
    childAges: ages.filter((a) => Number.isFinite(a) && a >= 0 && a <= 17).slice(0, 8),
    nights,
    // Blank or "auto" = each resort's own suggestion (SUGGESTED_PARK_DAYS).
    parkDays: Number.isFinite(Number(q.get("parkDays"))) && Number(q.get("parkDays")) >= 1
      ? clamp(Number(q.get("parkDays")), 1, nights + 1) : undefined,
    stay: (["on", "off", "none"].includes(q.get("stay") ?? "") ? q.get("stay") : "on") as Stay,
    tier: clamp(Number(q.get("tier") ?? 1), 0, 2) as TierIndex,
    food: (["grocery", "someQs", "qs", "mix", "ts", "someCharacter", "character", "plan"].includes(q.get("food") ?? "")
      ? q.get("food") : "mix") as FoodStyle,
    hopper: q.get("hopper") === "1" || q.get("hopper") === "true",
    hotelRooms: clamp(Number(q.get("rooms") ?? 1), 1, MAX_HOTEL_ROOMS),
    seniors: clamp(Number(q.get("seniors") ?? 0), 0, 12),
    cars: clamp(Number(q.get("cars") ?? 1), 0, 4),
    freeParking: q.get("freeParking") === "1",
    transportMode: "fly",
    // Plus since 2026-10-08 (owner: "move all the budget stuff to plus");
    // budgetFor() below drops these for anyone without Plus. `passes` is sent as
    // resort:tier:count triples so one query param carries a whole party's
    // holdings across the six-resort board.
    annualPasses: parsePassHoldings(
      (q.get("passes") ?? "").split(",").filter(Boolean).map((chunk) => {
        const [resortId, tierId, count] = chunk.split(":");
        return { resortId, tierId, count };
      })),
    dvcRental: parseDvcRental(q.get("dvcPoints"), q.get("dvcPerPoint")),
  };
}
function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
}

/**
 * "Your budget" is Plus (owner, 2026-10-08): annual passes and DVC points
 * you'd rent out. A personal discount stays FREE (owner, same day: "Free
 * visitors should still be able to enter their own numbers and
 * discounts"). Resolved from the session, never from
 * the client, so a free request that sends them is simply priced without
 * them, the same way it would be if the boxes were empty.
 */
function budgetFor(user: SessionUser | null, params: TripParams, overrides: Overrides): void {
  if (user && isPlus(user.plusUntil)) return;
  params.annualPasses = [];
  params.dvcRental = null;
}

/**
 * Which departure airport a request actually gets.
 *
 * Launch decision 2026-09-24: every airport in `ALL_ORIGINS` (the 19 big
 * metros plus the 22 smaller ones once reserved for Plus) is available to
 * everyone — see CLAUDE.md's Free/Plus split. `ORIGINS`/`PLUS_ORIGINS` stay
 * two separate lists in config.ts because the nightly refresh still only
 * pre-caches the first 19; a smaller airport still prices, off a BTS-derived
 * estimate rather than a real per-date lookup, exactly like any other
 * unswept domestic route.
 */
function resolveOrigin(requested: string): { origin: string } {
  const iata = (requested || "ATL").toUpperCase().slice(0, 3);
  return { origin: ORIGIN_BY_IATA.has(iata) ? iata : "ATL" };
}
function overridesFrom(q: URLSearchParams): Overrides {
  try {
    const raw = q.get("overrides");
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch { return {}; }
}

/**
 * Resolves a requested arrival airport against ONE specific resort's own
 * list (its primary iata plus altArrivalAirports) — never a bare string
 * trusted on its own. An unrecognized code (e.g. a WDW request carrying
 * Hong Kong's HKG) silently falls back to that resort's primary rather than
 * pricing against an unrelated airport.
 */
function resolveDestination(resort: { iata: string; altArrivalAirports: { iata: string }[] }, requested: string | null): string {
  if (!requested) return resort.iata;
  const code = requested.toUpperCase().slice(0, 3);
  if (code === resort.iata || resort.altArrivalAirports.some((a) => a.iata === code)) return code;
  return resort.iata;
}

/** Per-resort arrival-airport picks: {resortId: iata}, resolved against that resort's own list. */
function destinationsFrom(q: URLSearchParams): Record<string, string> {
  try {
    const raw = q.get("destinations");
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

/** x-forwarded-for first, since Render (and any reverse proxy) puts the real
 *  client IP there — req.socket.remoteAddress alone would just be the proxy.
 *  Delegates to signinThrottle's version so the "take the FIRST entry" rule
 *  has one home and one set of tests; the sign-in lockout depends on it not
 *  being something a client can rotate at will. */
/** One shared brake on the anonymous counter; see eventRateLimiter. */
const allowEvent = eventRateLimiter();

function clientIp(req: IncomingMessage): string {
  return callerIp(req.headers, req.socket.remoteAddress) ?? "";
}

async function readBody(req: IncomingMessage): Promise<any> {
  const raw = await new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/**
 * A urlencoded form body, for the one page in this app that is a real HTML
 * form rather than a fetch(): the password-reset page, which has to work in a
 * browser opened straight from an email client with no JavaScript assumed.
 */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

async function compare(q: URLSearchParams, user: SessionUser | null) {
  // Launch decision 2026-09-24: the only Plus feature is the shareable PDF.
  // Nothing in this function gates behavior on plan any more — a signed-in
  // user's own account (email, plan) is what /api/session reports, not this
  // endpoint. See CLAUDE.md's Free/Plus split for what that superseded.
  const params = paramsFrom(q);
  const { gettingThere, flyBase, driveBase } = gettingThereParams(q);
  const overrides = overridesFrom(q);
  budgetFor(user, params, overrides);
  const month = q.get("month") ?? todayISO().slice(0, 7);
  // A named holiday window (2026-09-25) narrows the scan to a real week
  // within the month instead of the whole thing — resolved server-side from
  // just an id, the same rule a curated promo's effect follows: the client
  // picks which one, the actual dates never come from it. One canonical
  // range, priced identically at all six resorts — the owner's call: "Paris
  // doesn't move during Thanksgiving. That's the point." Each resort's own
  // real season data decides whether the week is actually pricier for it,
  // rather than every resort being faked into agreeing that it is.
  const windowId = q.get("window");
  const holidayWindow = windowId ? holidayWindowsFor(month).find((w) => w.id === windowId) : undefined;
  const [from, to] = holidayWindow ? [holidayWindow.from, holidayWindow.to] : monthBounds(month);
  // An explicit date prices exactly that day instead of scanning the month for
  // the cheapest one — how a calendar-cell click asks for that date's full
  // breakdown, and how a traveler pins real travel dates instead of a month.
  const explicitDate = q.get("date");
  const originPick = resolveOrigin(params.origin);
  params.origin = originPick.origin;
  // Per-resort arrival-airport picks — only ever affects the resort they're
  // paired with (resolveDestination re-validates against that resort's own
  // list), so picking an alternate for one resort can't leak into another's.
  const destinationReqs = destinationsFrom(q);
  const destinationByResort = new Map(RESORTS.map((r) => [r.id, resolveDestination(r, destinationReqs[r.id] ?? null)]));
  const book = await loadBook(db, {
    origin: params.origin,
    destinations: [...destinationByResort.values()],
    resortIds: RESORTS.map((r) => r.id),
    from: explicitDate ?? from, to: addDaysISO(explicitDate ?? to, params.nights + 1),
    tripLength: bucketFor(params.nights),
  });
  const dates = explicitDate ? [explicitDate] : range(from, to);
  // Log what was asked for, so tonight's paid real-fare lookups go to the
  // routes people actually search. Fire-and-forget: recordSearch swallows
  // its own errors, and nothing below reads the result.
  const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  const byOwner = !!user && !!ownerEmail && user.email.trim().toLowerCase() === ownerEmail;
  // The free sample PDF (sample=1) is our own fixed scenario, not a person
  // asking about a route, so it must not steer tonight's paid lookups.
  if (q.get("sample") !== "1") {
    void recordSearch(db, params.origin, [...destinationByResort.values()], month, !byOwner);
  }

  // A signed-in traveler's attraction picks, read from their own row —
  // never from the query string, so the client can say which account it is
  // (via the cookie) but never what it has picked. A signed-out request gets
  // an empty list, so every resort's `attractions` comes back absent and the
  // board shows nothing rather than a teaser.
  const picks = user ? await picksFor(db, user.id) : [];
  // The owner's list overlaid on the shipped one, loaded once for the whole
  // board rather than per resort. Skipped entirely when nobody has picked
  // anything, since the matching never runs then and this would be a query
  // spent to answer a question nothing asks.
  const catalog = picks.length ? await effectiveAttractions(db) : [];

  // How much this traveler said crowds matter. Free, and read straight from
  // the query string — unlike promos or attraction picks there is nothing to
  // entitle here: it changes what the board SAYS, never what it charges or
  // what order it is in.
  const crowdCare = parseCrowdSensitivity(q.get("crowdCare"));
  // Free, and read straight from the query string — like crowdCare it changes
  // which day is described, never what anything costs.
  const priceBasis: "typical" | "cheapest" = q.get("basis") === "cheapest" ? "cheapest" : "typical";
  // The month actually being priced drives the crowd lookup. An explicit date
  // wins over the month picker, the same rule the weather box follows, so a
  // Plus trip pinned to real dates is not told about the wrong month.
  const crowdMonth = Number((explicitDate ?? `${month}-01`).slice(5, 7));

  const results = RESORTS.map((resort) => {
    const iata = destinationByResort.get(resort.id)!;
    // A "Getting there" preset can send different resorts down different
    // legs in this same request (e.g. drive to WDW, fly to the rest) —
    // resortTransportMode() decides which baseline this resort gets.
    const mode = resortTransportMode(gettingThere, resort, params.origin);
    // Too close to fly, whatever the preset said (the 100-mile rule).
    const drivenBecauseClose = mode === "drive" && resortTransportMode(gettingThere, resort) !== "drive";
    const modeParams = mode === "drive" ? driveBase : flyBase;
    const resortParams = { ...params, ...modeParams, destination: iata };
    // The day worth QUOTING, not the luckiest day in the month. `cheapest` is
    // still computed and still shown — see typicalIn's header for why the
    // floor stays visible instead of being hidden behind a better headline.
    let { typical, cheapest, spread, skipped } = typicalIn(book, resort, resortParams, overrides, dates);
    /* No flight price at all for a US resort — JAX->MCO is the owner's case
     * (2026-09-25): too short a hop for the government fare survey to have a
     * baseline, and not yet bought by the nightly job. Rather than a blank
     * row, price the same trip as a DRIVE from that airport's city, and say
     * so. This is a stand-in, not a decision: the search was recorded above,
     * so tonight's paid lookup can buy the real fare, and from then on the
     * flight prices normally and this branch never runs. */
    let droveInstead = false;
    // Only a short hop: a 2,000-mile "drive" standing in for a missing
    // cross-country fare would be a wrong number presented as a real one.
    const from = ORIGIN_BY_IATA.get(params.origin);
    const shortHop = !!from && haversineMiles(from.lat, from.lon, resort.lat, resort.lon) <= DRIVE_STAND_IN_MILES;
    if (!typical && mode !== "drive" && resort.region === "dom" && shortHop
        && skipped.some((r) => /no cached fare/.test(r))) {
      const asDrive = typicalIn(book, resort, { ...params, ...driveBase, destination: iata }, overrides, dates);
      if (asDrive.typical) {
        ({ typical, cheapest, spread, skipped } = asDrive);
        droveInstead = true;
      }
    }
    // Which day the traveler asked to be quoted. "typical" is the default and
    // the honest answer; "cheapest" is the old behavior, offered deliberately
    // because somebody with flexible dates is asking a real and different
    // question — what is the best this month can do — and answering it is not
    // the same as quoting it at somebody who cannot move their dates.
    //
    // It applies to ALL SIX resorts, never one. A board that quoted one
    // resort's best day against another's typical day would not be comparing
    // anything, which is the one thing this app exists to do.
    const best = priceBasis === "cheapest" ? cheapest : typical;
    // The real priced day, when there is one, drives the crowd lookup —
    // finer than crowdMonth alone for resorts whose chart is itself
    // period-banded rather than monthly (see CrowdYear.windows). Falls back
    // to the month-only lookup for a resort typicalIn couldn't price at all.
    const crowdMonthForRow = best ? Number(best.start.slice(5, 7)) : crowdMonth;
    const crowdDay = best ? Number(best.start.slice(8, 10)) : undefined;
    // Deliberately attached to the row and NOT used for ordering. The board
    // stays sorted by price — this is the app's one job — and the match is
    // context for what a cheaper total would cost you in attractions.
    const m = picks.length ? matchesForResort(resort.id, picks, catalog) : null;
    const attractions = m
      ? { ...m, summary: matchSummary(m, picks.length) }
      : undefined;
    // Same standing as the attraction match: attached to the row, never used
    // for ordering. "The cheapest week is also the busiest" is a trade-off a
    // traveler should make knowingly; quietly reordering the board because
    // we guessed they would mind is the app deciding for them.
    const crowd = crowdFor(resort.id, crowdMonthForRow, crowdDay) ?? undefined;
    const crowdWarning = crowdFlag(resort.id, crowdMonthForRow, crowdCare, crowdDay) ?? undefined;
    return best
      ? { resortId: resort.id, name: resort.name, iata, ok: true as const, price: best, attractions, crowd, crowdWarning,
          noFlightsYet: droveInstead ? `No flight prices yet for ${params.origin}→${iata} — priced as a drive for now` : undefined,
          drivenBecauseClose: drivenBecauseClose
            ? `${params.origin} is within driving distance of ${resort.name}, so it's priced as a drive, not a flight`
            : undefined,
          /** What the rest of the month looks like around the quoted day, so
           *  the card can say "as low as $X on the 31st" without a second
           *  request. Absent on an exact-date search: one day has no spread,
           *  and printing a range built from a single number would invent one. */
          spread: explicitDate ? undefined : spread ?? undefined,
          cheapest: explicitDate || !cheapest || cheapest.total === best.total ? undefined : { total: cheapest.total },
          priceBasis }
      : { resortId: resort.id, name: resort.name, iata, ok: false as const, reason: skipped[0] ?? "no data", attractions, crowd, crowdWarning };
  }).sort((a, b) => (a.ok ? a.price.total : Infinity) - (b.ok ? b.price.total : Infinity));

  return {
    month, pricesAsOf: book.oldestFetchedAt,
    params: { ...params, gettingThere },
    exactDate: explicitDate ?? undefined,
    // Which named holiday window (if any) actually narrowed the scan — echoed
    // back so the client can label the board honestly and a saved trip can
    // reconstruct the same range later without re-sending raw dates.
    window: holidayWindow?.id,
    windowLabel: holidayWindow?.label,
    /** How many picks the matches above were measured against, so the UI can
     *  say "3 of your 5" without a second request. */
    attractionPicks: picks.length,
    /** The six resorts ranked quietest-first for the month being priced.
     *  This is the Thanksgiving case: the domestic parks are at peak and an
     *  overseas park may be a fine time to go, and until now nothing in the
     *  app could say so. A comparison, not a recommendation — the board it
     *  sits beside stays in price order. */
    crowdRanking: crowdCare === "none" ? undefined : quietestThisMonth(RESORTS.map((r) => r.id), crowdMonth),
    crowdCare,
    priceBasis,
    results,
  };
}

async function calendar(q: URLSearchParams, user: SessionUser | null) {
  const from0 = q.get("from") ?? addDaysISO(todayISO(), 1);
  const to0 = q.get("to") ?? addDaysISO(from0, 364);
  // The trip price calendar — every arrival date's whole-trip total — is a
  // Plus feature (owner's call, 2026-09-25: it is the easy way to "monitor" a
  // trip, and nobody else prices flights+hotel+tickets+food per day). A
  // single-day read stays free: that is how the hotel card's "every category,
  // same N nights" comparison prices one date, and it reveals nothing the
  // board did not already show. Resolved from the session, never the client.
  if (from0 !== to0 && !(user && isPlus(user.plusUntil))) return { error: "plus_required" as const };
  const params = paramsFrom(q);
  const { gettingThere, flyBase, driveBase } = gettingThereParams(q);
  const overrides = overridesFrom(q);
  budgetFor(user, params, overrides);
  const resort = RESORT_BY_ID.get(q.get("resort") ?? "wdw");
  if (!resort) return { error: "unknown resort" };
  const mode = resortTransportMode(gettingThere, resort, params.origin);
  Object.assign(params, mode === "drive" ? driveBase : flyBase);
  params.destination = resolveDestination(resort, q.get("destination"));
  const from = from0, to = to0;
  const book = await loadBook(db, {
    origin: params.origin, destinations: [params.destination], resortIds: [resort.id],
    from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
  });
  // hotelTier only carried for a single-day request (from === to) — that is
  // the exact shape hotelAtTier() sends for the "every category, same
  // N nights" comparison, and the only caller that needs to know whether the
  // tier it asked for actually resolved to a different one. Adding it to
  // every day of a normal 365-day calendar fetch would be dead weight nobody
  // reads.
  const singleDay = from === to;
  const days = range(from, to).map((d) => {
    const r = priceTrip(book, resort, params, overrides, d);
    if (!r.ok) return { date: d, total: null };
    return {
      date: d, total: Math.round(r.price.total),
      ...(singleDay ? { hotelTier: r.price.hotelTier } : {}),
    };
  });
  return { resortId: resort.id, destination: params.destination, pricesAsOf: book.oldestFetchedAt, days };
}

/**
 * "Best months to go" (Plus, owner 2026-10-08): one resort's typical
 * whole-trip total for every plannable month, priced the way the board
 * prices a month. Replaced the day-by-day calendar, whose per-day dollar
 * figures claimed more precision than quarterly flight data can back (see
 * monthView.ts). Plus is resolved from the session, never the client.
 */
async function months(q: URLSearchParams, user: SessionUser | null) {
  if (!(user && isPlus(user.plusUntil))) return { error: "plus_required" as const };
  const params = paramsFrom(q);
  params.origin = resolveOrigin(params.origin).origin;
  const { gettingThere, flyBase, driveBase } = gettingThereParams(q);
  const overrides = overridesFrom(q);
  budgetFor(user, params, overrides);
  const resort = RESORT_BY_ID.get(q.get("resort") ?? "wdw");
  if (!resort) return { error: "unknown resort" };
  const mode = resortTransportMode(gettingThere, resort, params.origin);
  const destination = resolveDestination(resort, q.get("destination"));
  const trip = { ...params, ...(mode === "drive" ? driveBase : flyBase), destination };
  const list = plannableMonths(todayISO());
  const from = monthBounds(list[0]!)[0];
  const to = monthBounds(list[list.length - 1]!)[1];
  const book = await loadBook(db, {
    origin: params.origin, destinations: [destination], resortIds: [resort.id],
    from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
  });
  // The board's stand-in for a short US hop with no flight price yet.
  const home = ORIGIN_BY_IATA.get(params.origin);
  const shortHop = !!home && haversineMiles(home.lat, home.lon, resort.lat, resort.lon) <= DRIVE_STAND_IN_MILES;
  const fallback = mode !== "drive" && resort.region === "dom" && shortHop
    ? { ...params, ...driveBase, destination } : undefined;
  return {
    resortId: resort.id, destination, pricesAsOf: book.oldestFetchedAt,
    months: quoteMonths(book, resort, trip, overrides, list, fallback,
      q.get("basis") === "cheapest" ? "cheapest" : "typical"),
  };
}

/**
 * Public and free — browsing what Plus would unlock is exactly the "let
 * friends see what's behind the paywall" surface. Applying one to move a
 * number (via an override's promoId) is the Plus part, gated elsewhere.
 */
async function listPromos(q: URLSearchParams) {
  const resortId = q.get("resortId");
  const on = q.get("on") ?? todayISO();
  const params: unknown[] = [on, on];
  let where = "active and starts_on <= $1 and ends_on >= $2";
  if (resortId) { where += " and (resort_id = $3 or resort_id is null)"; params.push(resortId); }
  const { rows } = await db.query(
    `select id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, historical, source_note, min_nights, conditions
       from promos where ${where} order by starts_on`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, resortId: r.resort_id ?? null, label: r.label,
    effectKind: r.effect_kind, effectValue: Number(r.effect_value),
    startsOn: dateStr(r.starts_on), endsOn: dateStr(r.ends_on),
    historical: Boolean(r.historical), sourceNote: r.source_note ?? "",
    minNights: r.min_nights === null || r.min_nights === undefined ? null : Number(r.min_nights),
    conditions: r.conditions ?? "",
  }));
}

/** Origins as the trip form needs them: the airport, plus which "Getting
 *  there" preset suits someone departing from it (see gettingThere.ts). */
function withSuggestedMode(origins: typeof ORIGINS) {
  return origins.map((o) => ({ ...o, suggestedGettingThere: defaultGettingThere(o.iata) }));
}


/**
 * Is this request the owner?
 *
 * One account, named by OWNER_EMAIL, resolved from the session cookie against
 * the database — never from anything the client sends, the same rule Plus
 * follows. There is no owner ROLE and deliberately so: a role column is a
 * thing that can be set, and the only person who should be able to change
 * every price in the app is the person who holds the environment variable.
 *
 * With OWNER_EMAIL unset, nobody is the owner and the admin page is simply
 * closed. That is the safe direction to fail — the alternative, "no owner
 * configured so let anyone in", would open every rate in the app to the
 * internet the moment a deploy forgot one variable.
 *
 * It also requires a verified email, because an unverified address is one
 * nobody has proved they hold, and this is the account that can change what
 * every traveler is quoted.
 */
async function ownerOf(db: Db, req: IncomingMessage) {
  const owner = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  if (!owner) return null;
  const user = await currentUser(db, req);
  if (!user || user.email.trim().toLowerCase() !== owner) return null;
  if (!user.emailVerified) return null;
  return user;
}

/**
 * Everything the price-checks section of /admin shows: every row, what the
 * checks are doing to estimates right now, and how far off we run by how far
 * ahead a price was checked.
 */
async function checksReport() {
  const checks = await listChecks(db);
  const settings = await settingsMap(db);
  const factors = computeFactors(await countedChecks(db), {
    priorWeight: settings.get(CHECKS_WEIGHT_KEY) ?? DEFAULT_CHECKS_WEIGHT,
    hotelBase: (id) => settings.get(`hotel.${id}.base`)
      ?? RESORTS.flatMap((r) => r.hotels).find((h) => h.id === id)?.base,
  });
  return {
    checks,
    applying: (settings.get(CHECKS_USE_KEY) ?? 1) >= 1,
    priorWeight: settings.get(CHECKS_WEIGHT_KEY) ?? DEFAULT_CHECKS_WEIGHT,
    factors: [...factors.entries()].map(([key, f]) => {
      const [category, ...rest] = key.split("|");
      return { key, category, label: describeKey(category!, rest.join("|")), ...f,
               pct: Math.round((f.factor - 1) * 100) };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    // Counted rows only, one per hotel stay at its cheapest room — the same
    // collapse the nudge uses, or a family room at twice the price would read
    // as "hotels run double".
    byLead: summarizeByLead(cheapestRoomPerStay(checks.filter((c) => !c.notCounted))),
    columns: CHECK_COLUMNS,
    resorts: RESORTS.map((r) => ({ id: r.id, name: r.name, currency: r.currency })),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code: number, body: unknown, opts: { cache?: string; headers?: Record<string, string> } = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": opts.cache ?? "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  const withCookie = (setCookie: string) => ({ headers: { "set-cookie": setCookie } });
  // The verification link is clicked from an inbox, so it has to answer with
  // a page a human can read rather than JSON. `send` always stringifies.
  const sendHtml = (code: number, html: string) => {
    res.writeHead(code, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
    res.end(html);
  };
  try {
    // The site-wide password (siteGate.ts). Checked before anything else so
    // no page, file or API answer gets out to a visitor without it. Off
    // entirely when SITE_PASSWORD is unset.
    const gatePw = sitePassword();
    if (gatePw) {
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        return res.end("User-agent: *\nDisallow: /\n");
      }
      if (url.pathname === "/site-unlock" && req.method === "POST") {
        const form = await readForm(req);
        const ip = clientIp(req);
        if (gateLocked(ip)) {
          return sendHtml(429, comingSoonHtml({ next: form.next, error: "Too many tries. Wait 15 minutes and try again." }));
        }
        if (!passwordMatches(String(form.password ?? ""), gatePw)) {
          recordGateFailure(ip);
          return sendHtml(401, comingSoonHtml({ next: form.next, error: "That isn't the password." }));
        }
        clearGateFailures(ip);
        res.writeHead(303, {
          location: safeNext(form.next),
          "set-cookie": gateCookieHeader(gatePw, secureCookies()),
          "cache-control": "no-store",
        });
        return res.end();
      }
      if (!gateOpenPath(url.pathname) && !isUnlocked(req.headers.cookie, gatePw)) {
        res.setHeader("x-robots-tag", "noindex, nofollow");
        if (url.pathname.startsWith("/api/")) return send(401, { error: "site_locked" });
        return sendHtml(200, comingSoonHtml({ next: url.pathname + url.search }));
      }
      res.setHeader("x-robots-tag", "noindex, nofollow");
    }
    if (url.pathname === "/" || url.pathname === "/prototype.html") {
      const file = await readFile(new URL("prototype.html", PUBLIC_DIR));
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(file);
    }
    if (url.pathname.startsWith("/public/")) {
      const name = url.pathname.slice("/public/".length);
      const file = await readFile(new URL(name, PUBLIC_DIR));
      res.writeHead(200, {
        "content-type": MIME[extname(name)] ?? "application/octet-stream",
        // The illustration (tools/brand/gen.mjs) changes rarely; a day saves
        // re-sending ~120 KB of map on every visit.
        ...(name.startsWith("brand/") ? { "cache-control": "public, max-age=86400" } : {}),
      });
      return res.end(file);
    }
    if (url.pathname === "/health") {
      const { rows } = await db.query(
        `select max(finished_at) as last_refresh,
                (select count(*) from flight_prices) as flights,
                (select count(*) from hotel_rates) as hotels
           from fetch_runs where job = 'refresh' and errors = 0`);
      return send(200, { ok: true, db: db.kind, ...rows[0] }, { cache: "no-store" });
    }
    // Each origin carries the "Getting there" preset to offer someone
    // departing from it, resolved HERE rather than in the browser. The rule
    // is a distance measured against resort coordinates, and a second copy
    // of it in prototype.html would be free to drift from the one the
    // pricing and the paid rotation use — the same reason trip cost lives in
    // exactly one module. The client just reads the field.
    if (url.pathname === "/api/meta") {
      // Read live rather than from the module default: the owner can change
      // the take-home figure, and the box travelers type into should start
      // on their number, not the one this app shipped with.
      const settingsNow = await loadSettings(db);
      const dvcDefault = settingsNow.find((v) => v.key === DVC_TAKE_HOME_KEY)?.value
        ?? DVC_TAKE_HOME_PER_POINT;
      return send(200, {
      origins: withSuggestedMode(ORIGINS),
      plusOrigins: withSuggestedMode(PLUS_ORIGINS),
      // The order to OFFER them in — by city, free and Plus interleaved.
      // Sent as codes rather than a third copy of the airports, so the rule
      // itself stays in config.ts and the browser only obeys it.
      originOrder: ORIGINS_BY_CITY.map((o) => o.iata),
      // Each resort's lands come from the code's list corrected by the
      // owner's attraction sheet, so a closed land can be taken off in /admin.
      resorts: await effectiveParkLists(db, RESORTS),
      // Typical weather per resort per month. Its own key rather than folded
      // onto each Resort: 72 rows would bury the resort definitions, and
      // nothing that prices a trip reads it.
      climate: CLIMATE,
      // How busy each resort typically is, month by month. Sent whole, like
      // climate, because the crowd box, the "quieter overseas this month"
      // comparison and the shared PDF all read different slices of it and a
      // per-request slice would need three round trips.
      //
      // `placeholder` is the same honesty flag the exchange rates carry: true
      // while the shipped bands are Claude's rather than the owner's own
      // reading of a DVC points chart. The card says so rather than
      // presenting a guess as researched.
      crowds: {
        byResort: CROWDS,
        labels: CROWD_LABELS,
        placeholder: CROWDS_ARE_PLACEHOLDER,
        reviewed: CROWDS_REVIEWED,
      },
      // USD -> local, for the "a $50 dinner is about ¥355" line on a shared
      // PDF. Generated from ECB reference rates; `placeholder` is true while
      // the committed table is still the hand-seeded guess, so the page can
      // say so rather than presenting one as an observation. The browser used
      // to carry its own hardcoded copy of these five numbers, which nothing
      // could ever update.
      exchange: { rates: EXCHANGE_RATES, asOf: EXCHANGE_AS_OF, placeholder: EXCHANGE_IS_PLACEHOLDER },
      // Each resort's everyday prices against Orlando (priceLevels.ts). The
      // phrases are built here so the rounding rule has one home.
      priceLevels: {
        source: PRICE_LEVELS_SOURCE,
        byResort: Object.fromEntries(Object.entries(priceLevelsVsOrlando()).map(([id, l]) => [id, {
          ...l,
          eatingOutPhrase: vsOrlandoPhrase(l.eatingOut),
          groceriesPhrase: vsOrlandoPhrase(l.groceries),
        }])),
      },
      // Annual pass programs, and the default DVC take-home figure the
      // points box starts on. Sent from here so the catalog has one home
      // and the browser never carries its own copy of a price.
      // What vacation rentals near each resort typically cost a night, for
      // one information-only line in the off-property hotel card (owner,
      // 2026-10-05). Never in a total; absent with fewer than 3 listings.
      vacationRentals: await rentalLines(db),
      // The owner's pass prices when set in /admin, so the budget page's
      // break-even check uses the same numbers pricing does.
      passPrograms: PASS_RESORTS.map((p) => ({ ...p, tiers: p.tiers.map((t) => ({ ...t,
        priceUsd: settingsNow.find((v) => v.key === passPriceKey(p.resortId, t.id))?.value ?? t.priceUsd })) })),
      dvcTakeHomePerPoint: dvcDefault,
      // Each resort's suggested ticket length (the owner's number if set)
      // and the reason, so the "Park days" picker and the results can say
      // what "our suggestion" means without a copy of the table.
      suggestedParkDays: Object.fromEntries(Object.entries(SUGGESTED_PARK_DAYS).map(([id, s]) => [id, {
        days: Math.round(settingsNow.find((v) => v.key === suggestedParkDaysKey(id))?.value ?? s.days),
        why: s.why, short: s.short,
      }])),
      // Named holiday sub-weeks (December, Thanksgiving) for every month the
      // month picker offers, keyed by "YYYY-MM" — empty for a month with
      // none. Computed here, once, so the picker's labels can never drift
      // from what compare() actually resolves an id to; the browser only
      // renders what it's handed. See holidayWindows.ts for which months
      // have one and why (and which were deliberately left out).
      // The months the "Arriving" picker offers — two months out through
      // twelve (see firstPlannableMonth in config.ts). Sent from here so the
      // form and the paid overnight jobs share one rule.
      planMonths: plannableMonths(todayISO()),
      plusPasses: PLUS_PASSES,
      plusPassDefault: PLUS_PASS_DEFAULT,
      holidayWindows: Object.fromEntries(
        Array.from({ length: 14 }, (_, i): [string, ReturnType<typeof holidayWindowsFor>] => {
          const now = new Date();
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
          const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
          return [ym, holidayWindowsFor(ym)];
        }).filter(([, windows]) => windows.length > 0),
      ),
      }, { cache: "public, max-age=300" });
    }

    // --- auth: an email and nothing else. Real enough to make Plus real; ---
    // --- explicitly not enough for a public launch (see src/auth.ts).    ---
    // Sign up and sign in are two routes now, not one. The old single route
    // created an account on any unknown email, which meant a typo silently
    // became a second empty account — and with a password now required on
    // every account, "create it if missing" and "check the password" are
    // simply different operations.
    if ((url.pathname === "/api/auth/signup" || url.pathname === "/api/auth/signin")
        && req.method === "POST") {
      const body = await readBody(req);
      const password = typeof body.password === "string" ? body.password : "";
      const isSignup = url.pathname === "/api/auth/signup";
      // Throttle sign-in only. Sign-up is not a guessing game — there is no
      // secret to find — and locking it would just stop people joining.
      const scopes = scopesFor(String(body.email ?? ""), clientIp(req));
      if (!isSignup) {
        const gate = await checkSigninAllowed(db, scopes);
        if (!gate.allowed) {
          // 429 with Retry-After, and the SAME message whether or not this
          // address has an account — a lockout that only happens for real
          // accounts would tell an attacker which addresses are registered.
          return send(429, { error: "too_many_attempts", message: lockoutMessage(gate.retryAfterSeconds) },
            { headers: { "retry-after": String(gate.retryAfterSeconds) } });
        }
      }
      try {
        const user = isSignup
          ? await signUp(db, body.email, password)
          : await signIn(db, body.email, password);
        if (!isSignup) await clearSigninFailures(db, scopes);
        // Fire the confirmation link on sign-up. Never blocks the sign-up
        // itself: the account exists either way and another link is one
        // button away.
        if (isSignup) void sendVerification(db, user.id, user.email, pickEmailSender());
        const token = await createSession(db, user.id);
        return send(200, {
          email: user.email, plus: isPlus(user.plusUntil), plusUntil: user.plusUntil,
          emailVerified: user.emailVerified,
        }, withCookie(sessionCookieHeader(token)));
      } catch (e) {
        if (e instanceof AuthError) {
          // Only a wrong password counts towards a lockout. A malformed
          // address or a weak password is a form mistake, and counting those
          // would lock people out for typing badly rather than for guessing.
          if (!isSignup && e.reason === "bad_credentials") await recordSigninFailure(db, scopes);
          // 401 for a credential mismatch, 400 for something the form can
          // fix (bad address, weak password, wrong form entirely).
          return send(e.reason === "bad_credentials" ? 401 : 400,
            { error: e.reason, message: e.message });
        }
        throw e;
      }
    }

    // --- forgot password -------------------------------------------------
    // Always answers the same, whether or not that address has an account.
    // Sign-in refuses to leak which addresses are registered; a forgot form
    // that said "no such account" would hand it straight back.
    if (url.pathname === "/api/auth/forgot" && req.method === "POST") {
      const body = await readBody(req);
      void requestReset(db, body.email, pickEmailSender());
      return send(200, {
        message: "If that address has an account, a reset link is on its way. "
          + "The link works for 2 hours.",
      });
    }

    // Clicked from an inbox, so it answers with a page rather than JSON.
    if (url.pathname === "/api/auth/reset" && (req.method === "GET" || req.method === "POST")) {
      const page = (title: string, body: string, status = 200) => sendHtml(status,
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title} · Pricing the Magic</title>`
        + `<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem">`
        + `<h1 style="font-size:1.4rem">${title}</h1>${body}`
        + `<p><a href="/">Back to Pricing the Magic</a></p></div>`);
      const dead = (reason: "unknown" | "expired") => page(
        reason === "expired" ? "That link has expired" : "That link isn't valid",
        reason === "expired"
          ? `<p>Reset links last ${RESET_TOKEN_HOURS} hours. Ask for a new one from the sign-in box and we'll send another.</p>`
          : `<p>It may already have been used, or a newer link replaced it. Ask for a new one from the sign-in box.</p>`,
        reason === "expired" ? 410 : 404);

      if (req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        const found = await lookupReset(db, token);
        // Checked BEFORE rendering the form, so nobody types a new password
        // into a page that was never going to work.
        if (!found.ok) return dead(found.reason);
        return page("Set a new password",
          `<p>For ${escapeHtml(found.email)}. At least ${MIN_PASSWORD_LENGTH} characters.</p>`
          + `<form method="post" action="/api/auth/reset">`
          + `<input type="hidden" name="token" value="${escapeHtml(token)}">`
          + `<p><input type="password" name="password" minlength="${MIN_PASSWORD_LENGTH}" required`
          + ` autocomplete="new-password" placeholder="New password"`
          + ` style="font:inherit;padding:.6rem;width:100%;box-sizing:border-box"></p>`
          + `<p><button type="submit" style="font:inherit;padding:.6rem 1rem">Set password</button></p>`
          + `</form>`
          + `<p style="color:#666;font-size:.9rem">This signs out every device currently signed in to this account.</p>`);
      }

      const form = await readForm(req);
      const result = await consumeReset(db, form.token ?? "", form.password ?? "");
      if (!result.ok) {
        if (result.reason === "weak_password") {
          // The link survives a weak password, so one short try doesn't force
          // the whole flow to start over.
          return page("That password is too short",
            `<p>Passwords need at least ${MIN_PASSWORD_LENGTH} characters. `
            + `<a href="/api/auth/reset?token=${encodeURIComponent(form.token ?? "")}">Try again</a>.</p>`, 400);
        }
        return dead(result.reason);
      }
      return page("Password changed",
        `<p>${escapeHtml(result.email)} is set. `
        + `${result.sessionsEnded > 0 ? `Every device that was signed in has been signed out. ` : ""}`
        + `Sign in with the new password.</p>`);
    }
    // Clicked from an inbox, so it answers with a page rather than JSON.
    if (url.pathname === "/api/auth/verify" && req.method === "GET") {
      const result = await verifyEmailToken(db, url.searchParams.get("token") ?? "");
      const page = (title: string, body: string) =>
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title} · Pricing the Magic</title>`
        + `<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem">`
        + `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p>`
        + `<p><a href="/">Back to Pricing the Magic</a></p></div>`;
      if (result.ok) {
        return sendHtml(200, page(
          result.alreadyVerified ? "Already confirmed" : "Email confirmed",
          result.alreadyVerified
            ? `${escapeHtml(result.email)} was already confirmed. Nothing more to do.`
            : `Thanks — ${escapeHtml(result.email)} is confirmed. Price alerts can now reach you.`,
        ));
      }
      return sendHtml(result.reason === "expired" ? 410 : 404, page(
        result.reason === "expired" ? "That link has expired" : "That link isn't valid",
        result.reason === "expired"
          ? `Confirmation links last ${VERIFY_TOKEN_HOURS} hours. Sign in and ask for a new one.`
          : "It may already have been used, or replaced by a newer link. Sign in and ask for a new one.",
      ));
    }

    /* Deal-email unsubscribe (src/dealEmails.ts). No sign-in, by law and by
     * sense — the link in the email is the whole credential, and it only
     * unlocks this one switch.
     *
     * GET shows a button rather than acting, because mail scanners and link
     * previews open links on their own. POST acts: that's the page's button,
     * and it's also what Gmail's own "Unsubscribe" does (RFC 8058 one-click),
     * with no page to see — so a POST answers 200 whatever its body says. */
    if (url.pathname === "/unsubscribe") {
      const token = url.searchParams.get("t") ?? "";
      const page = (title: string, body: string, status = 200) => sendHtml(status,
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<meta name="robots" content="noindex"><title>${title} · Pricing the Magic</title>`
        + `<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem">`
        + `<h1 style="font-size:1.4rem">${title}</h1>${body}`
        + `<p style="margin-top:2rem"><a href="/">Back to Pricing the Magic</a></p></div>`);
      const button = (label: string, action: "stop" | "resume") =>
        `<form method="post" action="/unsubscribe?t=${encodeURIComponent(token)}">`
        + `<input type="hidden" name="do" value="${action}">`
        + `<button style="font:inherit;font-weight:600;padding:.6rem 1.1rem;border-radius:9px;border:1px solid #999;cursor:pointer">${label}</button></form>`;
      const unknown = () => page("That link isn't valid",
        "<p>It may have been copied incompletely. You can also turn deal emails off from your account panel once you've signed in.</p>", 404);

      if (req.method === "GET") {
        return page("Stop deal emails?",
          "<p>You'll stop getting Pricing the Magic's emails about new Disney deals. Your account, your Plus and your "
          + "saved searches aren't affected, and emails about your account (like password resets) still come.</p>"
          + button("Stop deal emails", "stop"));
      }
      if (req.method === "POST") {
        const form = await readForm(req);
        const resume = form.do === "resume";
        const email = await setDealEmailsByToken(db, token, resume);
        if (!email) return unknown();
        return resume
          ? page("Deal emails are back on",
              `<p>${escapeHtml(email)} will get an email when we add a new official Disney deal.</p>`)
          : page("You're unsubscribed",
              `<p>${escapeHtml(email)} won't get any more deal emails from Pricing the Magic.</p>`
              + `<p>Changed your mind?</p>` + button("Turn deal emails back on", "resume"));
      }
    }

    if (url.pathname === "/api/auth/resend-verification" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (user.emailVerified) return send(200, { ok: true, alreadyVerified: true }, { cache: "no-store" });
      const sender = pickEmailSender();
      const sent = await sendVerification(db, user.id, user.email, sender);
      // `delivers` is the honest part: the console sender "succeeds" by
      // printing to a log the user will never see, and telling them to check
      // an inbox that will stay empty would be a lie.
      return send(200, { ok: sent, delivers: sender.name !== "console" }, { cache: "no-store" });
    }

    if (url.pathname === "/api/auth/me") {
      const user = await currentUser(db, req);
      if (!user) return send(200, { authenticated: false });
      const plus = isPlus(user.plusUntil);
      // Exact-fare allowance travels with the identity, so the UI can show a
      // real remaining count instead of only finding out by hitting the cap.
      // Free for any signed-in account since the 2026-09-24 launch decision —
      // not conditioned on `plus`, which now gates only the PDF.
      const exactFare = { perDay: limitsFromEnv().perUserPerDay, remainingToday: await remainingForUser(db, user.id) };
      return send(200, {
        authenticated: true, email: user.email, plus, plusUntil: user.plusUntil,
        homeAirport: user.homeAirport, emailVerified: user.emailVerified, exactFare,
        dealEmails: await dealEmailsOn(db, user.id),
        // Only so the masthead can offer the link. Every admin route resolves
        // this again for itself — a client that lied about it would get a page
        // it still cannot save anything from.
        owner: !!await ownerOf(db, req),
      }, { cache: "no-store" });
    }
    // --- profile: free, signed in, always the caller's own row. ---------
    // Not Plus-gated, unlike saved trips: an account is free and this is a
    // remembered form field, not monitoring. The airport is validated against
    // the app's own list inside setHomeAirport, so a junk code can't be
    // stored and handed back as a pre-selected option later.
    if (url.pathname === "/api/profile" && req.method === "PUT") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      const body = await readBody(req);
      // The deal-email switch rides the same route. It's sent on its own,
      // so a request carrying only it must not touch the home airport.
      if (typeof body.dealEmails === "boolean") {
        await setDealEmailsForUser(db, user.id, body.dealEmails);
        if (!("homeAirport" in body)) return send(200, { ok: true, dealEmails: body.dealEmails }, { cache: "no-store" });
      }
      // An explicit null clears it. `undefined` would be ambiguous with "not
      // sent", so the client always sends the key.
      const raw = body.homeAirport;
      try {
        const homeAirport = await setHomeAirport(db, user.id, raw ? String(raw) : null);
        return send(200, { ok: true, homeAirport }, { cache: "no-store" });
      } catch (e) {
        if (e instanceof HomeAirportError) {
          return send(400, { error: e.reason, message: e.message });
        }
        throw e;
      }
    }

    // The attraction list itself is public — facts about what each resort
    // has, the same way a curated promo is public to browse. What Plus buys
    // is the personalization: picking yours and having the board answer.
    if (url.pathname === "/api/attractions") {
      // The owner's list, overlaid on the shipped one. No longer cacheable
      // for five minutes at the edge: the owner editing a row and not seeing
      // it is the exact complaint the admin page exists to answer.
      const list = await effectiveAttractions(db);
      return send(200, list.map((a) => ({
        ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null,
      })), { cache: "no-store" });
    }

    if (url.pathname === "/api/profile/attractions") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (req.method === "GET") {
        return send(200, { picks: await picksFor(db, user.id) }, { cache: "no-store" });
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        const ids = Array.isArray(body.picks) ? body.picks : [];
        try {
          return send(200, { picks: await setPicks(db, user.id, ids) }, { cache: "no-store" });
        } catch (e) {
          return send(400, { error: "bad_picks", message: (e as Error).message });
        }
      }
    }

    if (url.pathname === "/api/auth/signout" && req.method === "POST") {
      const token = sessionTokenFrom(req);
      if (token) await destroySession(db, token);
      return send(200, { ok: true }, withCookie(clearCookieHeader()));
    }

    // No payment processor yet — a Plus click from the paywall modal emails
    // the owner instead of charging anyone, so it does something real rather
    // than nothing. Granting Plus is still the one real mechanism: grantPlus.ts.
    // Anonymous action counts (siteEvents.ts). Answers 204 whatever happens:
    // a counter that breaks must never break the page that called it. The
    // owner's own clicks are skipped so testing doesn't skew the numbers.
    if (url.pathname === "/api/event" && req.method === "POST") {
      try {
        const ev = parseEvent(await readBody(req));
        if (ev && allowEvent(clientIp(req)) && !await ownerOf(db, req)) await recordEvent(db, ev);
      } catch (e) {
        console.error("event count failed:", (e as Error).message);
      }
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }

    if (url.pathname === "/api/plus/request" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign in first" });
      const body = await readBody(req);
      // Only a pass we sell; anything else is refused rather than guessed at,
      // so the email never quotes a price or a length nobody offered.
      const pass = PLUS_PASSES.find((p) => p.id === body.plan);
      if (!pass) return send(400, { error: "unknown_plan" });
      const owner = process.env.OWNER_EMAIL;
      if (owner) {
        await pickEmailSender().send({
          to: owner,
          subject: `Pricing the Magic: ${user.email} wants Plus`,
          text: `${user.email} picked the ${pass.label} pass ($${pass.priceUsd}, no renewal) in the paywall.`
            + `\n\nPayments aren't built yet. Once they've paid, grant it with:\n  npm run grant-plus -- ${user.email} ${pass.days}`,
        });
      }
      return send(200, { ok: true, delivered: Boolean(owner) });
    }

    // --- pricing: reads the cache, personalized only by what the signed-in ---
    // --- user is entitled to (compare()/calendar() decide that internally). ---
    if (url.pathname === "/api/months") {
      const user = await currentUser(db, req);
      const body = await months(url.searchParams, user);
      if ("error" in body && body.error === "plus_required") return send(402, body, { cache: "no-store" });
      return send(200, body, { cache: "private, max-age=60" });
    }
    if (url.pathname === "/api/compare" || url.pathname === "/api/calendar") {
      const user = await currentUser(db, req);
      const body = url.pathname === "/api/compare" ? await compare(url.searchParams, user) : await calendar(url.searchParams, user);
      if ("error" in body && body.error === "plus_required") return send(402, body, { cache: "no-store" });
      return send(200, body, { cache: "private, max-age=60" });
    }
    if (url.pathname === "/api/promos") {
      return send(200, await listPromos(url.searchParams), { cache: "public, max-age=300" });
    }

    // --- driving-mode "Departing from" search box: free for everyone, same ---
    // --- as driving-cost estimation itself. See src/geo/ for why this is   ---
    // --- the one place the app calls a live provider on a user's request. ---
    if (url.pathname === "/api/geocode") {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
      if (!q) return send(200, []);
      const results = await cachedGeocode(db, pickGeocodeProvider(), q);
      return send(200, results, { cache: "no-store" });
    }
    if (url.pathname === "/api/geolocate") {
      const provider = pickIpLocateProvider();
      const result = await provider.locate(clientIp(req)).catch(() => null);
      return send(200, result ?? { error: "unavailable" }, { cache: "no-store" });
    }
    // --- exact live fare: signed in, free. The one route where a user's
    // click spends metered provider money — no longer paywalled at launch,
    // but still bounded by the per-user and site-wide daily caps below, so
    // the spend stays capped even though it is no longer offset by Plus
    // revenue. Sign-in stays required because the per-user cap needs an
    // identity to key on.
    if (url.pathname === "/api/exact-fare" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required", message: "Sign in to check live fares." });
      const b = await readBody(req);
      const origin = String(b.origin ?? "").toUpperCase();
      const departDate = String(b.date ?? "");
      const nights = Number(b.nights ?? 7);
      // The destination is validated against the named resort's OWN airport
      // list, exactly as compare() does — so a request can never point a
      // paid lookup at an arbitrary airport pair.
      const resort = RESORT_BY_ID.get(String(b.resort ?? ""));
      if (!resort) return send(400, { error: "unknown_resort" });
      const destination = resolveDestination(resort, b.destination ? String(b.destination) : null);
      if (!ORIGIN_BY_IATA.has(origin)) return send(400, { error: "unknown_origin" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) return send(400, { error: "bad_date" });
      if (departDate < todayISO()) return send(400, { error: "past_date", message: "That date has already been and gone." });

      const { origin: pricedOrigin } = resolveOrigin(origin);
      const result = await fetchExactFare(db, {
        userId: user.id, origin: pricedOrigin, destination, departDate, tripLength: bucketFor(nights),
      });
      // 200 even on a refusal: "you're out of checks for today" is a normal
      // answer the UI shows inline, not an error condition.
      return send(200, result, { cache: "no-store" });
    }

    // --- saved trips: SAVING is Plus (owner's call, 2026-09-25), always the ---
    // --- caller's own rows. Listing, reopening and deleting stay open to any ---
    // --- signed-in account, so a lapsed member keeps what they saved.        ---
    if (url.pathname === "/api/trips" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
      const t = await readBody(req);
      const id = randomUUID();
      const params = { ...(t.params ?? {}) };
      // A saved trip is always one specific resort, but params.gettingThere
      // (if present) is a whole-board preset that can mean different things
      // per resort (e.g. "drive to WDW, fly everywhere else"). Resolve it to
      // a concrete transportMode/originPoint/overnightStop for
      // *this* resort now, at save time — the alert job re-prices one saved
      // trip at a time and has no notion of "Getting there" presets, so it
      // needs the resolved shape, the same one compare() builds per resort.
      const savedResort = RESORT_BY_ID.get(params.resortId);
      if (savedResort && params.gettingThere) {
        const asQuery = new URLSearchParams(
          Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
        );
        const { gettingThere, flyBase, driveBase } = gettingThereParams(asQuery);
        const mode = resortTransportMode(gettingThere, savedResort, String(params.origin ?? ""));
        Object.assign(params, mode === "drive" ? driveBase : flyBase);
      }
      // Passes and DVC points are normalized HERE, not trusted as saved. The
      // alert job re-prices straight from this row months later, and a tier
      // Disney has since retired (or a number somebody hand-edited) must not
      // reach pricing — parsePassHoldings drops what it does not recognize,
      // the same rule saved attraction picks follow.
      // Which day the board quoted when this was saved. Normalized here and
      // stored, because the alert job compares a fresh re-price against
      // baseline_total months later: a trip saved on its cheapest day and
      // re-priced on a typical one comes back pricier for no reason, and the
      // reverse fires "the price dropped" about a drop that never happened.
      // The basis is part of what was promised, so it is saved with it.
      params.priceBasis = params.priceBasis === "cheapest" ? "cheapest" : "typical";
      params.annualPasses = parsePassHoldings(params.annualPasses);
      params.dvcRental = parseDvcRental(
        (params.dvcRental as { points?: unknown } | null)?.points,
        (params.dvcRental as { takeHomePerPointUsd?: unknown } | null)?.takeHomePerPointUsd);
      // Stamps today's gas price into the saved trip so the alert job has a
      // "then" to compare "now" against — same idea as baseline_total, just
      // for the one input that changes on its own without the user doing
      // anything (unlike a nightly rate they typed in themselves).
      if (params.transportMode === "drive") {
        const { rows } = await db.query(`select price_per_gallon_usd from gas_prices order by as_of desc limit 1`);
        if (rows[0]) params.gasPriceAtSaveUsd = Number(rows[0].price_per_gallon_usd);
      }
      await db.query(
        `insert into saved_trips (id,user_id,label,params,overrides,baseline_total,threshold_pct)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, user.id, t.label ?? "", JSON.stringify(params), JSON.stringify(t.overrides ?? {}),
         Number(t.baselineTotal ?? 0), Number(t.thresholdPct ?? 5)],
      );
      return send(201, { id });
    }
    if (url.pathname === "/api/trips" && req.method === "GET") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      const { rows } = await db.query(
        `select id, label, params, overrides, baseline_total, active, created_at from saved_trips
          where user_id = $1 order by created_at desc`, [user.id]);
      // params/overrides are returned so a saved trip can be REOPENED, not
      // just listed — without them the list was a read-only receipt and the
      // only way back to a trip you had saved was to key it in again.
      // They are the user's own row, already scoped to their own id above.
      return send(200, rows.map((r) => ({
        id: r.id, label: r.label, resortId: r.params?.resortId ?? null,
        params: r.params ?? {}, overrides: r.overrides ?? {},
        baselineTotal: Number(r.baseline_total), active: r.active, createdAt: r.created_at,
      })));
    }
    const tripMatch = url.pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (tripMatch && req.method === "DELETE") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      await db.query(`delete from saved_trips where id = $1 and user_id = $2`, [tripMatch[1], user.id]);
      return send(200, { ok: true });
    }

    // --- custom planning expenses: free-form line items (VIP tours, ---
    // --- PhotoPass, anything not modeled elsewhere) attached to a saved  ---
    // --- trip — the user's own claim about their own price, same trust  ---
    // --- model as a personal promo. Always scoped to a trip the caller  ---
    // --- actually owns, joined through saved_trips.user_id.             ---
    const expensesMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/expenses$/);
    if (expensesMatch && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
      const owns = await db.query(`select 1 from saved_trips where id = $1 and user_id = $2`, [expensesMatch[1], user.id]);
      if (!owns.rows[0]) return send(404, { error: "not found" });
      const body = await readBody(req);
      const label = String(body.label ?? "").trim().slice(0, 120);
      const amount = Number(body.amountUsd);
      if (!label || !Number.isFinite(amount) || amount < 0) return send(400, { error: "label and a non-negative amountUsd are required" });
      const id = randomUUID();
      await db.query(`insert into custom_expenses (id, trip_id, label, amount_usd) values ($1,$2,$3,$4)`,
        [id, expensesMatch[1], label, amount]);
      return send(201, { id, label, amountUsd: amount });
    }
    if (expensesMatch && req.method === "GET") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      const owns = await db.query(`select 1 from saved_trips where id = $1 and user_id = $2`, [expensesMatch[1], user.id]);
      if (!owns.rows[0]) return send(404, { error: "not found" });
      const { rows } = await db.query(
        `select id, label, amount_usd from custom_expenses where trip_id = $1 order by created_at`, [expensesMatch[1]]);
      return send(200, rows.map((r) => ({ id: r.id, label: r.label, amountUsd: Number(r.amount_usd) })));
    }
    const expenseMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/expenses\/([^/]+)$/);
    if (expenseMatch && req.method === "DELETE") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      const owns = await db.query(`select 1 from saved_trips where id = $1 and user_id = $2`, [expenseMatch[1], user.id]);
      if (!owns.rows[0]) return send(404, { error: "not found" });
      await db.query(`delete from custom_expenses where id = $1 and trip_id = $2`, [expenseMatch[2], expenseMatch[1]]);
      return send(200, { ok: true });
    }


    /* ----------------------------- the admin page ------------------------
     * Owner-only, resolved server-side on every one of these routes. The page
     * itself is behind the same check as the data: serving the form to anyone
     * and refusing the saves would just be a confusing way to say no.
     * -------------------------------------------------------------------- */
    if (url.pathname === "/admin") {
      if (!await ownerOf(db, req)) {
        return sendHtml(404, `<!doctype html><meta charset="utf-8"><title>Not found</title>
          <body style="font:16px/1.6 system-ui; max-width:32rem; margin:15vh auto; padding:0 1rem">
          <h1 style="font-size:1.2rem">Not found</h1>
          <p>Nothing to see here. If you're the owner, <a href="/">sign in on the main page</a> first,
          then come back.</p>`);
      }
      const file = await readFile(new URL("admin.html", PUBLIC_DIR));
      res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
      return res.end(file);
    }

    if (url.pathname === "/api/admin/stats" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const days = clamp(Number(url.searchParams.get("days") ?? 30), 1, 366);
      return send(200, await loadStats(db, days), { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/settings" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const values = await loadSettings(db);
      const byKey = new Map(values.map((v) => [v.key, v]));
      // The registry travels with the values, so the page renders itself from
      // one response: label, group, bounds and help all come from the same
      // place the validation does, and can't drift from it.
      return send(200, {
        settings: SETTINGS.map((def) => ({ ...def, ...byKey.get(def.key)! })),
        groups: [...new Set(SETTINGS.map((s) => s.group))],
      }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/settings" && req.method === "PUT") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const key = String(body.key ?? "");
      // An explicit null is "put it back to the shipped default" — a different
      // act from typing the default in, and the only way to say it.
      const raw = body.value === null || body.value === "" ? null : body.value;
      try {
        const saved = await setSetting(db, key, raw, {
          note: String(body.note ?? "").slice(0, 300), by: owner.email,
        });
        // A hotel rate is not live until the cache it is served from agrees.
        const reseed = await reseedForKeys(db, [key]);
        return send(200, { ...saved, reseededRows: reseed.rows }, { cache: "no-store" });
      } catch (e) {
        // The message is the whole point here — it names the bound and says
        // what to do about it, so a refused save is actionable.
        return send(400, { error: "rejected", message: (e as Error).message });
      }
    }

    /* The spreadsheet, out and back. Same validation as the single-value
     * form, by construction: both call applySettings/setSetting. */
    if (url.pathname === "/api/admin/settings.csv" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const values = new Map((await loadSettings(db)).map((v) => [v.key, v]));
      const lines = [["key", "value", "label", "group", "shipped_default", "min", "max", "note", "help"].join(",")];
      for (const def of SETTINGS) {
        const v = values.get(def.key)!;
        lines.push([
          def.key,
          // Only the owner's own overrides are filled in. A file that arrived
          // with every box already holding the current number would turn a
          // round trip into an override of all 111 — including the ones they
          // never touched, frozen at today's defaults forever.
          v.overridden ? v.value : "",
          def.label, def.group, def.default, def.min, def.max, v.note, def.help,
        ].map(csvCell).join(","));
      }
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pricing-the-magic-settings-${todayISO()}.csv"`,
        "cache-control": "no-store",
      });
      return res.end(lines.join("\n") + "\n");
    }

    if (url.pathname === "/api/admin/settings.csv" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const parsed = entriesFromCsv(String(body.csv ?? ""));
      if (!parsed.ok) return send(400, { error: "unreadable", message: parsed.message });
      const entries = parsed.entries;
      const result = await applySettings(db, entries, { note: "spreadsheet", by: owner.email });
      if (!result.ok) return send(400, { error: "rejected", errors: result.errors });
      const reseed = await reseedForKeys(db, entries.map((e) => e.key));
      return send(200, { ...result, reseeded: reseed.resorts, reseededRows: reseed.rows }, { cache: "no-store" });
    }


    /* ------------------------- fare corrections -------------------------
     * Its own page and its own spreadsheet, deliberately. A fare is per
     * route AND per date — 171 domestic routes plus 95 international across
     * thirteen months — so folding them into the 73-row settings sheet would
     * bury everything else in it. The owner's call: "I think it would be too
     * much to have ALL of it on one sheet."
     * -------------------------------------------------------------------- */
    /* Wait times: what the two-hourly job has recorded. Read-only, owner
     * only, and never shown to travelers — see waitTimesView.ts. */
    if (url.pathname === "/api/admin/wait-times" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const park = Number(url.searchParams.get("park"));
      if (Number.isInteger(park) && park > 0) {
        return send(200, { parkId: park, rides: await rideSummary(db, park) }, { cache: "no-store" });
      }
      return send(200, { parks: await waitTimesSummary(db) }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/wait-times.csv" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const days = clamp(Number(url.searchParams.get("days") ?? 30) || 30, 1, 366);
      const rows = await waitTimeRows(db, days);
      const head = ["observed_at_utc", "resort", "park_id", "ride", "local_hour", "open", "posted_wait_min"];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push([r.observed_at, r.resort_id, r.park_id, r.ride_name, r.local_hour,
          r.is_open ? "yes" : "no", r.wait_min ?? ""].map(csvCell).join(","));
      }
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pricing-the-magic-wait-times-${days}d-${todayISO()}.csv"`,
        "cache-control": "no-store",
      });
      return res.end(lines.join("\n") + "\n");
    }

    if (url.pathname === "/api/admin/fares" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      return send(200, {
        corrections: await listCorrections(db),
        origins: [...KNOWN_ORIGINS].sort(),
        destinations: [...KNOWN_DESTINATIONS].sort(),
        defaultDays: DEFAULT_CORRECTION_DAYS,
      }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/fares" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const r = await addCorrection(db, body, owner.email);
      if (!r.ok) return send(400, { error: "rejected", message: r.reason });
      return send(201, { ok: true, id: r.id, corrections: await listCorrections(db) }, { cache: "no-store" });
    }

    const fareMatch = url.pathname.match(/^\/api\/admin\/fares\/([^/]+)$/);
    if (fareMatch && req.method === "DELETE") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const gone = await deleteCorrection(db, fareMatch[1]!);
      return send(gone ? 200 : 404, gone ? { ok: true } : { error: "not found" }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/fares.csv" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const rows = await listCorrections(db);
      const head = ["from", "to", "depart_date", "price", "band", "nights", "expires_on", "note", "counting", "id"];
      const lines = [head.join(",")];
      for (const c of rows) {
        lines.push([c.origin, c.destination, c.departDate, c.priceUsd, c.band,
          c.nights ?? "", c.expiresOn, c.note, c.counting ? "yes" : "expired", c.id].map(csvCell).join(","));
      }
      // An empty file still carries its header, so the owner always has a
      // template to type into rather than a blank page to guess at.
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pricing-the-magic-fares-${todayISO()}.csv"`,
        "cache-control": "no-store",
      });
      return res.end(lines.join("\n") + "\n");
    }

    if (url.pathname === "/api/admin/fares.csv" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const parsed = parseCsv(String(body.csv ?? ""));
      if (!parsed.length) return send(400, { error: "unreadable", message: "That file had no rows in it." });
      const header = parsed[0]!.map((h) => h.trim().toLowerCase());
      const at = (name: string) => header.indexOf(name);
      const need = ["from", "to", "depart_date", "price"];
      const missing = need.filter((n) => at(n) < 0);
      if (missing.length) {
        return send(400, { error: "no_header", message:
          `That file needs a header row with ${need.join(", ")} columns — missing: ${missing.join(", ")}. Download the fares spreadsheet again and type into it.` });
      }
      const cell = (r: string[], name: string) => (at(name) >= 0 ? (r[at(name)] ?? "").trim() : "");
      const inputs = parsed.slice(1).map((r) => ({
        origin: cell(r, "from"), destination: cell(r, "to"), departDate: cell(r, "depart_date"),
        priceUsd: cell(r, "price"), band: cell(r, "band") || "typical",
        nights: cell(r, "nights"), expiresOn: cell(r, "expires_on"), note: cell(r, "note"),
      }));
      // All or nothing, the same rule the settings sheet follows and for the
      // same reason: a half-applied file leaves evidence in a state nobody
      // intended and nobody can identify.
      const errors: string[] = [];
      inputs.forEach((row, i) => {
        const v = validateCorrection(row);
        if (!v.ok) errors.push(`row ${i + 2}: ${v.reason}`);
      });
      if (errors.length) return send(400, { error: "rejected", errors });
      for (const row of inputs) await addCorrection(db, row, owner.email);
      return send(200, { ok: true, added: inputs.length, corrections: await listCorrections(db) }, { cache: "no-store" });
    }

    /* --------------------------- your price checks ---------------------------
     * Real prices the owner has seen while pricing whole trips. Every row is
     * kept; the ones that match something we price nudge that estimate a
     * little (checkFactors.ts). Nothing here writes a rate, fare or ticket.
     * -------------------------------------------------------------------- */

    if (url.pathname === "/api/admin/checks" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      return send(200, await checksReport(), { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/checks" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const v = validateCheck(body);
      if (!v.ok) return send(400, { error: "rejected", message: v.reason });
      const r = await addChecks(db, [v.value], owner.email);
      return send(201, { ok: true, ...r, warnings: v.warnings, ...(await checksReport()) }, { cache: "no-store" });
    }

    const checkMatch = url.pathname.match(/^\/api\/admin\/checks\/([^/]+)$/);
    if (checkMatch && req.method === "DELETE") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const gone = await deleteCheck(db, checkMatch[1]!);
      return send(gone ? 200 : 404, gone ? { ok: true } : { error: "not found" }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/checks.csv" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      // Your columns first, exactly as uploaded, so this file can be edited
      // and sent straight back (repeats are skipped). Then what the app
      // worked out, which an upload ignores.
      const head = [...CHECK_COLUMNS, "per_unit_usd", "unit", "our_price_that_day_usd",
        "you_vs_us", "days_ahead", "counted", "id"];
      const lines = [head.join(",")];
      for (const c of await listChecks(db)) {
        lines.push([c.trip, c.checkedOn, c.resortId, c.category, c.item, c.detail, c.fromAirport ?? "",
          c.startDate ?? "", c.endDate ?? "", c.adults ?? "", c.seniors ?? "", c.childrenAges.join(", "),
          c.amount, c.currency, c.priceIs, c.source, c.notes,
          c.unitUsd ?? "", c.unit, c.modelUsd ?? "", c.ratio === null ? "" : `${Math.round((c.ratio - 1) * 100)}%`,
          c.leadDays ?? "", c.notCounted ? `no: ${c.notCounted}` : "yes", c.id].map(csvCell).join(","));
      }
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pricing-the-magic-price-checks-${todayISO()}.csv"`,
        "cache-control": "no-store",
      });
      return res.end(lines.join("\n") + "\n");
    }

    if (url.pathname === "/api/admin/checks.csv" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const parsed = parseCsv(String(body.csv ?? ""));
      if (!parsed.length) return send(400, { error: "unreadable", message: "That file had no rows in it." });
      const header = parsed[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
      const need = ["resort", "category", "amount"];
      const missing = need.filter((n) => !header.includes(n));
      if (missing.length) {
        return send(400, { error: "no_header", message:
          `That file needs a header row with at least ${need.join(", ")} — missing: ${missing.join(", ")}. The sample in docs/price-checks/ has every column.` });
      }
      const rows = parsed.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
      // All or nothing on anything unreadable, the same rule every sheet on
      // this page follows. Rows that are readable but can't move an estimate
      // are NOT errors: they are stored, and the list says why they don't count.
      const errors: string[] = [], warnings: string[] = [];
      const values = rows.map((row, i) => {
        const v = validateCheck(row);
        if (!v.ok) { errors.push(`row ${i + 2}: ${v.reason}`); return null; }
        for (const w of v.warnings) warnings.push(`row ${i + 2}: ${w}`);
        return v.value;
      });
      if (errors.length) return send(400, { error: "rejected", errors });
      const r = await addChecks(db, values as NonNullable<typeof values[number]>[], owner.email);
      return send(200, { ok: true, ...r, warnings, ...(await checksReport()) }, { cache: "no-store" });
    }

    /* ------------------------- the attraction list -------------------------
     * The owner's ask, in their words: "make sure I have a way to maintain
     * the attractions list." The shipped rows have always been a starter set
     * Claude was confident about, and until now the only way to change one
     * was to edit TypeScript and deploy.
     *
     * Everything here is an OVERLAY on the shipped list — see
     * ownerAttractions.ts for why a list needs that safety property even
     * more than a price does.
     * -------------------------------------------------------------------- */

    if (url.pathname === "/api/admin/attractions" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const owner = await listOwnerAttractions(db);
      const effective = await effectiveAttractions(db);
      return send(200, {
        // What the app is actually using, which is what somebody editing
        // wants to see — not only the handful of rows they have overridden.
        effective: effective.map((a) => ({ ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null })),
        owner,
        resorts: RESORTS.map((r) => ({ id: r.id, name: r.name })),
        shippedIds: ATTRACTIONS.map((a) => a.id),
      }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/attractions" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const r = await saveAttraction(db, body, owner.email);
      if (!r.ok) return send(400, { error: "rejected", message: r.reason });
      const effective = await effectiveAttractions(db);
      return send(200, {
        ok: true, id: r.id,
        effective: effective.map((a) => ({ ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null })),
        owner: await listOwnerAttractions(db),
      }, { cache: "no-store" });
    }

    const attrMatch = url.pathname.match(/^\/api\/admin\/attractions\/([^/]+)$/);
    if (attrMatch && req.method === "DELETE") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      // On a SHIPPED attraction this restores the shipped version rather
      // than deleting the attraction. That IS the safety property, and the
      // page names the button accordingly.
      const gone = await deleteOwnerAttraction(db, attrMatch[1]!);
      if (!gone) return send(404, { error: "not found" });
      const effective = await effectiveAttractions(db);
      return send(200, {
        ok: true,
        effective: effective.map((a) => ({ ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null })),
        owner: await listOwnerAttractions(db),
      }, { cache: "no-store" });
    }

    /* The Deals page: the owner adds, edits and turns off curated deals
     * (adminPromos.ts). The same rows travelers apply and the deal email
     * announces. */
    if (url.pathname === "/api/admin/deals" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      return send(200, { deals: await listDeals(db, todayISO()), kinds: DEAL_KINDS,
        resorts: RESORTS.map((r) => ({ id: r.id, name: r.name })) }, { cache: "no-store" });
    }
    if (url.pathname === "/api/admin/deals" && req.method === "POST") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const r = await saveDeal(db, body, todayISO(), typeof body?.id === "string" && body.id ? body.id : undefined);
      if (!r.ok) return send(400, { error: "rejected", message: r.reason });
      return send(200, { ok: true, id: r.id, deals: await listDeals(db, todayISO()) }, { cache: "no-store" });
    }
    const dealMatch = url.pathname.match(/^\/api\/admin\/deals\/([0-9a-f-]{36})(\/active)?$/);
    if (dealMatch && (req.method === "DELETE" || req.method === "POST")) {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const done = dealMatch[2]
        ? await setDealActive(db, dealMatch[1]!, Boolean((await readBody(req))?.active))
        : req.method === "DELETE" ? await deleteDeal(db, dealMatch[1]!) : false;
      if (!done) return send(404, { error: "not found" });
      return send(200, { ok: true, deals: await listDeals(db, todayISO()) }, { cache: "no-store" });
    }

    /* The Flights page: how far off our estimates run against the real fares
     * we buy (fareScoreboard.ts), and which routes people search
     * (routeDemand.ts). Both read-only, no provider calls. */
    if (url.pathname === "/api/admin/flights" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const days = Math.max(1, Math.min(120, Number(url.searchParams.get("days") ?? 30) || 30));
      return send(200, {
        scoreboard: await loadScoreboard(db, days),
        forecasts: await loadForecastScores(db, days),
        demand: await loadRouteDemand(db, days),
        hotels: await loadHotelScoreboard(db),
        hotelList: await loadHotelList(db),
      }, { cache: "no-store" });
    }

    /* The Lands page: each resort's lands exactly as the PDF prints them,
     * with Remove, Put back and Add. See adminLandLists in ownerAttractions.ts. */
    if (url.pathname === "/api/admin/lands" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      return send(200, { resorts: await adminLandLists(db, RESORTS) }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/lands" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req) as { action?: unknown; resort?: unknown; name?: unknown; park?: unknown };
      const resort = RESORTS.find((r) => r.id === String(body.resort ?? ""));
      if (!resort) return send(400, { error: "rejected", message: "Which resort?" });
      const name = String(body.name ?? "");
      const action = String(body.action ?? "");
      const r = action === "remove" ? await removeLand(db, resort.id, name, owner.email)
        : action === "restore" ? await restoreLand(db, resort.id, name, owner.email)
        : action === "add" ? await addLand(db, resort, name, String(body.park ?? ""), owner.email)
        : { ok: false as const, reason: "Unknown action." };
      if (!r.ok) return send(400, { error: "rejected", message: r.reason });
      return send(200, { ok: true, resorts: await adminLandLists(db, RESORTS) }, { cache: "no-store" });
    }

    if (url.pathname === "/api/admin/attractions.csv" && req.method === "GET") {
      if (!await ownerOf(db, req)) return send(403, { error: "owner_only" });
      const rows = sheetRows(await effectiveAttractions(db), await listOwnerAttractions(db));
      // `type` and `land` added 2026-09-26, `park` 2026-09-29. only_here and
      // source are read-only: worked out from the rows, never read back.
      const head = ["id", "name", "type", "resorts", "land", "park", "note", "hidden", "only_here", "source"];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push([r.id, r.name, r.type, r.resorts, r.land, r.park, r.note, r.hidden, r.only_here, r.source].map(csvCell).join(","));
      }
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pricing-the-magic-attractions-${todayISO()}.csv"`,
        "cache-control": "no-store",
      });
      return res.end(lines.join("\n") + "\n");
    }

    if (url.pathname === "/api/admin/attractions.csv" && req.method === "POST") {
      const owner = await ownerOf(db, req);
      if (!owner) return send(403, { error: "owner_only" });
      const body = await readBody(req);
      const parsed = parseCsv(String(body.csv ?? ""));
      if (!parsed.length) return send(400, { error: "unreadable", message: "That file had no rows in it." });
      const header = parsed[0]!.map((h) => h.trim().toLowerCase());
      const at = (name: string) => header.indexOf(name);
      const need = ["id", "name", "resorts"];
      const missing = need.filter((n) => at(n) < 0);
      if (missing.length) {
        return send(400, { error: "no_header", message:
          `That file needs a header row with ${need.join(", ")} columns — missing: ${missing.join(", ")}. Download the attractions spreadsheet again and type into it.` });
      }
      const cell = (r: string[], name: string) => (at(name) >= 0 ? (r[at(name)] ?? "").trim() : "");
      const inputs = parsed.slice(1)
        // A blank line at the end of a spreadsheet is not an error worth
        // refusing a whole file over.
        .filter((r) => r.some((c) => c.trim()))
        .map((r) => ({
          id: cell(r, "id"), name: cell(r, "name"), resortIds: cell(r, "resorts"),
          note: cell(r, "note"), hidden: /^(yes|true|1|y)$/i.test(cell(r, "hidden")),
          // Older sheets have neither column; a blank type is worked out from
          // the name, and "lands" is accepted as well as "land".
          kind: cell(r, "type"), lands: cell(r, "land") || cell(r, "lands"),
          parks: cell(r, "park") || cell(r, "parks"),
          onlyHere: cell(r, "only_here"),
        }));

      // All or nothing, and a duplicated id is refused rather than
      // last-one-wins — the same two rules the settings and fares sheets
      // follow, and for the same reason: silently taking the last row hides
      // a real editing mistake.
      const errors: string[] = [];
      const seen = new Map<string, number>();
      const valid: { row: number; value: AttractionValue; onlyHere: string }[] = [];
      inputs.forEach((row, i) => {
        const v = validateAttraction(row);
        if (!v.ok) { errors.push(`row ${i + 2}: ${v.reason}`); return; }
        const first = seen.get(v.value.id);
        if (first !== undefined) errors.push(`row ${i + 2}: "${v.value.id}" is already on row ${first + 2}.`);
        else { seen.set(v.value.id, i); valid.push({ row: i + 2, value: v.value, onlyHere: row.onlyHere }); }
      });
      if (errors.length) return send(400, { error: "rejected", errors });
      const warnings = sheetWarnings(valid);

      // A row the owner DELETED from the sheet should disappear from the
      // app. Without this, the spreadsheet could only ever add and change,
      // and the only way to remove something would be the hidden column —
      // which is not what deleting a row means to anybody.
      const keep = new Set(inputs.map((r) => String(r.id).trim().toLowerCase()));
      for (const existing of await listOwnerAttractions(db)) {
        if (!keep.has(existing.id)) await deleteOwnerAttraction(db, existing.id);
      }
      for (const row of inputs) await saveAttraction(db, row, owner.email);

      const effective = await effectiveAttractions(db);
      return send(200, {
        ok: true, applied: inputs.length, warnings,
        lands: valid.filter((v) => !v.value.hidden && v.value.kind === "land").length,
        attractions: valid.filter((v) => !v.value.hidden && v.value.kind === "attraction").length,
        hiddenCount: valid.filter((v) => v.value.hidden).length,
        effective: effective.map((a) => ({ ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null })),
        owner: await listOwnerAttractions(db),
      }, { cache: "no-store" });
    }

    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => console.log(`pricing-the-magic api on :${PORT} (${db.kind})`));
