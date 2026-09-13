/** Stands in for SerpApi so the paid path can be exercised without spending. */
import { createServer } from "node:http";
let hits = 0;
createServer((req, res) => {
  hits++;
  const u = new URL(req.url!, "http://x");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    best_flights: [{
      price: 428, type: "Round trip", total_duration: 92,
      flights: [{ airline: "Delta", flight_number: "DL 2903" }],
    }],
    price_insights: { lowest_price: 373 },
    _hits: hits, _asked: Object.fromEntries(u.searchParams),
  }));
}).listen(8611, () => console.log("fake serpapi on 8611"));
