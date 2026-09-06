/**
 * Used ONLY by the mock provider to generate believable prices with no account.
 * In production, flight and hotel prices come from the cache as actual per-date
 * values — there is no seasonality model in the real pricing path.
 */
import { parseISO, type ISODate } from "./dates.js";

type Window = [string, string, number, string];

const CURVES: Record<string, Window[]> = {
  wdw: [["01-01","01-04",1.68,"New Year week"],["01-05","02-12",0.84,"Post-holiday lull"],
    ["02-13","02-23",1.16,"Presidents week"],["02-24","03-07",1.0,""],
    ["03-08","04-21",1.4,"Spring break & Easter"],["04-22","05-24",0.98,""],
    ["05-25","08-10",1.26,"Summer"],["08-11","09-24",0.8,"Late-summer lull"],
    ["09-25","11-19",1.04,"Food & Wine season"],["11-20","11-30",1.48,"Thanksgiving"],
    ["12-01","12-17",0.94,"Early December"],["12-18","12-31",1.72,"Christmas"]],
  dlr: [["01-01","01-04",1.55,"New Year week"],["01-05","02-10",0.86,"January low"],
    ["02-11","02-22",1.14,"Presidents week"],["02-23","03-14",1.0,""],
    ["03-15","04-20",1.34,"Spring break"],["04-21","05-25",1.0,""],
    ["05-26","08-15",1.24,"Summer"],["08-16","09-20",0.88,"Back-to-school lull"],
    ["09-21","10-31",1.1,"Halloween season"],["11-01","11-21",0.96,""],
    ["11-22","11-30",1.42,"Thanksgiving"],["12-01","12-16",1.02,""],["12-17","12-31",1.62,"Christmas"]],
  dlp: [["01-01","01-05",1.45,"New Year"],["01-06","02-06",0.82,"January low"],
    ["02-07","03-08",1.22,"French winter holidays"],["03-09","04-04",0.96,""],
    ["04-05","04-27",1.3,"Easter holidays"],["04-28","05-12",1.1,"May bank holidays"],
    ["05-13","07-04",1.0,""],["07-05","08-31",1.34,"Summer holidays"],
    ["09-01","10-17",0.88,"Autumn low"],["10-18","11-03",1.28,"Toussaint holidays"],
    ["11-04","12-05",0.86,"November low"],["12-06","12-31",1.5,"Christmas season"]],
  tdr: [["01-01","01-03",1.7,"New Year"],["01-04","02-28",0.84,"Winter low"],
    ["03-01","03-19",1.0,""],["03-20","04-08",1.36,"Cherry blossom & spring break"],
    ["04-09","04-27",1.02,""],["04-28","05-06",1.62,"Golden Week"],
    ["05-07","07-17",0.94,"Rainy season"],["07-18","08-10",1.24,"Summer holidays"],
    ["08-11","08-17",1.44,"Obon"],["08-18","09-30",0.92,""],
    ["10-01","11-30",1.08,"Autumn"],["12-01","12-24",1.0,""],["12-25","12-31",1.66,"Year end"]],
  shdr: [["01-01","01-03",1.3,"New Year"],["01-04","02-09",0.82,"Winter low"],
    ["02-10","02-22",1.55,"Chinese New Year"],["02-23","04-02",0.94,""],
    ["04-03","04-06",1.2,"Qingming"],["04-07","04-30",1.0,""],
    ["05-01","05-05",1.5,"Labour Day holiday"],["05-06","06-20",0.92,""],
    ["06-21","08-31",1.3,"Summer holidays"],["09-01","09-30",0.8,"September low"],
    ["10-01","10-07",1.66,"National Day golden week"],["10-08","12-20",0.84,"Autumn low"],
    ["12-21","12-31",1.28,"Year end"]],
  hkdl: [["01-01","01-03",1.32,"New Year"],["01-04","02-09",0.84,"Winter low"],
    ["02-10","02-22",1.5,"Chinese New Year"],["02-23","03-28",0.92,""],
    ["03-29","04-12",1.34,"Easter"],["04-13","06-30",0.86,"Low season"],
    ["07-01","08-25",1.28,"Summer holidays"],["08-26","09-30",0.8,"September low"],
    ["10-01","10-07",1.34,"Golden Week visitors"],["10-08","11-30",0.94,""],
    ["12-01","12-18",1.02,""],["12-19","12-31",1.46,"Christmas & New Year"]],
};

const DOW = [1.02, 0.99, 0.95, 0.95, 1.0, 1.08, 1.09];

export function seasonOf(resortId: string, date: ISODate): { m: number; label: string } {
  const md = date.slice(5);
  for (const [a, b, m, label] of CURVES[resortId] ?? []) {
    if (md >= a && md <= b) return { m, label };
  }
  return { m: 1, label: "" };
}

export function dowFactor(date: ISODate): number {
  return DOW[parseISO(date).getUTCDay()]!;
}

/** Published hotel rates bottom out well above base-minus-every-discount. */
export function hotelSeasonFactor(resortId: string, date: ISODate): number {
  return Math.max(0.86, seasonOf(resortId, date).m) * dowFactor(date);
}

/** Deterministic jitter in [-1, 1] so mock data is stable across runs. */
export function jitter(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
