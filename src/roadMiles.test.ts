import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./db.js";
import { ensureRoadMiles, loadRoadMiles, routeKey, pointKey } from "./roadMiles.js";
import { RESORT_BY_ID, ORIGIN_BY_IATA } from "./config.js";
import { priceTrip } from "./pricing.js";
import { bookFrom } from "./book.js";
import { haversineMiles } from "./geo.js";

test("road miles: asked once per route, kept, and a slip of the map is not kept", async () => {
  const db = await memoryDb();
  const atl = ORIGIN_BY_IATA.get("ATL")!, wdw = RESORT_BY_ID.get("wdw")!, dlr = RESORT_BY_ID.get("dlr")!;
  let asked = 0;
  const fetcher = async (_f: unknown, to: { lat: number }) => { asked++; return to.lat === wdw.lat ? 438 : 99999; };
  const wants = [wdw, dlr].map((r) => ({ from: { lat: atl.lat, lon: atl.lon }, to: { lat: r.lat, lon: r.lon }, resortId: r.id }));
  const straight = (w: typeof wants[number]) => haversineMiles(w.from.lat, w.from.lon, w.to.lat, w.to.lon);
  assert.equal(await ensureRoadMiles(db, wants, fetcher, { pauseMs: 0, straightMiles: straight }), 1, "a 99,999-mile answer is a slip");
  assert.equal(await ensureRoadMiles(db, wants.slice(0, 1), fetcher, { pauseMs: 0, straightMiles: straight }), 0, "held: not asked again");
  assert.equal(asked, 2);
  const held = await loadRoadMiles(db);
  assert.equal(held.get(routeKey(atl, "wdw")), 438);
  assert.equal(pointKey({ lat: 33.6407, lon: -84.4277 }), "33.64,-84.43");
});

test("a driving trip prices map miles when held, else the straight-line estimate", () => {
  const wdw = RESORT_BY_ID.get("wdw")!;
  const base = bookFrom({ flights: [], hotels: [{ resortId: "wdw", date: "2027-03-01", night: { hotelId: "m", name: "M", descriptor: "", nightly: 200, tier: "moderate", onProperty: true } }],
    tickets: Array.from({ length: 8 }, (_, i) => ({ resortId: "wdw", date: `2027-03-0${i + 1}`, row: { adult: 150, child: 140 } })), promos: [] });
  const params = { origin: "ATL", adults: 1, childAges: [], nights: 1, parkDays: 1, stay: "none" as const, tier: 1 as const, food: "grocery" as const, transportMode: "drive" as const };
  const est = priceTrip(base, wdw, params, {}, "2027-03-01");
  const map = priceTrip({ ...base, roadMiles: () => 438 }, wdw, params, {}, "2027-03-01");
  assert.ok(est.ok && map.ok, JSON.stringify([!est.ok && est.reason, !map.ok && map.reason]));
  if (!est.ok || !map.ok) return;
  assert.equal(est.price.drivingPick!.milesFromMap, false);
  assert.equal(map.price.drivingPick!.milesFromMap, true);
  assert.equal(map.price.drivingPick!.roundTripMiles, 876);
});
