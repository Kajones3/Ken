// Types for screenshot-reader.js, which is plain JavaScript because the admin
// page loads it straight from /public with no build step. Only the pure
// functions the tests import are declared.
export interface FoundAmount { raw: string; amount: number; currency: string | null; context: string }
export function findAmounts(text: string, resortCurrency?: string): FoundAmount[];
export function findDates(text: string, today?: string): string[];
export function guessCategory(text: string): "hotel" | "flight" | "ticket" | "food" | null;
export function guessResort(text: string): string | null;
export function findAirports(text: string): string[];
export function guessName(text: string): string | null;
export function findPercents(text: string): number[];
export function guessDealKind(text: string): "room_pct_off" | "room_flat_off" | "room_night_off" | "free_dining" | "kids_free_dining" | "ticket_pct_off" | "flat_off_total" | null;
export function cleanLabel(line: string): string;
export interface ReadOffer {
  label: string | null; kind: ReturnType<typeof guessDealKind>; value: number | null; upTo: boolean;
  startsOn: string | null; endsOn: string | null; dates: string[]; minNights: number | null;
  conditions: string; resort: string | null; text: string;
}
export function readOffer(text: string, today?: string): ReadOffer;
export function splitOffers(text: string, today?: string): ReadOffer[];
export function guessDealLabel(text: string): string | null;
export function findDollarsOff(text: string): number[];
export function findColumnCuts(lum: ArrayLike<number>, width: number, height: number): number[];
export function readTicketPage(text: string, resortCurrency?: string):
  { adult: FoundAmount | null; child: FoundAmount | null; days: number | null; perPerson: boolean } | null;
export interface OcrWord { text: string; x0: number; y0: number; x1: number; y1: number }
export function readWords(image: Blob, opts?: { onProgress?: (p: number, status: string) => void; ink?: boolean }): Promise<{ words: OcrWord[]; text: string }>;
export function readUndatedTicket(text: string):
  { days: number; parks: number; adult: number; child: number | null; currency: "USD" | "GBP" | "EUR" | null } | null;
export function readTicketCalendar(words: OcrWord[]): {
  month: string | null; ticketDays: number | null; adultAges: string | null; resortGuess: "wdw" | "dlr" | "dlp" | null;
  currency?: "USD" | "GBP" | "EUR" | null;
  prices: Array<{ date: string; perDay: number; check?: boolean }>; missing: string[]; warnings: string[];
};

export interface CruiseCard {
  title: string | null; nights: number | null; region: string | null; departurePort: string | null;
  ports: string | null; price: number | null; currency: string; save: number | null;
  datesCount: number | null; guaranteed: boolean; perPerson: boolean; theme: string | null; text: string;
}
export const CRUISE_PORTS: string[];
export const CRUISE_THEMES: string[];
export function readCruiseCard(text: string): CruiseCard;
export function splitCruises(text: string): CruiseCard[];
export interface AdventurePage {
  days: number | null; nights: number | null; price: number | null; currency: string; perPerson: boolean;
  tripType: string | null; meals: number | null; breakfasts: number | null; lunches: number | null;
  dinners: number | null; minAge: number | null; suggestedAge: number | null; adultExclusiveAge: number | null;
  highlights: string[]; text: string;
}
export const ADVENTURE_TYPES: string[];
export function readAdventure(text: string): AdventurePage;

export function enlargeBy(width: number): number;
export type CruiseRoomKey = "inside" | "oceanview" | "verandah" | "concierge";
export interface CruiseRoomPrice { price: number | null; was: number | null; soldOut: boolean; check: boolean }
export interface CruiseSailing { start: string; end: string; nights: number; ship: string | null; rooms: Partial<Record<CruiseRoomKey, CruiseRoomPrice>> }
export interface CruiseRates {
  guests: Array<{ label: string; kind: "adult" | "child"; amount: number }>; adults: number; children: number;
  taxes: number | null; total: number | null; totalWas: number | null; startingFrom: number | null; cabin: CruiseRoomKey | null;
}
export const CRUISE_SHIPS: string[];
export const CRUISE_ROOMS: CruiseRoomKey[];
export function cruisePrice(token: string): { value: number; check: boolean; tag: boolean; alts: number[] } | null;
export function sailingDates(line: string): { start: string; end: string; nights: number } | null;
export function readCruiseDates(words: OcrWord[], opts?: { rightEdge?: number }): {
  sailings: CruiseSailing[]; ship: string | null; title: string | null; nights: number | null;
  departurePort: string | null; warnings: string[];
};
export function readCruiseRates(words: OcrWord[]): CruiseRates | null;
export function readCruiseScreenshot(words: OcrWord[]): ReturnType<typeof readCruiseDates> & { rates: CruiseRates | null };
