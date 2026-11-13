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

/**
 * Disney's UNDATED ticket in the cart (Paris, owner 2026-10-31: "Undated
 * Ticket 1 Day/1 Park ... Adult (12+) 1x £114.27, Child (3-11) 1x £106.30").
 * One price for any day. Null when the page doesn't say "Undated".
 * Returns { days, parks, adult, child, currency } (amounts as shown).
 */
export function readUndatedTicket(text) {
  if (!/\bundated\b/i.test(text || "")) return null;
  const page = readTicketPage(text, "");
  if (!page || !page.adult) return null;
  const pk = /(\d)\s*parks?\b/i.exec(text);
  const cur = page.adult.currency || (page.child && page.child.currency) || null;
  return {
    days: page.days || 1,
    parks: pk && (pk[1] === "1" || pk[1] === "2") ? Number(pk[1]) : 1,
    adult: page.adult.amount,
    child: page.child ? page.child.amount : null,
    currency: cur === "GBP" || cur === "EUR" || cur === "USD" ? cur : null,
  };
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

/* ------------------------- cruises (2026-11-12) -------------------------
 * Disney Cruise Line's list page: one card per itinerary, "Price from*
 * $686 USD Avg Per Person", "Save $138 Avg/Person", "3-Night Bahamian Cruise
 * from Fort Lauderdale", "Sailing to ...", "Show 26 Dates". OCR reads the
 * photo, the middle and the price column across one another, so a port can
 * be split ("Fort ... Lauderdale") and a stray word can sit in a title. The
 * owner checks every row before it is saved; this only fills the boxes. */
export const CRUISE_PORTS = ["Port Canaveral", "Fort Lauderdale", "Galveston", "Miami", "San Diego",
  "Vancouver", "Seward", "New Orleans", "San Juan", "Barcelona", "Civitavecchia", "Southampton", "Dover",
  "Copenhagen", "Reykjavik", "Lisbon", "Athens", "Piraeus", "Singapore", "Sydney", "Brisbane", "Melbourne",
  "Auckland", "Honolulu", "Yokohama", "Tokyo", "Long Beach", "Los Angeles"];
export const CRUISE_THEMES = ["Very Merrytime", "Halloween on the High Seas", "Marvel Day at Sea",
  "Pixar Day at Sea", "Star Wars Day at Sea"];

const MONEY = /(save\s+)?([$£€])\s?(\d[\d,]*)/gi;
const curOf = sym => sym === "£" ? "GBP" : sym === "€" ? "EUR" : "USD";

/** The departure port named after "from": a known port, even when OCR split
 *  its two words apart, else the word(s) right after "from". */
function cruisePort(text, fromAt) {
  const tail = text.slice(Math.max(0, fromAt));
  let best = null;
  for (const port of CRUISE_PORTS) {
    const w = port.split(" ");
    const re = w.length > 1
      ? new RegExp(`\\b${w[0]}\\b[\\s\\S]{0,160}?\\b${w[w.length - 1]}\\b`, "i")
      : new RegExp(`\\b${w[0]}\\b`, "i");
    const m = re.exec(tail);
    if (m && (!best || m.index < best.at)) best = { port, at: m.index };
  }
  if (best) return best.port;
  const m = /cruise\s+from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(tail);
  return m ? m[1] : null;
}

/** One cruise card's text to the boxes the owner checks. */
export function readCruiseCard(text) {
  const t = String(text || "");
  const flat = t.replace(/\s+/g, " ");
  const title = /(\d{1,2})\s*[-–]?\s*Night\s+([A-Za-z'’ ]{2,40}?)\s+Cruise\b/i.exec(flat);
  const nights = title ? Number(title[1]) : null;
  const region = title ? title[2].replace(/\s+/g, " ").trim() : null;
  const fromAt = title ? flat.indexOf(title[0]) : 0;
  const departurePort = title ? cruisePort(flat, fromAt) : null;
  let price = null, save = null, currency = "USD", m;
  MONEY.lastIndex = 0;
  while ((m = MONEY.exec(flat))) {
    const v = Number(m[3].replace(/,/g, ""));
    if (m[1]) { if (save === null && v > 0) save = v; }
    else if (price === null && v >= 50) { price = v; currency = curOf(m[2]); }
  }
  const dm = /Show\s+(\d{1,3})\s+Dates?/i.exec(flat);
  // Where it sails: the "Show N Dates" line (the ports sit beside that
  // button), else the first line after "Sailing to" with a comma in it.
  const lines = t.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const si = lines.findIndex(l => /sailing\s+to/i.test(l));
  let portsLine = lines.find(l => /Show\s+\d{1,3}\s+Dates?/i.test(l))
    || (si >= 0 ? lines.slice(si + 1, si + 4).find(l => /,/.test(l)) : null) || null;
  let ports = null;
  if (portsLine) {
    const toks = portsLine.replace(/Show\s+\d{1,3}\s+Dates?/i, "").replace(/sailing\s+to/i, "").split(" ").filter(Boolean);
    while (toks.length && !/^[A-Z][a-z]{2,}/.test(toks[0])) toks.shift();
    ports = toks.join(" ").trim() || null;
  }
  const theme = CRUISE_THEMES.find(x => new RegExp(x.replace(/ /g, "\\s+"), "i").test(flat)) || null;
  return {
    title: title ? `${nights}-Night ${region} Cruise${departurePort ? " from " + departurePort : ""}` : null,
    nights, region, departurePort, ports, price, currency, save,
    datesCount: dm ? Number(dm[1]) : null,
    guaranteed: /guaranteed/i.test(flat),
    perPerson: /per\s*person|avg\s*\/\s*person|\/\s*person/i.test(flat),
    theme, text: t,
  };
}

/** A screenshot of the cruise LIST holds several cards. Each card starts at
 *  its "Price from" line (else at its "N-Night ... Cruise" title). Chunks
 *  with neither a title nor a price are page furniture and are dropped. */
export function splitCruises(text) {
  const lines = String(text || "").split("\n");
  const starts = lines.some(l => /price\s+from/i.test(l))
    ? (l => /price\s+from/i.test(l))
    : (l => /\d{1,2}\s*[-–]?\s*Night\s+.+Cruise/i.test(l));
  const chunks = []; let cur = [];
  for (const l of lines) {
    if (starts(l) && cur.join("").trim()) { chunks.push(cur.join("\n")); cur = []; }
    cur.push(l);
  }
  if (cur.join("").trim()) chunks.push(cur.join("\n"));
  return chunks.map(readCruiseCard).filter(c => c.nights || c.price);
}

/* ------------------ one cruise's dates + Rate Details (2026-11-13) ------------------
 * After "Show N Dates", Disney lists every sailing: "January 15 - 20, 2027
 * Friday - Wednesday", "Sailing on <ship logo>", the four room headings
 * (Inside / Oceanview / Verandah / Concierge), a price under each ("$905",
 * "Unavailable"), and on a sale a crossed-out "was" price under that. Prices
 * are the AVERAGE PER PERSON for the party the page was set to, taxes, fees
 * and port expenses included (owner's screenshots, 2026-11-13).
 * "Rate & Room Details" opens a side panel: one line per guest ("Adult 1
 * $755.00 USD", "Child 1 $105 USD"), the taxes line, and "Stateroom Price".
 * Both are read from WORD POSITIONS (readWords), because a price belongs to
 * the room heading above it, not to the order OCR happens to list it in. */
export const CRUISE_SHIPS = ["Magic", "Wonder", "Dream", "Fantasy", "Wish", "Treasure", "Destiny", "Adventure", "Believe"];
export const CRUISE_ROOMS = ["inside", "oceanview", "verandah", "concierge"];

/** Words with centres, grouped into lines by height. */
function wordLines(words) {
  const W = (words || []).filter(w => w && String(w.text || "").trim())
    .map(w => ({ ...w, t: String(w.text).trim(), cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) }))
    .sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const lines = [];
  for (const w of W) {
    const l = lines.find(l => Math.abs(l.cy - w.cy) < Math.max(6, Math.min(l.h, w.h) * 0.6));
    if (l) { l.words.push(w); l.cy = (l.cy * (l.words.length - 1) + w.cy) / l.words.length; }
    else lines.push({ cy: w.cy, h: w.h, words: [w] });
  }
  for (const l of lines) { l.words.sort((a, b) => a.x0 - b.x0); l.text = l.words.map(w => w.t).join(" "); }
  return lines.sort((a, b) => a.cy - b.cy);
}

/**
 * One price word to dollars. Disney's green sale tag sits right before a sale
 * price and the reader often turns tag + "$" into junk: "©$775", "©4$1,035",
 * and worse, the "$" itself into a digit: "©3905" is $905, "©51,250" is
 * $1,250, "©9715" is $715. A tag with no "$" left drops one leading digit,
 * and the price is marked `check` so the owner looks at it.
 */
export function cruisePrice(token) {
  let t = String(token || "").trim();
  const tag = /^[©®@¢«&#*]+/.test(t);
  t = t.replace(/^[^\d$£€]+/, "");
  const sign = /[$£€]/.test(t);
  if (sign) t = t.slice(Math.max(t.lastIndexOf("$"), t.lastIndexOf("£"), t.lastIndexOf("€")) + 1);
  else if (!tag) return null;          // no "$" and no tag: not a price we trust
  const ok = x => /^\d{1,2}(?:,\d{3})+(?:\.\d{2})?$|^\d{2,5}(?:\.\d{2})?$/.test(x);
  const num = x => Number(x.replace(/,/g, ""));
  // Readings to choose from, best guess first: as read; without the one or
  // two leading characters a sale tag turned the "$" into; with a "1" the
  // reader lost in front (Disney's tight "11", as in "$140" for $1,140).
  const tries = sign ? [t] : [t.slice(1), t.slice(2)];
  const alts = [];
  for (const x of tries) if (x && ok(x)) {
    const v = num(x); if (v > 0 && !alts.includes(v)) alts.push(v);
    if (v < 1000 && !alts.includes(1000 + v)) alts.push(1000 + v);
  }
  if (!alts.length) return null;
  return { value: alts[0], check: !sign, tag, alts };
}

/** Rooms on one sailing sit in a rough ladder: Inside < Oceanview (about
 *  1.12x) < Verandah (about 1.3x), from the owner's 2026-11 screenshots.
 *  Used only to pick between a doubtful price's possible readings. */
const ROOM_STEP = { inside: 1, oceanview: 1.12, verandah: 1.3 };
function settlePrices(rooms) {
  const live = Object.entries(rooms).filter(([, r]) => r.price !== null && r.alts);
  for (const [, r] of live) {
    // A per-person cruise price is never under $100; a sale price sits under
    // its crossed-out price and at most about 45% below it.
    r.alts = r.alts.filter(v => v >= 100 && v <= 50000);
    const underWas = r.was ? r.alts.filter(v => v < r.was && v >= r.was * 0.55) : [];
    if (r.was && underWas.length) r.alts = underWas;
    else if (r.was) r.was = null;          // no reading fits under it: the crossed-out price is the misread
    if (!r.alts.length) { r.price = null; r.check = true; }
  }
  // Rooms with one possible reading anchor the rest.
  const sure = live.filter(([k, r]) => ROOM_STEP[k] && r.price !== null && (r.alts.length === 1 || !r.check));
  for (const [k, r] of live) {
    if (r.price === null || r.alts.length < 2) { if (r.alts && r.alts.length === 1 && r.alts[0] !== r.price) { r.price = r.alts[0]; r.check = true; } continue; }
    const refs = r.was ? [r.was * 0.85]
      : ROOM_STEP[k] ? sure.filter(([k2]) => k2 !== k).map(([k2, r2]) => (r2.alts.length === 1 ? r2.alts[0] : r2.price) * ROOM_STEP[k] / ROOM_STEP[k2]) : [];
    if (!refs.length) continue;
    const ref = refs.sort((a, b) => a - b)[Math.floor(refs.length / 2)];
    // Keep the plain reading unless it's well off what the other rooms say.
    const off = v => Math.abs(Math.log(v / ref));
    const pick = off(r.alts[0]) <= Math.log(1.3) ? r.alts[0] : r.alts.slice().sort((a, b) => off(a) - off(b))[0];
    if (Math.abs(Math.log(pick / ref)) > Math.log(1.8)) { r.price = null; r.check = true; continue; }
    if (pick !== r.price) { r.price = pick; r.check = true; }
  }
}

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthNo = m => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;
const ymdOf = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** "January 15 - 20, 2027", "January 28 - February 2, 2028", "December 30 -
 *  January 3, 2027" (the year belongs to the end), OCR's "17,2027" too. */
export function sailingDates(line) {
  const re = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})\\s*[-–]\\s*(?:${MONTH_RE}\\s+)?(\\d{1,2})\\s*,?\\s*(20\\d\\d)\\b`, "i");
  const m = re.exec(String(line || ""));
  if (!m) return null;
  const m1 = monthNo(m[1]), d1 = Number(m[2]), m2 = m[3] ? monthNo(m[3]) : m1, d2 = Number(m[4]), y2 = Number(m[5]);
  const y1 = m1 > m2 ? y2 - 1 : y2;
  const start = ymdOf(y1, m1, d1), end = ymdOf(y2, m2, d2);
  const nights = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  if (!(nights >= 1 && nights <= 60) || d1 > 31 || d2 > 31) return null;
  return { start, end, nights };
}

/** Which Disney ship a "Sailing on ..." line names, when the logo reads as
 *  letters (WISH did; MAGIC read as "Bee GIG"), else null. */
function shipOf(text) {
  const t = String(text || "").toLowerCase();
  return CRUISE_SHIPS.find(s => new RegExp(`\\b${s.toLowerCase()}\\b`).test(t)) || null;
}

/**
 * Every sailing in a screenshot of one cruise's dates. Returns
 * { sailings: [{ start, end, nights, ship, rooms: { inside: { price, was,
 * soldOut, check } ... } }], ship, title, nights, departurePort, warnings }.
 * `rightEdge` leaves out words right of it (a Rate Details panel open over
 * the list); readCruiseScreenshot works that out.
 */
export function readCruiseDates(words, { rightEdge = Infinity } = {}) {
  const lines = wordLines((words || []).filter(w => w && w.x0 < rightEdge));
  const warnings = [];
  const sailings = [];
  for (let i = 0; i < lines.length; i++) {
    const when = sailingDates(lines[i].text);
    if (!when) continue;
    // This sailing's block runs to the next date line.
    let j = i + 1;
    while (j < lines.length && !sailingDates(lines[j].text)) j++;
    const block = lines.slice(i, j);
    const sailing = { ...when, ship: null, rooms: {} };
    const on = block.find(l => /sailing\s+on/i.test(l.text)) || lines[i];
    sailing.ship = shipOf(on.text.replace(/.*sailing\s+on/i, ""));
    const head = block.find(l => /inside/i.test(l.text) && /verandah/i.test(l.text));
    if (!head) { warnings.push(`${when.start}: couldn't find the room headings.`); sailings.push(sailing); continue; }
    const cols = CRUISE_ROOMS.map(r => head.words.find(w => w.t.toLowerCase().startsWith(r.slice(0, 5)))).map(w => w ? w.x0 : null);
    if (cols.some(x => x === null)) { warnings.push(`${when.start}: a room heading is missing.`); }
    const colOf = w => {
      let best = -1;
      for (let c = 0; c < cols.length; c++) if (cols[c] !== null && w.x0 >= cols[c] - 25) best = c;
      return best;
    };
    // The price lines: under the headings, before "Avg per person".
    const below = block.filter(l => l.cy > head.cy);
    const stop = below.findIndex(l => /avg|per\s+person|occupancy|rate\s*&/i.test(l.text));
    const priceLines = (stop >= 0 ? below.slice(0, stop) : below)
      .filter(l => l.words.some(w => cruisePrice(w.t) || /unavail/i.test(w.t)));
    priceLines.forEach((l, k) => {
      for (const w of l.words) {
        const c = colOf(w); if (c < 0) continue;
        const room = CRUISE_ROOMS[c];
        const r = sailing.rooms[room] || (sailing.rooms[room] = { price: null, was: null, soldOut: false, check: false });
        if (k === 0) {
          if (/unavail/i.test(w.t)) { r.soldOut = true; continue; }
          const p = cruisePrice(w.t); if (!p || r.price !== null) continue;
          r.price = p.value; r.check = p.check; r.alts = p.alts;
        } else if (k === 1) {
          const p = cruisePrice(w.t.startsWith("$") ? w.t : ""); if (!p || r.was !== null) continue;
          r.was = p.alts[0];
        }
      }
    });
    // A crossed-out price is the price BEFORE the sale: above it, and a sale
    // is never more than about 40% off. Anything else is a misread.
    const wasFits = r => r.was !== null && r.price !== null && r.was > r.price && r.was <= r.price * 1.7;
    for (const r of Object.values(sailing.rooms)) if (r.was !== null && r.price !== null && !r.check && !wasFits(r)) r.was = null;
    settlePrices(sailing.rooms);
    for (const r of Object.values(sailing.rooms)) {
      if (r.was !== null && !wasFits(r)) r.was = null;
      if (r.price !== null && (r.price < 50 || r.price > 50000)) { r.price = null; r.check = true; }
      delete r.alts;
    }
    sailings.push(sailing);
  }
  // One screenshot is one cruise on one ship: lend a ship read in one block
  // to the blocks whose logo didn't read.
  const ship = sailings.map(s => s.ship).find(Boolean) || null;
  for (const s of sailings) if (!s.ship) s.ship = ship;
  // The cruise's own name when it's in the picture ("3-Night Bahamian Cruise
  // from Port Canaveral"), from the lines above the first sailing.
  const firstY = sailings.length ? lines.find(l => sailingDates(l.text)).cy : Infinity;
  const top = lines.filter(l => l.cy < firstY).map(l => l.text).join("\n");
  const card = readCruiseCard(top);
  return {
    sailings, ship, title: card.nights ? card.title : null, nights: card.nights || (sailings[0] ? sailings[0].nights : null),
    departurePort: card.departurePort, warnings,
  };
}

/**
 * The Rate Details panel: { guests: [{ label, kind: adult|child, amount }],
 * adults, children, taxes, total, totalWas, startingFrom, cabin } where cabin
 * is guessed from the room's description (Disney's text, e.g. "porthole
 * mirror (no exterior view)" = Inside) and may be null. Null when there's no
 * panel. Taxes is the one amount in the summary with no guest beside it.
 */
export function readCruiseRates(words) {
  const all = (words || []).filter(w => w && String(w.text || "").trim());
  const sum = all.find(w => /^summary$/i.test(String(w.text).trim()));
  const pw = sum && all.find(w => /^price$/i.test(String(w.text).trim()) && w.x1 <= sum.x0 + 5 && Math.abs(w.y0 - sum.y0) < 15);
  const anchor = pw || sum || all.find(w => /^adult$/i.test(String(w.text).trim()));
  if (!anchor) return null;
  const left = anchor.x0 - 40;
  const lines = wordLines(all.filter(w => w.x0 >= left));
  const money = l => {
    const ws = l.words.filter(w => /\d/.test(w.t));
    for (let k = ws.length - 1; k >= 0; k--) {
      const t = ws[k].t.replace(/^[©®@¢«]+/, "");
      const m = /^\$?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)$/.exec(t);
      if (m) return Number(m[1].replace(/,/g, ""));
    }
    return null;
  };
  const guests = []; let taxes = null, total = null, totalWas = null, startingFrom = null;
  const summaryY = anchor.cy !== undefined ? anchor.cy : (anchor.y0 + anchor.y1) / 2;
  for (const l of lines) {
    const g = /\b(adult|child)\s*(\d{1,2})\b/i.exec(l.text);
    const v = money(l);
    if (/starting\s+from/i.test(l.text)) { startingFrom = v; continue; }
    if (l.cy < summaryY - 5) continue;
    if (g && v !== null) { guests.push({ label: `${g[1][0].toUpperCase()}${g[1].slice(1).toLowerCase()} ${g[2]}`, kind: g[1].toLowerCase(), amount: v }); continue; }
    if (/stateroom\s+price/i.test(l.text)) { if (v !== null) total = v; continue; }
    if (v === null || g) continue;
    if (/tax|fee|port/i.test(l.text) || (taxes === null && total === null && guests.length)) {
      if (taxes === null) { taxes = v; continue; }
    }
    if (taxes !== null && total === null && v > taxes) totalWas = v;
  }
  // The stateroom price can sit a line below its label.
  if (total === null) {
    const i = lines.findIndex(l => /stateroom\s+price/i.test(l.text));
    if (i >= 0) for (const l of lines.slice(i + 1, i + 3)) { const v = money(l); if (v !== null) { total = v; break; } }
  }
  const panel = lines.map(l => l.text).join(" ").toLowerCase();
  // The tabs always say all four rooms, so only the description can tell.
  const cabin = /no exterior view|porthole mirror/.test(panel) ? "inside"
    : /porthole window|window (?:view|overlooking)/.test(panel) ? "oceanview"
    : /private verandah|own verandah|balcony/.test(panel) ? "verandah"
    : /concierge (?:lounge|level|service|host)/.test(panel) ? "concierge" : null;
  if (!guests.length && total === null) return null;
  return {
    guests, adults: guests.filter(g => g.kind === "adult").length, children: guests.filter(g => g.kind === "child").length,
    taxes, total, totalWas, startingFrom, cabin,
  };
}

/** A whole screenshot: the dates list and, if it's open, the Rate Details
 *  panel (to the right of "Price Summary", left out of the list). */
export function readCruiseScreenshot(words) {
  const ws = (words || []).filter(w => w && String(w.text || "").trim());
  const sum = ws.find(w => /^summary$/i.test(String(w.text).trim()));
  const priceWord = sum ? ws.find(w => /^price$/i.test(String(w.text).trim()) && Math.abs(w.y0 - sum.y0) < 15) : null;
  const rightEdge = priceWord ? priceWord.x0 - 40 : Infinity;
  const dates = readCruiseDates(ws, { rightEdge });
  // The panel's header ("Rate Details by Stateroom Type", tabs, "Starting
  // from") sits above "Price Summary" at the same x.
  const rates = readCruiseRates(ws);
  return { ...dates, rates };
}

/* -------------------- Adventures by Disney (2026-11-12) --------------------
 * A trip page's header: "3 DAYS FROM $2,799 /Person", "Trip Type Escape",
 * "4 Meals 2 Breakfasts, 1 Lunches, 1 Dinners", "Minimum Age: 5 Suggested
 * Age: 6+ Adult Exclusive: 18+", and the highlights ("Visit Neuschwanstein
 * Castle: Step into ..."). The trip's name is usually above the screenshot,
 * so the owner types it. */
export const ADVENTURE_TYPES = ["Land Adventure", "Short Escape", "Escape", "Classic", "Expedition Cruise",
  "Expedition", "River Cruise", "Small Ship", "Signature"];
/** Page buttons OCR glues onto the front of a highlight ("Request Booking
 *  Velika Planina Visit", owner's Croatia screenshot, 2026-11-13). */
const PAGE_FURNITURE = /^(?:(?:request booking|view rates (?:&|and) dates|trip (?:highlights|overview)|itinerary|or call(?: us)?|call us(?: at)?|what's included|rates (?:&|and) dates)\s+)+/i;

export function readAdventure(text) {
  const t = String(text || "");
  const flat = t.replace(/\s+/g, " ");
  const n = re => { const m = re.exec(flat); return m ? Number(m[1]) : null; };
  const pm = /FROM\s*([$£€])\s?(\d[\d,]*)/i.exec(flat) || /([$£€])\s?(\d{3}[\d,]*)/.exec(flat);
  const meals = n(/(\d{1,2})\s*Meals\b/i);
  const breakfasts = n(/(\d{1,2})\s*Breakfasts?\b/i);
  const dinners = n(/(\d{1,2})\s*Dinners?\b/i);
  let lunches = n(/(\d{1,2})\s*Lunch(?:es)?\b/i);
  if (lunches === null && meals !== null && breakfasts !== null && dinners !== null && meals - breakfasts - dinners >= 0)
    lunches = meals - breakfasts - dinners;
  const tripType = ADVENTURE_TYPES.find(x => new RegExp(`\\b${x.replace(/ /g, "\\s+")}\\b`, "i").test(flat)) || null;
  const highlights = [];
  const hre = /(?:^|[«•*+·]\s*)([A-Z][A-Za-z'’ ,&-]{3,70}?):\s/gm;
  let h;
  while ((h = hre.exec(t)) && highlights.length < 12) {
    const x = h[1].trim().replace(PAGE_FURNITURE, "").trim();
    if (x.length < 4 || /\b(?:age|exclusive|call us|trip type|meals?)\b/i.test(x)) continue;
    if (!highlights.includes(x)) highlights.push(x);
  }
  return {
    days: n(/(\d{1,2})\s*DAYS?\b/i), nights: n(/(\d{1,2})\s*NIGHTS?\b/i),
    price: pm ? Number(pm[2].replace(/,/g, "")) : null, currency: pm ? curOf(pm[1]) : "USD",
    perPerson: /\/?\s*\[?\s*Person\b|per\s+person/i.test(flat),
    tripType, meals, breakfasts, lunches, dinners,
    minAge: n(/Minimum\s+Age:?\s*(\d{1,2})/i), suggestedAge: n(/Suggested\s+Age:?\s*(\d{1,2})/i),
    adultExclusiveAge: n(/Adults?\s+Exclusive:?\s*(\d{1,2})/i),
    highlights, text: t,
  };
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
/** Letters the reader mistakes for digits in Disney's price font: "n" is a
 *  tight "11", "l"/"I"/"|" a "1", "o"/"O" a "0". Only used on words that are
 *  already price-shaped ("$...+"). */
const digitLookalikes = t => String(t).replace(/[nN]/g, "11").replace(/[lI|]/g, "1").replace(/[oO]/g, "0");
const cleanWord = t => String(t || "").trim().replace(/^[^\w$]+|[^\w+.$]+$/g, "");

/** Single-letter weekday headings (S M T W T F S) on one row below the month
 *  heading, matched to weekdays in left-to-right order. Of the orders the
 *  letters could stand for, keep the one whose columns are most evenly
 *  spaced. Returns [[weekday 0-6, word], ...], or [] when fewer than four. */
function singleLetterHeads(W, heading) {
  const PATTERN = "SMTWTFS";
  const letters = W.filter(w => /^[SMTWF]$/.test(w.t) && (!heading || w.cy > heading.cy));
  if (letters.length < 4) return [];
  // The row the most letters share.
  let row = [];
  for (const a of letters) {
    const same = letters.filter(b => Math.abs(b.cy - a.cy) < Math.max(a.h, 8));
    if (same.length > row.length) row = same;
  }
  row.sort((a, b) => a.cx - b.cx);
  if (row.length < 4 || row.length > 7) return [];
  let best = null, bestErr = Infinity;
  const walk = (i, from, picked) => {
    if (i === row.length) {
      const n = picked.length, sx = picked.reduce((a, d) => a + d, 0), sy = row.reduce((a, w) => a + w.cx, 0);
      const sxx = picked.reduce((a, d) => a + d * d, 0), sxy = picked.reduce((a, d, k) => a + d * row[k].cx, 0);
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n;
      if (!(b > 0)) return;
      const err = row.reduce((e, w, k) => e + (w.cx - (a0 + b * picked[k])) ** 2, 0);
      if (err < bestErr) { bestErr = err; best = [...picked]; }
      return;
    }
    for (let d = from; d < 7; d++) if (PATTERN[d] === row[i].t) walk(i + 1, d + 1, [...picked, d]);
  };
  walk(0, 0, []);
  return best ? best.map((d, k) => [d, row[k]]) : [];
}

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
 * Returns { month: "YYYY-MM" | null, ticketDays, adultAges, resortGuess ("wdw" | "dlr" | null),
 *           prices: [{date, perDay, check?}],
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

  // The money it is priced in: Paris's UK site shows "£94", Disney's US
  // sites "$153+". Whichever sign the cells use most.
  const signs = { USD: 0, GBP: 0, EUR: 0 };
  for (const w of W) { if (/£/.test(w.text)) signs.GBP++; else if (/€/.test(w.text)) signs.EUR++; else if (/\$/.test(w.text)) signs.USD++; }
  const currency = Object.entries(signs).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(signs).sort((a, b) => b[1] - a[1])[0][0] : null;

  // The weekday headings, the top of the grid: "Sun", "Monday", or Paris's
  // two-letter "Mo Tu We Th Fr Sa Su".
  const dayIdx = t => {
    const l = t.toLowerCase();
    if (l.length >= 3) return CAL_WEEKDAYS.indexOf(l.slice(0, 3));
    if (l.length === 2) return CAL_WEEKDAYS.findIndex(d => d.startsWith(l));
    return -1;
  };
  const heads = W.filter(w => dayIdx(w.t) >= 0 && w.t.length <= 9
    && /^[A-Za-z]+$/.test(w.t) && (!heading || w.cy > heading.cy));
  // Keep one heading per weekday, the row the most of them share.
  const byDay = new Map();
  for (const h of heads) {
    const d = dayIdx(h.t);
    const prev = byDay.get(d);
    if (!prev || (heading && Math.abs(h.cy - heading.cy) < Math.abs(prev.cy - heading.cy))) byDay.set(d, h);
  }
  // Disneyland heads its calendar with single letters (S M T W T F S), and
  // S and T each appear twice, so they are placed by order across the row:
  // the reading of the letters that best fits evenly spaced columns.
  let letterHeads = false;
  if (byDay.size < 2) for (const [d, h] of singleLetterHeads(W, heading)) { byDay.set(d, h); letterHeads = true; }
  // Europe starts the week on Monday (Paris: Mo..Su). Sunday then sits at
  // the RIGHT end, so it counts as column 7, not 0.
  const sun = byDay.get(0), mon = byDay.get(1);
  const others = [...byDay.entries()].filter(([d]) => d !== 0).map(([, h]) => h.cx);
  const mondayFirst = sun ? (mon ? sun.cx > mon.cx : others.length > 0 && sun.cx > Math.max(...others))
    : (currency === "GBP" || currency === "EUR");
  if (mondayFirst && sun) { byDay.delete(0); byDay.set(7, sun); }
  // Disney World's calendar always names its ticket ("5-Day Ticket") under
  // Sun..Sat headings; Disneyland's 1-day calendar names none, under letters;
  // Paris prices in pounds or euros.
  const resortGuess = currency === "GBP" || currency === "EUR" ? "dlp"
    : letterHeads && !ticketDays ? "dlr" : ticketDays ? "wdw" : null;
  const headRowY = byDay.size ? [...byDay.values()].map(h => h.cy).sort((a, b) => a - b)[Math.floor(byDay.size / 2)] : null;

  // The prices: "$153+" (or "153+"); a lone "$153" only if no "+" prices were read.
  const priceOf = w => {
    const read = t => {
      const m = /^[$£€]?(\d{2,4}(?:\.\d{1,2})?)([+t*])?$/.exec(t.replace(/,/g, ""));
      if (!m) return null;
      const v = Number(m[1]);
      return v >= 20 && v <= 1000 ? { v, plus: !!m[2] || /\+$/.test(w.text) } : null;
    };
    // Disneyland marks its cheapest days with a "$" in a green circle. The
    // reader sees that circle as "0", "@", "©", "S", "6", "8", or drops it
    // ("$154" as "0154", "@154", "154"...; owner's December 2026 calendar,
    // 2026-10-28/29). cleanWord has already taken off a leading symbol, so a
    // 3-digit price with at most one look-alike in front is a badge price.
    // Day numbers are never 3 digits, and a "+" calendar (Disney World)
    // keeps only its "+" prices below, so this never adds a stray number there.
    const badge = /[$£€]/.test(w.text) ? null : /^[0568sSoO]?(\d{3})$/.exec(w.t);
    const b = badge && read("$" + badge[1]);
    if (b) return { ...b, check: true, badge: true };
    const p = read(w.t);
    if (p) return p;
    // Disney's thin font draws "11" so tight that the reader sees "n"
    // ($112+ comes back as "$n2+"; owner's September 2027 calendar, 2026-10-28).
    // Inside something already price-shaped, read the look-alikes as digits
    // and mark the box for the owner to check.
    const fixed = read(digitLookalikes(w.t));
    if (fixed) return { ...fixed, check: true };
    // The same tight "11" can also lose a 1 altogether: "$111" comes back
    // "$11" (owner's March 2027 calendar, 2026-11-02). No ticket costs under
    // $20 a day, so a priced "$1x" is read as "$11x" and marked to check.
    const short = /^([$£€])(1\d)([+t*])?$/.exec(digitLookalikes(w.t));
    const restored = short && read(`${short[1]}1${short[2]}${short[3] || ""}`);
    return restored ? { ...restored, check: true } : null;
  };
  let cands = W.map(w => ({ w, p: priceOf(w) })).filter(x => x.p && (x.p.badge || /[$£€+]/.test(x.w.text)))
    .filter(x => headRowY === null || x.w.cy > headRowY);
  const plus = cands.filter(x => x.p.plus);
  if (plus.length >= 7) cands = plus;
  const prices = cands.map(x => ({ ...x.w, v: x.p.v, check: !!x.p.check }));
  if (!month) return { month: null, ticketDays, adultAges, resortGuess, currency, prices: [], missing: [], warnings: ["Couldn't find the month (like \"October 2027\") in the picture."] };
  if (!prices.length) return { month, ticketDays, adultAges, resortGuess, currency, prices: [], missing: [], warnings: ["Couldn't find the prices in the calendar."] };

  // Columns: from the headings when at least two were read, else from the prices' spread.
  // Column numbers are weekdays: Sun 0..Sat 6, or Mon 1..Sun 7 when Monday comes first.
  const c0 = mondayFirst ? 1 : 0, c6 = c0 + 6;
  let colOf;
  const hs = [...byDay.entries()];
  if (hs.length >= 2) {
    const n = hs.length, sx = hs.reduce((a, [d]) => a + d, 0), sy = hs.reduce((a, [, h]) => a + h.cx, 0);
    const sxx = hs.reduce((a, [d]) => a + d * d, 0), sxy = hs.reduce((a, [d, h]) => a + d * h.cx, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    colOf = cx => Math.max(c0, Math.min(c6, Math.round((cx - a) / b)));
  } else {
    const xs = prices.map(p => p.cx), lo = Math.min(...xs), hi = Math.max(...xs);
    colOf = cx => c0 + (hi > lo ? Math.max(0, Math.min(6, Math.round((cx - lo) / (hi - lo) * 6))) : 0);
    warnings.push(`Couldn't read the ${mondayFirst ? "Mon–Sun" : "Sun–Sat"} headings; worked out the columns from the prices.`);
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
  const dow1 = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
  const firstDow = mondayFirst && dow1 === 0 ? 7 : dow1;
  const daysIn = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const placed = [];
  rows.forEach((row, r) => row.items.forEach(p => placed.push({ p, day: r * 7 + colOf(p.cx) - firstDow + 1 })));

  // Check the weeks against the day numbers printed in the cells (top right
  // of each cell, above its price). A whole-week slip shows as +-7.
  const rowGap = rows.length > 1 ? (rows[rows.length - 1].y - rows[0].y) / (rows.length - 1) : hMed * 6;
  const colW = (() => { const xs = placed.map(x => x.p.cx).sort((a, b) => a - b); return xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / 6 : 100; })();
  const nums = W.map(w => /^\d{1,2}$/.test(w.t) ? w : /^[nN]$/.test(w.t) ? { ...w, t: "11" } : null)
    .filter(w => w && Number(w.t) >= 1 && Number(w.t) <= 31 && (headRowY === null || w.cy > headRowY));
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

  const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const out = new Map();
  for (const x of placed) {
    if (x.day < 1 || x.day > daysIn) { warnings.push(`A price (${sym}${x.p.v}) didn't fall on a day of the month and was left out.`); continue; }
    const date = `${month}-${String(x.day).padStart(2, "0")}`;
    if (out.has(date)) { warnings.push(`Two prices landed on ${date}; kept ${sym}${out.get(date).v}. Check that day.`); continue; }
    out.set(date, { v: x.p.v, check: x.p.check });
  }
  const all = Array.from({ length: daysIn }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  return {
    month, ticketDays, adultAges, resortGuess, currency,
    prices: all.filter(d => out.has(d)).map(d => ({ date: d, perDay: out.get(d).v, ...(out.get(d).check ? { check: true } : {}) })),
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
/** Darker than this (0-255) is ink when reading with `ink`. Coloured
 *  calendar cells sit around 150-230; Disney's navy digits well under 100. */
export const INK_CUTOFF = 110;
/** How much to enlarge a screenshot before reading it: small text reads far
 *  better bigger (owner, 2026-11-13: a phone-width cruise list, 674 pixels
 *  wide, "is too small for me to read"). Aim for at least ~1,600 wide. */
export function enlargeBy(width) {
  if (!(width > 0)) return 1;
  return width < 900 ? 3 : width < 1600 ? 2 : 1;
}
export async function readWords(image, { onProgress, ink = false } = {}) {
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
      const k = enlargeBy(bmp.width);
      const c = document.createElement("canvas");
      c.width = bmp.width * k; c.height = bmp.height * k;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      // ink: keep only dark text, every coloured background turned white.
      // Paris colours each calendar day by price band (light blue, orange,
      // purple...) and the reader loses dark digits on them (owner's
      // December 2026 screenshot, 2026-10-31: 4 of 31 read).
      if (ink) {
        const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
        for (let i = 0; i < px.length; i += 4) {
          const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = lum < INK_CUTOFF ? 0 : 255;
          px[i] = px[i + 1] = px[i + 2] = v;
        }
        g.putImageData(img, 0, 0);
      }
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


/* ---------------- a Disney ship page, pasted as text ---------------- */
/* Owner, 2026-11-13: paste Disney's ship page into /admin -> Ships and get the
 * restaurants, shows, adult spaces and kids clubs as a list to check. Only
 * NAMES and FACTS are kept (ages, adults only); Disney's own sentences are
 * never stored. A proposal only: the owner ticks what to keep. Pure. */
const SHIP_SECTIONS = [
  [/^dining\b|\bdining with\b/i, "dining"],
  [/quick bites|\btreats$/i, "quick"],
  [/entertainment$|^extra enchantment/i, "show"],
  [/adult (escapes|spaces)|^elevated adult/i, "adults"],
  [/kids clubs?$/i, "kids"],
];
const SHIP_STOP = /^(spacious staterooms|stateroom options|deck plans|popular itineraries)/i;
const SHIP_SKIP = /^(more to explore|view cruises|view staterooms|skip navigation|\*|\d+\.\s*\d*)$/i;
const SHIP_STOPWORDS = new Set(["the", "and", "with", "for", "your", "from", "into", "this", "that", "all", "of", "a", "an", "in", "at", "on", "to"]);
function shipWords(t){
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !SHIP_STOPWORDS.has(w));
}
function shipFacts(p){
  if(!p) return "";
  const out = [];
  const m = p.match(/(?:children\s+)?ages?\s+(\d+)\s*(?:to|-|–)\s*(\d+)/i);
  if(m) out.push(`Ages ${m[1]} to ${m[2]}`);
  const b = p.match(/(\d+)\s+months?\s+to\s+(\d+)\s+years?/i);
  if(b) out.push(`Ages ${b[1]} months to ${b[2]} years`);
  if(/adults?[- ]only|adult-exclusive|haven for adults/i.test(p)) out.push(/during the day|by day|in the morning/i.test(p) ? "Adults only at night" : "Adults only");
  const star = p.match(/(\d)-Michelin-starred/i);
  if(star) out.push(`By a ${star[1]}-Michelin-star chef`);
  return out.join("; ");
}
export function readShipPage(text){
  const lines = String(text || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const long = l => l.length > 80;
  // Each line: a section heading, a paragraph, a short line (a name or a
  // tagline), or furniture to skip.
  const rows = [];
  let kind = null;
  for(const l of lines){
    // Disney's page opens with a small menu (Dining, Entertainment, Adult
    // Spaces, Kids Clubs, Staterooms, Deck Plans): "Deck Plans" there is not
    // the end of the page, so stop only once something has been found.
    if(SHIP_STOP.test(l)){ if(rows.some(r => r.t === "para")) break; kind = null; rows.length = 0; continue; }
    const sec = SHIP_SECTIONS.find(([re]) => !long(l) && re.test(l.replace(/^[*•-]\s*/, "")));
    if(sec){ kind = sec[1]; rows.push({ t: "head" }); continue; }
    if(!kind) continue;
    if(long(l)){ rows.push({ t: "para", l }); continue; }
    if(SHIP_SKIP.test(l) || /^[*•]/.test(l) || /[.?]$/.test(l) || l.split(" ").length > 8 || /^\[/.test(l)){ rows.push({ t: "skip" }); continue; }
    rows.push({ t: "short", l, kind });
  }
  // Disney's layout: NAME, then a tagline, then the paragraph; sometimes the
  // tagline and paragraph come first and the name after. So the first short
  // line before a paragraph is a name, a second one is a tagline, and a short
  // line after a paragraph is a name only if that paragraph names it.
  const items = [];
  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    if(r.t !== "short") continue;
    const firstInRun = rows[i - 1]?.t !== "short";
    let j = i; while(rows[j]?.t === "short") j++;
    const beforePara = rows[j]?.t === "para";
    const next = beforePara ? rows[j].l : "";
    const prev = rows[i - 1]?.t === "para" ? rows[i - 1].l : "";
    const words = shipWords(r.l);
    const hits = p => words.filter(w => p.toLowerCase().includes(w)).length;
    const namedBefore = prev && words.length > 0 && hits(prev) * 2 >= words.length;
    const likely = beforePara ? (firstInRun && !namedBefore) || (!firstInRun && false) : !!namedBefore;
    const about = namedBefore && !(beforePara && firstInRun) ? prev : next || prev;
    items.push({ kind: r.kind, name: r.l.replace(/!$/, ""), note: shipFacts(about), likely });
  }
  const seen = new Set();
  return items.filter(x => { const k = x.name.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; });
}
