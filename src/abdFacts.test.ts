import { test } from "node:test";
import assert from "node:assert/strict";
import { abdPlaceOf, abdFlightDates } from "./abdFacts.js";

test("a one-city Escape is placed; a touring trip is not guessed", () => {
  assert.equal(abdPlaceOf({ tripName: "Paris Escape", destination: "Paris", tripType: "Escape" })?.airport, "CDG");
  assert.equal(abdPlaceOf({ tripName: "France: Paris Escape", destination: null, tripType: null })?.airport, "CDG");
  assert.equal(abdPlaceOf({ tripName: "Croatia & Slovenia", destination: null, tripType: "Land Adventure" }), null);
  assert.equal(abdPlaceOf({ tripName: "Disneyland Resort and Southern California Escape", destination: null, tripType: "Escape" })?.airport, "LAX");
});

test("flying abroad leaves the evening before day 1", () => {
  const paris = abdPlaceOf({ tripName: "Paris Escape", destination: "Paris", tripType: "Escape" })!;
  assert.deepEqual(abdFlightDates(paris, "2027-09-07", "2027-09-09", 2), { depart: "2027-09-06", back: "2027-09-09", tripLength: 3 });
  const la = abdPlaceOf({ tripName: "Southern California Escape", destination: null, tripType: "Escape" })!;
  assert.deepEqual(abdFlightDates(la, "2027-04-01", "2027-04-04", 3), { depart: "2027-04-01", back: "2027-04-04", tripLength: 3 });
});

test("the flight to Paris is the estimate the Disneyland Paris card shows; a bought fare wins", async () => {
  const { abdFlight } = await import("./abdFacts.js");
  const { quotedEstimate } = await import("./pricing.js");
  const paris = abdPlaceOf({ tripName: "Paris Escape", destination: "Paris", tripType: "Escape" })!;
  const dep = { departureDate: "2027-09-07", returnDate: "2027-09-09", nights: 2 };
  const book: any = { flight: () => undefined, setting: () => undefined,
    flightEstimate: () => ({ low: 900, med: 1100, high: 1300, candidate: true }) };
  const f = abdFlight(paris, dep, "DEN", 2, null, book);
  assert.equal(f.perSeat, quotedEstimate(book, "DEN", "CDG", "2027-09-06"));
  assert.equal(f.perSeat, 1100);
  assert.equal(f.total, 2200);
  assert.equal(f.how, "model");
  const bought = abdFlight(paris, dep, "DEN", 2, () => ({ perSeat: 980, how: "bought", date: "2027-09-06" }), book);
  assert.deepEqual([bought.perSeat, bought.how], [980, "bought"]);
  const none = abdFlight(paris, dep, "DEN", 2, null, null);
  assert.equal(none.total, null, "no fare and no estimate = left out, never guessed");
});
