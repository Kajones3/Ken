import { test } from "node:test";
import assert from "node:assert/strict";
import { resortTransportMode, defaultGettingThere } from "./gettingThere.js";
import { RESORTS, ORIGINS, PLUS_ORIGINS } from "./config.js";

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

/* ---------------------------------------------------------------------------
 * defaultGettingThere — the preset offered before the traveller touches
 * anything, decided by where they're departing from.
 * ------------------------------------------------------------------------ */

test("someone departing Los Angeles is set up to drive to Disneyland", () => {
  // The ask, and the fix for the gap the local-route rule opened: LAX has no
  // flight to Disneyland to show, so the board must offer the drive rather
  // than a blank cell where the nearest resort's price belongs.
  assert.equal(defaultGettingThere("LAX"), "driveDlr");
});

test("someone departing Tampa is set up to drive to Walt Disney World", () => {
  assert.equal(defaultGettingThere("TPA"), "driveWdw");
});

test("the local resort drives and the other five still fly", () => {
  // The preset already expresses this; the point of the test is that the
  // default lands on a preset with exactly that shape, not a drive-everything
  // one. A single board, five flights and one drive.
  const mode = defaultGettingThere("LAX");
  const drives = RESORTS.filter((r) => resortTransportMode(mode, r) === "drive");
  const flies = RESORTS.filter((r) => resortTransportMode(mode, r) === "fly");
  assert.deepEqual(drives.map((r) => r.id), ["dlr"]);
  assert.equal(flies.length, 5);
});

test("everybody else still gets 'flying to all'", () => {
  // The default must stay the default for almost everyone — this is a narrow
  // fix for people who live next to a resort, not a new general behaviour.
  for (const iata of ["ATL", "JFK", "DEN", "SEA", "ORD", "LAS", "MIA", "SFO"]) {
    assert.equal(defaultGettingThere(iata), "fly", `${iata} should still fly`);
  }
});

test("an unknown airport falls back to flying, never to a broken drive", () => {
  // A drive preset with an origin priceTrip can't place would fail the whole
  // board. Flying is the safe answer to "I don't know where you are".
  assert.equal(defaultGettingThere("XXX"), "fly");
  assert.equal(defaultGettingThere(""), "fly");
});

test("the suggestion never proposes driving to a resort across an ocean", () => {
  // priceTrip refuses a drive to any non-domestic resort, so a suggestion
  // that implied one would produce an unpriceable board.
  for (const o of [...ORIGINS, ...PLUS_ORIGINS]) {
    const mode = defaultGettingThere(o.iata);
    for (const r of RESORTS) {
      if (resortTransportMode(mode, r) === "drive") {
        assert.equal(r.region, "dom", `${o.iata} was told to drive to ${r.id}`);
      }
    }
  }
});
