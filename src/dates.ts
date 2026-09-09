/** Date helpers. Everything is UTC and ISO `YYYY-MM-DD`; no local timezones anywhere. */

export type ISODate = string;

export function iso(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}
export function parseISO(s: ISODate): Date {
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${s}`);
  return d;
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
export function addDaysISO(s: ISODate, n: number): ISODate {
  return iso(addDays(parseISO(s), n));
}
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}
export function todayISO(): ISODate {
  return iso(new Date());
}
/** Every date in [from, to] inclusive. */
export function range(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = parseISO(from); iso(d) <= to; d = addDays(d, 1)) out.push(iso(d));
  return out;
}
export function monthKey(s: ISODate): string {
  return s.slice(0, 7);
}
/** First and last day of a `YYYY-MM` month. */
export function monthBounds(ym: string): [ISODate, ISODate] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}
/**
 * Calendar quarter (1-4) of an ISO date. BTS DB1B publishes fares by
 * quarter — not by month — so this is the finest seasonal grain a
 * historical baseline can honestly be matched on.
 */
export function quarterOf(s: ISODate): number {
  return Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1;
}
