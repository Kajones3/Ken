import type { ISODate } from "../dates.js";

export interface FlightQuote {
  origin: string; destination: string; departDate: ISODate; tripLength: number;
  priceUsd: number; carrier?: string; stops: number; deepLink?: string;
  /** Google's own read of this route and date, from the same paid search. */
  insights?: FlightInsights;
}
export interface FlightInsights {
  typicalLow?: number; typicalHigh?: number; lowestPrice?: number; priceLevel?: string;
  /** [unix seconds, price] pairs, as Google returned them. */
  history?: [number, number][];
  /** How many itineraries the search returned. */
  itineraries: number;
}
export interface HotelQuote {
  hotelId: string; resortId: string; hotelName: string; descriptor: string;
  stayDate: ISODate; nightlyUsd: number; tier: string; onProperty: boolean; deepLink?: string;
}

/**
 * One call returns a whole month of departure dates. That is what keeps the
 * refresh job at ~1,710 calls a day instead of ~131,000.
 */
export interface Provider {
  readonly name: string;
  /**
   * What to record in hotel_rates.source for rows this provider returns.
   * Defaults to `name`. pickProvider() composes flights and hotels from two
   * unrelated vendors and its `name` names both, so a hotel row tagged with
   * that combined name would claim a vendor that never touched it.
   */
  readonly hotelSource?: string;
  flightMonth(origin: string, destination: string, month: string, tripLength: number): Promise<FlightQuote[]>;
  hotelMonth(resortId: string, month: string): Promise<HotelQuote[]>;
  /** Off-property pulls made so far this run, each with its own night and
   *  the real rates returned — kept by the hotel scorecard (hotel_samples). */
  hotelPulls?(): { resort: string; month: string; checkIn: string; rates: { name: string; nightly: number; kind?: string; extra?: unknown }[] }[];
  /** Google's whole answers, for rawResponses.ts. */
  readonly raw?: import("../rawResponses.js").RawResponse[];
  /** Every paid hotel search made this run, empty ones included. */
  hotelSearches?(): { resort: string; month: string; checkIn: string; properties: number; priced: number; status: string }[];
}
