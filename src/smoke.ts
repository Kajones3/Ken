/**
 * End-to-end proof with no accounts and no network: apply the schema, run a
 * refresh through the mock provider, then price trips out of the cache exactly
 * the way the API server does. `npm run smoke`
 */
import { memoryDb } from "./db.js";
import { runRefresh } from "./jobs/refresh.js";
import { findAlerts, applyCap } from "./jobs/alerts.js";
import { loadBook } from "./book.js";
import { cheapestIn, type TripParams } from "./pricing.js";
import { RESORTS, bucketFor } from "./config.js";
import { monthBounds, range, addDaysISO } from "./dates.js";
import { randomUUID } from "node:crypto";

const MONTH = "2027-03";
const t0 = Date.now();
const db = await memoryDb();

console.log("1. refresh (mock provider, 4 origins, all 6 resorts, 1 month)");
const r = await runRefresh(db, {
  months: [MONTH], origins: ["ATL", "JFK", "ORD", "LAX"],
});
console.log(`   ${r.calls} provider calls -> ${r.rows.toLocaleString()} rows, ${r.errors} errors, ${Date.now() - t0}ms`);

console.log("2. price all six resorts from the cache");
const params: TripParams = {
  origin: "ATL", adults: 2, childAges: [11, 8, 2], nights: 6, parkDays: 4,
  stay: "on", tier: 1, food: "mix",
};
const [from, to] = monthBounds(MONTH);
const tQuery = Date.now();
const book = await loadBook(db, {
  origin: params.origin,
  destinations: RESORTS.map((x) => x.iata),
  resortIds: RESORTS.map((x) => x.id),
  from, to: addDaysISO(to, params.nights + 1), tripLength: bucketFor(params.nights),
});
const dates = range(from, addDaysISO(to, -params.nights));
const ranked = RESORTS.map((resort) => ({
  resort, ...cheapestIn(book, resort, params, {}, dates),
})).sort((a, b) => (a.best?.total ?? Infinity) - (b.best?.total ?? Infinity));
console.log(`   loaded + priced ${dates.length} dates x 6 resorts in ${Date.now() - tQuery}ms\n`);

for (const [i, row] of ranked.entries()) {
  if (!row.best) { console.log(`   ${i + 1}. ${row.resort.name.padEnd(24)} unavailable`); continue; }
  const b = row.best;
  console.log(
    `   ${i + 1}. ${row.resort.name.padEnd(24)} $${Math.round(b.total).toLocaleString().padStart(6)}` +
    `  flights $${Math.round(b.flights).toString().padStart(5)}` +
    `  tickets $${Math.round(b.tickets).toString().padStart(5)}` +
    `  hotel $${Math.round(b.hotel).toString().padStart(5)}` +
    `  food $${Math.round(b.food).toString().padStart(5)}   from ${b.start}`,
  );
}

console.log("\n3. save a trip and run the alert job");
const userId = randomUUID(), tripId = randomUUID();
await db.query(`insert into users (id,email) values ($1,$2)`, [userId, "you@example.com"]);
const top = ranked[0]!;
if (!top.best) { console.error("nothing priceable:", top.skipped.slice(0, 3)); process.exit(1); }
const baseline = top.best.total * 1.12;   // pretend prices were 12% higher when saved
await db.query(
  `insert into saved_trips (id,user_id,params,overrides,baseline_total,threshold_pct)
   values ($1,$2,$3,$4,$5,5)`,
  [tripId, userId, JSON.stringify({ ...params, month: MONTH, resortId: top.resort.id }),
   JSON.stringify({ [top.resort.id]: { nightly: 400 } }), baseline],
);
const { candidates, checked } = await findAlerts(db);
const fired = applyCap(candidates);
console.log(`   ${checked} trip checked, ${fired.length} alert(s), 0 provider calls`);
for (const c of fired) console.log(`   -> [${c.kind}] ${c.detail} (${c.dropPct.toFixed(1)}% better)`);

const runs = await db.query(`select job, calls, rows_written, errors from fetch_runs order by started_at`);
console.log("\n4. run log");
for (const row of runs.rows) console.log(`   ${row.job.padEnd(8)} calls=${row.calls} rows=${row.rows_written} errors=${row.errors}`);

await db.close();
console.log(`\ntotal ${Date.now() - t0}ms`);
