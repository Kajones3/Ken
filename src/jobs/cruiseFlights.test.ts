import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCruiseBuys, cruiseSlotsTonight, CRUISE_ONLY_AIRPORTS } from "./cruiseFlights.js";

const origins = [
  { iata: "ATL", lat: 33.64, lon: -84.43 },
  { iata: "MIA", lat: 25.79, lon: -80.29 },   // ~21 miles from Fort Lauderdale: drives
  { iata: "DEN", lat: 39.86, lon: -104.67 },
];
const sailings = [
  { airport: "FLL", sailDate: "2027-02-10", nights: 4 },
  { airport: "MCO", sailDate: "2027-02-11", nights: 3 },   // Disney World buying covers MCO
  { airport: "IAH", sailDate: "2028-01-05", nights: 5 },   // not on sale yet
];

test("cruise ports: about 50 searches a month", () => {
  let sum = 0;
  for (let d = 0; d < 30; d++) sum += cruiseSlotsTonight(d);
  assert.equal(sum, 50);
  assert.deepEqual([...CRUISE_ONLY_AIRPORTS].sort(), ["BCN", "FCO", "FLL", "IAH", "LHR", "SAN", "SIN", "SJU", "YVR"]);
});

test("demand first, exact sailing day, never a drive, a covered date or a date not on sale", () => {
  const buys = pickCruiseBuys({
    sailings, origins, n: 5, lastSaleDay: "2027-09-29",
    demand: [{ origin: "DEN", destination: "FLL", month: "2027-02", searches: 3 }],
    bought: [{ origin: "ATL", destination: "FLL", departDate: "2027-02-12" }],
  });
  assert.deepEqual(buys, [{ origin: "DEN", destination: "FLL", date: "2027-02-10", nights: 4, why: "demand" }]);
});

test("rotation fills the rest, never-bought pairs first", () => {
  const buys = pickCruiseBuys({
    sailings: [{ airport: "SAN", sailDate: "2027-03-01", nights: 4 }],
    origins, n: 2, lastSaleDay: "2027-09-29", demand: [],
    bought: [{ origin: "ATL", destination: "SAN", departDate: "2027-06-01" }],
  });
  assert.deepEqual(buys.map((b) => b.origin), ["DEN", "MIA"]);
});
