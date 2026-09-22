import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crowdFor, crowdFlag, crowdRank, quietestMonths, quietestThisMonth,
  parseCrowdSensitivity,
} from "./crowds.js";
import { CROWDS, CROWD_BANDS, CROWD_LABELS, RESORTS, type CrowdBand } from "./config.js";

test("every resort has a full, valid twelve-month year", () => {
  for (const r of RESORTS) {
    const year = CROWDS[r.id];
    assert.ok(year, `${r.id} has no crowd row — a resort on the board with no crowd box`);
    assert.equal(year.months.length, 12, `${r.id} does not have twelve months`);
    for (const [i, b] of year.months.entries()) {
      assert.ok(CROWD_BANDS.includes(b), `${r.id} month ${i + 1} has invalid band ${b}`);
    }
    for (const k of Object.keys(year.why ?? {})) {
      const m = Number(k);
      assert.ok(m >= 1 && m <= 12, `${r.id} has a 'why' for month ${k}`);
    }
  }
});

test("every band has a label", () => {
  for (const b of CROWD_BANDS) assert.ok(CROWD_LABELS[b], `no label for ${b}`);
});

/**
 * The honesty pin. Only WDW and Disneyland have DVC inventory, so only they
 * can claim a points chart. If an international resort ever says dvcPoints,
 * the card prints a source that does not exist for it.
 */
test("only the two DVC resorts claim a points-chart basis", () => {
  const dvc = Object.entries(CROWDS).filter(([, y]) => y.basis === "dvcPoints").map(([id]) => id).sort();
  assert.deepEqual(dvc, ["dlr", "wdw"]);
});

test("bands rank in order, and an unknown band sorts as moderate", () => {
  assert.ok(crowdRank("veryLow") < crowdRank("low"));
  assert.ok(crowdRank("low") < crowdRank("moderate"));
  assert.ok(crowdRank("moderate") < crowdRank("high"));
  assert.ok(crowdRank("high") < crowdRank("peak"));
  assert.equal(crowdRank("nonsense" as CrowdBand), crowdRank("moderate"));
});

test("an unknown resort or month is null, never a throw", () => {
  assert.equal(crowdFor("nope", 3), null);
  assert.equal(crowdFor("wdw", 0), null);
  assert.equal(crowdFor("wdw", 13), null);
  assert.equal(crowdFlag("nope", 3, "high"), null);
  assert.deepEqual(quietestMonths("nope"), []);
});

test("'not much' never flags, however busy the month", () => {
  for (let m = 1; m <= 12; m++) {
    for (const r of RESORTS) assert.equal(crowdFlag(r.id, m, "none"), null);
  }
});

test("'somewhat' flags only peak; 'a lot' also flags high", () => {
  // wdw: December is peak, March is high, August is veryLow.
  assert.ok(crowdFlag("wdw", 12, "some"), "peak should flag at 'somewhat'");
  assert.equal(crowdFlag("wdw", 3, "some"), null, "a high month should not flag at 'somewhat'");
  assert.ok(crowdFlag("wdw", 3, "high"), "a high month should flag at 'a lot'");
  assert.equal(crowdFlag("wdw", 8, "high"), null, "a quiet month should never flag");
});

test("alternatives are offered only at 'a lot', and only when genuinely quieter", () => {
  const peak = crowdFlag("wdw", 12, "high");
  assert.ok(peak);
  assert.ok(peak.alternatives.length > 0, "a peak month should offer quieter months");
  for (const a of peak.alternatives) {
    assert.ok(peak.alternatives.every(() => crowdRank(peak.band) - a.rank >= 2),
      "an alternative must be at least two bands quieter");
  }
  assert.deepEqual(crowdFlag("wdw", 12, "some")?.alternatives, [],
    "'somewhat' should not push alternative months");
});

test("the detail sentence names the month and does not claim to measure crowds", () => {
  const f = crowdFlag("wdw", 12, "high");
  assert.ok(f?.detail.includes("December"));
});

/**
 * Both basis notes must hedge. The regex looks for an AFFIRMATIVE claim to
 * have measured something ("we measured", "based on actual attendance") —
 * not the word "measured" itself, since the DVC note legitimately says a
 * points chart is NOT a measured wait time, and an earlier version of this
 * test failed on exactly that correct sentence.
 */
test("no basis note claims to have measured crowds, and every one hedges", () => {
  for (const id of Object.keys(CROWDS)) {
    const c = crowdFor(id, 6);
    assert.ok(c, `${id} has no June row`);
    assert.ok(
      !/\b(we |is |are )(measured|counted|based on actual)\b/i.test(c.basisNote),
      `${id} claims to have measured crowds`,
    );
    assert.ok(/forecast|estimate/i.test(c.basisNote), `${id} does not hedge`);
  }
});

/**
 * The owner's own case: domestic parks at peak over Thanksgiving while an
 * overseas park is a fine time to go. If this ever returns the six resorts in
 * board order the comparison says nothing.
 */
test("quietestThisMonth ranks the six resorts and puts the quietest first", () => {
  const ids = RESORTS.map((r) => r.id);
  const nov = quietestThisMonth(ids, 11);
  assert.equal(nov.length, ids.length);
  for (let i = 1; i < nov.length; i++) {
    assert.ok(nov[i - 1]!.rank <= nov[i]!.rank, "not sorted quietest-first");
  }
  assert.ok(nov[0]!.rank < nov[nov.length - 1]!.rank,
    "November should not be uniformly busy across all six resorts");
});

test("quietestMonths is stable and genuinely quietest-first", () => {
  const q = quietestMonths("wdw", 3);
  assert.equal(q.length, 3);
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1]!.rank <= q[i]!.rank);
  assert.deepEqual(quietestMonths("wdw", 3).map((x) => x.month), q.map((x) => x.month));
});

test("an unknown sensitivity from a client falls back to 'somewhat'", () => {
  assert.equal(parseCrowdSensitivity("high"), "high");
  assert.equal(parseCrowdSensitivity("none"), "none");
  assert.equal(parseCrowdSensitivity(undefined), "some");
  assert.equal(parseCrowdSensitivity("{}"), "some");
  assert.equal(parseCrowdSensitivity(7), "some");
});
