import { test } from "node:test";
import assert from "node:assert/strict";
import { fitRidge, solve, runStudy, rng, featuresOf, INDICATORS, type Indicator } from "./indicatorStudy.js";

test("solve: a small linear system", () => {
  const x = solve([[2, 1], [1, 3]], [3, 5]);
  assert.ok(Math.abs(x[0]! - 0.8) < 1e-9 && Math.abs(x[1]! - 1.4) < 1e-9);
});

test("fitRidge recovers known coefficients in original units, with a dead column left at 0", () => {
  const r = rng(1);
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 300; i++) {
    const a = r() * 10, b = r() < 0.5 ? 1 : 0;
    X.push([a, b, 7]);
    y.push(2 + 0.3 * a - 0.5 * b);
  }
  const f = fitRidge(X, y, 0.001);
  assert.ok(Math.abs(f.beta[0]! - 0.3) < 0.01);
  assert.ok(Math.abs(f.beta[1]! + 0.5) < 0.01);
  assert.equal(f.beta[2], 0);
});

test("runStudy finds a real effect, calls a constant one 'can't tell yet', and beats the plain model", () => {
  const r = rng(3);
  const inds: Indicator[] = [
    { key: "miles", label: "m", unit: "1,000 more miles", step: 1, source: "" },
    { key: "europe", label: "e", unit: "Europe", step: 1, source: "" },
    { key: "asia", label: "a", unit: "Asia", step: 1, source: "" },
    { key: "weekend", label: "w", unit: "weekend", step: 1, source: "" },
  ];
  const X: number[][] = [], P: number[] = [];
  for (let i = 0; i < 200; i++) {
    const miles = 0.5 + r() * 3, eu = r() < 0.3 ? 1 : 0, as = !eu && r() < 0.3 ? 1 : 0;
    X.push([miles, eu, as, 0]);                  // nobody leaves on a weekend
    P.push(Math.exp(5 + 0.25 * miles + 0.3 * eu + 0.5 * as + (r() - 0.5) * 0.1));
  }
  const s = runStudy(X, P, inds, "structure", 100);
  const miles = s.effects.find((e) => e.key === "miles")!;
  assert.equal(miles.verdict, "solid");
  assert.ok(Math.abs(miles.effectPct! - 28.4) < 3);   // e^0.25 - 1
  assert.equal(s.effects.find((e) => e.key === "weekend")!.verdict, "can't tell yet");
  assert.ok(s.cv!.medianOffPct < s.plainCv!.medianOffPct);
});

test("featuresOf: places a real fare, and refuses one it can't place", () => {
  const hub = new Map([["ATL", 100000]]);
  const x = featuresOf({ origin: "ATL", destination: "CDG", departDate: "2027-07-16", observedAt: "2026-10-10T10:00:00Z", price: 1000 }, hub, false)!;
  assert.equal(x.length, INDICATORS.length - 1);
  assert.equal(x[1], 1);       // Europe
  assert.equal(x[4], 1);       // July-September
  assert.equal(x[6], 1);       // 2027-07-16 is a Friday
  assert.equal(featuresOf({ origin: "ZZZ", destination: "CDG", departDate: "2027-07-16", observedAt: "2026-10-10", price: 1 }, hub, false), null);
  assert.equal(featuresOf({ origin: "ATL", destination: "CDG", departDate: "2027-07-16", observedAt: "2026-10-10", price: 1 }, hub, true), null);
});
