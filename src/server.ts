/**
 * The API. Deliberately dependency-free — node:http and nothing else — because
 * every dependency is a thing that can break at 3am.
 *
 * Every endpoint reads the cache. None of them calls a provider.
 */
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { RESORTS, RESORT_BY_ID, ORIGINS, PLUS_ORIGINS, ORIGINS_BY_CITY, ORIGIN_BY_IATA, originNeedsPlus, bucketFor, ATTRACTIONS, isOnlyAt, CLIMATE, type TierIndex, type FoodStyle, type Stay } from "./config.js";
import { picksFor, setPicks, matchesForResort, matchSummary } from "./attractions.js";
import { addDaysISO, monthBounds, range, todayISO } from "./dates.js";
import { getDb } from "./db.js";
import { loadBook, dateStr } from "./book.js";
import { recordSearch } from "./routeDemand.js";
import { haversineMiles } from "./geo.js";
import { fetchExactFare, limitsFromEnv, remainingForUser } from "./exactFare.js";
import { cheapestIn, priceTrip, type Overrides, type TripParams } from "./pricing.js";
import { resortTransportMode, GETTING_THERE_MODES, defaultGettingThere, type GettingThereMode } from "./gettingThere.js";
import { pickGeocodeProvider, pickIpLocateProvider } from "./geo/pick.js";
import { cachedGeocode } from "./geo/cache.js";
import {
  currentUser, createSession, sessionTokenFrom, destroySession,
  sessionCookieHeader, clearCookieHeader, isPlus, signUp, signIn, AuthError,
  setHomeAirport, HomeAirportError, type SessionUser,
} from "./auth.js";
import { pickEmailSender } from "./email/pick.js";
import { sendVerification, verifyEmailToken, VERIFY_TOKEN_HOURS } from "./verifyEmail.js";

const db = await getDb();
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = new URL("../public/", import.meta.url);

/** The address goes into a page we render, and an address is user input. */
function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

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
  if (q.get("flyRentalCar") === "1") flyBase.rentalCar = true;

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
  if (q.get("driveRentalCar") === "1") driveBase.rentalCar = true;
  // Default (unset) is true — only an explicit "0" turns it off. Moot once
  // rentalCar is true, since priceTrip zeroes wear-and-tear for a rental
  // regardless of this flag.
  if (q.get("driveWearAndTear") === "0") driveBase.includeWearAndTear = false;

  return { gettingThere, flyBase, driveBase };
}

function paramsFrom(q: URLSearchParams): TripParams {
  const ages = (q.get("childAges") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const nights = clamp(Number(q.get("nights") ?? 6), 1, 30);
  return {
    origin: (q.get("origin") ?? "ATL").toUpperCase().slice(0, 3),
    adults: clamp(Number(q.get("adults") ?? 2), 1, 12),
    childAges: ages.filter((a) => Number.isFinite(a) && a >= 0 && a <= 17).slice(0, 8),
    nights,
    parkDays: clamp(Number(q.get("parkDays") ?? 4), 1, nights + 1),
    stay: (["on", "off", "both", "none"].includes(q.get("stay") ?? "") ? q.get("stay") : "on") as Stay,
    tier: clamp(Number(q.get("tier") ?? 1), 0, 2) as TierIndex,
    food: (["grocery", "qs", "mix", "ts", "plan"].includes(q.get("food") ?? "") ? q.get("food") : "mix") as FoodStyle,
    hopper: q.get("hopper") === "1" || q.get("hopper") === "true",
    transportMode: "fly",
  };
}
function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
}

/**
 * Which departure airport a request actually gets, and why.
 *
 * The free list is the 19 big metros the cache is pre-filled for. Plus adds
 * the smaller airports people actually live near — someone in Raleigh is
 * offered Charlotte three hours away, and the fare they'd really pay is a
 * different number.
 *
 * A free user asking for a Plus airport is NOT an error: they are quietly
 * given the nearest free one and told, so the board still prices and the
 * paywall has something concrete to point at. Server-side, because the
 * airport list in the UI is only the cosmetic half.
 */
function resolveOrigin(requested: string, plus: boolean): { origin: string; downgradedFrom?: string; downgradedTo?: string } {
  const iata = (requested || "ATL").toUpperCase().slice(0, 3);
  if (!originNeedsPlus(iata) || plus) {
    return { origin: ORIGIN_BY_IATA.has(iata) ? iata : "ATL" };
  }
  const wanted = ORIGIN_BY_IATA.get(iata);
  if (!wanted) return { origin: "ATL" };
  // Nearest free metro by great-circle distance — the airport they'd have
  // picked themselves if the Plus one weren't offered.
  const nearest = ORIGINS.reduce((best, o) =>
    haversineMiles(wanted.lat, wanted.lon, o.lat, o.lon) <
    haversineMiles(wanted.lat, wanted.lon, best.lat, best.lon) ? o : best);
  return { origin: nearest.iata, downgradedFrom: iata, downgradedTo: nearest.iata };
}
/** Strips promo fields for anyone not Plus — the server-side gate; hiding the UI control is only the cosmetic half. */
function overridesFrom(q: URLSearchParams, allowPromos: boolean): Overrides {
  let overrides: Overrides;
  try {
    const raw = q.get("overrides");
    overrides = raw ? (JSON.parse(raw) as Overrides) : {};
  } catch { return {}; }
  if (allowPromos) return overrides;
  const stripped: Overrides = {};
  for (const [resortId, ov] of Object.entries(overrides)) {
    if (!ov) continue;
    const { promoId, personalPromo, ...rest } = ov;
    stripped[resortId] = rest;
  }
  return stripped;
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
 *  client IP there — req.socket.remoteAddress alone would just be the proxy. */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "";
}

async function readBody(req: IncomingMessage): Promise<any> {
  const raw = await new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function compare(q: URLSearchParams, user: SessionUser | null) {
  const plus = isPlus(user?.plusUntil ?? null);
  const params = paramsFrom(q);
  const { gettingThere, flyBase, driveBase } = gettingThereParams(q);
  // Server-side gate, not just a hidden UI control: a non-Plus request never
  // gets promo effects, whatever the query string asks for.
  const overrides = overridesFrom(q, plus);
  const month = q.get("month") ?? todayISO().slice(0, 7);
  const [from, to] = monthBounds(month);
  // An explicit date prices exactly that day instead of scanning the month for
  // the cheapest one — how a calendar-cell click asks for that date's full
  // breakdown, and how a Plus user pins real travel dates instead of a month.
  const explicitDate = q.get("date");
  // Free users get the 19 pre-cached metros; Plus can depart from a smaller
  // airport they actually live near. Enforced here, not in the UI.
  const originPick = resolveOrigin(params.origin, plus);
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
  void recordSearch(db, params.origin, [...destinationByResort.values()], month);

  // A Plus traveller's attraction picks, read from their own row — never
  // from the query string. Same rule as promos: the client may say which
  // account it is (via the cookie), never what that account is entitled to.
  // A free request gets an empty list, so every resort's `attractions` comes
  // back absent and the board shows nothing rather than a teaser.
  const picks = plus && user ? await picksFor(db, user.id) : [];

  const results = RESORTS.map((resort) => {
    const iata = destinationByResort.get(resort.id)!;
    // A "Getting there" preset can send different resorts down different
    // legs in this same request (e.g. drive to WDW, fly to the rest) —
    // resortTransportMode() decides which baseline this resort gets.
    const mode = resortTransportMode(gettingThere, resort);
    const modeParams = mode === "drive" ? driveBase : flyBase;
    const resortParams = { ...params, ...modeParams, destination: iata };
    const { best, skipped } = cheapestIn(book, resort, resortParams, overrides, dates);
    // Deliberately attached to the row and NOT used for ordering. The board
    // stays sorted by price — this is the app's one job — and the match is
    // context for what a cheaper total would cost you in attractions.
    const m = picks.length ? matchesForResort(resort.id, picks) : null;
    const attractions = m
      ? { ...m, summary: matchSummary(m, picks.length) }
      : undefined;
    return best
      ? { resortId: resort.id, name: resort.name, iata, ok: true as const, price: best, attractions }
      : { resortId: resort.id, name: resort.name, iata, ok: false as const, reason: skipped[0] ?? "no data", attractions };
  }).sort((a, b) => (a.ok ? a.price.total : Infinity) - (b.ok ? b.price.total : Infinity));

  return {
    month, pricesAsOf: book.oldestFetchedAt,
    params: { ...params, gettingThere },
    // Present only when a free request asked for a Plus airport, so the UI can
    // say which airport it actually priced rather than silently substituting.
    originDowngrade: originPick.downgradedFrom
      ? { requested: originPick.downgradedFrom, priced: originPick.downgradedTo }
      : undefined,
    exactDate: explicitDate ?? undefined,
    /** How many picks the matches above were measured against, so the UI can
     *  say "3 of your 5" without a second request. */
    attractionPicks: picks.length,
    results,
  };
}

async function calendar(q: URLSearchParams, user: SessionUser | null) {
  const plus = isPlus(user?.plusUntil ?? null);
  const params = paramsFrom(q);
  const { gettingThere, flyBase, driveBase } = gettingThereParams(q);
  const overrides = overridesFrom(q, plus);
  const resort = RESORT_BY_ID.get(q.get("resort") ?? "wdw");
  if (!resort) return { error: "unknown resort" };
  const mode = resortTransportMode(gettingThere, resort);
  Object.assign(params, mode === "drive" ? driveBase : flyBase);
  params.destination = resolveDestination(resort, q.get("destination"));
  const from = q.get("from") ?? addDaysISO(todayISO(), 1);
  const to = q.get("to") ?? addDaysISO(from, 364);
  const book = await loadBook(db, {
    origin: params.origin, destinations: [params.destination], resortIds: [resort.id],
    from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
  });
  const days = range(from, to).map((d) => {
    const r = priceTrip(book, resort, params, overrides, d);
    return r.ok ? { date: d, total: Math.round(r.price.total) } : { date: d, total: null };
  });
  return { resortId: resort.id, destination: params.destination, pricesAsOf: book.oldestFetchedAt, days };
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
    `select id, resort_id, label, effect_kind, effect_value, starts_on, ends_on, historical, source_note
       from promos where ${where} order by starts_on`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, resortId: r.resort_id ?? null, label: r.label,
    effectKind: r.effect_kind, effectValue: Number(r.effect_value),
    startsOn: dateStr(r.starts_on), endsOn: dateStr(r.ends_on),
    historical: Boolean(r.historical), sourceNote: r.source_note ?? "",
  }));
}

/** Origins as the trip form needs them: the airport, plus which "Getting
 *  there" preset suits someone departing from it (see gettingThere.ts). */
function withSuggestedMode(origins: typeof ORIGINS) {
  return origins.map((o) => ({ ...o, suggestedGettingThere: defaultGettingThere(o.iata) }));
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
    if (url.pathname === "/" || url.pathname === "/prototype.html") {
      const file = await readFile(new URL("prototype.html", PUBLIC_DIR));
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(file);
    }
    if (url.pathname.startsWith("/public/")) {
      const name = url.pathname.slice("/public/".length);
      const file = await readFile(new URL(name, PUBLIC_DIR));
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream" });
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
    if (url.pathname === "/api/meta") return send(200, {
      origins: withSuggestedMode(ORIGINS),
      plusOrigins: withSuggestedMode(PLUS_ORIGINS),
      // The order to OFFER them in — by city, free and Plus interleaved.
      // Sent as codes rather than a third copy of the airports, so the rule
      // itself stays in config.ts and the browser only obeys it.
      originOrder: ORIGINS_BY_CITY.map((o) => o.iata),
      resorts: RESORTS,
      // Typical weather per resort per month. Its own key rather than folded
      // onto each Resort: 72 rows would bury the resort definitions, and
      // nothing that prices a trip reads it.
      climate: CLIMATE,
    }, { cache: "public, max-age=300" });

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
      try {
        const user = isSignup
          ? await signUp(db, body.email, password)
          : await signIn(db, body.email, password);
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
          // 401 for a credential mismatch, 400 for something the form can
          // fix (bad address, weak password, wrong form entirely).
          return send(e.reason === "bad_credentials" ? 401 : 400,
            { error: e.reason, message: e.message });
        }
        throw e;
      }
    }
    // Clicked from an inbox, so it answers with a page rather than JSON.
    if (url.pathname === "/api/auth/verify" && req.method === "GET") {
      const result = await verifyEmailToken(db, url.searchParams.get("token") ?? "");
      const page = (title: string, body: string) =>
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>${title} · Parkfare</title>`
        + `<div style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem">`
        + `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p>`
        + `<p><a href="/">Back to Parkfare</a></p></div>`;
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
      const exactFare = plus
        ? { perDay: limitsFromEnv().perUserPerDay, remainingToday: await remainingForUser(db, user.id) }
        : null;
      return send(200, {
        authenticated: true, email: user.email, plus, plusUntil: user.plusUntil,
        homeAirport: user.homeAirport, emailVerified: user.emailVerified, exactFare,
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
      // An explicit null clears it. `undefined` would be ambiguous with "not
      // sent", so the client always sends the key.
      const raw = body.homeAirport;
      try {
        const homeAirport = await setHomeAirport(db, user.id, raw ? String(raw) : null);
        return send(200, { ok: true, homeAirport }, { cache: "no-store" });
      } catch (e) {
        // 402 for the Plus case so it reads the same as every other paywalled
        // route, 400 for a code we simply don't know. Disabling the option in
        // the form is only the cosmetic half — this is the half that counts.
        if (e instanceof HomeAirportError) {
          return send(e.reason === "plus_required" ? 402 : 400,
            { error: e.reason, message: e.message });
        }
        throw e;
      }
    }

    // The attraction list itself is public — facts about what each resort
    // has, the same way a curated promo is public to browse. What Plus buys
    // is the personalisation: picking yours and having the board answer.
    if (url.pathname === "/api/attractions") {
      return send(200, ATTRACTIONS.map((a) => ({
        ...a, onlyAt: isOnlyAt(a) ? a.resortIds[0] : null,
      })), { cache: "public, max-age=300" });
    }

    if (url.pathname === "/api/profile/attractions") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (!isPlus(user.plusUntil)) {
        return send(402, {
          error: "plus_required",
          message: "Choosing the attractions you care about is a Plus feature. Browsing what each resort has is free.",
        });
      }
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
    if (url.pathname === "/api/plus/request" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign in first" });
      const body = await readBody(req);
      const plan = body.plan === "yearly" ? "yearly ($19/year)" : "trip pass ($9/90 days)";
      const owner = process.env.OWNER_EMAIL;
      if (owner) {
        await pickEmailSender().send({
          to: owner,
          subject: `Parkfare: ${user.email} wants Plus`,
          text: `${user.email} picked "${plan}" in the paywall.\n\nGrant it with:\n  npm run grant-plus -- ${user.email} 90`,
        });
      }
      return send(200, { ok: true, delivered: Boolean(owner) });
    }

    // --- pricing: reads the cache, personalized only by what the signed-in ---
    // --- user is entitled to (compare()/calendar() decide that internally). ---
    if (url.pathname === "/api/compare" || url.pathname === "/api/calendar") {
      const user = await currentUser(db, req);
      const body = url.pathname === "/api/compare" ? await compare(url.searchParams, user) : await calendar(url.searchParams, user);
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
    // --- exact live fare: signed in and Plus. The one route where a user's
    // click spends metered provider money, which is exactly why it is
    // paywalled. Plus is resolved from the session cookie against the
    // database here — never from anything the client sends.
    if (url.pathname === "/api/exact-fare" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required", message: "Sign in to check exact fares." });
      if (!isPlus(user.plusUntil)) {
        return send(402, {
          error: "plus_required",
          message: "Exact live fares are a Plus feature. The estimate is free and unlimited.",
        });
      }
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

      // Same free/Plus airport rule as compare(). A Plus user is by
      // definition allowed any of them, so this only ever normalises.
      const { origin: pricedOrigin } = resolveOrigin(origin, true);
      const result = await fetchExactFare(db, {
        userId: user.id, origin: pricedOrigin, destination, departDate, tripLength: bucketFor(nights),
      });
      // 200 even on a refusal: "you're out of checks for today" is a normal
      // answer the UI shows inline, not an error condition.
      return send(200, result, { cache: "no-store" });
    }

    // --- saved trips: signed in and Plus, always the caller's own rows. ---
    if (url.pathname === "/api/trips" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required", message: "Saved trips and alerts are a Plus feature." });
      const t = await readBody(req);
      const id = randomUUID();
      const params = { ...(t.params ?? {}) };
      // A saved trip is always one specific resort, but params.gettingThere
      // (if present) is a whole-board preset that can mean different things
      // per resort (e.g. "drive to WDW, fly everywhere else"). Resolve it to
      // a concrete transportMode/originPoint/overnightStop/rentalCar for
      // *this* resort now, at save time — the alert job re-prices one saved
      // trip at a time and has no notion of "Getting there" presets, so it
      // needs the resolved shape, the same one compare() builds per resort.
      const savedResort = RESORT_BY_ID.get(params.resortId);
      if (savedResort && params.gettingThere) {
        const asQuery = new URLSearchParams(
          Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
        );
        const { gettingThere, flyBase, driveBase } = gettingThereParams(asQuery);
        const mode = resortTransportMode(gettingThere, savedResort);
        Object.assign(params, mode === "drive" ? driveBase : flyBase);
      }
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
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
      const { rows } = await db.query(
        `select id, label, params, overrides, baseline_total, active, created_at from saved_trips
          where user_id = $1 order by created_at desc`, [user.id]);
      // params/overrides are returned so a saved trip can be REOPENED, not
      // just listed — without them the list was a read-only receipt and the
      // only way back to a trip you had saved was to key it in again.
      // They are the user's own row, already Plus-gated above.
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
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
      await db.query(`delete from saved_trips where id = $1 and user_id = $2`, [tripMatch[1], user.id]);
      return send(200, { ok: true });
    }

    // --- custom planning expenses: free-form Plus line items (VIP tours, ---
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
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
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
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required" });
      const owns = await db.query(`select 1 from saved_trips where id = $1 and user_id = $2`, [expenseMatch[1], user.id]);
      if (!owns.rows[0]) return send(404, { error: "not found" });
      await db.query(`delete from custom_expenses where id = $1 and trip_id = $2`, [expenseMatch[2], expenseMatch[1]]);
      return send(200, { ok: true });
    }

    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => console.log(`parkfare api on :${PORT} (${db.kind})`));
