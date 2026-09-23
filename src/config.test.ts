import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RESORTS, RESORT_BY_ID, IRS_MILEAGE_RATES, MILEAGE_RATE_CARRY_FORWARD_YEARS,
  irsMileageRate, newestMileageRateYear, mileageRateStatus,
  isLocalRoute, ORIGINS, PLUS_ORIGINS, ORIGINS_BY_CITY, ALL_ORIGINS, compareOriginsByCity,
  CLIMATE, climateFor,
  type Origin,
} from "./config.js";

/**
 * `dataConfidence` is the "our cost model does not quite match how this
 * resort sells a trip" badge. It exists so the six-resort comparison can
 * stay complete without overclaiming — the same honesty rule the flight
 * estimates follow.
 *
 * These tests pin WHICH resorts carry it. That is a launch decision, not an
 * implementation detail: adding or removing a badge should be a deliberate
 * edit that fails a test first, never something that drifts.
 */
test("only the three resorts with real cost-model gaps carry a confidence badge", () => {
  const flagged = RESORTS.filter((r) => r.dataConfidence).map((r) => r.id).sort();
  assert.deepEqual(flagged, ["dlp", "hkdl", "shdr"]);
});

test("Paris's badge names the actual gap: we price room-only, Disney bundles", () => {
  const dlp = RESORT_BY_ID.get("dlp")!;
  assert.ok(dlp.dataConfidence);
  assert.match(dlp.dataConfidence!.note, /package|bundle/i);
  // The badge is only true while hotel and tickets really are separate
  // lines. If a package price is ever modelled, this is the reminder to
  // drop the badge instead of leaving it contradicting the breakdown.
  assert.equal(dlp.plans.length > 0, true, "meal plans are separate from ticket bundling");
  assert.ok(
    !("packageUsd" in (dlp.ticket as object)),
    "package pricing appears to be modelled now — remove Paris's badge",
  );
});

test("Shanghai's badge names the actual gap: height bands, which are not modelled", () => {
  const shdr = RESORT_BY_ID.get("shdr")!;
  assert.ok(shdr.dataConfidence);
  assert.match(shdr.dataConfidence!.note, /height/i);
  // The badge must stay true to the model. If height banding is ever
  // implemented, `bands` grows a height field and this assertion is the
  // reminder to drop the badge rather than leave it lying to people.
  assert.ok(
    !("height" in (shdr.bands as object)),
    "height banding appears to be modelled now — remove Shanghai's badge",
  );
});

test("Hong Kong's badge names the actual gap: unverified age bands", () => {
  const hkdl = RESORT_BY_ID.get("hkdl")!;
  assert.ok(hkdl.dataConfidence);
  assert.match(hkdl.dataConfidence!.note, /age/i);
});

test("every badge renders and gives the reader somewhere to check", () => {
  for (const r of RESORTS) {
    const dc = r.dataConfidence;
    if (!dc) continue;
    // Short enough to sit in a chip next to the resort name.
    assert.ok(dc.level.length > 0 && dc.level.length <= 24,
      `${r.id}: badge label "${dc.level}" is ${dc.level.length} chars, too long for a chip`);
    // A real, actionable sentence — not "we're still working on it".
    assert.ok(dc.note.length >= 60, `${r.id}: note is too short to explain anything`);
    assert.match(dc.note, /[.!]$/, `${r.id}: note should end as a sentence`);
    assert.doesNotMatch(dc.note, /working on it|coming soon|TBD/i,
      `${r.id}: say what is actually unmodelled, not that it is in progress`);
    // The detail view links here so someone can check the real price.
    assert.match(r.ticketUrl, /^https:\/\//, `${r.id}: badge needs a real ticket URL to link to`);
  }
});

test("a badged resort is still fully priced — badging is not hiding", () => {
  // The whole point of choosing badges over a staged launch: all six resorts
  // still price. A badge that quietly disabled a resort would defeat it.
  for (const id of ["shdr", "hkdl", "dlp"]) {
    const r = RESORT_BY_ID.get(id)!;
    assert.ok(r.ticket.base > 0, `${id} must still have real ticket pricing`);
    assert.ok(r.hotels.length > 0, `${id} must still have hotels to price`);
    assert.ok(r.food.qs > 0, `${id} must still have food rates`);
  }
});

/**
 * The IRS mileage rate is hand-entered and the IRS publishes a new one every
 * December, so the real failure mode isn't a wrong number — it's a right
 * number quietly outliving its year. These tests pin the year-awareness:
 * that a rate knows which year it's for, that reusing an old one is always
 * flagged, that it stops being reused once it's genuinely too old, and that
 * the owner gets a signal before any of that bites.
 */
test("every rate on file is tagged with a real year and two plausible half-year rates", () => {
  assert.ok(IRS_MILEAGE_RATES.length > 0, "there must be at least one rate on file");
  for (const r of IRS_MILEAGE_RATES) {
    assert.ok(Number.isInteger(r.year) && r.year > 2000, `${r.year} is not a real year`);
    for (const rate of [r.janToJunPerMile, r.julToDecPerMile]) {
      assert.ok(rate > 0.3 && rate < 2, `${r.year}: ${rate}/mi is outside any plausible IRS rate`);
    }
  }
  const years = IRS_MILEAGE_RATES.map((r) => r.year);
  assert.equal(new Set(years).size, years.length, "a year must not appear twice");
});

test("a year we have on file uses its own rate, and is not marked carried forward", () => {
  const jan = irsMileageRate("2026-01-15");
  const jul = irsMileageRate("2026-07-15");
  assert.ok(jan.ok && jul.ok);
  assert.equal(jan.ratePerMile, 0.725);
  assert.equal(jul.ratePerMile, 0.76);
  assert.equal(jan.rateYear, 2026);
  assert.equal(jan.tripYear, 2026);
  assert.equal(jan.carriedForward, false);
  assert.equal(jul.carriedForward, false);
});

test("the half-year split is June/July, not some other month", () => {
  const jun = irsMileageRate("2026-06-30");
  const jul = irsMileageRate("2026-07-01");
  assert.ok(jun.ok && jul.ok);
  assert.equal(jun.ratePerMile, 0.725);
  assert.equal(jul.ratePerMile, 0.76);
});

test("a year with no rate on file reuses the newest one AND says it did", () => {
  const newest = newestMileageRateYear();
  const r = irsMileageRate(`${newest + 1}-03-01`);
  assert.ok(r.ok, "the next year must still price — the app books 365 days out");
  assert.equal(r.carriedForward, true, "reusing last year's rate must never be silent");
  assert.equal(r.rateYear, newest);
  assert.equal(r.tripYear, newest + 1);
});

test("a year too far past the newest rate refuses rather than guessing", () => {
  const newest = newestMileageRateYear();
  const tooFar = newest + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1;
  const r = irsMileageRate(`${tooFar}-03-01`);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes(String(tooFar)));
  assert.ok(!r.ok && r.reason.includes(String(newest)));
});

test("a year older than anything on file refuses too — we never invented a past rate", () => {
  const oldest = Math.min(...IRS_MILEAGE_RATES.map((r) => r.year));
  const r = irsMileageRate(`${oldest - 1}-03-01`);
  assert.equal(r.ok, false);
});

test("the owner is warned about a year with no rate while it is still only carried forward", () => {
  const newest = newestMileageRateYear();
  // Stand on 1 July of the newest year: the 365-day booking window reaches
  // into the next year, which has no rate yet.
  const s = mileageRateStatus(`${newest}-07-01`);
  assert.deepEqual(s.uncoveredYears, [newest + 1]);
  assert.equal(s.newestYearOnFile, newest);
  assert.equal(s.pricingBroken, false, "carried forward is a warning, not a breakage");
});

test("the owner is told plainly once a missing year actually stops trips pricing", () => {
  const newest = newestMileageRateYear();
  const s = mileageRateStatus(`${newest + MILEAGE_RATE_CARRY_FORWARD_YEARS + 1}-07-01`);
  assert.ok(s.uncoveredYears.length > 0);
  assert.equal(s.pricingBroken, true);
});

test("a fully covered booking window warns about nothing", () => {
  const oldest = Math.min(...IRS_MILEAGE_RATES.map((r) => r.year));
  // A one-day window inside a year we have on file.
  const s = mileageRateStatus(`${oldest}-02-01`, 1);
  assert.deepEqual(s.uncoveredYears, []);
  assert.equal(s.pricingBroken, false);
});


/* ---------------------------------------------------------------------------
 * isLocalRoute — "you don't fly to the city you're already in".
 *
 * Every one of these was really being requested every night, and every one
 * came back as an error the job then logged and moved on from.
 * ------------------------------------------------------------------------ */

test("the same airport at both ends is never a flight", () => {
  // The literal bug: LAX is a departure airport AND one of Disneyland's
  // arrival airports, so the refresh asked for LAX->LAX three times a month.
  assert.equal(isLocalRoute("LAX", "LAX"), true);
  assert.equal(isLocalRoute("MCO", "MCO"), true);
});

test("a different airport in the same metro is not a flight either", () => {
  // The half of the bug a plain origin === destination check would miss:
  // LAX->SNA failed with the identical "origin and destination are equal"
  // error, because the provider resolves SNA to the Los Angeles city code.
  assert.equal(isLocalRoute("LAX", "SNA"), true, "LAX to Anaheim is a drive");
  assert.equal(isLocalRoute("SAN", "SNA"), true, "San Diego to Anaheim is a drive");
  assert.equal(isLocalRoute("TPA", "MCO"), true, "Tampa to Orlando is a drive");
});

test("real, regularly-flown routes are left alone", () => {
  // The rule must never withhold a fare somebody might actually book. These
  // are the four closest origin/resort pairs that are still genuine routes,
  // so they pin the radius from the other side: if someone widens it, this
  // fails rather than a user silently losing a price.
  assert.equal(isLocalRoute("MIA", "MCO"), false, "Miami-Orlando is a real route");
  assert.equal(isLocalRoute("LAS", "SNA"), false, "Vegas-Orange County is a real route");
  assert.equal(isLocalRoute("JAX", "MCO"), false);
  assert.equal(isLocalRoute("RSW", "MCO"), false);
  assert.equal(isLocalRoute("ATL", "MCO"), false);
  assert.equal(isLocalRoute("JFK", "CDG"), false);
});

test("an unknown airport is never guessed at", () => {
  // A code we don't recognise gets the benefit of the doubt: refusing to
  // price it would be a silent gap, and this rule is an optimisation, not a
  // validation step. Real validation happens at the API boundary.
  assert.equal(isLocalRoute("XXX", "MCO"), false);
  assert.equal(isLocalRoute("ATL", "XXX"), false);
  assert.equal(isLocalRoute("", "MCO"), false);
});

test("no resort is cut off from every departure airport it has", () => {
  // The failure mode worth guarding against: a radius wide enough to strand
  // a resort, so the board shows it as permanently unavailable to everyone.
  const airports = new Set([...ORIGINS, ...PLUS_ORIGINS].map((o) => o.iata));
  for (const resort of RESORTS) {
    for (const dest of [resort.iata, ...resort.altArrivalAirports.map((a) => a.iata)]) {
      const reachable = [...airports].filter((o) => !isLocalRoute(o, dest));
      assert.ok(reachable.length > airports.size - 5,
        `${dest} lost too many origins to the local-route rule`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * Airport picker order.
 *
 * Sorting by IATA code yields something that LOOKS alphabetical and isn't:
 * the free list used to read Atlanta, Boston, Baltimore. That is worse than
 * an obviously arbitrary order, because it invites you to scan and then
 * hides the entry you were scanning for. These tests pin the declaration
 * order so adding an airport in the wrong place fails here rather than
 * quietly in a dropdown nobody is auditing.
 * ------------------------------------------------------------------------ */

function isCityOrdered(list: readonly Origin[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (compareOriginsByCity(list[i - 1]!, list[i]!) > 0) return false;
  }
  return true;
}

test("both airport lists are declared in city order", () => {
  assert.ok(isCityOrdered(ORIGINS), "free origins are out of city order");
  assert.ok(isCityOrdered(PLUS_ORIGINS), "Plus origins are out of city order");
  // The specific pair that was wrong: BWI before BOS by city, the other way
  // round by code.
  const codes = ORIGINS.map((o) => o.iata);
  assert.ok(codes.indexOf("BWI") < codes.indexOf("BOS"), "Baltimore comes before Boston");
});

test("the picker order interleaves free and Plus airports", () => {
  assert.ok(isCityOrdered(ORIGINS_BY_CITY));
  assert.equal(ORIGINS_BY_CITY.length, ALL_ORIGINS.length, "every airport is offered");
  assert.equal(new Set(ORIGINS_BY_CITY.map((o) => o.iata)).size, ALL_ORIGINS.length,
    "and exactly once");

  // Austin is Plus and Baltimore is free; by city Austin comes first. If the
  // list were still two blocks, every Plus airport would sit after every
  // free one and this would fail.
  const at = (iata: string) => ORIGINS_BY_CITY.findIndex((o) => o.iata === iata);
  assert.ok(at("AUS") > at("ATL") && at("AUS") < at("BWI"),
    "Austin sits between Atlanta and Baltimore, not in a Plus block at the end");
  assert.ok(at("TPA") < at("IAD"), "Tampa (Plus) still comes before Washington (free)");
});

/**
 * On-property nightly rates are a baseline the seasonal multiplier moves
 * around, so what matters is where each CATEGORY sits, not any one hotel.
 * The owner's instruction was to pick a median per category and keep the
 * per-hotel spread around it, then replace the median with real data later.
 *
 * Pinning the medians here is the drift alarm that pattern needs: the bases
 * are ordinary numbers in a long list, and nudging one is exactly the kind of
 * edit that silently moves which resort wins the board — the app's one job.
 * If you are deliberately re-baselining, change the number here too and say
 * in the commit where it came from.
 */
const CATEGORY_MEDIANS: Record<string, Partial<Record<string, number>>> = {
  // Researched by the owner against 2026 published ranges: Value $150-390,
  // Moderate $300-600+, Deluxe $680-1500+.
  wdw:  { value: 270, moderate: 450, deluxe: 1090 },
  // Midpoints of per-hotel ranges researched earlier (Pixar Place $355-466,
  // Disneyland Hotel $464-631, Grand Californian $584-767).
  dlr:  { moderate: 410, deluxe: 611.5 },
  // The four below are CLAUDE DRAFTS from web search, corrected by the owner
  // as they get checked — same standing as the starter attraction rows. Hong
  // Kong is the weakest: the only figures found were "starts at" rates during
  // an active 40%-off promotion, which is neither a median nor a rack rate.
  dlp:  { value: 264, moderate: 326.5, deluxe: 826 },
  // Tokyo's VALUE median moved because Toy Story Hotel is a Moderate, not a
  // Value — Disney's own reservation page lists it that way. No rate changed;
  // one hotel changed category, which left Celebration Hotel alone in Value.
  tdr:  { value: 180, moderate: 250, deluxe: 620 },
  // Re-based 2026-09-23 from the owner's own screenshots of each resort's
  // booking flow. See the notes in config.ts for what each figure is and,
  // where it matters, what it is not.
  shdr: { moderate: 280, deluxe: 520 },
  hkdl: { value: 345, moderate: 395, deluxe: 485 },
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

test("every on-property category sits on its pinned median", () => {
  for (const resort of RESORTS) {
    const expected = CATEGORY_MEDIANS[resort.id];
    assert.ok(expected, `${resort.id} has no pinned medians — add them`);
    const byTier = new Map<string, number[]>();
    for (const h of resort.hotels.filter((h) => h.onProperty)) {
      byTier.set(h.tier, [...(byTier.get(h.tier) ?? []), h.base]);
    }
    assert.deepEqual([...byTier.keys()].sort(), Object.keys(expected).sort(),
      `${resort.id} offers different on-property categories than are pinned`);
    for (const [tier, bases] of byTier) {
      assert.equal(median(bases), expected[tier],
        `${resort.id} ${tier} median moved`);
    }
  }
});

test("no on-property hotel is priced below a cheaper category's median", () => {
  // The spread around each median is allowed to be wide, but a Deluxe room
  // costing less than the typical Moderate one means the categories have
  // crossed over and the "Resort Category" picker is lying to somebody.
  const order = ["value", "moderate", "deluxe"];
  for (const resort of RESORTS) {
    const meds = CATEGORY_MEDIANS[resort.id]!;
    for (const h of resort.hotels.filter((h) => h.onProperty)) {
      for (const lower of order.slice(0, order.indexOf(h.tier))) {
        const m = meds[lower];
        if (m === undefined) continue;
        assert.ok(h.base > m,
          `${resort.id}: ${h.name} (${h.tier}, $${h.base}) is under the ${lower} median $${m}`);
      }
    }
  }
});

test("every resort sends on-property bookings to Disney, not a reseller", () => {
  for (const r of RESORTS) {
    assert.match(r.onPropertyHotels.url, /^https:\/\//, `${r.id} hotel url`);
    assert.ok(!/booking\.com|agoda|expedia/i.test(r.onPropertyHotels.url),
      `${r.id} points on-property guests at a reseller`);
    for (const url of Object.values(r.onPropertyHotels.byTier ?? {})) {
      assert.match(url!, /^https:\/\//);
    }
  }
  // Walt Disney World is the only resort that publishes a page per category,
  // and the owner asked for the category page rather than the index.
  assert.deepEqual(Object.keys(RESORT_BY_ID.get("wdw")!.onPropertyHotels.byTier ?? {}).sort(),
    ["deluxe", "moderate", "value"]);
});

/**
 * The climate table is hand-maintained reference data with no live source, so
 * the only thing standing between a typo and a resort claiming an average low
 * above its average high is a test. Same reasoning as the category-median pins
 * above: these are ordinary numbers in a long list.
 */
test("every resort has a full, internally consistent year of climate rows", () => {
  for (const resort of RESORTS) {
    const rows = CLIMATE[resort.id];
    assert.ok(rows, `${resort.id} has no climate rows`);
    assert.equal(rows!.length, 12, `${resort.id} needs twelve months`);
    rows!.forEach((m, i) => {
      const where = `${resort.id} month ${i + 1}`;
      assert.ok(m.highF > m.lowF, `${where}: high ${m.highF} is not above low ${m.lowF}`);
      assert.ok(m.rainDays >= 0 && m.rainDays <= 31, `${where}: ${m.rainDays} rain days`);
      // Nothing on Earth plausibly sits outside this at a Disney resort; a row
      // that does is a transposed or mistyped number, not a climate.
      assert.ok(m.lowF > -20 && m.highF < 125, `${where}: ${m.lowF}-${m.highF}F is not a real climate`);
      if (m.note) {
        assert.ok(m.note.emoji.length > 0 && m.note.text.length > 20, `${where}: thin season note`);
      }
    });
  }
});

test("climateFor answers by month and refuses nonsense instead of throwing", () => {
  const july = climateFor("wdw", 7);
  assert.ok(july && july.highF > 85, "Orlando in July is hot");
  const january = climateFor("wdw", 1);
  assert.ok(january && january.highF < 80, "and milder in January");
  // A missing weather box must never break a board.
  assert.equal(climateFor("nope", 7), null);
  assert.equal(climateFor("wdw", 0), null);
  assert.equal(climateFor("wdw", 13), null);
});

test("the wet and dry seasons land in the right hemisphere and month", () => {
  // Cheap sanity checks against facts nobody needs a source to confirm, aimed
  // at the failure that matters: a table pasted against the wrong resort.
  const wettest = (id: string) => CLIMATE[id]!
    .reduce((best, m, i) => (m.rainDays > CLIMATE[id]![best]!.rainDays ? i : best), 0) + 1;
  assert.ok([6, 7, 8].includes(wettest("wdw")), "Orlando is wettest in high summer");
  assert.ok([6, 7, 8].includes(wettest("hkdl")), "so is Hong Kong");
  assert.ok(wettest("dlr") <= 3 || wettest("dlr") >= 11, "Anaheim's rain is a winter thing");
  assert.ok(CLIMATE["dlr"]!.reduce((n, m) => n + m.rainDays, 0) < 60,
    "and Southern California is dry overall");
  assert.ok(CLIMATE["wdw"]![8]!.note?.text.includes("hurricane"),
    "September at Walt Disney World says hurricane season");
});

test("a season that wraps the year end covers December AND January", () => {
  // The bug this pins: a naive a..b range computes a negative length for a
  // wrapping range and yields NO months, so every winter note in the climate
  // table attached to nothing while the table looked complete.
  for (const id of ["dlr", "dlp", "tdr", "shdr"]) {
    const rows = CLIMATE[id]!;
    assert.ok(rows[11]!.note, `${id} has no December note`);
    assert.ok(rows[0]!.note, `${id} has no January note`);
    assert.equal(rows[11]!.note!.text, rows[0]!.note!.text,
      `${id}: December and January should share one winter note, not two that can drift`);
  }
});

test("every resort's park list matches the park count the board shows", () => {
  // The board says "4 parks" from `parks` and the shared PDF lists them from
  // `parkList`. Two hand-maintained fields describing the same fact will
  // drift; this is the cheap place to catch it, rather than on a page
  // somebody has already emailed to their family.
  for (const r of RESORTS) {
    assert.equal(r.parkList.length, r.parks,
      `${r.id}: parks says ${r.parks}, parkList has ${r.parkList.length}`);
  }
});

test("every park has a name and at least one land, with no duplicates", () => {
  for (const r of RESORTS) {
    for (const park of r.parkList) {
      assert.ok(park.name.trim().length > 0, `${r.id}: a park has no name`);
      assert.ok(park.lands.length > 0, `${r.id}/${park.name}: no lands listed`);
      const seen = new Set(park.lands.map(l => l.toLowerCase()));
      assert.equal(seen.size, park.lands.length, `${r.id}/${park.name}: a land is listed twice`);
      for (const land of park.lands) {
        assert.ok(land.trim().length > 0, `${r.id}/${park.name}: an empty land name`);
      }
    }
  }
});
