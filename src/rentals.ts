/**
 * Vacation rentals (Airbnb/Vrbo-style listings) among Google's hotel results.
 *
 * Owner, 2026-10-05: "I can tell some of these are AirBNB type things. I
 * don't want to surface these on the site individually ... the pricing is
 * relevant, but sort of for its own category of off property."
 *
 * Google labels every property it returns: `type` is "hotel" or "vacation
 * rental" (SerpApi google_hotels). That label is the evidence and wins.
 * Rows kept before we read it (hotel_samples before 2026-10-05, every
 * hotel_rates row) have no label, so the NAME decides, and that is a guess:
 * "Family 2BR at Meliá Celebration", "Condo near Disney", "... | Pool". It is
 * deliberately narrow (a bedroom count, condo, apartment, townhome, a "|"
 * listing title) so a real hotel isn't swept out: "Westgate Vacation Villas
 * Resort" and "Home2 Suites" stay hotels.
 *
 * Rentals are kept in the record like everything else; they are only kept
 * OUT of the off-property hotel picks (a two-bedroom condo for the whole
 * family is a different product from one hotel room).
 */
const RENTAL_NAME = /\b\d+\s?(?:br|bd|bed(?:room)?s?)\b|\bbedrooms?\b|\bcondos?\b|\bapartments?\b|\btown\s?(?:home|house)s?\b|\bvacation home\b|\bprivate (?:pool|balcony)\b|\|/i;

export function isRental(name: string, googleType?: string | null): boolean {
  if (googleType) return /rental/i.test(googleType);
  return RENTAL_NAME.test(name);
}

/** Where a rental/hotel call came from: Google's own label, or our name guess. */
export function rentalBasis(googleType?: string | null): "google" | "name" {
  return googleType ? "google" : "name";
}

export interface RentalSummary { count: number; median: number | null; low: number | null; high: number | null }

export function summarize(nightly: number[]): RentalSummary {
  const v = nightly.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return { count: 0, median: null, low: null, high: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { count: v.length, median: Math.round(median), low: Math.round(v[0]!), high: Math.round(v[v.length - 1]!) };
}
