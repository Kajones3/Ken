import type { ISODate } from "../dates.js";

export interface FlightQuote {
  origin: string; destination: string; departDate: ISODate; tripLength: number;
  priceUsd: number; carrier?: string; stops: number; deepLink?: string;
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
  flightMonth(origin: string, destination: string, month: string, tripLength: number): Promise<FlightQuote[]>;
  hotelMonth(resortId: string, month: string): Promise<HotelQuote[]>;
}
