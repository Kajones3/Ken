import { todayISO } from "../dates.js";
import { jitter } from "../seasonality.js";
import type { GasPriceProvider } from "./types.js";

/** Deterministic and plausible, no account, no network — same spirit as
 *  MockProvider for flights/hotels. Wobbles a few cents a day around a
 *  round, recent-ish national average so refresh runs aren't all identical. */
export class MockGasProvider implements GasPriceProvider {
  readonly name = "mock";

  async nationalAverage() {
    const asOf = todayISO();
    const wobble = jitter("gas" + asOf) * 0.15; // +/- $0.15
    const pricePerGallonUsd = Math.round((3.15 + wobble) * 1000) / 1000;
    return { pricePerGallonUsd, asOf };
  }
}
