import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memoryDb } from "./db.js";
import { loadBook } from "./book.js";
import { computeFareTrend } from "./jobs/fareTrend.js";

const seedRow = (d: Awaited<ReturnType<typeof memoryDb>>, origin: string, dest: string, med: number) => d.query(
  `insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,median_fare_usd,p25_fare_usd,p75_fare_usd,
     passengers_sampled,itin_count,source)
   values ($1,$2,2027,1,$3,$3,$3,$3,500,100,'seed_guess')`, [origin, dest, med]);

test("the seeded international guesses are relabeled once, and real baselines are left alone", async () => {
  const d = await memoryDb();
  await d.query(`insert into historical_fares (origin,destination,year,quarter,avg_fare_usd,passengers_sampled,itin_count,source)
                 values ('ATL','NRT',2027,1,924,500,100,'sampled_live'), ('ATL','CDG',2027,1,900,4,4,'sampled_live')`);
  await d.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const r = await d.query<{ destination: string; source: string }>(`select destination, source from historical_fares order by destination`);
  assert.deepEqual(r.rows.map((x) => [x.destination, x.source]), [["CDG", "sampled_live"], ["NRT", "seed_guess"]]);
  await d.close();
});

test("real international fares correct every seeded guess, through their own trend", async () => {
  const d = await memoryDb();
  for (const o of ["ATL", "BOS", "DEN", "JFK", "ORD", "SEA"]) await seedRow(d, o, "NRT", 1000);
  // Five routes bought at 1.4x the guess; SEA never bought.
  for (const o of ["ATL", "BOS", "DEN", "JFK", "ORD"]) {
    await d.query(`insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,source)
                   values ($1,'NRT','2027-02-10',7,1400,'serpapi_flights')`, [o]);
  }
  // Domestic needs its own trend: no domestic one here, and the intl one must not leak into it.
  assert.equal(await computeFareTrend(d, "domestic"), null);
  const t = await computeFareTrend(d, "intl");
  assert.ok(t && t.sampleRoutes === 5);
  const book = await loadBook(d, { origin: "SEA", destinations: ["NRT"], resortIds: ["tdr"], from: "2027-02-01", to: "2027-02-28", tripLength: 7 });
  const est = book.flightEstimate?.("SEA", "NRT");
  assert.equal(est?.med, 1400, "an unbought route moves by what the bought ones measured");
  assert.equal(est?.seedGuess, true);
  await d.close();
});

test("a seeded guess still prices before any international trend exists", async () => {
  const d = await memoryDb();
  await seedRow(d, "SEA", "NRT", 1000);
  const book = await loadBook(d, { origin: "SEA", destinations: ["NRT"], resortIds: ["tdr"], from: "2027-02-01", to: "2027-02-28", tripLength: 7 });
  assert.equal(book.flightEstimate?.("SEA", "NRT")?.med, 1000);
  await d.close();
});

test("Disney's own hotels cached as off-property are not offered as off-property picks", async () => {
  const d = await memoryDb();
  const ins = (id: string, name: string, on: boolean) => d.query(
    `insert into hotel_rates (resort_id, hotel_id, hotel_name, descriptor, stay_date, nightly_usd, tier, on_property, source)
     values ('wdw',$1,$2,'','2027-03-10',200,'budget',$3,'serpapi_hotels')`, [id, name, on]);
  await ins("serp-pop", "Disney's Pop Century Resort", false);
  await ins("serp-hi", "Hampton Inn Lake Buena Vista", false);
  await ins("wdw-pop", "Disney's Pop Century", true);
  const book = await loadBook(d, { origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"], from: "2027-03-10", to: "2027-03-10", tripLength: 7 });
  const names = book.hotelNights("wdw", "2027-03-10").map((h) => `${h.onProperty ? "on" : "off"}:${h.name}`).sort();
  assert.deepEqual(names, ["off:Hampton Inn Lake Buena Vista", "on:Disney's Pop Century"]);
  await d.close();
});
