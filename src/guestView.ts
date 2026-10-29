/**
 * What a visitor who isn't signed in may see (owner, 2026-10-29): "search for
 * free and get their first 2 resorts and we blur the rest. Then they have to
 * create a free account." The two shown are the cheapest US resort and the
 * cheapest international one (owner's pick of the options offered), so a
 * visitor from most US cities still sees an overseas park and the comparison
 * that makes this site different. The other four are sent WITHOUT prices:
 * blurring on the page alone would leave the numbers one "view source" away.
 *
 * Pure, no I/O, like pricing.ts.
 */
import { RESORT_BY_ID } from "./config.js";

/** The free sample PDF's trip (prototype.html SAMPLE_TRIP). A signed-out
 *  visitor may price exactly this one in full, because the sample PDF is
 *  ours to give away and shows all six. Anything else stays locked. */
export const SAMPLE_GUEST_TRIP = { origin: "SFO", adults: 2, childAges: [8, 11], nights: 6 };

export function isSampleTrip(p: { origin: string; adults: number; childAges: number[]; nights: number }): boolean {
  const ages = [...p.childAges].sort((a, b) => a - b).join(",");
  return p.origin === SAMPLE_GUEST_TRIP.origin && p.adults === SAMPLE_GUEST_TRIP.adults
    && p.nights === SAMPLE_GUEST_TRIP.nights && ages === SAMPLE_GUEST_TRIP.childAges.join(",");
}

type Row = { resortId: string; name: string; iata: string; ok: boolean; price?: { total: number } };
export interface LockedRow { resortId: string; name: string; iata: string; ok: false; locked: true; reason: string }

/**
 * The cheapest priced US resort and the cheapest priced international one
 * keep everything; every other row becomes a locked stub with no price. The
 * shown rows come first (in price order), the locked ones after in the
 * resorts' usual order, so their place in the list says nothing about price.
 */
export function lockForGuests<T extends Row>(results: T[]): (T | LockedRow)[] {
  const priced = results.filter((r) => r.ok && r.price).sort((a, b) => a.price!.total - b.price!.total);
  const dom = priced.find((r) => RESORT_BY_ID.get(r.resortId)?.region === "dom");
  const intl = priced.find((r) => RESORT_BY_ID.get(r.resortId)?.region !== "dom");
  const shown = [dom, intl].filter((r): r is T => !!r).sort((a, b) => a.price!.total - b.price!.total);
  const keep = new Set(shown.map((r) => r.resortId));
  const order = [...RESORT_BY_ID.keys()];
  const locked: LockedRow[] = results.filter((r) => !keep.has(r.resortId))
    .sort((a, b) => order.indexOf(a.resortId) - order.indexOf(b.resortId))
    .map((r) => ({ resortId: r.resortId, name: r.name, iata: r.iata, ok: false as const, locked: true as const,
      reason: "Create a free account to see this trip." }));
  return [...shown, ...locked];
}
