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
  [/EUR\s?$/i, "EUR"], [/USD\s?$/i, "USD"], [/HKD\s?$/i, "HKD"], [/GBP\s?$/i, "GBP"],
  // £ (2026-10-11): Disneyland Paris's UK ticket site prices in pounds, and
  // without this a £ price was saved as euros.
  [/[¥￥]\s?$/, "YEN_SIGN"], [/€\s?$/, "EUR"], [/£\s?$/, "GBP"], [/\$\s?$/, "USD"],
];
const AFTER = [
  [/^\s?(yen|円)/i, "JPY"], [/^\s?JPY/i, "JPY"], [/^\s?(元|RMB|CNY|yuan)/i, "CNY"],
  [/^\s?(HKD)/i, "HKD"], [/^\s?(EUR|€|euros?)/i, "EUR"], [/^\s?(GBP|pounds?)/i, "GBP"], [/^\s?(USD|dollars?)/i, "USD"],
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
  const spans = [];
  const add = (index, s) => { if (s && !spans.some(([a, b]) => index > a && index < b)) found.push({ index, iso: s }); };
  let m;
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  // A range names its year once, at the end: "Sept 25 to Dec 24, 2026" and
  // "Jan 3 – 29, 2027". The first date takes the second's year (the year
  // before, when its month comes later). Read alone it would be guessed, and
  // a start already passed would wrongly jump to next year.
  const rangeRe = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s*(?:to|through|thru|until|till|–|—|-)\\s*(?:${mon}\\s+)?(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,\\s*|\\s+)(\\d{4})`, "gi");
  while ((m = rangeRe.exec(text))) {
    const m1 = monthIdx(m[1]) + 1, d1 = Number(m[2]);
    const m2 = m[3] ? monthIdx(m[3]) + 1 : m1, d2 = Number(m[4]), y2 = Number(m[5]);
    const y1 = m1 > m2 ? y2 - 1 : y2;
    const a = iso(y1, m1, d1), b = iso(y2, m2, d2);
    if (a && b) {
      found.push({ index: m.index, iso: a }, { index: m.index + 1, iso: b });
      spans.push([m.index - 1, m.index + m[0].length]);
    }
  }
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

/* ---------------------------------------------------- a ticket page */

/**
 * A park-ticket page ("Price per person · Adult (12+) £285 · Child (3-11)
 * £268 · Save £93 per person with a 3-day ticket"). The first price on such
 * a page is a calendar cell for some OTHER day, so it must not be taken
 * (2026-10-11: a Paris check saved April 4's £297 as euros, split four ways,
 * against a 1-day ticket). Returns the adult and child prices printed beside
 * their labels, how many days the ticket covers, and whether the page says
 * the prices are per person. Null when the page has no Adult/Child labels.
 */
export function readTicketPage(text, resortCurrency = "") {
  const lab = (re) => { const m = re.exec(text); return m ? m.index + m[0].length : -1; };
  const pa = lab(/\badult\b[^\n\d£€$¥]*(?:\(\s*\d+\s*\+?\s*\))?/i);
  const pc = lab(/\bchild(?:ren)?\b[^\n\d£€$¥]*(?:\(\s*\d+\s*[-–]\s*\d+\s*\))?/i);
  if (pa < 0 && pc < 0) return null;
  // Prices after the labels, in order, marked with a currency.
  const from = Math.min(...[pa, pc].filter((x) => x >= 0));
  const priced = findAmounts(text.slice(from), resortCurrency).filter((a) => a.currency);
  let adult = null, child = null;
  if (pa >= 0 && pc >= 0) {
    // Side by side ("Adult (12+)  Child (3-11)" then "£285  £268") or one
    // after the other: either way the first price belongs to the first label.
    const [first, second] = pa < pc ? ["adult", "child"] : ["child", "adult"];
    const v = { adult: null, child: null };
    v[first] = priced[0] || null; v[second] = priced[1] || null;
    adult = v.adult; child = v.child;
  } else if (pa >= 0) adult = priced[0] || null;
  else child = priced[0] || null;
  const d = /\b(\d{1,2})\s*-?\s*(?:day|jour)s?\b/i.exec(text);
  const days = d && Number(d[1]) >= 1 && Number(d[1]) <= 10 ? Number(d[1]) : null;
  return { adult, child, days, perPerson: /per\s+person|par\s+personne/i.test(text) };
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
  if (/walt disney world|orlando|\bmco\b|disney resorts collection|disney springs|magic kingdom|epcot|hollywood studios|animal kingdom|disneyworld/.test(s)) return "wdw";
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

/* ------------------------------------------------------------ deals */

/**
 * What a Disney offer page says, read for the Deals page in /admin
 * (2026-10-03). Offer pages read "Save up to 25% on rooms at select Disney
 * Resort hotels" and "Valid for most nights Feb 22 – Apr 30, 2026". Like
 * everything here these are guesses the form highlights, never saved alone.
 */
export function findPercents(text) {
  const out = [];
  const re = /(\d{1,2}(?:\.\d)?)\s*%/g;
  let m;
  while ((m = re.exec(text))) { const v = Number(m[1]); if (v > 0 && v <= 100 && !out.includes(v)) out.push(v); }
  return out;
}

/** "free dining" -> free_dining; a percent about tickets -> ticket_pct_off;
 *  a percent otherwise -> room_pct_off (Disney's offers are mostly rooms);
 *  "$X off" about rooms -> room_flat_off, otherwise flat_off_total. */
export function guessDealKind(text) {
  const s = text.toLowerCase();
  if (/free\s+dining|dining\s+plan/.test(s)) {
    // "FREE Dining Plan for Kids (Ages 3 to 9)": only the children eat free.
    return /\b(kids?|child(ren)?)\b|ages?\s+\d+\s*(?:to|-|–)\s*\d+/.test(s) ? "kids_free_dining" : "free_dining";
  }
  const ticket = /\btickets?\b|park hopper|admission|theme park/.test(s);
  const room = /\brooms?\b|resort hotels?|\bstay\b|\bnights?\b|accommodation/.test(s);
  if (/[$€£¥]\s?\d[\d,]*\s*(?:off\s+)?(?:per|a|each|\/)\s*night/.test(s)) return "room_night_off";
  if (findPercents(text).length) return ticket && !room ? "ticket_pct_off" : "room_pct_off";
  if (/[$€£¥]\s?\d[\d,]*\s*(?:off|discount|savings)|save\s+[$€£¥]\s?\d/.test(s)) return room ? "room_flat_off" : "flat_off_total";
  return null;
}

/** The headline, usually the line that says what you save. */
export function guessDealLabel(text) {
  const lines = text.split("\n").map((x) => x.replace(/\s+/g, " ").trim());
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    // Not a bare page heading like "Special Offers": the headline names a saving.
    if (l.length >= 8 && l.length <= 100 && /save|%|\boff\b|free\s|discount/i.test(l)) {
      // A big headline often wraps: "...at Select Disney" / "Resort Hotels".
      // Join a short next line with no numbers in it (dates and prices have them).
      const next = lines[i + 1] || "";
      if (next && !/\d/.test(next) && !/[.!:]$/.test(l) && (l + " " + next).length <= 100) l = l + " " + next;
      return l;
    }
  }
  return guessName(text);
}

/** "$300 off" / "save $200" -> 300 / 200 (the number after a dollar sign
 *  next to "off" or "save"). */
export function findDollarsOff(text) {
  const out = [];
  const re = /(?:save\s+)?\$\s?(\d[\d,]*)(?:\s*(?:off|discount|savings))?/gi;
  let m;
  while ((m = re.exec(text))) {
    // "Save Up to $250 Per Night": the word can sit a few words away.
    const near = /save|off|discount|savings/i.test(text.slice(Math.max(0, m.index - 14), m.index + m[0].length + 10));
    const v = Number(m[1].replace(/,/g, ""));
    if (near && v > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/** OCR leaves strays at the start of a headline: a "3" from an icon, a
 *  bullet, a quote. Strip those, never a real "25% off" or "$300". */
export function cleanLabel(line) {
  let l = String(line || "").replace(/\s+/g, " ").trim();
  l = l.replace(/^(?:[^\p{L}\p{N}$€£¥]+|\d{1}\s+(?=\p{Lu}))+/u, "").trim();
  return l.replace(/[\s|•·>»]+$/u, "").trim();
}

// Where an offer's headline stops and its small print begins.
const SMALL_PRINT = /^(?:[•·*\-–]\s*|for (?:stays|travel)|valid|offer type|location|book (?:by|now|through)|learn more|view |see |terms|eligib|available|must|stays? |travel |when you|excludes|limited|\d{1,2}\/\d)/i;
// A line that ends an offer card on Disney's pages.
const CARD_END = /^(?:learn more|view (?:offer|details)|see (?:offer|details)|get (?:offer|details)|book now)\b/i;
// A line that starts one: it names a saving, or "...Members: Save...".
const HEADLINE = /^(?:save|get|enjoy|free|up to|\d{1,2}% off|\$\d)|members?:|\bsave\b.*(?:%|\$|\bon\b)|\b\d{1,2}% off\b/i;

/**
 * Pulls one offer apart: headline (joined across wrapped lines), what it
 * takes off and how much, travel dates, the shortest stay, and the
 * conditions a traveler must meet. Pure; a guess the owner checks.
 */
export function readOffer(text, today = new Date().toISOString().slice(0, 10)) {
  const lines = String(text).split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  let start = lines.findIndex((l) => /save|%|\boff\b|free\s|discount/i.test(l) && cleanLabel(l).length >= 8);
  if (start < 0) start = 0;
  const parts = [];
  for (let i = start; i < lines.length && parts.length < 4; i++) {
    const l = cleanLabel(lines[i]);
    if (i > start && (SMALL_PRINT.test(lines[i]) || SMALL_PRINT.test(l) || CARD_END.test(l))) break;
    // Body copy, not a wrapped headline: a sentence, or a long line (a
    // headline is set large, so OCR gives it short lines).
    if (i > start && (/[.!]\s|[.!]$/.test(l) || l.length > 55)) break;
    if (!l) break;
    // A second "Save up to..." is the description repeating the headline.
    if (i > start && /^(?:save|get|enjoy)\b/i.test(l)) break;
    parts.push(l);
    if ((parts.join(" ")).length > 110) break;
  }
  // "Room-" / "and-Ticket" was one word wrapped at its hyphen.
  let label = parts.join(" ").replace(/(\p{L})- (\p{Ll})/gu, "$1-$2").replace(/\s+/g, " ").trim();
  if (label.length > 120) label = label.slice(0, 117).replace(/\s+\S*$/, "") + "…";
  const kind = guessDealKind(text);
  const pcts = findPercents(text), dollars = findDollarsOff(text);
  const value = kind === "free_dining" || kind === "kids_free_dining" ? null
    : /pct/.test(kind || "") ? (pcts[0] ?? null)
    : kind ? (dollars[0] ?? null) : null;
  const dates = findDates(text, today);
  // Wrapped lines rejoined, so "FREE Park / Hopper" still reads as one phrase.
  const s = text.toLowerCase().replace(/(\p{L})-\s+(\p{L})/gu, "$1-$2").replace(/\s+/g, " ");
  const nm = s.match(/(?:minimum|at least)\s+(?:of\s+)?(\d{1,2})[- ]nights?/) || s.match(/\b(\d{1,2})[- ]nights?\b/);
  const conditions = [];
  if (/disney\+|perks members?/.test(s)) conditions.push("Disney+ Perks members");
  if (/passholders?|magic key|annual pass/.test(s)) conditions.push("Annual Passholders / Magic Key holders");
  if (/florida residents?/.test(s)) conditions.push("Florida residents");
  if (/california residents?|socal residents?/.test(s)) conditions.push("California residents");
  if (/military|armed forces/.test(s)) conditions.push("Military");
  if (/room[- ]and[- ]ticket|package/.test(s)) conditions.push("Room-and-ticket package only");
  if (/free park hopper|park hopper option/.test(s) && /free/.test(s)) conditions.push("Includes a free Park Hopper (not counted in our price)");
  if (/select (?:disney )?resort|select hotels?|select rooms?/.test(s)) conditions.push("Select hotels");
  if (/most nights/.test(s)) conditions.push("Most nights, not all");
  return {
    label: label || guessName(text), kind, value, upTo: /up\s+to/.test(s),
    startsOn: dates[0] ?? null, endsOn: dates[1] && dates[1] > dates[0] ? dates[1] : null,
    dates, minNights: nm ? Number(nm[1]) : null, conditions: conditions.join("; "),
    resort: guessResort(text), text,
  };
}

/**
 * A screenshot of an offers PAGE holds several offers. Split the text into
 * one chunk per offer: after each "Learn More"-type line when the page has
 * them, else before each headline. Chunks with no saving and no date (page
 * headings, menus) are dropped. One offer in, one offer out.
 */
export function splitOffers(text, today = new Date().toISOString().slice(0, 10)) {
  const lines = String(text).split("\n");
  let chunks = [];
  let cur = [];
  const push = () => { if (cur.join("").trim()) chunks.push(cur.join("\n")); cur = []; };
  if (lines.some((l) => CARD_END.test(cleanLabel(l)))) {
    for (const l of lines) { cur.push(l); if (CARD_END.test(cleanLabel(l))) push(); }
    push();
  } else {
    let inSmallPrint = false;
    for (const l of lines) {
      const c = cleanLabel(l);
      if (HEADLINE.test(c) && !SMALL_PRINT.test(l.trim()) && (inSmallPrint || !cur.some((x) => HEADLINE.test(cleanLabel(x))))) {
        push(); inSmallPrint = false;
      }
      cur.push(l);
      if (cur.length > 1 && (SMALL_PRINT.test(l.trim()) || /\d{4}/.test(l))) inSmallPrint = true;
    }
    push();
  }
  // Whatever resort the page names applies to every offer on it.
  const pageResort = guessResort(text);
  const offers = chunks.map((c) => readOffer(c, today))
    .filter((o) => (o.kind || o.dates.length) && o.label && /save|%|\boff\b|free|discount/i.test(o.text));
  for (const o of offers) if (!o.resort) o.resort = pageResort;
  return offers;
}

/**
 * Where to cut a screenshot of cards laid out SIDE BY SIDE (Disney's offer
 * pages are a grid). Read whole, OCR goes straight across every card a line
 * at a time and stirs three headlines into one. A gap between cards is a
 * band of columns with almost nothing changing from top to bottom; text
 * always has something. `lum` is one brightness value (0-255) per pixel,
 * row by row. Returns the x positions to cut at, [] for one column.
 */
export function findColumnCuts(lum, width, height) {
  if (width < 200 || height < 100) return [];
  // Changes down AND across: a card's border is a steady vertical line, but
  // the step from page to border still counts, so only true gaps are blank.
  const ink = new Array(width).fill(0);
  for (let y = 1; y < height; y++) {
    const row = y * width, prev = (y - 1) * width;
    for (let x = 1; x < width; x++) {
      const v = lum[row + x];
      if (Math.abs(v - lum[prev + x]) > 40 || Math.abs(v - lum[row + x - 1]) > 40) ink[x]++;
    }
  }
  // Measured on a rendered offers page: gaps read 0, the sparsest text
  // column 8+. A little room for a page title that crosses a gap.
  const quiet = (x) => ink[x] <= 2 + height * 0.003;
  const minGap = Math.max(10, Math.round(width * 0.008));
  const runs = [];
  for (let x = 0; x < width; ) {
    if (!quiet(x)) { x++; continue; }
    const a = x; while (x < width && quiet(x)) x++;
    if (x - a >= minGap && a > 0 && x < width) runs.push(Math.round((a + x) / 2));
  }
  // Every piece has to be wide enough to be a card, not a sliver of margin.
  const cuts = [];
  let last = 0;
  for (const c of runs) if (c - last >= width * 0.15 && width - c >= width * 0.15) { cuts.push(c); last = c; }
  return cuts;
}

/* --------------------------------------------- Disney's ticket calendars */

const CAL_MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const CAL_WEEKDAYS = ["sun","mon","tue","wed","thu","fri","sat"];
const cleanWord = t => String(t || "").trim().replace(/^[^\w$]+|[^\w+.$]+$/g, "");

/**
 * Disney's ticket calendar ("Choose the Start Date of Your 5-Day Ticket",
 * a month with "$153+" in every day) read into one per-day price per date
 * (owner, 2026-10-21). Pure: it takes the WORDS the OCR found, each with its
 * box, and works out the dates from the picture's own grid:
 *  - the month and year from the "October 2027" heading;
 *  - the ticket length from "5-Day Ticket";
 *  - each "$153+" price's column from the Sun..Sat headings above it (or, if
 *    those were missed, from the spread of the prices themselves: a month
 *    fills all seven columns), and its week from its height on the page;
 *  - then checks itself against the day numbers printed in the cells.
 * The owner checks every box before saving; a misread digit is fixed there.
 *
 * words: [{ text, x0, y0, x1, y1 }]
 * Returns { month: "YYYY-MM" | null, ticketDays, adultAges, prices: [{date, perDay}],
 *           missing: [dates], warnings: [] }
 */
export function readTicketCalendar(words) {
  const W = (words || []).filter(w => w && String(w.text || "").trim())
    .map(w => ({ ...w, t: cleanWord(w.text), cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, h: w.y1 - w.y0 }));
  const warnings = [];
  const text = W.map(w => w.text).join(" ");

  // The heading: a full month name followed by a year ("October 2027").
  let month = null, heading = null;
  for (let i = 0; i < W.length - 1; i++) {
    const m = CAL_MONTHS.indexOf(W[i].t.toLowerCase());
    const y = /^(20\d\d)$/.exec(W[i + 1].t);
    if (m >= 0 && y && Math.abs(W[i + 1].cy - W[i].cy) < Math.max(W[i].h, 8)) {
      const ym = `${y[1]}-${String(m + 1).padStart(2, "0")}`;
      if (!month) { month = ym; heading = W[i]; }
      else if (ym !== month) { warnings.push(`It also mentions ${CAL_MONTHS[m]} ${y[1]}; read as ${month}. Check the month.`); break; }
    }
  }
  const len = /(\d{1,2})\s*-?\s*Day\s+Ticket/i.exec(text) || /(\d{1,2})\s*-?\s*day\s+ticket/i.exec(text.replace(/\s+/g, " "));
  const ticketDays = len ? Number(len[1]) : null;
  const ages = /Ages?\s*(\d{1,2})\s*\+/i.exec(text);
  const adultAges = ages ? `${ages[1]}+` : null;

  // The weekday headings, the top of the grid.
  const heads = W.filter(w => CAL_WEEKDAYS.includes(w.t.slice(0, 3).toLowerCase()) && w.t.length <= 9
    && /^[A-Za-z]+$/.test(w.t) && (!heading || w.cy > heading.cy));
  // Keep one heading per weekday, the row the most of them share.
  const byDay = new Map();
  for (const h of heads) {
    const d = CAL_WEEKDAYS.indexOf(h.t.slice(0, 3).toLowerCase());
    const prev = byDay.get(d);
    if (!prev || (heading && Math.abs(h.cy - heading.cy) < Math.abs(prev.cy - heading.cy))) byDay.set(d, h);
  }
  const headRowY = byDay.size ? [...byDay.values()].map(h => h.cy).sort((a, b) => a - b)[Math.floor(byDay.size / 2)] : null;

  // The prices: "$153+" (or "153+"); a lone "$153" only if no "+" prices were read.
  const priceOf = w => {
    const m = /^\$?(\d{2,4}(?:\.\d{1,2})?)([+t*])?$/.exec(w.t.replace(/,/g, ""));
    if (!m) return null;
    const v = Number(m[1]);
    return v >= 20 && v <= 1000 ? { v, plus: !!m[2] || /\+$/.test(w.text) } : null;
  };
  let cands = W.map(w => ({ w, p: priceOf(w) })).filter(x => x.p && /\$|\+/.test(x.w.text))
    .filter(x => headRowY === null || x.w.cy > headRowY);
  const plus = cands.filter(x => x.p.plus);
  if (plus.length >= 7) cands = plus;
  const prices = cands.map(x => ({ ...x.w, v: x.p.v }));
  if (!month) return { month: null, ticketDays, adultAges, prices: [], missing: [], warnings: ["Couldn't find the month (like \"October 2027\") in the picture."] };
  if (!prices.length) return { month, ticketDays, adultAges, prices: [], missing: [], warnings: ["Couldn't find the prices in the calendar."] };

  // Columns: from the headings when at least two were read, else from the prices' spread.
  let colOf;
  const hs = [...byDay.entries()];
  if (hs.length >= 2) {
    const n = hs.length, sx = hs.reduce((a, [d]) => a + d, 0), sy = hs.reduce((a, [, h]) => a + h.cx, 0);
    const sxx = hs.reduce((a, [d]) => a + d * d, 0), sxy = hs.reduce((a, [d, h]) => a + d * h.cx, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    colOf = cx => Math.max(0, Math.min(6, Math.round((cx - a) / b)));
  } else {
    const xs = prices.map(p => p.cx), lo = Math.min(...xs), hi = Math.max(...xs);
    colOf = cx => hi > lo ? Math.max(0, Math.min(6, Math.round((cx - lo) / (hi - lo) * 6))) : 0;
    warnings.push("Couldn't read the Sun–Sat headings; worked out the columns from the prices.");
  }

  // Weeks: prices sorted top to bottom, a new week when the height jumps.
  const hMed = [...prices.map(p => p.h)].sort((a, b) => a - b)[Math.floor(prices.length / 2)] || 10;
  const sorted = [...prices].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const p of sorted) {
    const row = rows[rows.length - 1];
    if (row && p.cy - row.y < hMed * 2) row.items.push(p); else rows.push({ y: p.cy, items: [p] });
  }
  const [yy, mm] = month.split("-").map(Number);
  const firstDow = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
  const daysIn = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const placed = [];
  rows.forEach((row, r) => row.items.forEach(p => placed.push({ p, day: r * 7 + colOf(p.cx) - firstDow + 1 })));

  // Check the weeks against the day numbers printed in the cells (top right
  // of each cell, above its price). A whole-week slip shows as +-7.
  const rowGap = rows.length > 1 ? (rows[rows.length - 1].y - rows[0].y) / (rows.length - 1) : hMed * 6;
  const colW = (() => { const xs = placed.map(x => x.p.cx).sort((a, b) => a - b); return xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / 6 : 100; })();
  const nums = W.filter(w => /^\d{1,2}$/.test(w.t) && Number(w.t) >= 1 && Number(w.t) <= 31 && (headRowY === null || w.cy > headRowY));
  const votes = new Map();
  for (const x of placed) {
    let best = null, bestD = Infinity;
    for (const n of nums) {
      const dy = x.p.cy - n.cy, dx = n.cx - x.p.cx;
      if (dy <= 0 || dy > rowGap * 0.9 || dx < -colW * 0.3 || dx > colW * 1.1) continue;
      const dist = dy + Math.abs(dx) * 0.2;
      if (dist < bestD) { bestD = dist; best = n; }
    }
    if (best) { const d = Number(best.t) - x.day; votes.set(d, (votes.get(d) || 0) + 1); }
  }
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[0] !== 0 && top[0] % 7 === 0 && top[1] >= Math.max(3, placed.length * 0.3)) {
    placed.forEach(x => { x.day += top[0]; });
    warnings.push("The calendar's own day numbers moved the weeks; check the first and last week.");
  }

  const out = new Map();
  for (const x of placed) {
    if (x.day < 1 || x.day > daysIn) { warnings.push(`A price ($${x.p.v}) didn't fall on a day of the month and was left out.`); continue; }
    const date = `${month}-${String(x.day).padStart(2, "0")}`;
    if (out.has(date)) { warnings.push(`Two prices landed on ${date}; kept $${out.get(date)}. Check that day.`); continue; }
    out.set(date, x.p.v);
  }
  const all = Array.from({ length: daysIn }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  return {
    month, ticketDays, adultAges,
    prices: all.filter(d => out.has(d)).map(d => ({ date: d, perDay: out.get(d) })),
    missing: all.filter(d => !out.has(d)),
    warnings,
  };
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
export async function readImage(image, { langs = "eng", onProgress, columns = false } = {}) {
  const T = await loadTesseract();
  const worker = await T.createWorker(langs, 1, {
    logger: (m) => { if (onProgress && typeof m.progress === "number") onProgress(m.progress, m.status || ""); },
  });
  try {
    const rects = columns ? await columnRects(image) : [];
    if (rects.length < 2) return (await worker.recognize(image)).data.text || "";
    // One card column at a time, left to right, so each offer reads whole.
    const parts = [];
    for (const rectangle of rects) parts.push((await worker.recognize(image, { rectangle })).data.text || "");
    return parts.join("\n");
  } finally {
    await worker.terminate();
  }
}

/**
 * Every word in an image with its box, for readers that need WHERE a word
 * sits (the ticket calendar). Small screenshots are doubled first, which
 * reads small calendar digits far more reliably; boxes are in that scale.
 */
export async function readWords(image, { onProgress } = {}) {
  const T = await loadTesseract();
  const worker = await T.createWorker("eng", 1, {
    logger: (m) => { if (onProgress && typeof m.progress === "number") onProgress(m.progress, m.status || ""); },
  });
  try {
    // "Sparse text": a calendar is scattered words, not paragraphs.
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    let src = image;
    try {
      const bmp = await createImageBitmap(image);
      const k = bmp.width < 1600 ? 2 : 1;
      const c = document.createElement("canvas");
      c.width = bmp.width * k; c.height = bmp.height * k;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      src = c;
    } catch { /* read it as it is */ }
    const { data } = await worker.recognize(src, {}, { blocks: true, text: true });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
      words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    }
    if (!words.length && Array.isArray(data.words)) {
      for (const w of data.words) words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    }
    return { words, text: data.text || "" };
  } finally {
    await worker.terminate();
  }
}

/** The card columns in an image file, as rectangles for Tesseract. */
async function columnRects(image) {
  try {
    const bmp = await createImageBitmap(image);
    const { width, height } = bmp;
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, width, height).data;
    const lum = new Uint8Array(width * height);
    for (let i = 0; i < lum.length; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    const cuts = findColumnCuts(lum, width, height);
    const edges = [0, ...cuts, width];
    return cuts.length ? edges.slice(1).map((x, i) => ({ left: edges[i], top: 0, width: x - edges[i], height })) : [];
  } catch { return []; }
}
