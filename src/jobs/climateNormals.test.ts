import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyNormals, validateYear, rowIsPlausible, fetchDaily, renderFile, retryAfterMs,
  RAIN_DAY_INCHES, type DailyObservation, type NormalRow,
} from "./climateNormals.js";

/**
 * The generator's arithmetic is tested hard and its HTTP call is stubbed,
 * because the sandbox this was written in cannot reach Open-Meteo — so the
 * network shape is the one thing these tests genuinely cannot prove. Every
 * other provider in this project carries the same caveat; the response is to
 * make the part that CAN be checked airtight, and to have the job refuse to
 * write anything it can't validate.
 */

function days(spec: { date: string; high?: number | null; low?: number | null; precip?: number | null }[]): DailyObservation[] {
  return spec.map((s) => ({
    date: s.date,
    highF: s.high === undefined ? 70 : s.high,
    lowF: s.low === undefined ? 50 : s.low,
    precipIn: s.precip === undefined ? 0 : s.precip,
  }));
}

test("averages the highs and lows of each calendar month separately", () => {
  const rows = monthlyNormals(days([
    { date: "2020-01-01", high: 70, low: 50 },
    { date: "2020-01-02", high: 80, low: 60 },
    { date: "2020-07-01", high: 90, low: 70 },
    { date: "2020-07-02", high: 100, low: 80 },
  ]));
  assert.deepEqual(rows[0]?.slice(0, 2), [75, 55], "January");
  assert.deepEqual(rows[6]?.slice(0, 2), [95, 75], "July");
  assert.equal(rows[1], null, "a month with no observations is null, not zero");
});

test("rain days are per YEAR, not a raw count across the window", () => {
  // Three Januaries, two rainy days in each. The answer is 2, not 6.
  const spec = [];
  for (const y of [2020, 2021, 2022]) {
    spec.push({ date: `${y}-01-01`, precip: 0.5 });
    spec.push({ date: `${y}-01-02`, precip: 0.5 });
    spec.push({ date: `${y}-01-03`, precip: 0 });
  }
  const rows = monthlyNormals(days(spec));
  assert.equal(rows[0]?.[2], 2, "two rainy days in a typical January");
});

test("a trace of rain is not a rain day, and the threshold is inclusive", () => {
  const rows = monthlyNormals(days([
    { date: "2020-03-01", precip: RAIN_DAY_INCHES - 0.001 },
    { date: "2020-03-02", precip: RAIN_DAY_INCHES },
    { date: "2020-03-03", precip: 2 },
  ]));
  assert.equal(rows[2]?.[2], 2, "0.009in doesn't count; exactly 0.01in does");
});

test("missing readings are skipped, never treated as zero", () => {
  // The failure this prevents: a null temperature averaged in as 0°F drags a
  // month 20 degrees cold, and a null precipitation read as 0 invents a dry day.
  const rows = monthlyNormals(days([
    { date: "2020-05-01", high: 80, low: 60, precip: 1 },
    { date: "2020-05-02", high: null, low: null, precip: null },
  ]));
  assert.deepEqual(rows[4], [80, 60, 1], "the one real day is the average");
});

test("a month with only null readings is null rather than a fabricated row", () => {
  const rows = monthlyNormals(days([{ date: "2020-05-01", high: null, low: null, precip: null }]));
  assert.equal(rows[4], null);
});

test("garbage dates are ignored instead of averaged into a month", () => {
  const rows = monthlyNormals([
    { date: "2020-01-01", highF: 70, lowF: 50, precipIn: 0 },
    { date: "not-a-date", highF: 500, lowF: 400, precipIn: 99 },
    { date: "2020-13-01", highF: 500, lowF: 400, precipIn: 99 },
  ]);
  assert.deepEqual(rows[0]?.slice(0, 2), [70, 50]);
  assert.ok(rows.every((r, i) => i === 0 || r === null));
});

test("validateYear refuses an incomplete or impossible year", () => {
  const good = Array.from({ length: 12 }, () => [80, 60, 5] as NormalRow);
  assert.equal(validateYear(good).ok, true);

  const gap: (NormalRow | null)[] = [...good]; gap[3] = null;
  const g = validateYear(gap);
  assert.equal(g.ok, false);
  assert.match(g.ok === false ? g.reason : "", /month\(s\) 4/);

  const flipped = [...good]; flipped[5] = [50, 90, 5];
  const f = validateYear(flipped);
  assert.equal(f.ok, false, "a low above the high is a transposed row, not a climate");
  assert.match(f.ok === false ? f.reason : "", /month 6/);

  assert.equal(validateYear(good.slice(0, 11)).ok, false, "eleven months is not a year");
});

test("rowIsPlausible catches a units mix-up", () => {
  assert.ok(rowIsPlausible([92, 74, 17]));
  // Celsius left in by mistake: 33/23 is "plausible" as °F and this check
  // cannot catch it — which is why the generator asks for fahrenheit
  // explicitly rather than converting, and why the summary prints July.
  assert.ok(!rowIsPlausible([200, 74, 17]), "200F is not a place");
  assert.ok(!rowIsPlausible([92, 74, 40]), "40 rainy days in a month");
  assert.ok(!rowIsPlausible([74, 92, 5]), "high below low");
});

test("fetchDaily asks for fahrenheit and inches, one year at a time", async () => {
  const urls: string[] = [];
  const stub = (async (u: string) => {
    urls.push(String(u));
    const year = String(u).match(/start_date=(\d{4})/)![1];
    return Response.json({
      daily: {
        time: [`${year}-01-01`, `${year}-01-02`],
        temperature_2m_max: [70, 72],
        temperature_2m_min: [50, 52],
        precipitation_sum: [0, 0.5],
      },
    });
  }) as unknown as typeof fetch;

  const out = await fetchDaily(28.43, -81.31, 2021, 2023, stub);
  assert.equal(urls.length, 3, "one request per year");
  assert.equal(out.length, 6);
  for (const u of urls) {
    assert.match(u, /temperature_unit=fahrenheit/, "units must be explicit, not converted after the fact");
    assert.match(u, /precipitation_unit=inch/);
    assert.match(u, /latitude=28\.43&longitude=-81\.31/);
  }
  assert.deepEqual(out[1], { date: "2021-01-02", highF: 72, lowF: 52, precipIn: 0.5 });
});

test("fetchDaily gives up rather than returning a short year", async () => {
  const bad = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchDaily(1, 2, 2021, 2021, bad, { sleep: async () => {} }),
    /open-meteo 429 after \d+ retries/);

  const empty = (async () => Response.json({ daily: { time: [] } })) as unknown as typeof fetch;
  await assert.rejects(() => fetchDaily(1, 2, 2021, 2021, empty, { sleep: async () => {} }), /no daily rows/);
});

/* ---------------------------------------------------------------------------
 * Living inside the free allowance. These cover the exact failure that killed
 * the first real run: 120 requests fired flat out, four resorts in, 429.
 * ------------------------------------------------------------------------ */

test("a minutely limit is waited out, and the whole run slows down afterwards", async () => {
  // The point is not merely that the request is retried — it is that the pace
  // changes. Retrying at the same speed walks into the same wall.
  let calls = 0;
  const waits: number[] = [];
  const flaky = (async () => {
    calls++;
    return calls === 1
      ? new Response('{"error":true,"reason":"Minutely API request limit exceeded. Please try again in one minute."}', { status: 429 })
      : Response.json({ daily: { time: ["2021-01-01"], temperature_2m_max: [70],
          temperature_2m_min: [50], precipitation_sum: [0] } });
  }) as unknown as typeof fetch;

  const pace = { pauseMs: 250 };
  const out = await fetchDaily(1, 2, 2021, 2021, flaky,
    { sleep: async (ms) => { waits.push(ms); } }, pace);

  assert.equal(out.length, 1, "the year came back after the wait");
  assert.ok(waits.includes(60_000), "it waited the minute the response asked for");
  assert.ok(pace.pauseMs > 250, `the pace slowed for everything after it (was ${pace.pauseMs}ms)`);
});

test("a daily limit fails immediately, because waiting a minute cannot clear it", async () => {
  // Spending eight minute-long retries to discover this produces the same
  // failure half an hour later and tells the owner nothing new.
  let calls = 0;
  const capped = (async () => {
    calls++;
    return new Response('{"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."}', { status: 429 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => fetchDaily(1, 2, 2021, 2021, capped, { sleep: async () => {} }),
    /waiting will not help today/);
  assert.equal(calls, 1, "it did not burn retries on a limit that a wait cannot clear");
});

test("a 400 is not retried — a wrong argument does not become right", async () => {
  let calls = 0;
  const wrong = (async () => { calls++; return new Response("bad latitude", { status: 400 }); }) as unknown as typeof fetch;
  await assert.rejects(() => fetchDaily(1, 2, 2021, 2021, wrong, { sleep: async () => {} }), /open-meteo 400/);
  assert.equal(calls, 1);
});

test("Retry-After is obeyed in both the forms servers send it", async () => {
  assert.equal(retryAfterMs("30"), 30_000, "seconds");
  const soon = new Date(Date.now() + 45_000).toUTCString();
  const fromDate = retryAfterMs(soon)!;
  assert.ok(fromDate > 40_000 && fromDate <= 45_000, `an HTTP date (got ${fromDate})`);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs("nonsense"), null, "and junk is ignored rather than becoming NaN");
});

test("the run shares one pace across all six resorts", async () => {
  // Per-resort pacing would reset to full speed at every resort and hit the
  // same ceiling again — the budget belongs to the account, not the request.
  let calls = 0;
  const gaps: number[] = [];
  const oneSlowStart = (async () => {
    calls++;
    return calls === 1
      ? new Response('{"reason":"Minutely API request limit exceeded."}', { status: 429 })
      : Response.json({ daily: {
          time: Array.from({ length: 365 }, (_, i) =>
            new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10)),
          temperature_2m_max: Array(365).fill(70),
          temperature_2m_min: Array(365).fill(50),
          precipitation_sum: Array(365).fill(0.5),
        } });
  }) as unknown as typeof fetch;

  const { runClimateNormals } = await import("./climateNormals.js");
  await runClimateNormals({
    years: 1, dryRun: true, fetchImpl: oneSlowStart,
    tuning: { sleep: async (ms) => { gaps.push(ms); }, onWait: () => {} },
  });
  // Six resorts, one 429 at the very start: every later request pays the
  // raised pause, so the slow-down outlived the resort that caused it.
  const pauses = gaps.filter((g) => g > 0 && g < 60_000);
  assert.ok(pauses.length >= 6, "every request paused");
  assert.ok(pauses[pauses.length - 1]! > pauses[0]!,
    "the pace raised by one resort's 429 still applied to the last resort");
});

test("the rendered file parses back to the same numbers", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => [70 + i, 50 + i, i] as NormalRow);
  const file = renderFile({ wdw: rows }, "test source");
  assert.match(file, /GENERATED DATA/);
  assert.match(file, /CLIMATE_SOURCE = "test source"/);
  // Round-trip it the way the compiler will: the point is that the generator
  // writes valid TypeScript with the values intact, not that it looks right.
  const asJs = file
    .replace(/export type[^\n]*\n/, "")            // the type alias
    .replace(/: Record<[^>]*>/, "");                // and the annotation on the export
  const mod = await import("data:text/javascript," + encodeURIComponent(asJs));
  assert.deepEqual(mod.CLIMATE_ROWS.wdw, rows);
  assert.equal(mod.CLIMATE_SOURCE, "test source");
});

test("the whole job runs: fetch, validate, render, write", async () => {
  // Everything except the network, exercised for real — the loop over all six
  // resorts, the per-resort validation, the file write. The sandbox can't
  // reach Open-Meteo, so this is as close to running it as is possible here.
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runClimateNormals } = await import("./climateNormals.js");
  const { RESORTS } = await import("../config.js");

  const seen: string[] = [];
  const stub = (async (u: string) => {
    const s = String(u);
    seen.push(s);
    const year = s.match(/start_date=(\d{4})/)![1]!;
    // A year of plausible weather: warm in July, cool in January, rain on
    // every third day, so each month lands somewhere believable.
    const time: string[] = [], hi: number[] = [], lo: number[] = [], pr: number[] = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        time.push(`${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
        const seasonal = 20 * Math.cos(((m - 7) / 12) * 2 * Math.PI);
        hi.push(70 + seasonal); lo.push(50 + seasonal); pr.push(d % 3 === 0 ? 0.5 : 0);
      }
    }
    return Response.json({ daily: { time, temperature_2m_max: hi, temperature_2m_min: lo, precipitation_sum: pr } });
  }) as unknown as typeof fetch;

  const out = join(mkdtempSync(join(tmpdir(), "climate-")), "climateData.ts");
  const r = await runClimateNormals({ years: 2, outPath: out, fetchImpl: stub });

  assert.equal(Object.keys(r.byResort).length, RESORTS.length, "every resort got a full year");
  assert.equal(seen.length, RESORTS.length * 2, "two years fetched per resort");
  for (const resort of RESORTS) {
    const rows = r.byResort[resort.id]!;
    assert.equal(rows.length, 12, `${resort.id}`);
    assert.ok(rows[6]![0] > rows[0]![0], `${resort.id}: July warmer than January in this fixture`);
    // 28 days a month, rain every third -> 9 rainy days.
    assert.equal(rows[6]![2], 9, `${resort.id}: rain days are per year, not summed over the window`);
  }
  const written = readFileSync(out, "utf8");
  assert.match(written, /Open-Meteo archive \(ERA5\), daily observations/);
  assert.match(written, /CLIMATE_ROWS/);
  assert.ok(RESORTS.every((x) => written.includes(`  ${x.id}: [`)), "all six resorts in the file");
});

test("one bad resort aborts the run instead of writing a half-table", async () => {
  const { runClimateNormals } = await import("./climateNormals.js");
  // Returns a single January day for every request: eleven months missing.
  const thin = (async () => Response.json({
    daily: { time: ["2023-01-01"], temperature_2m_max: [70], temperature_2m_min: [50], precipitation_sum: [0] },
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => runClimateNormals({ years: 1, outPath: "/tmp/should-never-be-written.ts", fetchImpl: thin }),
    /no data for month\(s\)/,
    "a partial fetch must never overwrite a good table",
  );
});
