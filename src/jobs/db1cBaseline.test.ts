import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { aggregateDb1cFile, turnaround } from "./db1cBaseline.js";

test("turnaround: out-and-back paths only, the middle airport is the destination", () => {
  assert.deepEqual(turnaround("BNA:SFO:BNA"), { origin: "BNA", destination: "SFO" });
  assert.deepEqual(turnaround("AVP:IAD:BNA:IAD:AVP"), { origin: "AVP", destination: "BNA" });
  assert.equal(turnaround("MCO:IAH:DEN"), null);      // open jaw
  assert.equal(turnaround("ABQ:DEN"), null);          // one way
  assert.equal(turnaround("ATL:MCO:ATL:MCO"), null);  // even length
});

// Header and rows copied from the real March 2026 file's shape.
const HEAD = "ItinID,Coupons,RpYear,RpQuarter,RpMonth,SchFlYear,SchFlQuarter,SchFlMonth,Origin,AirportGroupString,RoundTrip,Passengers,TotalAmount,TaxAmount,PurchaseWindowGroup";
const row = (path: string, rt: string, pax: string, total: string, win = "21AP", month = "3") =>
  `1,2,2026,1,3,2026,1,${month},X,${path},${rt},${pax},${total},10.00,${win}`;

test("aggregate: round trips into our resort airports, whole-ticket fare, weighted, junk dropped", async () => {
  const csv = [HEAD,
    row("BNA:MCO:BNA", "1.00", "1.00", "300.00"),
    row("BNA:ATL:MCO:ATL:BNA", "1.00", "3.00", "400.00", "2290"),
    row("BNA:MCO:BNA", "1.00", "1.00", "5.60"),          // award ticket, dropped
    row("BNA:MCO", "0.00", "1.00", "150.00"),            // one way, dropped
    row("BNA:DEN:BNA", "1.00", "1.00", "250.00"),        // not a resort airport
    row("BNA:MCO:BNA", "1.00", "1.00", "320.00", "21AP", "4"),
  ].join("\n");
  const out = await aggregateDb1cFile(Readable.from([csv]), {
    origins: new Set(["BNA"]), destinations: new Set(["MCO"]),
  });
  const march = out.find((r) => r.month === 3)!;
  assert.equal(out.length, 2);                 // March and April are separate months
  assert.equal(march.itinCount, 2);
  assert.equal(march.passengersSampled, 4);
  assert.equal(march.medianFareUsd, 400);      // 3 passengers at $400 outweigh 1 at $300
  assert.equal(march.avgFareUsd, 375);
  assert.deepEqual(march.purchaseWindow, { "21AP": 1, "2290": 3 });
});

test("the monthly correction is measured against the monthly survey for the same calendar month", async () => {
  const { memoryDb } = await import("../db.js");
  const { computeFareTrend } = await import("./fareTrend.js");
  const db = await memoryDb();
  for (const [o, med, bought] of [["ATL", 400, 440], ["BNA", 300, 330], ["CLT", 350, 385]] as const) {
    await db.query(
      `insert into historical_fares_monthly (origin,destination,year,month,avg_fare_usd,median_fare_usd,p25_fare_usd,p75_fare_usd,itin_count)
       values ($1,'MCO',2026,3,$2,$2,$2,$2,100)`, [o, med]);
    await db.query(
      `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
       values ($1,'MCO','2027-03-15',7,$2,0,'serpapi_flights',now())`, [o, bought]);
  }
  const t = await computeFareTrend(db, "domestic_monthly");
  assert.equal(t?.sampleRoutes, 3);
  const row = await db.query(`select multiplier, kind from fare_trend`);
  assert.equal(Number(row.rows[0].multiplier), 1.1);
  assert.equal(row.rows[0].kind, "domestic_monthly");
  await db.close();
});

test("aggregate: the airlines on a route, the budget airlines' share and the median without them", async () => {
  const H = "ItinID,SchFlYear,SchFlMonth,AirportGroupString,RoundTrip,Passengers,TotalAmount,PurchaseWindowGroup,IssuingCarrier";
  const r = (fare: string, carrier: string, pax = "1.00", win = "21AP") => `1,2026,3,RDU:MCO:RDU,1.00,${pax},${fare},${win},${carrier}`;
  const csv = [H,
    r("120.00", "NK", "2.00"), r("140.00", "F9"),
    r("300.00", "DL"), r("320.00", "DL"), r("340.00", "WN"),
    r("310.00", "DL", "1.00", "2290"), r("315.00", "DL", "1.00", "2290"), r("320.00", "DL", "1.00", "2290"),
    r("325.00", "DL", "1.00", "2290"), r("330.00", "DL", "1.00", "2290"),
  ].join("\n");
  const [m] = await aggregateDb1cFile(Readable.from([csv]), { origins: new Set(["RDU"]), destinations: new Set(["MCO"]) });
  assert.deepEqual(m!.carriers, { NK: 2, F9: 1, DL: 7, WN: 1 });
  assert.equal(m!.budgetShare, 0.273);            // 3 of 11 passengers
  assert.equal(m!.medianNoBudgetUsd, 320);        // Delta and Southwest only
  assert.ok(m!.medianFareUsd < 320, "budget fares pull the plain median down");
  assert.equal(m!.windowMedians["2290"], 320);    // five tickets in that window
  assert.equal(m!.windowMedians["21AP"], 140);    // budget-heavy window: cheap
  const few = await aggregateDb1cFile(Readable.from([[H, r("300.00", "DL")].join("\n")]),
    { origins: new Set(["RDU"]), destinations: new Set(["MCO"]) });
  assert.deepEqual(few[0]!.windowMedians, {}, "a window with fewer than 5 tickets gets no median");
});

test("aggregate: a file without the airline column still loads, with no airline figures", async () => {
  const csv = [HEAD, row("BNA:MCO:BNA", "1.00", "1.00", "300.00")].join("\n");
  const [m] = await aggregateDb1cFile(Readable.from([csv]), { origins: new Set(["BNA"]), destinations: new Set(["MCO"]) });
  assert.deepEqual(m!.carriers, {});
  assert.equal(m!.budgetShare, null);
  assert.equal(m!.medianNoBudgetUsd, null);
});
