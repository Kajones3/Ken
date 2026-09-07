/** One number: the current US national average retail gas price. Same
 *  provider-swap shape as flights/hotels/email — an interface, a mock that
 *  needs no account, and a real adapter used once a key is configured. */
export interface GasPriceProvider {
  readonly name: string;
  nationalAverage(): Promise<{ pricePerGallonUsd: number; asOf: string } | null>;
}
