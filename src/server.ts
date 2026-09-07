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
import { RESORTS, RESORT_BY_ID, ORIGINS, bucketFor, type TierIndex, type FoodStyle, type Stay } from "./config.js";
import { addDaysISO, monthBounds, range, todayISO } from "./dates.js";
import { getDb } from "./db.js";
import { loadBook, dateStr } from "./book.js";
import { cheapestIn, priceTrip, type AirportTransportChoice, type Overrides, type TripParams } from "./pricing.js";
import {
  currentUser, createSession, sessionTokenFrom, destroySession,
  sessionCookieHeader, clearCookieHeader, isPlus, type SessionUser,
} from "./auth.js";

const db = await getDb();
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = new URL("../public/", import.meta.url);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

/** Free for everyone — how you get there isn't a Plus feature, just a different
 *  way to answer "what does this trip cost". Gas-price *monitoring* (an alert
 *  when the price moves after you save a trip) is the actual Plus feature. */
function transportModeFrom(q: URLSearchParams): { transportMode?: TripParams["transportMode"]; overnightStop?: TripParams["overnightStop"]; milesPct?: number } {
  const mode = q.get("transportMode");
  if (mode !== "drive" && mode !== "miles") return {};
  if (mode === "drive") {
    const label = (q.get("overnightLabel") ?? "").slice(0, 80);
    const cost = Number(q.get("overnightCost") ?? 0);
    const overnightStop = label && Number.isFinite(cost) && cost > 0 ? { label, costUsd: cost } : null;
    return { transportMode: "drive", overnightStop };
  }
  const milesPct = clamp(Number(q.get("milesPct") ?? 0), 0, 100);
  return { transportMode: "miles", milesPct };
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
    stay: (["on", "off", "both"].includes(q.get("stay") ?? "") ? q.get("stay") : "on") as Stay,
    tier: clamp(Number(q.get("tier") ?? 1), 0, 2) as TierIndex,
    food: (["grocery", "qs", "mix", "ts", "plan"].includes(q.get("food") ?? "") ? q.get("food") : "mix") as FoodStyle,
    ...transportModeFrom(q),
  };
}
function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
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

/** Defaults to "auto" — a Plus user sees the real cost without an opt-in toggle they might miss. */
function airportTransportFrom(q: URLSearchParams): AirportTransportChoice {
  const raw = q.get("airportTransport");
  if (!raw) return { mode: "auto" };
  try {
    const parsed = JSON.parse(raw);
    const mode = (["auto", "parking", "rideshare", "transit", "custom"].includes(parsed.mode) ? parsed.mode : "auto") as AirportTransportChoice["mode"];
    const customAmount = Number.isFinite(parsed.customAmount) ? Number(parsed.customAmount) : undefined;
    return { mode, customAmount };
  } catch { return { mode: "auto" }; }
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
  // Server-side gate, not just a hidden UI control: a non-Plus request never
  // gets airport-transport pricing or promos, whatever the query string asks for.
  if (plus) params.airportTransport = airportTransportFrom(q);
  const overrides = overridesFrom(q, plus);
  const month = q.get("month") ?? todayISO().slice(0, 7);
  const [from, to] = monthBounds(month);
  // An explicit date prices exactly that day instead of scanning the month for
  // the cheapest one — how a calendar-cell click asks for that date's full breakdown.
  const explicitDate = q.get("date");
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
  const results = RESORTS.map((resort) => {
    const iata = destinationByResort.get(resort.id)!;
    const resortParams = { ...params, destination: iata };
    const { best, skipped } = cheapestIn(book, resort, resortParams, overrides, dates);
    return best
      ? { resortId: resort.id, name: resort.name, iata, ok: true as const, price: best }
      : { resortId: resort.id, name: resort.name, iata, ok: false as const, reason: skipped[0] ?? "no data" };
  }).sort((a, b) => (a.ok ? a.price.total : Infinity) - (b.ok ? b.price.total : Infinity));

  return { month, pricesAsOf: book.oldestFetchedAt, params, results };
}

async function calendar(q: URLSearchParams, user: SessionUser | null) {
  const plus = isPlus(user?.plusUntil ?? null);
  const params = paramsFrom(q);
  if (plus) params.airportTransport = airportTransportFrom(q);
  const overrides = overridesFrom(q, plus);
  const resort = RESORT_BY_ID.get(q.get("resort") ?? "wdw");
  if (!resort) return { error: "unknown resort" };
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code: number, body: unknown, opts: { cache?: string; headers?: Record<string, string> } = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": opts.cache ?? "no-store", ...opts.headers });
    res.end(JSON.stringify(body));
  };
  const withCookie = (setCookie: string) => ({ headers: { "set-cookie": setCookie } });
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
    if (url.pathname === "/api/meta") return send(200, { origins: ORIGINS, resorts: RESORTS }, { cache: "public, max-age=300" });

    // --- auth: an email and nothing else. Real enough to make Plus real; ---
    // --- explicitly not enough for a public launch (see src/auth.ts).    ---
    if (url.pathname === "/api/auth/signin" && req.method === "POST") {
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) return send(400, { error: "a valid email is required" });
      const { rows } = await db.query(
        `insert into users (id, email) values ($1,$2)
         on conflict (email) do update set email = excluded.email
         returning id, email, plus_until`,
        [randomUUID(), email],
      );
      const row = rows[0];
      const token = await createSession(db, row.id);
      const plusUntil = row.plus_until ? dateStr(row.plus_until) : null;
      return send(200, { email: row.email, plus: isPlus(plusUntil), plusUntil }, withCookie(sessionCookieHeader(token)));
    }
    if (url.pathname === "/api/auth/me") {
      const user = await currentUser(db, req);
      if (!user) return send(200, { authenticated: false });
      return send(200, { authenticated: true, email: user.email, plus: isPlus(user.plusUntil), plusUntil: user.plusUntil });
    }
    if (url.pathname === "/api/auth/signout" && req.method === "POST") {
      const token = sessionTokenFrom(req);
      if (token) await destroySession(db, token);
      return send(200, { ok: true }, withCookie(clearCookieHeader()));
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
    // --- saved trips: signed in and Plus, always the caller's own rows. ---
    if (url.pathname === "/api/trips" && req.method === "POST") {
      const user = await currentUser(db, req);
      if (!user) return send(401, { error: "sign_in_required" });
      if (!isPlus(user.plusUntil)) return send(402, { error: "plus_required", message: "Saved trips and alerts are a Plus feature." });
      const t = await readBody(req);
      const id = randomUUID();
      const params = { ...(t.params ?? {}) };
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
        `select id, label, params, baseline_total, active, created_at from saved_trips
          where user_id = $1 order by created_at desc`, [user.id]);
      return send(200, rows.map((r) => ({
        id: r.id, label: r.label, resortId: r.params?.resortId ?? null,
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

    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => console.log(`parkfare api on :${PORT} (${db.kind})`));
