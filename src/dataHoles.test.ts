import { test } from "node:test";
import assert from "node:assert/strict";
import { rankRouteHoles, ROTATION_PER_NIGHT, type RouteData } from "./dataHoles.js";

const route = (o: Partial<RouteData>): RouteData => ({
  origin: "ATL", destination: "MCO", resortId: "wdw", intl: false,
  btsQuarters: 4, btsMonths: 1, feed90: 10, paid90: 0, answers90: 0, searches: 0,
  inRotation: true, queuePlace: 0, ...o,
});

test("searched routes with no fares bought come first", () => {
  const h = rankRouteHoles([
    route({ origin: "ATL", paid90: 5, searches: 10 }),
    route({ origin: "CLT", paid90: 0, searches: 3 }),
    route({ origin: "DEN", paid90: 0, searches: 0 }),
  ], "2026-10-16", null);
  assert.deepEqual(h.map((x) => x.origin), ["CLT", "ATL", "DEN"]);
});

test("each hole gets one action", () => {
  const [rot] = rankRouteHoles([route({ queuePlace: ROTATION_PER_NIGHT * 2 })], "2026-10-16", null);
  assert.deepEqual(rot!.action, { kind: "rotation", byDate: "2026-10-19" });
  const [plus] = rankRouteHoles([route({ inRotation: false, queuePlace: null })], "2026-10-16", null);
  assert.equal(plus!.action.kind, "not in rotation");
  const [gov] = rankRouteHoles([route({ paid90: 3, btsMonths: 0 })], "2026-10-16", "March 2026");
  assert.deepEqual(gov!.action, { kind: "government", newestSurvey: "March 2026" });
  // International routes never wait on BTS: it surveys US flights only.
  const [intl] = rankRouteHoles([route({ intl: true, destination: "HND", paid90: 3, btsMonths: 0, btsQuarters: 0 })], "2026-10-16", null);
  assert.equal(intl!.action.kind, "rotation");
});

test("loader: an empty database lists every route and hotel month as a hole", async () => {
  const { memoryDb } = await import("./db.js");
  const { loadDataHoles } = await import("./dataHoles.js");
  const db = await memoryDb();
  const h = await loadDataHoles(db, new Date("2026-10-16T12:00:00Z"));
  assert.ok(h.routes.total > 200);
  assert.equal(h.routes.noPaid, h.routes.total);
  assert.equal(h.routes.holes.length, 25);
  assert.ok(h.routes.holes.every((r) => r.destination !== "SNA" && r.destination !== "TPA" && r.destination !== "NRT"));
  assert.equal(h.hotels.empty, h.hotels.total);
  await db.close();
});
