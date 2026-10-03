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
export function guessDealKind(text: string): "room_pct_off" | "room_flat_off" | "room_night_off" | "free_dining" | "ticket_pct_off" | "flat_off_total" | null;
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
