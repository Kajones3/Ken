/**
 * The API. Deliberately dependency-free — node:http and nothing else — because
 * every dependency is a thing that can break at 3am.
 *
 * Every endpoint reads the cache. None of them calls a provider.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { RESORTS, RESORT_BY_ID, ORIGINS, bucketFor, type TierIndex, type FoodStyle, type Stay } from "./config.js";
import { addDaysISO, monthBounds, range, todayISO } from "./dates.js";
import { getDb } from "./db.js";
import { loadBook } from "./book.js";
import { cheapestIn, priceTrip, type Overrides, type TripParams } from "./pricing.js";

const db = await getDb();
const PORT = Number(process.env.PORT ?? 8080);

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
  };
}
function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
}
function overridesFrom(q: URLSearchParams): Overrides {
  try {
    const raw = q.get("overrides");
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch { return {}; }
}

async function compare(q: URLSearchParams) {
  const params = paramsFrom(q);
  const overrides = overridesFrom(q);
  const month = q.get("month") ?? todayISO().slice(0, 7);
  const [from, to] = monthBounds(month);
  const book = await loadBook(db, {
    origin: params.origin,
    destinations: RESORTS.map((r) => r.iata),
    resortIds: RESORTS.map((r) => r.id),
    from, to: addDaysISO(to, params.nights + 1),
    tripLength: bucketFor(params.nights),
  });
  const dates = range(from, to);
  const results = RESORTS.map((resort) => {
    const { best, skipped } = cheapestIn(book, resort, params, overrides, dates);
    return best
      ? { resortId: resort.id, name: resort.name, iata: resort.iata, ok: true as const, price: best }
      : { resortId: resort.id, name: resort.name, iata: resort.iata, ok: false as const, reason: skipped[0] ?? "no data" };
  }).sort((a, b) => (a.ok ? a.price.total : Infinity) - (b.ok ? b.price.total : Infinity));

  return { month, pricesAsOf: book.oldestFetchedAt, params, results };
}

async function calendar(q: URLSearchParams) {
  const params = paramsFrom(q);
  const overrides = overridesFrom(q);
  const resort = RESORT_BY_ID.get(q.get("resort") ?? "wdw");
  if (!resort) return { error: "unknown resort" };
  const from = q.get("from") ?? addDaysISO(todayISO(), 1);
  const to = q.get("to") ?? addDaysISO(from, 364);
  const book = await loadBook(db, {
    origin: params.origin, destinations: [resort.iata], resortIds: [resort.id],
    from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
  });
  const days = range(from, to).map((d) => {
    const r = priceTrip(book, resort, params, overrides, d);
    return r.ok ? { date: d, total: Math.round(r.price.total) } : { date: d, total: null };
  });
  return { resortId: resort.id, pricesAsOf: book.oldestFetchedAt, days };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "public, max-age=300" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") {
      const { rows } = await db.query(
        `select max(finished_at) as last_refresh,
                (select count(*) from flight_prices) as flights,
                (select count(*) from hotel_rates) as hotels
           from fetch_runs where job = 'refresh' and errors = 0`);
      return send(200, { ok: true, db: db.kind, ...rows[0] });
    }
    if (url.pathname === "/api/meta") return send(200, { origins: ORIGINS, resorts: RESORTS });
    if (url.pathname === "/api/compare") return send(200, await compare(url.searchParams));
    if (url.pathname === "/api/calendar") return send(200, await calendar(url.searchParams));
    if (url.pathname === "/api/trips" && req.method === "POST") {
      const body = await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
      const t = JSON.parse(body || "{}");
      const id = randomUUID();
      await db.query(
        `insert into saved_trips (id,user_id,label,params,overrides,baseline_total,threshold_pct)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, t.userId, t.label ?? "", JSON.stringify(t.params ?? {}), JSON.stringify(t.overrides ?? {}),
         Number(t.baselineTotal ?? 0), Number(t.thresholdPct ?? 5)],
      );
      return send(201, { id });
    }
    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => console.log(`parkfare api on :${PORT} (${db.kind})`));
