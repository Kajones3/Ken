import { test } from "node:test";
import assert from "node:assert/strict";
import { fitAdditive, predictAdditive, looAdditive, score, routeShare, type Obs } from "./errorBudget.js";

// Synthetic fares: log fare = 6 + destination + origin + small noise.
const dests: Record<string, number> = { CDG: 0, HND: 0.4 };
const origins: Record<string, number> = { ATL: 0, SEA: -0.2, PHL: 0.2 };
const noise = [0.01, -0.02, 0.015, -0.01, 0.02, -0.015];
const rows: Obs[] = [];
let n = 0;
for (const d of Object.keys(dests)) for (const o of Object.keys(origins)) for (let k = 0; k < 3; k++) {
  rows.push({ y: 6 + dests[d]! + origins[o]! + noise[n++ % noise.length]!, keys: { all: "x", dest: d, origin: o } });
}

test("the additive model recovers destination and home-airport effects", () => {
  const m = fitAdditive(rows, ["all", "dest", "origin"], 0);
  const hnd = m.effects.get("dest")!.get("HND")! - m.effects.get("dest")!.get("CDG")!;
  const phl = m.effects.get("origin")!.get("PHL")! - m.effects.get("origin")!.get("SEA")!;
  assert.ok(Math.abs(hnd - 0.4) < 0.02, `HND ${hnd}`);
  assert.ok(Math.abs(phl - 0.4) < 0.02, `PHL-SEA ${phl}`);
});

test("leaving the home airport out costs accuracy when home airports differ", () => {
  const y = rows.map((r) => r.y);
  const without = score(looAdditive(rows, ["all", "dest"], 0), y);
  const withO = score(looAdditive(rows, ["all", "dest", "origin"], 0), y);
  assert.ok(withO.within10 > without.within10);
  assert.ok(withO.off < without.off);
});

test("score: within ±10%, typical miss and lean", () => {
  const s = score([Math.log(110), Math.log(100), Math.log(80)], [Math.log(100), Math.log(100), Math.log(100)]);
  assert.equal(s.within10, 67);
  assert.equal(s.off, 10);
  assert.equal(s.lean, 0);
});

test("route share: residuals that repeat on the same route are counted as the route's", () => {
  const sticky = routeShare([{ route: "a", r: 0.2 }, { route: "a", r: 0.21 }, { route: "b", r: -0.2 }, { route: "b", r: -0.19 }, { route: "c", r: 0.05 }, { route: "c", r: 0.04 }]);
  assert.ok(sticky.corr! > 0.9);
  const noisy = routeShare([{ route: "a", r: 0.2 }, { route: "a", r: -0.2 }, { route: "b", r: -0.2 }, { route: "b", r: 0.2 }, { route: "c", r: 0.1 }, { route: "c", r: -0.1 }]);
  assert.ok(noisy.corr! < -0.5);
});

test("predicting a row uses only the levels the model has seen", () => {
  const m = fitAdditive(rows, ["all", "dest", "origin"], 0);
  const unseen = predictAdditive(m, { y: 0, keys: { all: "x", dest: "PVG", origin: "ATL" } });
  assert.ok(Number.isFinite(unseen));
});

test("loader runs on an empty database", async () => {
  const { memoryDb } = await import("../db.js");
  const { errorBudget } = await import("./errorBudget.js");
  const db = await memoryDb();
  const lines = await errorBudget(db);
  assert.ok(lines[0]!.startsWith("## ERROR BUDGET"));
  await db.close();
});
