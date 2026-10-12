// Day of week from fares that share a route, month and trip length.
//
// Comparing a Tuesday with a Friday on the SAME route, month and trip length
// cancels the route and the season, so what is left is the weekday. The free
// Travelpayouts feed is the source that has several dates per route-month;
// our paid fares have one (the 15th), so they teach weekday across months
// instead (fareModel.ts). Pure; tested.

export interface DatedFare { origin: string; destination: string; departDate: string; tripLength: number; price: number }

export interface WeekdayEffect {
  /** 0 = Sunday. */
  day: number;
  /** Median of fare / its group's median: 1.05 = 5% dearer than that route-month's middle. */
  factor: number;
  fares: number;
  groups: number;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Only groups with at least `minPerGroup` fares on at least two different weekdays count. */
export function weekdayPattern(fares: DatedFare[], minPerGroup = 3): WeekdayEffect[] {
  const groups = new Map<string, DatedFare[]>();
  for (const f of fares) {
    if (!(f.price > 0)) continue;
    const k = `${f.origin}|${f.destination}|${f.departDate.slice(0, 7)}|${f.tripLength}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const ratios = new Map<number, number[]>();
  const groupsBy = new Map<number, Set<string>>();
  for (const [k, g] of groups) {
    const days = new Set(g.map((f) => new Date(f.departDate + "T00:00:00Z").getUTCDay()));
    if (g.length < minPerGroup || days.size < 2) continue;
    const mid = median(g.map((f) => f.price));
    for (const f of g) {
      const d = new Date(f.departDate + "T00:00:00Z").getUTCDay();
      ratios.set(d, [...(ratios.get(d) ?? []), f.price / mid]);
      groupsBy.set(d, (groupsBy.get(d) ?? new Set()).add(k));
    }
  }
  return [...ratios].sort(([a], [b]) => a - b)
    .map(([day, r]) => ({ day, factor: median(r), fares: r.length, groups: groupsBy.get(day)!.size }));
}
