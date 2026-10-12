import { test } from "node:test";
import assert from "node:assert/strict";
import { weekdayPattern } from "./dayOfWeek.js";

const f = (departDate: string, price: number, origin = "ATL") =>
  ({ origin, destination: "MCO", departDate, tripLength: 7, price });

test("compares weekdays inside one route-month, so route and season cancel", () => {
  // 2027-03-02 Tue, 03-05 Fri, 03-09 Tue, 03-12 Fri. ATL is cheap, BOS dear;
  // both have Friday 20% over Tuesday.
  const rows = [
    f("2027-03-02", 200), f("2027-03-09", 200), f("2027-03-05", 240), f("2027-03-12", 240),
    f("2027-03-02", 500, "BOS"), f("2027-03-09", 500, "BOS"), f("2027-03-05", 600, "BOS"), f("2027-03-12", 600, "BOS"),
  ];
  const p = weekdayPattern(rows);
  const tue = p.find((x) => x.day === 2)!, fri = p.find((x) => x.day === 5)!;
  assert.ok(Math.abs(fri.factor / tue.factor - 1.2) < 1e-9);
  assert.equal(fri.groups, 2);
});

test("a route-month with one weekday or too few fares teaches nothing", () => {
  assert.deepEqual(weekdayPattern([f("2027-03-02", 200), f("2027-03-09", 210), f("2027-03-16", 220)]), []);
  assert.deepEqual(weekdayPattern([f("2027-03-02", 200), f("2027-03-05", 240)]), []);
});
