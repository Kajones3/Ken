import { test } from "node:test";
import assert from "node:assert/strict";
import { portPlaces, renderPortFile, runPortClimate } from "./portClimate.js";
import { PORT_CLIMATE_ROWS } from "../portClimateData.js";
import { HOME_PORTS, PORTS_OF_CALL } from "../cruiseFacts.js";

test("every home port and port of call has a place to read weather for", () => {
  const p = portPlaces();
  assert.equal(p.length, HOME_PORTS.length + PORTS_OF_CALL.length);
  assert.equal(new Set(p.map((x) => x.id)).size, p.length, "ids are unique");
  for (const x of p) assert.ok(Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180, x.id);
});

test("the committed table is twelve plausible months for any port it has", () => {
  for (const [id, rows] of Object.entries(PORT_CLIMATE_ROWS)) {
    assert.equal(rows.length, 12, id);
    for (const [hi, lo, rain] of rows) { assert.ok(hi > lo, id); assert.ok(rain >= 0 && rain <= 31, id); }
  }
});

test("the generator writes a table for every port from a stubbed fetch", async () => {
  const fetchImpl = (async (url: string) => {
    const y = /start_date=(\d{4})/.exec(String(url))![1];
    const time: string[] = [], hi: number[] = [], lo: number[] = [], pr: number[] = [];
    for (let d = new Date(`${y}-01-01T00:00:00Z`); d.getUTCFullYear() === +y!; d = new Date(d.getTime() + 864e5)) {
      time.push(d.toISOString().slice(0, 10)); hi.push(80); lo.push(65); pr.push(d.getUTCDate() % 5 === 0 ? 0.2 : 0);
    }
    return new Response(JSON.stringify({ daily: { time, temperature_2m_max: hi, temperature_2m_min: lo, precipitation_sum: pr } }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = `/tmp/port-climate-test-${process.pid}.ts`;
  const r = await runPortClimate({ years: 1, outPath: out, fetchImpl, tuning: { sleep: async () => {} } });
  assert.equal(Object.keys(r.rows).length, portPlaces().length);
  assert.match(r.file, /"cozumel": \[\[80, 65, \d+\]/);
  assert.match(renderPortFile({}, "x"), /PORT_CLIMATE_ROWS/);
});

test("a dropped connection is waited out and retried, not fatal", async () => {
  let calls = 0;
  const ok = (async (url: string) => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    const y = /start_date=(\d{4})/.exec(String(url))![1];
    return new Response(JSON.stringify({ daily: { time: [`${y}-01-01`], temperature_2m_max: [80], temperature_2m_min: [60], precipitation_sum: [0] } }), { status: 200 });
  }) as unknown as typeof fetch;
  const { fetchDaily } = await import("./climateNormals.js");
  const d = await fetchDaily(0, 0, 2020, 2020, ok, { sleep: async () => {} });
  assert.equal(d.length, 1);
  assert.equal(calls, 2);
});
