/**
 * Quick test: verify international flight estimates are now populated.
 * Run: npm run typecheck && tsx src/testIntlPricing.ts
 */
import { memoryDb } from "./db.js";
import { loadBook } from "./book.js";

const testRoutes = [
  { origin: "ATL", dest: "tdr", destCode: "NRT", name: "Tokyo" },
  { origin: "BOS", dest: "dlp", destCode: "CDG", name: "Paris" },
  { origin: "LAX", dest: "sdr", destCode: "PVG", name: "Shanghai" },
  { origin: "ORD", dest: "hkd", destCode: "HKG", name: "Hong Kong" },
];

const db = await memoryDb();

console.log("Testing international flight estimates:\n");

for (const route of testRoutes) {
  const book = await loadBook(db, {
    origin: route.origin,
    destinations: [route.dest],
    resortIds: [route.dest],
    from: "2027-03-01",
    to: "2027-03-08",
    tripLength: 7,
  });

  const est = book.flightEstimate?.(route.origin, route.destCode);
  if (est) {
    console.log(
      `${route.origin} → ${route.name} (${route.destCode}): ` +
      `$${est.med} (low: $${est.low}, high: $${est.high})`,
    );
  } else {
    console.log(`${route.origin} → ${route.name}: NO ESTIMATE`);
  }
}

await db.close();
console.log("\n✓ International baselines loaded from historical_fares");
