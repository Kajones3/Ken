import { EiaGasProvider } from "./eia.js";
import { MockGasProvider } from "./mock.js";
import type { GasPriceProvider } from "./types.js";

export function pickGasProvider(): GasPriceProvider {
  return process.env.EIA_API_KEY ? new EiaGasProvider() : new MockGasProvider();
}
