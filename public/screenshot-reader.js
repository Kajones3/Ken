/**
 * The screenshot reader for /admin (2026-09-27).
 *
 * The owner asked for this so they "don't have to depend on AI for
 * everything". So:
 *  - The text is read by Tesseract.js running IN THE OWNER'S OWN BROWSER. The
 *    image never leaves their device and no AI service sees it. (The library
 *    and its language files download from cdn.jsdelivr.net the first time.)
 *  - It only PRE-FILLS the price-check form. Nothing is saved until the owner
 *    has looked at every box and pressed Save — OCR misreads digits, and a
 *    misread digit saved automatically would be a wrong price stored as a
 *    real one.
 *
 * The functions that find prices and dates in the text are plain and pure,
 * and src/screenshotReader.test.ts runs them against real OCR output.
 */

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js";

/* ------------------------------------------------------------ amounts */

// Currency markers before a number, and words after one. OCR often turns
// "¥" into "Y" or "\", so a bare Y or backslash counts only when it is
// directly followed by a comma-grouped number — "Y502,500", never "Y2".
const BEFORE = [
  [/HK\s?\$$/i, "HKD"], [/US\s?\$$/i, "USD"], [/(RMB|CNY)\s?$/i, "CNY"], [/JPY\s?$/i, "JPY"],
  [/EUR\s?$/i, "EUR"], [/USD\s?$/i, "USD"], [/HKD\s?$/i, "HKD"],
  [/[¥￥]\s?$/, "YEN_SIGN"], [/€\s?$/, "EUR"], [/\$\s?$/, "USD"],
];
const AFTER = [
  [/^\s?(yen|円)/i, "JPY"], [/^\s?JPY/i, "JPY"], [/^\s?(元|RMB|CNY|yuan)/i, "CNY"],
  [/^\s?(HKD)/i, "HKD"], [/^\s?(EUR|€|euros?)/i, "EUR"], [/^\s?(USD|dollars?)/i, "USD"],
];

/**
 * Every price-looking number in the text, in the order it appears, with the
 * currency it was written in when the text says. `resortCurrency` settles the
 * one ambiguous sign: ¥ is the yen in Tokyo and the yuan in Shanghai.
 */
export function findAmounts(text, resortCurrency = "") {
  const out = [];
  const seen = new Set();
  const re = /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const start = m.index, end = start + raw.length;
    // Part of a date, a time, a longer number or a flight number? Skip it.
    const prev = text[start - 1] || "", next = text[end] || "";
    if (/[\d/:\-]/.test(prev) || /[\d/:]/.test(next) || (next === "-" && /\d/.test(text[end + 1] || ""))) continue;
    const before = text.slice(Math.max(0, start - 5), start);
    const after = text.slice(end, end + 8);
    let currency = null, marked = false;
    for (const [pat, cur] of BEFORE) if (pat.test(before)) { currency = cur; marked = true; break; }
    if (!currency && /[Y\\]\s?$/.test(before) && raw.includes(",")) { currency = "YEN_SIGN"; marked = true; }
    // Glued to a word ("DL1234", "Room2") and not to a currency: not a price.
    if (/[A-Za-z]/.test(prev) && !marked) continue;
    if (!currency) for (const [pat, cur] of AFTER) if (pat.test(after)) { currency = cur; break; }
    if (currency === "YEN_SIGN") currency = resortCurrency === "CNY" ? "CNY" : "JPY";
    const amount = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // A bare number with no currency is only a candidate when it looks like
    // a price: grouped with commas, or with cents. A lone "2" or "2026" is
    // a count or a year far more often than a price.
    if (!currency && !raw.includes(",") && !/\.\d{2}$/.test(raw)) continue;
    if (!currency && /^(19|20)\d{2}$/.test(raw)) continue;
    const key = `${amount}|${currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A few words after the number ("per night", "total"), so the owner can
    // tell a nightly rate from a whole stay without squinting at the image.
    const context = text.slice(end, end + 18).split("\n")[0].trim();
    out.push({ raw, amount, currency, context });
  }
  return out;
}

/* -------------------------------------------------------------- dates */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIdx = (w) => MONTHS.indexOf(String(w).slice(0, 3).toLowerCase());
const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(s + "T00:00:00Z");
  return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
};
/** A date with no year is the next one on or after today — a booking page
 *  shows dates you are about to travel, never last year's. */
const nextYearFor = (m, d, today) => {
  const y = Number(today.slice(0, 4));
  const thisYear = iso(y, m, d);
  return thisYear && thisYear >= today ? y : y + 1;
};

/**
 * Every date in the text, as YYYY-MM-DD, in the order it appears. Reads the
 * shapes booking pages use: "Dec 17, 2026", "Wed, Dec 17", "17 Dec 2026",
 * "12/17/2026", "2026-12-17", "2026/12/17" and "2026年12月17日".
 */
export function findDates(text, today = new Date().toISOString().slice(0, 10)) {
  const found = [];
  const add = (index, s) => { if (s) found.push({ index, iso: s }); };
  let m;
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  // (?!\\d) after the day: in "17 Dec 2026" the "20" of the year is not a day.
  // OCR drops spaces: "Dec 17,2026" has to read the same as "Dec 17, 2026".
  let re = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:(?:,\\s*|\\s+)(\\d{4}))?`, "gi");
  while ((m = re.exec(text))) {
    const mi = monthIdx(m[1]) + 1, d = Number(m[2]);
    add(m.index, iso(m[3] ? Number(m[3]) : nextYearFor(mi, d, today), mi, d));
  }
  re = new RegExp(`\\b(\\d{1,2})\\s+${mon}(?:(?:,\\s*|\\s+)(\\d{4}))?`, "gi");
  while ((m = re.exec(text))) {
    const mi = monthIdx(m[2]) + 1, d = Number(m[1]);
    add(m.index, iso(m[3] ? Number(m[3]) : nextYearFor(mi, d, today), mi, d));
  }
  re = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  while ((m = re.exec(text))) add(m.index, iso(+m[1], +m[2], +m[3]));
  re = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
  while ((m = re.exec(text))) add(m.index, iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]));
  re = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  while ((m = re.exec(text))) add(m.index, iso(+m[1], +m[2], +m[3]));
  found.sort((a, b) => a.index - b.index);
  const out = [];
  for (const f of found) if (!out.includes(f.iso)) out.push(f.iso);
  return out;
}

/* ---------------------------------------------------- what it is about */

export function guessCategory(text) {
  const s = text.toLowerCase();
  const score = {
    hotel: (s.match(/check[- ]?in|check[- ]?out|per night|\bnights?\b|\broom\b|\bhotel\b|\bguests?\b/g) || []).length,
    flight: (s.match(/nonstop|non-stop|round trip|\bstops?\b|depart|return|airline|economy|\bflight/g) || []).length,
    ticket: (s.match(/passport|\btickets?\b|admission|park hopper|1-day|one-day/g) || []).length,
    food: (s.match(/\bmenu\b|\bset\b|\bcombo\b|\bmeal\b|\bdrink\b|\bsnack\b|restaurant|\bcafe\b/g) || []).length,
  };
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

export function guessResort(text) {
  const s = text.toLowerCase();
  if (/paris|marne/.test(s)) return "dlp";
  if (/hong kong/.test(s)) return "hkdl";
  if (/shanghai/.test(s)) return "shdr";
  if (/tokyo|maihama|urayasu|miracosta|ambassador|celebration hotel/.test(s)) return "tdr";
  if (/walt disney world|orlando|\bmco\b/.test(s)) return "wdw";
  if (/anaheim|disneyland resort|\bsna\b|california adventure/.test(s)) return "dlr";
  return null;
}

/** The first line that reads like a name — on a booking page, the hotel,
 *  ticket or restaurant is almost always the heading. A guess, like
 *  everything else here, and the form highlights it as one. */
export function guessName(text) {
  for (const line of text.split("\n")) {
    const l = line.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (l.length >= 4 && l.length <= 70 && /\p{L}{3}/u.test(l) && !/\d{3}/.test(l)) return l;
  }
  return null;
}

/** Departure airports, as three capital letters next to an arrow or dash. */
export function findAirports(text) {
  const out = [];
  const re = /\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/g;
  let m;
  while ((m = re.exec(text))) { if (!out.includes(m[1])) out.push(m[1]); }
  return out;
}

/* ------------------------------------------------------------ the OCR */

let loading = null;
function loadTesseract() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.onload = () => resolve(globalThis.Tesseract);
      s.onerror = () => { loading = null; reject(new Error("Couldn't load the text reader from cdn.jsdelivr.net — check the connection and try again.")); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Read the text in an image, on this device. `langs` is "eng", or
 * "eng+jpn+chi_sim" to also read Japanese and Chinese (a few MB more the
 * first time). `onProgress` gets a 0-1 number and a status line.
 */
export async function readImage(image, { langs = "eng", onProgress } = {}) {
  const T = await loadTesseract();
  const worker = await T.createWorker(langs, 1, {
    logger: (m) => { if (onProgress && typeof m.progress === "number") onProgress(m.progress, m.status || ""); },
  });
  try {
    const { data } = await worker.recognize(image);
    return data.text || "";
  } finally {
    await worker.terminate();
  }
}
