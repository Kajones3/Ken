import { test } from "node:test";
import assert from "node:assert/strict";
import { fitMonthLevers, monthFactor, gradeMonthLevers, MONTH_MIN_GROUPS } from "./hotelMonths.js";
import type { GoogleDisneyRate } from "./disneyEvidence.js";

const at = new Date("2026-11-01T00:00:00Z");
const rate = (hotelId: string, resortId: string, night: string, ours: number, google: number): GoogleDisneyRate =>
  ({ resortId, hotelId, hotelName: hotelId, googleName: hotelId, night, google, lead: google, ours, pulledAt: at });
const one = () => 1;
const opts = { checks: [], googleWeight: 1, priorWeight: 3, hotelBase: () => undefined, zone: 0.1 };

test("a month with no Google rates stays exactly as before", () => {
  const lv = fitMonthLevers([rate("wdw-pop", "wdw", "2027-03-14", 300, 450)], one);
  assert.equal(monthFactor(lv, "wdw", "wdw-pop", "2027-07-14"), 1);
  assert.equal(monthFactor(lv, "tdr", "tdr-amb", "2027-03-14"), 1);
});

test("one rate moves a month only part of the way; many move it most of the way", () => {
  const few = fitMonthLevers([rate("wdw-pop", "wdw", "2027-03-14", 300, 450)], one);
  const f1 = monthFactor(few, "wdw", "wdw-pop", "2027-03-20");
  assert.ok(f1 > 1 && f1 < 1.15, `one rate: ${f1}`);
  const many = fitMonthLevers(Array.from({ length: 30 }, (_, i) =>
    rate("wdw-pop", "wdw", `2027-03-${String(1 + (i % 28)).padStart(2, "0")}`, 300, 450)), one);
  const f2 = monthFactor(many, "wdw", "wdw-pop", "2027-03-20");
  assert.ok(f2 > 1.3 && f2 <= 1.5, `thirty rates: ${f2}`);
});

test("a hotel with no rates that month still moves with its resort's other Disney hotels", () => {
  const rs = Array.from({ length: 20 }, (_, i) => rate(i % 2 ? "wdw-cbr" : "wdw-por", "wdw", `2027-03-${String(1 + i).padStart(2, "0")}`, 300, 390));
  const lv = fitMonthLevers(rs, one);
  const f = monthFactor(lv, "wdw", "wdw-asm", "2027-03-10");
  assert.ok(f > 1.15 && f < 1.3, `neighbor-led: ${f}`);
});

test("the hotel's own all-months factor is taken out first, so nothing is counted twice", () => {
  const rs = Array.from({ length: 30 }, (_, i) => rate("wdw-pop", "wdw", `2027-03-${String(1 + (i % 28)).padStart(2, "0")}`, 300, 450));
  const lv = fitMonthLevers(rs, () => 1.5);
  assert.equal(monthFactor(lv, "wdw", "wdw-pop", "2027-03-10"), 1);
});

test("held within 0.5x-2x whatever Google says", () => {
  const rs = Array.from({ length: 60 }, (_, i) => rate("tdr-tdh", "tdr", `2027-05-${String(1 + (i % 28)).padStart(2, "0")}`, 100, 480));
  const lv = fitMonthLevers(rs, one);
  assert.ok(monthFactor(lv, "tdr", "tdr-tdh", "2027-05-10") <= 2);
});

test("the grade leaves each hotel+month out and says the levers help when months really differ", () => {
  // Two hotels, four months. Google runs 40% over us in March and 20% under
  // in August at both hotels; one factor per hotel can't follow that.
  const rs: GoogleDisneyRate[] = [];
  for (const h of ["wdw-pop", "wdw-cbr", "wdw-por", "wdw-asm", "wdw-xxx", "wdw-yyy"]) {
    for (const [m, x] of [["2027-03", 1.4], ["2027-08", 0.8], ["2027-05", 1.0], ["2027-10", 1.0]] as const) {
      for (let d = 1; d <= 6; d++) rs.push(rate(h, "wdw", `${m}-${String(d * 3).padStart(2, "0")}`, 300, 300 * x));
    }
  }
  const g = gradeMonthLevers(rs, opts);
  assert.equal(g.groups, 24);
  assert.ok(g.with.typicalOffPct! < g.without.typicalOffPct!, `${g.with.typicalOffPct} vs ${g.without.typicalOffPct}`);
  assert.equal(g.better, g.groups >= MONTH_MIN_GROUPS);
  assert.equal(g.better, true);
  assert.equal(g.byResort[0]!.resortId, "wdw");
});

test("when every month says the same, the levers don't earn their place", () => {
  const rs: GoogleDisneyRate[] = [];
  for (const h of ["wdw-pop", "wdw-cbr", "wdw-por", "wdw-asm", "wdw-xxx", "wdw-yyy"]) {
    for (const m of ["2027-03", "2027-05", "2027-08", "2027-10"]) {
      for (let d = 1; d <= 6; d++) rs.push(rate(h, "wdw", `${m}-${String(d * 3).padStart(2, "0")}`, 300, 300 * (1 + ((d % 3) - 1) * 0.05)));
    }
  }
  assert.equal(gradeMonthLevers(rs, opts).better, false);
});

test("too few hotel-months to judge: not used", () => {
  const rs = Array.from({ length: 10 }, (_, i) => rate("wdw-pop", "wdw", `2027-03-${String(1 + i).padStart(2, "0")}`, 300, 450));
  assert.equal(gradeMonthLevers(rs, opts).better, false);
});

test("end to end: the price book moves Disney hotels by month, and the owner's switch turns it off", async () => {
  const { memoryDb } = await import("./db.js");
  const { loadBook } = await import("./book.js");
  const { setSetting } = await import("./settings.js");
  const { recordHotelSamples } = await import("./hotelScoreboard.js");
  const { clearGoogleDisneyCache } = await import("./disneyEvidence.js");
  const { RESORT_BY_ID } = await import("./config.js");
  const { HOTEL_MONTH_KEY } = await import("./checkFactors.js");
  const db = await memoryDb();
  const hotels = RESORT_BY_ID.get("wdw")!.hotels.filter((h) => h.onProperty).slice(0, 6);
  const months = [["2027-03", 1.4], ["2027-05", 1], ["2027-08", 0.8], ["2027-10", 1]] as const;
  for (const [m, x] of months) {
    for (let d = 1; d <= 6; d++) {
      const night = `${m}-${String(d * 3).padStart(2, "0")}`;
      for (const h of hotels) {
        await db.query(
          `insert into hotel_rates (hotel_id,resort_id,hotel_name,descriptor,stay_date,nightly_usd,tier,on_property,source)
           values ($1,'wdw',$2,'',$3,300,$4,true,'owner_base')`, [h.id, h.name, night, h.tier]);
      }
      await recordHotelSamples(db, [{ resort: "wdw", month: m, checkIn: night,
        rates: hotels.map((h) => ({ name: h.name, nightly: 300 * x })) }]);
    }
  }
  clearGoogleDisneyCache(db);
  const night = async (date: string) => (await loadBook(db, { origin: "ATL", destinations: ["MCO"], resortIds: ["wdw"],
    from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-28`, tripLength: 7 }))
    .hotelNights("wdw", date).find((h) => h.hotelId === hotels[0]!.id)!.nightly;
  const march = await night("2027-03-06"), aug = await night("2027-08-06");
  assert.ok(march > 340, `March moves up: ${march}`);
  assert.ok(aug < 280, `August moves down: ${aug}`);
  await setSetting(db, HOTEL_MONTH_KEY, 0);
  assert.ok(Math.abs((await night("2027-03-06")) - 300) < 10, "off: one factor per hotel, as before");
  await db.close();
});
