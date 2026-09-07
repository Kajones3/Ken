/**
 * Real adapter for the U.S. Energy Information Administration's free, public
 * Open Data API v2 (registration required for a key, no cost, no per-request
 * charge). Written to the documented request shape — RESTful route +
 * facets + data[] fields + sort — never run against a live key. Verify
 * against current EIA docs before relying on this in production, same
 * caveat as travelpayouts.ts and resend.ts elsewhere in this project.
 *
 * Series: weekly U.S. regular-grade retail gasoline price, national average
 * (duoarea=NUS, product=EPMR — EIA's codes for "US national" and "regular
 * motor gasoline"). One row per week; this reads the most recent one.
 */
import type { GasPriceProvider } from "./types.js";

const BASE = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";

export class EiaGasProvider implements GasPriceProvider {
  readonly name = "eia";

  constructor(private readonly apiKey = process.env.EIA_API_KEY ?? "") {
    if (!this.apiKey) throw new Error("EIA_API_KEY is not set");
  }

  async nationalAverage() {
    const url = new URL(BASE);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("frequency", "weekly");
    url.searchParams.set("data[0]", "value");
    url.searchParams.set("facets[duoarea][]", "NUS");
    url.searchParams.set("facets[product][]", "EPMR");
    url.searchParams.set("sort[0][column]", "period");
    url.searchParams.set("sort[0][direction]", "desc");
    url.searchParams.set("length", "1");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`EIA gas price -> ${res.status} ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as any;
    const row = json?.response?.data?.[0];
    const price = Number(row?.value);
    if (!row || !Number.isFinite(price) || price <= 0) return null;
    return { pricePerGallonUsd: price, asOf: String(row.period) };
  }
}
