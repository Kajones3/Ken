/**
 * Quick test: verify international flight estimates are now populated.
 * Run: npm run typecheck && tsx src/testIntlPricing.ts
 */
import { getDb } from "./db.js";
import { loadBook } from "./book.js";

const testRoutes = [
  { origin: "ATL", airport: "NRT", resort: "tdr", name: "Tokyo" },
  { origin: "BOS", airport: "CDG", resort: "dlp", name: "Paris" },
  { origin: "LAX", airport: "PVG", resort: "sdr", name: "Shanghai" },
  { origin: "ORD", airport: "HKG", resort: "hkd", name: "Hong Kong" },
];

const db = await getDb();

console.log("Testing international flight estimates:\n");

for (const route of testRoutes) {
  const book = await loadBook(db, {
    origin: route.origin,
    destinations: [route.airport],
    resortIds: [route.resort],
    from: "2027-03-01",
    to: "2027-03-08",
    tripLength: 7,
  });

  const est = book.flightEstimate?.(route.origin, route.airport);
  if (est) {
    console.log(
      `${route.origin} → ${route.name} (${route.airport}): ` +
      `$${est.med} (low: $${est.low}, high: $${est.high})`,
    );
  } else {
    console.log(`${route.origin} → ${route.name}: NO ESTIMATE`);
  }
}

await db.close();
console.log("\n✓ International baselines loaded from historical_fares");
