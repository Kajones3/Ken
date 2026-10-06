import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { matchDisneyHotel, pullPairs, loadHotelScoreboard, recordHotelSamples } from "./hotelScoreboard.js";

test("Google's names for Disney's own hotels match ours", () => {
  const is = (resort: string, name: string, id: string | null) =>
    assert.equal(matchDisneyHotel(resort, name)?.id ?? null, id, `${resort}: ${name}`);
  is("wdw", "Disney's Pop Century Resort", "wdw-pop");
  is("wdw", "Disney's All-Star Movies Resort", "wdw-asm");
  is("wdw", "Disney's Port Orleans Resort - Riverside", "wdw-por");
  is("wdw", "Disney's Coronado Springs Resort", "wdw-gdt");
  is("wdw", "Disney's Grand Floridian Resort & Spa", "wdw-gf");
  is("wdw", "Disney’s Animal Kingdom Lodge", "wdw-akl");
  is("dlr", "Disney's Grand Californian Hotel & Spa", "dlr-gch");
  is("dlr", "Disneyland Hotel", "dlr-dlh");
  is("tdr", "Tokyo DisneySea Hotel MiraCosta", "tdr-mc");
  is("hkdl", "Hong Kong Disneyland Hotel", "hkdl-hkd");
  is("dlp", "Disney Hotel Santa Fe", "dlp-sf");
});

test("near-misses are NOT matched: a wrong match would grade the wrong hotel", () => {
  const none = (resort: string, name: string) => assert.equal(matchDisneyHotel(resort, name), null, `${resort}: ${name}`);
  none("wdw", "Copper Creek Villas & Cabins at Disney's Wilderness Lodge");
  none("wdw", "Bay Lake Tower at Disney's Contemporary Resort");
  none("wdw", "Hilton Orlando Lake Buena Vista - Disney Springs Area");
  none("dlr", "Howard Johnson by Wyndham Anaheim Hotel near Disneyland Park");
  none("dlr", "Best Western Plus Stovall's Inn");
  none("wdw", "Disneyland Hotel");
});

test("pull to pull: the old pull, moved by the season curve, against the new one", () => {
  const flat = () => 1;
  const at = (d: string) => new Date(d);
  const pairs = pullPairs([
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-14", pulledAt: at("2026-10-01"),
      rates: [{ name: "Hampton Inn", nightly: 150 }, { name: "Hilton", nightly: 200 }, { name: "Disney's Pop Century Resort", nightly: 999 }] },
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-14", pulledAt: at("2026-10-11"),
      rates: [{ name: "Hampton Inn", nightly: 200 }, { name: "Hilton", nightly: 300 }] },
  ], flat);
  assert.equal(pairs.length, 1);
  // Shown 175 (Disney's hotel left out of the off-property typical), real 250.
  assert.equal(pairs[0]!.shown, 175);
  assert.equal(pairs[0]!.real, 250);
  assert.equal(pairs[0]!.pct, -30);
  // A season curve moves what was shown to the new night.
  const curved = pullPairs([
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-02", pulledAt: at("2026-10-01"), rates: [{ name: "A", nightly: 100 }] },
    { resort: "wdw", month: "2027-03", checkIn: "2027-03-14", pulledAt: at("2026-10-11"), rates: [{ name: "A", nightly: 120 }] },
  ], (_r, d) => (d === "2027-03-14" ? 1.2 : 1));
  assert.equal(curved[0]!.pct, 0);
});

test("the scorecard reads Disney hotels from Google's list, pulls, and price checks", async () => {
  const d = await memoryDb();
  const ins = (hotel: string, name: string, date: string, usd: number, on: boolean, source: string | null) => d.query(
    `insert into hotel_rates (resort_id, hotel_id, hotel_name, descriptor, stay_date, nightly_usd, tier, on_property, source)
     values ('wdw',$1,$2,'',$3,$4,'value',$5,$6)`, [hotel, name, date, usd, on, source]);
  await ins("wdw-pop", "Disney's Pop Century", "2027-03-10", 300, true, "serpapi_hotels");
  await ins("serp-x", "Disney's Pop Century Resort", "2027-03-10", 250, false, "serpapi_hotels");
  await ins("serp-y", "Hampton Inn", "2027-03-10", 150, false, "serpapi_hotels");
  await recordHotelSamples(d, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-14", rates: [{ name: "Hampton Inn", nightly: 150 }] }]);
  await new Promise((r) => setTimeout(r, 5));
  await recordHotelSamples(d, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-14", rates: [{ name: "Hampton Inn", nightly: 200 }] }]);
  await d.query(`insert into price_checks (id, checked_on, resort_id, category, amount, currency, price_is, unit_usd, model_usd, dedupe)
                 values (gen_random_uuid(), '2026-10-01', 'tdr', 'hotel', 400, 'USD', 'per_night', 400, 300, 'a'),
                        (gen_random_uuid(), '2026-10-01', 'wdw', 'ticket', 150, 'USD', 'per_person', 150, 150, 'b')`);
  const b = await loadHotelScoreboard(d);
  assert.equal(b.disney.rows.length, 1);
  assert.equal(b.disney.rows[0]!.pct, 20, "ours 300 against Google's 250");
  assert.deepEqual(b.disney.inOffPropertyList, [{ resort: "wdw", name: "Walt Disney World", hotels: ["Disney's Pop Century Resort"] }]);
  assert.equal(b.offProperty.pullsRecorded, 2);
  assert.equal(b.offProperty.pairs[0]!.pct, -25);
  assert.equal(b.checks.hotels.medianPct, -25);
  assert.equal(b.checks.tickets.typicalOffPct, 0);
  // The same rows graded by the shared accuracy rule (±10%, either direction).
  assert.equal(b.zonePct, 10);
  assert.equal(b.graded.disney.all.n, 1);
  assert.equal(b.graded.disney.all.medianPct, b.disney.rows[0]!.shownPct);
  assert.deepEqual([b.graded.offProperty.all.lowPct, b.graded.offProperty.all.inZonePct], [100, 0]);
  assert.deepEqual([b.graded.hotelChecks.byResort[0]!.resort, b.graded.hotelChecks.byResort[0]!.score.lowPct], ["tdr", 100]);
  assert.equal(b.graded.ticketChecks.within5Pct, 100);
  await d.close();
});

test("the hotel record keeps what else Google said about each hotel", async () => {
  const d = await memoryDb();
  await recordHotelSamples(d, [{ resort: "wdw", month: "2027-03", checkIn: "2027-03-14",
    rates: [{ name: "Hampton Inn", nightly: 160, extra: { lessThanUsualPct: 20, usualNightly: 200 } }, { name: "Plain Inn", nightly: 120 }] }]);
  const r = await d.query<{ hotel_name: string; extra: unknown }>(`select hotel_name, extra from hotel_samples order by hotel_name`);
  assert.deepEqual(r.rows.map((x) => [x.hotel_name, x.extra]), [["Hampton Inn", { lessThanUsualPct: 20, usualNightly: 200 }], ["Plain Inn", null]]);
  await d.close();
});
