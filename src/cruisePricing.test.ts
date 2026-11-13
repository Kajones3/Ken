import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCruises, pickCruiseFare, countUnder, CRUISE_FRESH_DAYS, type SightingIn } from "./cruisePricing.js";
import { portsOfCall, excursionAt, homePortOf, PORTS_OF_CALL, CRUISE_SHIPS } from "./cruiseFacts.js";

const today = "2026-11-13";
const rates = { regular: 16, concierge: 27.25 };
const ATL = { iata: "ATL", lat: 33.64, lon: -84.43 };
const base: SightingIn = {
  title: "4-Night Bahamian Cruise from Fort Lauderdale", nights: 4, departurePort: "Fort Lauderdale, Florida",
  ports: "Disney Lookout Cay at Lighthouse Point, Nassau, Bahamas", ship: "Wish",
  sailDate: "2027-02-10", sailEnd: "2027-02-14", cabin: "inside", priceUsd: 900, soldOut: false,
  partyAdults: 2, partyChildren: 2, seenOn: "2026-11-12",
};
const flight = () => ({ perSeat: 300, how: "bought" as const, date: "2027-02-10" });
const family = { adults: 2, childAges: [8, 1] };

test("a cruise prices only for the party the price was saved for", () => {
  const r = priceCruises({ rows: [base], party: family, origin: ATL, today, rates, flight });
  assert.equal(r.priced.length, 1);
  const c = r.priced[0]!;
  assert.equal(c.lines.fare, 3600);                   // 900 a person x 4
  assert.equal(c.lines.gratuities, 4 * 4 * 16);       // every guest, infant too
  assert.equal(c.lines.flights, 300 * 3);              // the 1-year-old is a lap infant
  assert.equal(c.lines.transfers, 2 * 29 * 4);
  // Nassau median: adult (239,99,179,209) = 194, child (139,89,179) = 139;
  // two adults + the 8-year-old at the child price; Lookout Cay is $0; the baby free.
  assert.equal(c.lines.excursions, 194 * 2 + 139);
  assert.equal(c.total, 3600 + 256 + 900 + 232 + 527);
  const couple = priceCruises({ rows: [base], party: { adults: 2, childAges: [] }, origin: ATL, today, rates, flight });
  assert.equal(couple.priced.length, 0, "a different party never borrows this party's average");
});

test("stale, past, sold-out and party-less prices fall off", () => {
  const old = { ...base, seenOn: "2026-10-01" };
  const past = { ...base, sailDate: "2026-11-10" };
  const sold = { ...base, soldOut: true, priceUsd: null };
  const noParty = { ...base, partyAdults: null, partyChildren: null };
  for (const row of [old, past, sold, noParty]) {
    assert.equal(priceCruises({ rows: [row], party: family, origin: ATL, today, rates, flight }).priced.length, 0);
  }
  assert.equal(CRUISE_FRESH_DAYS, 21);
});

test("the newest price per room wins, and the cheapest open room is priced", () => {
  const rows: SightingIn[] = [
    { ...base, cabin: "inside", priceUsd: 950, seenOn: "2026-11-01" },
    { ...base, cabin: "inside", soldOut: true, priceUsd: null, seenOn: "2026-11-12" },  // sold out since
    { ...base, cabin: "oceanview", priceUsd: 1000 },
    { ...base, cabin: "concierge", priceUsd: 3000 },
  ];
  const c = priceCruises({ rows, party: family, origin: ATL, today, rates, flight }).priced[0]!;
  assert.equal(c.cabin, "oceanview");
  assert.equal(c.perPersonFare, 1000);
});

test("concierge pays Disney's higher gratuity", () => {
  const c = priceCruises({ rows: [{ ...base, cabin: "concierge" }], party: family, origin: ATL, today, rates, flight }).priced[0]!;
  assert.equal(c.lines.gratuities, 4 * 4 * 27.25);
});

test("holes drop the sailing and say what's missing", () => {
  const holes = (row: SightingIn, origin: any = ATL, fl: any = flight) =>
    priceCruises({ rows: [row], party: family, origin, today, rates, flight: fl }).holes.map((h) => h.what);
  assert.match(holes({ ...base, ports: "Catalina Island, Ensenada" })[0]!, /Catalina/);
  assert.match(holes({ ...base, ports: "Victoria, British Columbia" })[0]!, /Victoria/);
  assert.match(holes(base, ATL, () => null)[0]!, /flight ATL-FLL/);
  assert.match(holes(base, { iata: "MIA", lat: 25.79, lon: -80.29 })[0]!, /driving/);
  assert.match(holes({ ...base, title: "Somewhere cruise", departurePort: "Atlantis" })[0]!, /home port/);
});

test("ports of call are read from Disney's line; unknown pieces are holes", () => {
  const p = portsOfCall("Disney Lookout Cay at Lighthouse Point, Nassau, Bahamas");
  assert.deepEqual(p.known.map((x) => x.id), ["lookout", "nassau"]);
  assert.deepEqual(p.unknown, []);
  assert.deepEqual(portsOfCall("Cozumel, Mexico; Progreso").known.map((x) => x.id), ["cozumel", "progreso"]);
  assert.deepEqual(portsOfCall("Juneau, Skagway, Ketchikan, Tracy Arm Fjord, Victoria").unknown, ["Victoria"]);
  assert.equal(excursionAt(PORTS_OF_CALL.find((x) => x.id === "catalina")!), null);
  assert.equal(homePortOf("3-Night Bahamian Cruise from Port Canaveral")?.airport, "MCO");
});

test("the nine ships, as Disney names them", () => {
  assert.equal(CRUISE_SHIPS.length, 9);
  assert.ok(CRUISE_SHIPS.includes("Disney Believe"));
});

test("a fare comes from the nearest bought date, then the month, then the model", () => {
  const bought = [
    { destination: "FLL", departDate: "2027-02-12", tripLength: 7, priceUsd: 410 },
    { destination: "FLL", departDate: "2027-02-25", tripLength: 7, priceUsd: 300 },
    { destination: "FLL", departDate: "2027-02-27", tripLength: 7, priceUsd: 500 },
  ];
  assert.deepEqual(pickCruiseFare(bought, "FLL", "2027-02-10", 4), { perSeat: 410, how: "bought", date: "2027-02-12" });
  assert.equal(pickCruiseFare(bought, "FLL", "2027-02-02", 4)?.perSeat, 410, "month median of 300, 410, 500");
  assert.equal(pickCruiseFare(bought, "FLL", "2027-02-02", 4)?.how, "bought_month");
  assert.equal(pickCruiseFare(bought, "IAH", "2027-02-02", 4), null);
  assert.equal(pickCruiseFare([], "MCO", "2027-02-02", 4, () => 333)?.how, "model");
});

test("a free visitor is told how many, not which", () => {
  const r = priceCruises({ rows: [base, { ...base, sailDate: "2027-02-20", sailEnd: "2027-02-24", priceUsd: 2000 }],
    party: family, origin: ATL, today, rates, flight });
  assert.equal(countUnder(r.priced, 6000), 1);
});

test("driving: too close to fly = driving only; farther = both, flying first", () => {
  const drive = (port: any) => port.id === "fll" ? { oneWayMiles: 30, fromMap: true, gasUsd: 7.2, wearUsd: 43.5, parkingPerDay: 25 } : null;
  const MIA = { iata: "MIA", lat: 25.79, lon: -80.29 };
  const near = priceCruises({ rows: [base], party: family, origin: MIA, today, rates, flight, drive }).priced[0]!;
  assert.equal(near.travel.default, "drive");
  assert.equal(near.travel.fly, null);
  assert.equal(near.travel.drive!.parking, 25 * 5, "parking for nights + 1 days");
  assert.equal(near.lines.flights, 0);
  assert.equal(near.total, near.base + 7.2 + 43.5 + 125);
  const far = priceCruises({ rows: [base], party: family, origin: ATL, today, rates, flight, drive }).priced[0]!;
  assert.equal(far.travel.default, "fly");
  assert.ok(far.travel.drive, "the I'm driving switch has a price");
  // No fare bought yet but driving is priced: the sailing still shows.
  const noFare = priceCruises({ rows: [base], party: family, origin: ATL, today, rates, flight: () => null, drive }).priced[0]!;
  assert.equal(noFare.travel.default, "drive");
  // Neither = a hole.
  const none = priceCruises({ rows: [base], party: family, origin: MIA, today, rates, flight, drive: () => null });
  assert.equal(none.priced.length, 0);
  assert.match(none.holes[0]!.what, /driving to Fort Lauderdale/);
});

test("a free visitor's count takes the cheaper way there", () => {
  const drive = () => ({ oneWayMiles: 300, fromMap: true, gasUsd: 72, wearUsd: 435, parkingPerDay: 25 });
  const r = priceCruises({ rows: [base], party: family, origin: ATL, today, rates, flight, drive });
  const c = r.priced[0]!;
  const cheaper = c.base + Math.min(c.travel.fly!.total, c.travel.drive!.total);
  assert.equal(countUnder(r.priced, cheaper), 1);
  assert.equal(countUnder(r.priced, cheaper - 1), 0);
});
