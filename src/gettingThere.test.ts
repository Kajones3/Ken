import { test } from "node:test";
import assert from "node:assert/strict";
import { resortTransportMode } from "./gettingThere.js";
import { RESORTS } from "./config.js";

test("fly: every resort flies", () => {
  for (const r of RESORTS) assert.equal(resortTransportMode("fly", r), "fly", r.id);
});

test("flyMiles: every resort flies with miles", () => {
  for (const r of RESORTS) assert.equal(resortTransportMode("flyMiles", r), "miles", r.id);
});

test("driveWdw: only WDW drives, everyone else flies", () => {
  for (const r of RESORTS) {
    assert.equal(resortTransportMode("driveWdw", r), r.id === "wdw" ? "drive" : "fly", r.id);
  }
});

test("driveDlr: only Disneyland drives, everyone else flies", () => {
  for (const r of RESORTS) {
    assert.equal(resortTransportMode("driveDlr", r), r.id === "dlr" ? "drive" : "fly", r.id);
  }
});

test("driveDomestic: both domestic resorts drive, every international resort flies", () => {
  for (const r of RESORTS) {
    const expected = r.region === "dom" ? "drive" : "fly";
    assert.equal(resortTransportMode("driveDomestic", r), expected, r.id);
  }
  // Pin down which resorts that actually is, so a config change to `region` is caught.
  const driving = RESORTS.filter((r) => resortTransportMode("driveDomestic", r) === "drive").map((r) => r.id);
  assert.deepEqual(driving.sort(), ["dlr", "wdw"]);
});
