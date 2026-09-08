import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseCsvLine, aggregateDb1bFile } from "./btsBaseline.js";

// Real header confirmed 2026-09-08 against an actual downloaded 2024 Q4
// DB1B Market file — column order matters for this fixture (the parser
// itself reads names from the header, not hardcoded positions).
const HEADER =
  '"ItinID","MktID","MktCoupons","Year","Quarter","OriginAirportID","OriginAirportSeqID","OriginCityMarketID",' +
  '"Origin","OriginCountry","OriginStateFips","OriginState","OriginStateName","OriginWac","DestAirportID",' +
  '"DestAirportSeqID","DestCityMarketID","Dest","DestCountry","DestStateFips","DestState","DestStateName","DestWac",' +
  '"AirportGroup","WacGroup","TkCarrierChange","TkCarrierGroup","OpCarrierChange","OpCarrierGroup","RPCarrier",' +
  '"TkCarrier","OpCarrier","BulkFare","Passengers","MktFare","MktDistance","MktDistanceGroup","MktMilesFlown",' +
  '"NonStopMiles","ItinGeoType","MktGeoType",';

// A real ATL->MCO row from that same file (ItinID 202441907910, MktFare 105.04).
const REAL_ATL_MCO_ROW =
  '202441907910,20244190791003,1,2024,4,10397,1039707,30397,"ATL","US","13","GA","Georgia",34,13204,1320402,' +
  '31454,"MCO","US","12","FL","Florida",33,"ATL:MCO","34:33",0.00,"DL",0.00,"DL","DL","DL","DL",0.00,1.00,105.04,' +
  '404.00,1,404.00,404.00,2,2,';

test("parseCsvLine: splits a real BTS row into the expected number of fields", () => {
  const fields = parseCsvLine(REAL_ATL_MCO_ROW);
  assert.equal(fields.length, 42); // 41 real columns + one trailing empty field
  assert.equal(fields[8], "ATL");
  assert.equal(fields[17], "MCO");
  assert.equal(fields[33], "1.00");
  assert.equal(fields[34], "105.04");
});

test("parseCsvLine: unquoted numeric fields and quoted string fields both parse", () => {
  const fields = parseCsvLine('202441907910,"ATL",13,"Georgia",');
  assert.deepEqual(fields, ["202441907910", "ATL", "13", "Georgia", ""]);
});

function csv(...lines: string[]): Readable {
  return Readable.from([HEADER, ...lines].join("\n") + "\n");
}

test("aggregateDb1bFile: a real ATL->MCO row aggregates to itself with no halving/doubling", async () => {
  const agg = await aggregateDb1bFile(csv(REAL_ATL_MCO_ROW), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  });
  const route = agg.get("ATL|MCO");
  assert.ok(route);
  assert.equal(route!.avgFareUsd, 105.04);
  assert.equal(route!.passengersSampled, 1);
  assert.equal(route!.itinCount, 1);
});

test("aggregateDb1bFile: rows outside the origin/destination filter are dropped", async () => {
  const otherRoute = REAL_ATL_MCO_ROW.replace('"ATL"', '"SLC"');
  const agg = await aggregateDb1bFile(csv(otherRoute), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  });
  assert.equal(agg.size, 0);
});

test("aggregateDb1bFile: averages are passenger-weighted across multiple rows", async () => {
  const cheap = REAL_ATL_MCO_ROW.replace(",1.00,105.04,", ",1.00,100.00,"); // 1 passenger @ $100
  const expensive = REAL_ATL_MCO_ROW.replace(",1.00,105.04,", ",3.00,300.00,"); // 3 passengers @ $300
  const agg = await aggregateDb1bFile(csv(cheap, expensive), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  });
  const route = agg.get("ATL|MCO")!;
  // (1*100 + 3*300) / (1+3) = 250, not the plain average of 100 and 300 (200)
  assert.equal(route.avgFareUsd, 250);
  assert.equal(route.passengersSampled, 4);
});

test("aggregateDb1bFile: a zero/garbage fare row is skipped, never written as junk", async () => {
  const zeroFare = REAL_ATL_MCO_ROW.replace(",1.00,105.04,", ",1.00,0.00,");
  const agg = await aggregateDb1bFile(csv(zeroFare), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  });
  assert.equal(agg.size, 0);
});

test("aggregateDb1bFile: a missing/zero passenger count still counts as weight 1, not a divide-by-zero", async () => {
  const zeroPax = REAL_ATL_MCO_ROW.replace(",1.00,105.04,", ",0.00,105.04,");
  const agg = await aggregateDb1bFile(csv(zeroPax), {
    origins: new Set(["ATL"]), destinations: new Set(["MCO"]),
  });
  const route = agg.get("ATL|MCO")!;
  assert.equal(route.avgFareUsd, 105.04);
  assert.equal(route.passengersSampled, 1);
});
