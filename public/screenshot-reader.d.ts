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
export function guessDealKind(text: string): "room_pct_off" | "room_flat_off" | "free_dining" | "ticket_pct_off" | "flat_off_total" | null;
export function guessDealLabel(text: string): string | null;
export function findDollarsOff(text: string): number[];
