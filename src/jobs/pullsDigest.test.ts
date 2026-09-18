import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, type Db } from "../db.js";
import { runPullsDigest, routePulls, hotelPulls } from "./pullsDigest.js";
import type { EmailMessage, EmailSender } from "../email/types.js";

/**
 * The whole value of this digest is that it reports only what a vendor
 * genuinely returned. A digest that quietly counts mock rows would say the
 * cache is healthy on a deploy with no provider keys at all — the exact
 * false reassurance it exists to prevent. These tests pin that line.
 */

function collector() {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = { name: "test", async send(m) { sent.push(m); } };
  return { sent, sender };
}

async function flight(db: Db, o: string, d: string, source: string | null, hoursAgo: number, depart = "2027-03-01") {
  await db.query(
    `insert into flight_prices (origin,destination,depart_date,trip_length,price_usd,stops,source,fetched_at)
     values ($1,$2,$3,7,400,0,$4, now() - ($5 || ' hours')::interval)`,
    [o, d, depart, source, String(hoursAgo)],
  );
}

async function hotel(db: Db, id: string, resort: string, source: string | null, hoursAgo: number, stay = "2027-03-01") {
  await db.query(
    `insert into hotel_rates (hotel_id,resort_id,hotel_name,stay_date,nightly_usd,tier,on_property,source,fetched_at)
     values ($1,$2,$3,$4,150,'budget',false,$5, now() - ($6 || ' hours')::interval)`,
    [id, resort, `Hotel ${id}`, stay, source, String(hoursAgo)],
  );
}

test("pulls digest: reports a real provider pull, with the departures it covered", async () => {
  const db = await memoryDb();
  await flight(db, "ATL", "MCO", "serpapi_flights", 6, "2027-03-01");
  await flight(db, "ATL", "MCO", "serpapi_flights", 6, "2027-03-08");

  const routes = await routePulls(db, 15);
  assert.equal(routes.length, 1, "one route/source pair, not one row each");
  assert.equal(routes[0]!.rows, 2);
  assert.equal(routes[0]!.origin, "ATL");
  assert.equal(routes[0]!.destination, "MCO");
  assert.equal(routes[0]!.firstDepart, "2027-03-01");
  assert.equal(routes[0]!.lastDepart, "2027-03-08");

  await db.close();
});

test("pulls digest: mock and unlabelled rows are never counted as real pulls", async () => {
  const db = await memoryDb();
  await flight(db, "LAS", "MCO", "mock", 1);
  await flight(db, "BOS", "MCO", null, 1);
  await hotel(db, "pop", "wdw", "mock", 1);
  await hotel(db, "art", "wdw", null, 1);

  assert.deepEqual(await routePulls(db, 15), [], "mock data is not a pull");
  assert.deepEqual(await hotelPulls(db, 15), [], "an unlabelled row claims no vendor");

  await db.close();
});

test("pulls digest: the window really is a window — older pulls drop out", async () => {
  const db = await memoryDb();
  await flight(db, "ATL", "MCO", "serpapi_flights", 24 * 14);   // inside 15 days
  await flight(db, "DEN", "LAX", "serpapi_flights", 24 * 16);   // outside

  const routes = await routePulls(db, 15);
  assert.deepEqual(routes.map((r) => r.origin), ["ATL"]);

  // Widen the window and the older one comes back, so this is the window
  // doing the work and not some other filter.
  const wider = await routePulls(db, 30);
  assert.deepEqual(wider.map((r) => r.origin).sort(), ["ATL", "DEN"]);

  await db.close();
});

test("pulls digest: one row per hotel per source, not one per night", async () => {
  const db = await memoryDb();
  await hotel(db, "hi-mco", "wdw", "serpapi_hotels", 5, "2027-03-01");
  await hotel(db, "hi-mco", "wdw", "serpapi_hotels", 5, "2027-03-02");
  await hotel(db, "hi-mco", "wdw", "serpapi_hotels", 5, "2027-03-03");

  const hotels = await hotelPulls(db, 15);
  assert.equal(hotels.length, 1);
  assert.equal(hotels[0]!.rows, 3);
  assert.equal(hotels[0]!.firstStay, "2027-03-01");
  assert.equal(hotels[0]!.lastStay, "2027-03-03");

  await db.close();
});

test("pulls digest: emails the owner, naming the routes and hotels in the body", async () => {
  const db = await memoryDb();
  await flight(db, "JFK", "CDG", "serpapi_flights", 12);
  await hotel(db, "hi-mco", "wdw", "serpapi_hotels", 12);
  const { sent, sender } = collector();

  const r = await runPullsDigest(db, { sender, ownerEmail: "owner@example.com" });
  assert.equal(r.sent, 1);
  assert.equal(r.routes, 1);
  assert.equal(r.hotels, 1);
  assert.match(sent[0]!.text, /JFK-CDG/);
  assert.match(sent[0]!.text, /serpapi_flights/);
  assert.match(sent[0]!.text, /Hotel hi-mco/);
  assert.equal(sent[0]!.to, "owner@example.com");

  await db.close();
});

test("pulls digest: a quiet window still sends, and says plainly that nothing was pulled", async () => {
  const db = await memoryDb();
  // Only mock data — exactly what a deploy with no provider keys looks like.
  await flight(db, "LAS", "MCO", "mock", 1);
  const { sent, sender } = collector();

  const r = await runPullsDigest(db, { sender, ownerEmail: "owner@example.com" });
  assert.equal(r.sent, 1, "silence is the signal that matters most — it must still arrive");
  assert.equal(r.routes, 0);
  assert.match(sent[0]!.subject, /no real provider data/i);
  assert.match(sent[0]!.text, /Nothing\. No route had a real fare pulled/);
  // And it must explain the mock rows, or "nothing pulled" reads as a broken job.
  assert.match(sent[0]!.text, /mock provider/);

  await db.close();
});

test("pulls digest: with no OWNER_EMAIL it sends nothing and says so, rather than failing", async () => {
  const db = await memoryDb();
  await flight(db, "ATL", "MCO", "serpapi_flights", 3);
  const sender: EmailSender = { name: "test", async send() { throw new Error("should not be called"); } };

  const r = await runPullsDigest(db, { sender, ownerEmail: "" });
  assert.equal(r.sent, 0);
  assert.match(r.note, /OWNER_EMAIL is not set/);
  assert.equal(r.routes, 1, "the report is still computed, just not delivered");

  await db.close();
});

test("pulls digest: a send failure is reported, not swallowed into a success", async () => {
  const db = await memoryDb();
  await flight(db, "ATL", "MCO", "serpapi_flights", 3);
  const sender: EmailSender = { name: "test", async send() { throw new Error("resend is down"); } };

  const r = await runPullsDigest(db, { sender, ownerEmail: "owner@example.com" });
  assert.equal(r.sent, 0);
  assert.match(r.note, /send failed/);

  await db.close();
});
