# Parkfare — project context

Compares the **total cost of a Disney trip across all six global resorts at once**, and
tells you *when* to go. Walt Disney World, Disneyland Resort, Disneyland Paris, Tokyo
Disney Resort, Shanghai Disney Resort, Hong Kong Disneyland.

Nobody else prices "should we do Orlando or Tokyo this spring?" side by side. That
comparison is the product; everything else supports it.

Owner is non-technical-to-semi-technical. Explain trade-offs in plain language and
say when something is a guess.

---

## START HERE — state as of 2026-09-25 (end of session)

**Live at https://pricingthemagic.com.** `master` is at `f2bb7a2` (PR #71,
merged — PR #70 merged earlier the same day). **Ask whether Render has been
redeployed before trusting what the live site shows** — the owner clicks
that by hand and it has lagged `master` for days at a time.

Run `npm test` and `npm run typecheck` before you believe anything. 565
tests, typecheck clean, `npm run smoke` unchanged.

### LATEST — second 2026-09-25 session: Plus redefined, monitoring removed

The owner's launch-prep list, all built. **These supersede anything below
that disagrees**, including the whole "Free/Plus split, settled 2026-09-24"
section further down:

- **Plus is now four things**: the **trip price calendar** (every arrival
  date's whole-trip total — renamed from "fare calendar", since it prices
  flights+hotel+tickets+food), **saving searches**, the **PDF**, and
  **emails about new Disney deals**. Free visitors see a blurred, locally
  drawn stand-in calendar and a blurred board sparkline (no real prices are
  fetched or put in the page). Server-side: `/api/calendar` answers 402 for
  any multi-day range without Plus (a single-day read stays free — the hotel
  card's "every category" comparison uses it); `POST /api/trips` and
  `POST /api/trips/:id/expenses` answer 402. Listing, reopening and deleting
  saved searches stay open to any signed-in account, so a lapsed member
  keeps what they saved. Comparing, live fare checks, overrides, attraction
  picks and APPLYING deals stay free.
- **Price-drop monitoring is REMOVED** (owner picked this option when asked).
  No price-drop, crossed-your-number or gas alerts, and no "Save & watch"
  anywhere. `jobs/alerts.ts` now only emails Plus members with a confirmed
  address about curated promos added since their last deal email (or since
  their account was created). `price_alerts` gained `user_id` and `trip_id`
  is now nullable (schema.sql migrates it in place).
- **Multiple hotel rooms**: a "Hotel rooms" 1-6 picker. `TripParams.hotelRooms`
  / `?rooms=`; `pricing.ts` multiplies the room line (pick or the traveler's
  own nightly rate, which is per room). Parking is NOT multiplied — it's per
  day, and guessing how many cars a group brings would be inventing it.
  `TripPrice.roomCount` says how many rooms `rooms` covers.
- **Typed numbers no longer persist in localStorage.** A number typed weeks
  ago used to come back on a fresh search, so the card said "Your number"
  before anyone typed. Now kept for the visit only; saved searches keep them.
  Every untyped tile says "estimate".
- **American English across the site and code** (traveler, color, gray,
  "most expensive days" not "dearest", etc.).
- **Less "where every number came from"**: the flight "how this estimate is
  worked out" disclosure, the ticket and driving ones, the "based on a
  different season" suffix, and the "What it would take to make these
  numbers real" footer are gone. Crowd notes use the owner's wording.
  Disneyland Paris's "Hotel+tickets separate" badge is gone (Good to know
  already covers it; config.test.ts pins that).

### Today in one paragraph

Five pieces of original work (free/Plus regating, real WDW/Disneyland/Paris
promos, a Shanghai hotel-tier bug, a flight-estimate blending fix, and named
holiday weeks replacing free-text dates), then two rounds of owner-reported
fixes from two separate screenshots (PRs #70 and #71) — a recurring
off-property hotel-tier bug (fixed twice, at ingestion and again at
display), a crowd-flag threshold that silently never fired, a crowd chip
that was correct but never rendered, a misleading resort badge, a useless
rental-car control, and a full food-style rebuild into the owner's own
seven categories. **The three things below are what's actually left open**
— read those before doing anything else; the long day-by-day recap that
used to live here has been folded into "Decisions already made" below,
searchable by date if you need the blow-by-blow.

### Three things to pick up next — in the owner's likely order

1. **The restaurant-example feature drew direct pushback and hasn't been
   revised yet.** PR #70 added named real restaurants (Sanaa, 'Ohana,
   Explorer's Club Restaurant...) per resort per dining style
   (`foodExamples` in config.ts). The owner: "It sounds like you went too
   literal. I didn't mean you had to pull those exact restaurants." **Ask
   what they'd rather see** before changing anything — fewer names? no
   specific restaurants at all, just a $ range per style? something else?
   Don't re-guess a second time with no new direction.
2. **Food's new `character` rate (all-character-dining) is Claude's own
   unresearched guess** — 1.5x that resort's `ts` rate, one flat multiplier
   applied identically at all six resorts, same standing as the
   unresearched Park Hopper differentials. Flagged as its own standing task
   (`character-dining-rate` in `ownerTasks.ts`). Worth asking the owner to
   sanity-check against a real character-dining price (e.g. a Cinderella's
   Royal Table or 'Ohana receipt) before trusting the number for real.
3. **The crowd chip is correct but the "typical day" picker sometimes
   dodges the very day it would flag.** `typicalIn()` trims toward the
   average price, and the day that makes a week "Thanksgiving" (the
   Nov 24-26 arrival days) is often the pricier tail that gets trimmed
   away — so a 6-night Thanksgiving-week search can quietly land on the
   cheaper Nov 27-30 stretch and never flag at all. Not a bug in the chip
   itself (it correctly describes whichever day was actually priced); it's
   a mismatch between "the day pricing picked as typical" and "the day a
   person means when they say Thanksgiving." No fix designed yet — flag it
   to the owner as a known limitation rather than silently living with it,
   and don't attempt a fix without their input on what they'd want instead
   (bias the picker toward the peak day for a NAMED holiday week
   specifically? show the flag for the whole window regardless of which
   day was priced? something else).

**Also still open, lower priority (unchanged from before today):**

- **Cruises.** Explicitly on hold — "don't worry about cruises yet, we'll
  get there." The agreed shape so far (from earlier sessions, still valid):
  a free-side teaser line ("We estimate a Disney Cruise could run about
  $X-$Y — see the real per-cabin range with Plus") with the real detail
  built later. No code exists for this yet.
- **Spring break** was deliberately left out of the holiday-windows work
  (real, but shaped completely differently per resort and spans two
  calendar months) — a natural next addition to `holidayWindows.ts` using
  the same mechanism, not urgent.
- **Tokyo, Hong Kong, Shanghai promos** — WDW/Disneyland/Paris are done;
  nothing official has turned up for the other three yet, see "Next work"
  below.

### What actually shipped today, for reference (PRs #67-#71, all merged)

1. **Finished the free/Plus launch regating.** The owner's call, mid-session:
   "at launch, the only thing on plus is the PDF print out." Every other
   Plus gate (saved trips/alerts, custom expenses, exact fares, the 22
   smaller airports, attraction picks, applying promos) came out of both
   `server.ts` and `prototype.html` — see "Free/Plus split, settled
   2026-09-24" below for the full list of what changed. **This is the single
   biggest thing to understand about the current state of the app**: almost
   nothing is paywalled any more.
2. **Real promos for WDW, Disneyland and Disneyland Paris** — found by web
   search of each resort's own official offers page, replacing the three
   illustrative rows. Tokyo, Hong Kong and Shanghai still have none (nothing
   official turned up, only third-party reseller codes that don't fit the
   model) — see "Next work" below, this is now the top item.
3. **Fixed a real bug the owner found from a screenshot**: Shanghai's "every
   category, same N nights" comparison showed Value and Moderate at the
   identical price, because Shanghai has no on-property Value hotel at all —
   the app was silently substituting Moderate's price under the Value label.
   Now says "Not offered at Shanghai Disney Resort" instead of faking a
   price. Same underlying `poolFor()`/`hotelTier.swapped` mechanism the main
   hotel card already used correctly; only the "every category" list hadn't
   been taught to check it.
4. **Fixed a real "crisis of confidence" bug the owner reported**: the same
   trip searched a few weeks apart could show wildly different flight
   prices, for no reason a traveller could see. Root cause: ONE real bought
   fare fully overrode a whole route's estimate for the entire quarter, no
   matter how small a sample of one thing is. Now blended by sample size
   (`ROUTE_CORRECTION_MIN_SAMPLES`, default 3) — one fare nudges a third of
   the way, three or more moves the whole way, same as before once there's
   real evidence.
5. **Replaced "pin exact dates" with named holiday weeks.** The owner's
   framing: "Paris doesn't move during Thanksgiving. That's the point." One
   canonical week (December's Before/Around Christmas split, a real
   calendar-computed Thanksgiving week) is priced identically at all six
   resorts, and each resort's own real season data decides whether it's
   actually pricier there — verified live, Paris's Thanksgiving total came
   back byte-for-byte identical to its whole-month scan while WDW's moved.
   Flights also got a real, sourced holiday premium (+55%/+58%,
   Thanksgiving/Christmas) from a third-party fare study, since BTS itself
   is quarterly-only and structurally can't measure this.
6. **Dropped the "not yet checked against real demand data" banner from the
   crowd card.** The owner's call: "We have the hotel demand data and that
   is enough here." `CROWDS_ARE_PLACEHOLDER` (config.ts) is now `false` — the
   per-month "estimated" vs. "real demand data" chip on the crowd card still
   says which basis a given month has, that per-month honesty didn't change,
   only the blanket first-pass disclaimer sitting on top of it.
7. **Fixed crowd flagging so a real Thanksgiving-week trip to WDW actually
   flags at the default sensitivity.** "Somewhat" used to flag only `peak`,
   and Thanksgiving at WDW is deliberately banded `high` (one notch under
   Christmas's `peak` — see the windows decision above), so it silently never
   flagged for anyone who hadn't cranked sensitivity to "a lot." Now
   `some` flags `high`+`peak` and `high` also flags `moderate` (`crowds.ts`,
   `crowdFlag()`). Verified live: pricing WDW for a date inside the Nov 24-26
   window now flags "Busy" at "somewhat," and the same check for Disneyland
   Paris in November (banded `low`) does not — the owner's own example.
8. **Sample restaurants under the Food card — but see item 1 above, this
   drew direct pushback and is not settled.** Added `foodExamples` per
   resort (config.ts) — a couple of named, real restaurants per dining
   style, priced by $ TIER the way Disney's own dining guide does
   ($ / $$ / $$$ / $$$$), not a claimed dollar figure a real menu would
   contradict. Rendered under the food line items in `prototype.html`.
   Flagged with a standing task (`food-examples` in `ownerTasks.ts`) since
   restaurants close and rename more often than rides do.
9. **Removed "Compare both" (on-property vs. off-property) entirely.** The
   owner's report: "that isn't working right." Rather than debug a feature
   whose own reasoning (silently picking the cheaper side, see the
   2026-09-19 decision above) the owner had already found confusing in
   practice, it's gone — `Stay` is now just `"on" | "off" | "none"`, and
   `stayCompare` (the whole comparison block, the pricing.ts logic behind it,
   and its board/PDF rendering) is deleted rather than left dead. The
   dining-plan-forces-on-property special case that existed only to handle
   `"both"` is gone too; `planFor()` already refuses a plan for `"off"`/
   `"none"` on its own, so nothing had to replace it.
10. **Stopped calling anything "exact."** The owner's reasoning: "Even
   though we have good data, we are setting ourselves up for failure." A
   real fare found right now can still move by the time somebody actually
   books, so claiming "exact" was a promise the site couldn't keep. The
   on-demand fare lookup (`/api/exact-fare` — the route name and internal
   plumbing are unchanged, only what's shown) is now labelled "Check a live
   price" / "Live fare $X" / "live" chip, each with a line making clear it's
   still an estimate, not a guaranteed checkout price. Marketing copy that
   listed "exact live fares" as a free feature now says "live fare checks."
11. **Fixed the off-property pricing bug — TWICE, because the first fix
   only helps data bought from now on.** First report: Budget was pricing
   at $377/night against Mid-range's $141 and Upscale's $178 — backwards.
   Root cause: off-property hotels were tiered by Google's
   `extracted_hotel_class` (star rating) alone (`providers/serpapi.ts`,
   `tierFromClass`), a weak, sparse signal for what a single sampled night
   actually costs. Fixed by ranking what SerpApi actually returned BY PRICE
   (`tiersByPrice()`) instead, guaranteeing budget <= mid <= upscale by
   construction. **The owner came back with the SAME bug on a different
   resort (Tokyo)** — the first fix can't retroactively fix rows already
   cached with the old tag, and the hotel-rotation cycle takes ~10 days to
   touch every resort/month. Second, independent fix: the "Every category,
   same N nights" comparison now sorts off-property by PRICE at DISPLAY
   time and labels positionally ("Cheapest off property" / "Mid-range off
   property" / "Most expensive off property") instead of trusting the
   stored tag — so the card literally cannot show this bug again regardless
   of what's cached. On-property is untouched: Value/Moderate/Deluxe stay
   in that fixed order, since those are Disney's own real categories, per
   the owner's own split ("Off property organized by price, on property by
   category"). With only 1-2 real off-property price points, the labels
   scale down rather than claiming a fake "Mid-range."
12. **Fixed the crowd chip not showing on the main board row.** It was
   defined and correct (`crowdChip()`, `crowdFlag()`) but only ever wired
   into the "no cached price" fallback row template, never the normal
   priced row — a copy-paste-shaped bug, not a logic bug. One line fixes
   it. Verified live: an exact Nov 24 search shows "Busy" on WDW and
   nothing on Paris, before Details is opened. **See item 3 above** for the
   real remaining nuance (the typical-day picker sometimes avoids the
   flagged day).
13. **Removed the rental-car add-on entirely** ("Why do we have the rental
   car option? We never include it in the final price. It's kind of
   useless."). It WAS wired into the total (verified before touching
   anything), but it priced one flat national-average rate applied
   identically across all six resorts, so it never changed which resort
   won a comparison. Gone from `pricing.ts`, `config.ts` (`CAR_RENTAL`),
   `settings.ts`, and both trip-form controls. `includeWearAndTear`
   ("Include wear & tear on your car?") is untouched — a real, unrelated
   choice about gas-only vs. full IRS-rate pricing.
14. **Reworded Disneyland Paris's `dataConfidence` badge**, "Priced
   room-only" → "Hotel+tickets separate". The three-word chip, read alone
   next to a resort name, said the opposite of what it means — hotel AND
   tickets are both priced and in the total; the real gap is only that
   Disney's own site bundles them while this app prices two lines.
15. **Food: seven real dining styles, in the owner's own words** ("We'll
   bring our own food, Some Quick Service, All Quick Service, Some Quick
   Service Some Table Service, All table service, Some Character meals, All
   Character Meals"). Four of the seven already existed (grocery/qs/mix/ts);
   new: `someQs`, `someCharacter`, and `character` — a full character-dining
   rate, which the old four-style model didn't have at all (its "ts" label
   literally said "Table service & character meals" as one blended
   approximation). **See items 1-2 above** — both the example restaurants
   and the new `character` rate are unverified and worth the owner's look.
   `foodRate()` in pricing.ts is the one place a style
   becomes a dollar rate: `someQs`/`someCharacter` are the MIDPOINT of their
   neighbors rather than their own researched numbers — "some of each" has
   no real data behind what fraction of meals that actually means, so a
   midpoint is the honest amount of precision to claim, not a measurement.
   `character` is Claude's own estimate (1.5x that resort's `ts` rate, one
   flat multiplier at all six resorts, same standing as the unresearched
   Park Hopper differentials) — flagged as its own standing task
   (`character-dining-rate` in `ownerTasks.ts`) since a bad number here also
   skews `someCharacter`. A test pins that all seven styles price in strict
   ascending order and that a real trip's total actually differs across all
   seven, not just the original four.

### What is REAL data and what is still a guess

This is the question that matters most, because the product's whole claim is
that every number is either real or labelled a guess.

| Data | State |
|---|---|
| **Tickets — WDW, Disneyland** | **REAL.** Published multi-day totals 1-7 / 1-5 days, adult and child, plus Park Hopper by ticket length. Stored as published in `ticket.multiDayAdultUsd`; the old base x slope curve is now only a fallback for resorts without a table. |
| **Tickets — Tokyo, Shanghai, Hong Kong** | **REAL** (owner-checked against each resort's own purchase flow, 2026-09-23). Hong Kong's CHILD RATIO is still a guess. |
| **Tickets — Paris** | Still the curve. No real table. |
| **Crowd bands** | **REAL from DVC points charts** at WDW and Disneyland (all 12 months) and Hong Kong (Apr-Dec). Tokyo and Paris have one-quarter charts that only ORDER their own months. Shanghai is judgement. `chartMonths` says which per resort, per month. |
| **Exchange rates** | **REAL.** ECB via the monthly Actions job, generated 2026-09-22. |
| **Weather** | **REAL.** Open-Meteo ERA5, 2006-2025. |
| **Hotels — WDW, Disneyland** | Owner-researched against 2026 published ranges. **See the open question below.** |
| **Hotels — Hong Kong, Shanghai** | **REAL** (owner's screenshots, 2026-09-23). Hong Kong Disneyland Hotel's Deluxe rate is DERIVED from a ratio, not observed. |
| **Hotels — Tokyo** | Mostly guesses. Only Disney Ambassador Hotel is real. |
| **Hotels — Paris** | Claude draft. |
| **Food** | Guesses from budget guides, all six resorts. ~40% of a typical total. NOT owner-editable yet. Seven styles as of 2026-09-25 (see "What actually shipped today" above); `character` (all-character-dining) is Claude's own unresearched multiplier on `ts`, weaker confidence than the original four — see "Three things to pick up next," item 2. |
| **Promos** | **REAL for WDW, Disneyland, Disneyland Paris** (`seedPromos.ts`, found by web search of each resort's own official offers page, 2026-09-25). **Still illustrative-gap for Tokyo, Hong Kong, Shanghai** — nothing official found, see "Next work". Applying one is free for anyone signed in, not Plus. |
| **Attractions** | Starter set, ~10 rows. |
| `parkList` lands, `QUEUE_TIMES_PARKS` | Claude drafts. |

### Open questions for the owner — do not decide these alone

1. ~~**WDW hotel medians.**~~ **RESOLVED 2026-09-23.** CLAUDE.md had recorded
   Value/Moderate/Deluxe as 270/450/1090, researched by the OWNER against 2026
   published ranges; a Gemini-generated sheet said 225/327/727. A web-search
   cross-check this session (third-party rate write-ups, not Disney's own
   booking flow — its rate pages have no static price, only an interactive
   date-driven search a fetch can't run) landed closer to the Gemini figures
   for Moderate. The owner's call: **305/700** (Value's 270 was never in
   dispute). See `config.ts`'s comment on WDW's hotels array for the real
   per-hotel bands this was checked against.
2. ~~**Shanghai's `dataConfidence` badge**~~ **RESOLVED 2026-09-23.** It claimed
   children are priced by height (1.0-1.4m, unmodelled), on model knowledge
   with no source. The owner confirmed via Shanghai's real purchase flow that
   it uses AGE bands — Standard 12-59, Child 3-11 — exactly what `bands`
   already modelled. The old claim was simply wrong, not a real cost-model
   gap, so the badge is gone (`config.ts`, `shdr`), not reworded. Pinned by a
   test named for the correction rather than the old claim.
3. ~~**Weekly rather than monthly crowd bands.**~~ **BUILT 2026-09-23**, for WDW
   (the resort with a real period-banded chart). `CrowdYear.windows` in
   `config.ts` holds 14 real "MM-DD" date ranges off the same Animal Kingdom
   Villas chart `months` already summarizes; `crowdFor()` takes an optional
   `day` and checks these first, falling back to the whole-month band when no
   day is given or no window matches — so every existing month-only caller is
   unaffected. `server.ts` now derives that day from the trip's own priced
   date (`best.start`), not just the search month. December: 1-23 is `low`,
   24-31 is `peak`. Thanksgiving: 24-26 Nov (flying in) is `high`, 27-30 (the
   weekend after) is `moderate` — genuinely the opposite of what most people
   would guess, and now the card says so instead of averaging it away.
   The other five resorts have no period-banded chart, so they still read
   whole-month bands exactly as before; extend `windows` to any of them the
   day a matching chart turns up.

### Next work, in the owner's priority order

1. **Food's example restaurants and `character` rate** — both need the
   owner's look; see "Three things to pick up next," items 1-2 at the top
   of this file. Don't build anything further on food until that feedback
   is in.
2. **The crowd-chip/typical-day mismatch** — see "Three things to pick up
   next," item 3. Needs the owner's input on the right fix before building
   one.
3. **Tokyo, Hong Kong, Shanghai promos** — WDW/Disneyland/Paris are done
   (2026-09-25); nothing official has turned up for the other three, only
   third-party reseller codes that don't fit the model. Their official offer
   pages exist but can't be fetched from this sandbox — paste-the-page, same
   pattern as the ticket tables.
4. **The attraction list** — paste-and-structure, 40-80 headline rows, every
   cross-resort clone FLAGGED for the owner rather than asserted.
5. **Disney Cruise pricing** — explicitly on hold ("don't worry about cruises
   yet, we'll get there", 2026-09-25). Its monetization is an OPEN QUESTION,
   not settled (see the free/Plus section below) — no longer assumed to be
   "the Plus anchor". No API exists, so it will be a hand-maintained table
   and sailings are dated, which means it goes stale faster than anything
   else here. Add it to `REVIEWABLE` the day it ships.
6. **Paris tickets**, still on the curve.
7. **Spring break window** — real, but deliberately left out of the
   2026-09-25 holiday-windows work (shaped differently per resort, spans two
   calendar months). Natural follow-up to `holidayWindows.ts` using the same
   mechanism, once there's a clean way to handle the two-month span.

### Free/Plus split, settled 2026-09-24 — at launch, Plus is the PDF, full stop

**>> SUPERSEDED later on 2026-09-25** — see "LATEST" at the top of this file:
Plus is now the trip price calendar, saving searches, the PDF and deal
emails, and price-drop monitoring was removed. Kept below for the reasoning.

**SUPERSEDES the 2026-09-22 decision** (which had already reversed an even
earlier one — see the "SUPERSEDED 2026-09-22" note under "Attractions: what a
resort HAS" further down for that history). The owner's own words: "I just
want to make sure that at launch, the only thing on plus is the PDF print
out." Every other feature that was ever Plus-gated is now free:

- **Free:** the six-resort comparison, calendars, crowd bands, weather, every
  override, booking links, attraction picks, applying promos, **saved
  searches and price/deal/gas alerts, custom planning expenses, exact live
  fares, and all 41 origin airports** (the free/Plus airport split still
  exists in `config.ts` — `ORIGINS` vs. `PLUS_ORIGINS` — but it now governs
  only which 19 the nightly refresh pre-caches, not which a traveller may
  pick or save; every origin still prices, either from the nightly cache or
  the BTS-baseline estimate).
- **Plus:** the shareable PDF. That's the whole list.

Exact live fares stay CAPPED, not unlimited, but the cap is no longer a
paywall — it exists because the lookup spends real SerpApi money per click,
so it is bounded by the same per-user/site-wide daily limits regardless of
who is asking (see `exactFare.ts`). Signing in is still required (the cap
needs an identity to key on), which is different from requiring Plus.

**What changed, concretely, so the reasoning isn't re-derived:**
- `src/server.ts`: every `isPlus`/402 check on `/api/exact-fare`,
  `/api/trips*`, `/api/profile/attractions`, and promo application was
  removed; each of those routes now checks only sign-in (401). `resolveOrigin()`
  and `overridesFrom()` dropped their Plus-branching parameter entirely —
  every origin resolves to itself, with no free-metro downgrade path left to
  exercise. `/api/auth/me`'s `exactFare` allowance is reported for any
  signed-in account, not just a Plus one.
- `src/auth.ts`: `setHomeAirport()` dropped its `plus_required` throw
  entirely; `HomeAirportError`'s `reason` is just `"unknown_airport"` now.
- `src/jobs/alerts.ts`: `findAlerts()` dropped the `plus_until` clause from
  its eligibility query — a confirmed email is the only condition left.
- `public/prototype.html`: every `session.plus` check gating a UI control
  for one of these features was removed or changed to gate on `session.email`
  (sign-in) instead — the airport dropdown's "(Plus)"/"(needs Plus)" labels,
  the exact-dates pill and its disabled inputs, the promo apply button and
  personal-discount form, the exact-fare "Get Plus" upsell, the save-search/
  save-trip button text, the alerts-toggle upsell, the attraction-picker
  checkboxes, the home-airport Plus-airport disabling and lapsed-Plus
  messaging, the custom-expenses box, and the "My searches" menu visibility.
  The paywall dialog itself was rewritten top to bottom: it now offers
  exactly one thing (the PDF) instead of a feature list most of which is now
  free.
- `src/ownerTasks.ts`: the `attraction-list` and `real-promos` standing tasks
  were relabelled `side: "free"` — neither is Plus-gated data anymore, so
  calling them Plus tasks would misprioritize the nightly digest.

**Disney Cruise pricing's monetization is now an OPEN QUESTION, not
settled.** It was called "the Plus anchor" in the 2026-09-22 decision this
one supersedes, but it was never built (still just research and a sketched
schema — see
"Next work" above), so nothing about it actually changed here. Whether it
ships free, Plus, or as some third thing needs a real decision when it
actually gets built, informed by whatever this simplified free/Plus split
has taught the owner about what people actually pay for by then. Don't
assume it inherits either the old "Plus anchor" framing or the new
PDF-only framing without asking.

**Why simplify this far, when the earlier entries below spent real effort
building a nuanced split?** The owner's own reasoning, paraphrased: a
$9-90-day trip pass is a small ask, and every feature gated behind it was
also a feature that could have made someone finish planning and click a
booking link — which is worth far more per trip than the subscription. The
PDF is different: it's a real deliverable (a written document, not a
metered API call or a monitoring job), so it is the one thing left worth
asking money for at launch. If usage data later says otherwise, that is a
new decision, not a reason to silently re-add gates this entry removed.

### Known environment limits — do not rediscover these

- **This sandbox's egress proxy denies almost everything.** Disney, Google,
  Kayak, docs.google.com, every weather and wait-time host: `CONNECT tunnel
  failed, 403`. Web SEARCH works; fetching a page does not.
- **So anything needing the network runs in GitHub Actions**, which is not
  restricted — that is why the climate, exchange-rate and coverage jobs are
  workflows.
- **And anything that cannot be tested from here needs the owner's click.**
  The card prints what it is asking for so a mismatch stays visible. This is
  how the Kayak link, the Disney URL parameters and `PUBLIC_BASE_URL` were
  all settled.
- **If a page must be fetched, ask the owner to paste it or upload it.** That
  has worked well: the ticket tables, the points charts and the hotel rates
  all arrived that way. Offer this EARLY rather than parking work on the
  owner's list — a session was lost to not offering it.

### Working agreement

- **Push and merge at the end of a piece of work** unless told otherwise. The
  owner merges through `mcp__github__` tools here rather than by hand.
- **Evidence before fixes.** Twice now a documented-but-wrong theory nearly
  shipped a bad fix (the BTS halving bug, the $139 fare). Run the free
  diagnostic first.
- **Never overwrite owner-researched numbers with an AI draft.** Flag the
  disagreement instead.
- The owner is non-technical-to-semi-technical. Plain language, and say when
  something is a guess.

## Current state

| Piece | State |
|---|---|
| Backend (`src/`, `db/`) | **Working.** 537 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline — refresh, pricing, a saved trip, and now a sent (console) alert email — with no accounts or network. |
| Multiple arrival airports | **Wired, free.** Five of six resorts (all but Hong Kong) have alternates (`altArrivalAirports` in `config.ts` — Tampa/WDW, LAX/Disneyland, Beauvais/DLP, Haneda/Tokyo, Hongqiao/Shanghai). Refresh fetches flights to each; a resort's detail view picks among only its own airports, never a bare code trusted from elsewhere. |
| "Getting there" — mixed drive/fly, wear-and-tear | **Wired, free.** Five presets on the trip form (`src/gettingThere.ts`'s `resortTransportMode()`): Flying to all, Flying to all with miles (0-100% off the cash fare, no floor), Driving to WDW only, Driving to Disneyland only, Driving domestically (both) — each drive preset flies every other resort in the *same* six-resort comparison, so "drive to WDW, fly to Disneyland" is one board, not two searches. Driving cost includes wear-and-tear at the real IRS standard mileage rate (`irsMileageRate()` in `config.ts`, year-aware — see the decision note), with an "Include wear & tear?" opt-out for gas-only pricing. **The rental-car add-on was removed entirely 2026-09-25** (owner's call — it priced one flat rate identically across all six resorts, so it never changed which resort won). The gas-price alert (told if the cached price has moved since a driving trip was saved) is free too, same as every other alert — see the 2026-09-24 free/Plus decision at the top of this file. |
| Park Hopper | **Wired, free, and now real where it exists.** An add-on that SCALES WITH TICKET LENGTH at WDW ($70-95) and Disneyland ($70-135) from published figures; a flat guess still at Paris. **Tokyo sells no hopper at all** (owner-confirmed) and neither do Hong Kong or Shanghai, which each have one park — asking for one there costs $0. |
| "Need a hotel?" | **Wired, free.** A real `stay: "none"` state (not just "off property") prices $0 hotel/transport with no pick, for day-trippers or anyone staying with family/friends. |
| Driving-mode city search | **Wired, free — the one live-provider exception.** `src/geo/` (Nominatim geocoding + ip-api.com IP lookup, both free/keyless, mock by default, `GEOCODE_LIVE=true` to go live) backs a real "Departing from" search box and a "use my location" button for driving mode. See the architecture-invariants note below on why this is a deliberate exception to "users never call a provider API." |
| Real-pulls digest | **Wired, owner-only.** `npm run pulls-digest` emails a daily list of every flight route and hotel a real provider actually returned prices for in the last 15 days (`PULLS_WINDOW_DAYS` to change it), grouped by route/hotel and source, with the departure/stay dates covered and when it was last pulled. Sends even when the answer is "nothing" — a quiet cache is the signal worth having. Mock and unlabelled rows are excluded and footnoted, never folded in. `hotel_rates.source` was added for this: without it there was no way to tell a rate a vendor returned from one the mock provider invented. Read-only; no provider calls. |
| Disney news digest | **Wired, owner-only.** `npm run news-digest` reads a few RSS feeds (`NEWS_FEEDS` in `config.ts`) and emails whatever's new — never shown to end users automatically; the owner reviews and hand-adds anything worth surfacing to a resort's `goodToKnow`. |
| Frontend (`public/prototype.html`) | **Wired to the real API.** Every price on the page comes from `/api/compare` and `/api/calendar` — no in-browser pricing model left. `src/server.ts` now also serves the prototype itself at `/`, so `npm start` + open `http://localhost:PORT/` is the whole dev loop, same origin, no CORS. |
| Live provider data | **Partly connected.** Travelpayouts + SerpApi keys are set in production. Flights now come from real per-date SerpApi Google Flights lookups on searched routes, and from real BTS DB1B medians moved by a measured trend everywhere else — see "How a flight number is arrived at" in README.md. |
| Flight pricing model | **Reworked (2026-09-09).** Median-not-mean, same-quarter-not-newest, demand-driven real lookups, honest `est.` labelling on the board itself. See the decision note below. |
| Alert emails | **Wired.** `runAlerts` sends through `src/email/` — console by default (no account), Resend if `RESEND_API_KEY` is set. Now also fires a `new_promo` "we found a deal" alert. |
| Accounts | **Real, minimal, and now visible.** Signing in is a real dialog (`#authModal`) reached from a **Sign in** button, not two inputs wedged into the masthead; once you're in, an account button carries your initial, email and plan, and opens a panel showing who you are, your plan, when Plus runs out, how many trips you've saved, and your **home airport** (free, `users.home_airport` — see the profile decision below). The owner's report was "I have no real idea that I am signed in" — a small grey chip among other small grey chips. **Nothing about entitlement changed**: Plus is still resolved server-side from the session cookie on every request that matters; this is only the part that tells you about it. **Every account requires a password** (scrypt, salted, `node:crypto`, no new dependency) — sign-up and sign-in are separate operations and email-only sign-in no longer exists anywhere. A real `sessions` table, real `plus_until`-based entitlement. **Email verification is live and links genuinely arrive**; the alert job refuses any address without `email_verified_at`, and `REQUIRE_VERIFIED_EMAIL=true` additionally blocks sign-in. Signing out has a masthead button, not just the account panel's footer. **Guessing is rate-limited and there is a real "Forgot your password?"** — five wrong answers lock an address for 15 minutes (25 per IP, so one household's typos don't lock out the street), and an emailed single-use link sets a new password, signs out every device, confirms the email and clears the lockout. The owner can still reset one by hand with `npm run set-password -- email 'value'` (`--clear` makes the account unreachable until re-claimed through Sign up). The owner comps Plus via `npm run grant-plus -- email days` — no payment processor yet. |
| Annual passes & DVC | **Wired, free.** A pass you hold takes its holder off the ticket line (and off hopper and parking) at that resort only, with the pass's own yearly price reported beside the trip rather than added to it — the "what if I don't buy it" number. DVC points you'd rent out are a take-home credit on the total. `src/memberships.ts`; every price is owner-editable. |
| Owner-editable numbers | **Done, end to end.** `src/settings.ts` declares 73 editable values (every hotel base, every resort's parking and transfers, hopper differentials, the rental-car rate) and `owner_settings` holds the overrides, reaching pricing through `PriceBook.setting` so `pricing.ts` stays pure. `/admin` is the screen: owner-only, one form per number, plus a spreadsheet for bulk edits. Saving a hotel rate re-seeds that resort's `hotel_rates` rows immediately, and the generator reads the owner's value, so the nightly refresh can't revert it. The database overrides the shipped defaults and never replaces them. |
| Owner-maintained attractions | **Wired, owner-only.** `/admin` has a section for the attraction list, backed by `owner_attractions` as an OVERLAY on `config.ts` — replace, add or hide a row, with its own spreadsheet. An empty table ships exactly as the code does. See the decision note. |
| Exchange rates | **Wired, free — and still a placeholder.** `src/exchangeData.ts` is generated from ECB reference rates by a monthly Actions job; the browser's five hardcoded numbers are gone. **The committed rows are Claude's seed and `EXCHANGE_IS_PLACEHOLDER` says so in the UI** — run the "Parkfare exchange rates" workflow. |
| Lands per park | **Wired, free.** `parkList` names every park and its lands, pinned against the `parks` count by a test. **A Claude draft for the owner to correct**, same standing as the international hotels. |
| The shared PDF | **Rebuilt.** Written prose per resort, not a print stylesheet over the live board, and "Save as PDF" asks which resorts to include. See the decision note for the three things deliberately left out. |
| Average wait times | **Recorded, shown to nobody.** `wait_time_samples` + a two-hourly Actions job reading Queue-Times, keeping only 9am-7pm local. No card, no API wiring, no aggregation — the card was dropped because every automated source records POSTED waits and that bias is not uniform across six operators. This exists so there is an archive to decide with in a year. Park ids are a draft until the probe runs. See the decision note. |
| Flight estimate lean | **Wired, owner-editable.** `flight.estimateLean` picks a point between a route's own p25 / median / p75; ships at 100, the dear end. A BTS median is the median fare *paid* over a quarter and runs structurally below what you are quoted today. See the decision note, including the halving bug that was diagnosed, written, and turned out to be wrong. |
| Weather per month | **Wired, free, and now real.** Average high/low, rainy days and a season note on each resort's detail view, from the generated `src/climateData.ts`. Nothing in the request path fetches weather. **The generator has been run** (2026-09-20, commit `369d5fa`): the rows are Open-Meteo ERA5 daily observations, 2006-2025, for all six resorts. **One column is worth a second look** — see the rain-day note below; ERA5 counts more wet days than a rain gauge does. |
| Saved searches | **Wired, free (2026-09-24) — signed in, not Plus.** A save captures the WHOLE comparison — every resort's own typed numbers — and asks which park should lead. Reopened from the "My searches" masthead dropdown; deleting confirms by name. Extra costs hang off the open search rather than a standalone panel. |
| Promos, custom expenses | **Wired, free (2026-09-24) — signed in, not Plus.** Curated + personal discounts are real cost lines in `pricing.ts`, gated server-side on sign-in only. `custom_expenses` lets a signed-in traveller attach free-form planning-expense line items (VIP tours, PhotoPass, anything not modeled) to a saved trip — this, not airport ground-transport pricing (built earlier, since removed), is what "extra planning of expenses" turned out to mean once the owner used the app: monitoring, saved trips, deal/gas alerts, and room for costs the model can't guess at. |
| Exact live fares | **Wired, free (2026-09-24) but capped, not Plus.** Free = a labelled estimate with its range, unlimited, no sign-in needed. Any signed-in account can also get the real fare for one specific date (`POST /api/exact-fare`, `src/exactFare.ts`), cache-first and capped per-user + site-wide — the cap exists because the lookup spends metered provider money per click, not because of who is asking. The one route where a user's click spends real money. |
| Payments | Not built. Stripe is stubbed in the prototype. |
| Deployment | **Ready, $0/month.** `render.yaml` + Neon (free Postgres) + three GitHub Actions cron workflows (`refresh`, `alerts`, `news-digest`). Owner still has to click through the actual Neon/Render sign-ups by hand — see README.md's "Deploy for free" section — but nothing else is missing. |

**Step 3 (wiring the frontend) is done.** What changed along the way, beyond swapping
the data source:
- `pricing.ts`'s `TripPrice` gained `flightPick` (`{price, carrier, stops, deepLink}` from
  the cached flight row) — it existed in the cache but was never surfaced, so the Flights
  card had nothing real to show beyond the fare total.
- `/api/compare` gained an optional `date` query param that prices one exact date instead
  of scanning a month for the cheapest — what a calendar-cell click needs (the full
  breakdown for a specific day), which neither existing endpoint provided on its own.
- The frontend's override key was renamed `fare` → `farePerSeat` to match `Overrides` —
  the prototype's local-only version had never actually sent overrides in a shape the API
  would recognize.
- Dropped from the prototype because the API has nothing to back them with: the three
  fictional airline options (only one real cached fare exists per date/route), and the
  ranked top-5 alternate-hotel list (only the best pick is exposed, not the full pool).
  The hotel card keeps a same-date "every category" comparison instead, computed from two
  extra `/api/calendar` reads with a `tier` override.
- Calendar/board cells can now show a real gap (`total: null` — no cached price for that
  date) instead of a fabricated number; rendered as a muted cell / "no cached price" row.

**Step 6 (alert email send) is done.** `src/email/` mirrors `src/providers/`: an
`EmailSender` interface, `console.ts` (default, prints instead of sending) and
`resend.ts` (used when `RESEND_API_KEY` is set), picked by `pickEmailSender()`.
`runAlerts` inserts the `price_alerts` row *before* attempting the send, stamps
`notified_at` on success, and retries every still-unnotified row on its next run
before looking for new drops — a send failure delays an alert, never drops it.
Along the way: fixed `npm test` silently running only 3 of 20 tests (the shell glob
`src/**/*.test.ts` doesn't recurse under a plain POSIX shell, which is what `npm`
actually invokes it with) — it now runs `tsx --test $(find src -name '*.test.ts')`.
Also caught that `smoke.ts` had been calling `findAlerts`/`applyCap` directly,
bypassing `suppressAnomalies` entirely — the demo fixture's 33% "your number"
override was itself exactly the kind of single-trip wild swing that rail exists to
catch. Now `smoke.ts` calls the real `runAlerts()` and uses a believable override.

**Step 5 (Plus foundation: accounts, airport transport, discounts/promos, two free
filters) is done.** This was scoped as a phase after the owner asked to slow down and
confirm exactly how the paywall and pricing should behave before building more —
see the "Plus and paywall" decisions below for what was actually decided.

- **Accounts** (`src/auth.ts`, new): email-only sign-in, no password — explicitly the
  right trade-off for a friends demo, explicitly not enough for a public launch
  (anyone who knows a friend's email can sign in as them). A `pf_session` cookie ties
  a browser to a `sessions` row; `isPlus(plusUntil)` is the one real entitlement check,
  used everywhere Plus matters. Fixed a real bug found while wiring this up:
  `findAlerts()` treated a brand-new user with no `plus_until` as alert-eligible
  (`plus_until is null OR ...`) — flipped to require a real, current date.
- **`npm run grant-plus -- email [days=90]`** (`src/grantPlus.ts`, new) is the one
  mechanism for granting Plus — comping a friend or the owner's own testing. No coupon
  codes, no dev-only API endpoint. **Important with the default embedded PGlite
  database: stop the server before running this** (see "PGlite is single-process"
  below) — running it while the server is live silently doesn't reach the server's
  view of the data and can corrupt the store if both write at once.
- **Airport transport** (Plus-only): a new real cost line in `pricing.ts`
  (`TripPrice.airportTransport`), sibling to flights/tickets/hotel/food — parking vs.
  rideshare vs. transit vs. "my own way," auto-picking the cheaper one by trip length.
  `airport_transport` is a new hand-maintained table (same "no live API" pattern as
  ticket prices), seeded with **unverified placeholder guesses for all 18 origins** —
  see "NOT verified" below.
- **Discounts & promos** (Plus-only): a curated `promos` table (owner hand-maintains,
  same pattern as tickets) is public to *browse* — "let friends see what Plus would
  unlock" — but *applying* one is Plus.
  **>> SUPERSEDED 2026-09-22: applying a promo is moving to FREE** — a lower
  total makes somebody book, and the booking is worth ten times the
  subscription. The server-side lookup rule below does NOT change: a curated
  promo's effect is always resolved from `promosFor()` and only its id ever
  comes from the client. A personal discount (Annual Passholder, DVC,
  military, Florida resident, or custom) reuses the existing `ResortOverride` shape
  rather than a new table, since it's the same "free to try, Plus to save" thing
  overrides already are. The composition rule, in order: (1) a curated room discount
  is skipped if you've typed your own nightly rate — a guess shouldn't second-guess a
  rate you already found; (2) ticket/dining effects aren't blocked by that; (3) a
  personal discount always applies, even on top of your own nightly rate, since it's
  your own claim about your own price; (4) `flat_off_total` clamps the trip at $0,
  never negative. All five rules have a test in `pricing.test.ts`.
- **Two free filters**: a domestic/international board filter (client-side, using the
  `region` field every resort already has) and a "jump straight to one resort" entry
  point (reuses the existing `runSearch(resortId)` path the per-row Details button
  already took).
- **A day-by-day trip planner** (itinerary, checklist, dining tracker, budget, per-day
  notes, and a realistic price floor for special hard-ticket events like Mickey's Not
  So Scary) was requested but **deliberately deferred** to its own follow-up — it needs
  real saved trips (built here) and is large enough to deserve its own design pass once
  the owner has seen friends actually use this foundation.

### PGlite is single-process — a real constraint, not a bug

The embedded dev database (used whenever `DATABASE_URL` is unset) does not support two
processes touching the same `.pgdata` directory at once. Running any script
(`grant-plus`, `refresh`, `migrate`, `seed-promos`) while `npm start` is running against
the same directory is unsafe: at best the running server never sees the write, at worst
the store corrupts and the next `npm start` fails with a PGlite `RuntimeError`. **Stop
the server first, run the script, then restart it.** This has always been true of every
script in this project — it just hadn't come up until `grant-plus` became something
you'd plausibly want to run while the server was live. A real Postgres (`DATABASE_URL`
set) doesn't have this limitation.

---

## Decisions already made — reasoning included so they don't get re-litigated

**The paid budget is SerpApi Starter: $25/month, 1,000 searches** (bought
2026-09-17). Every default in this repo was originally sized for the
**Developer plan (5,000/month)** and had to be retuned. The allocation, worst
case, must stay inside 1,000:

| Job | Budget | Worst case/month |
|---|---|---|
| `popular-routes` (demand + rotation) | 10/night | 300 |
| `refresh` off-property hotels | 8/night | 240 |
| exact-fare (on demand) | 6/day site-wide | 180 |
| Reserve (manual `intl-sweep`, headroom) | | 280 |

Two consequences worth not re-deriving: **`intl-sweep` is deliberately
unscheduled** (a full 12-month sweep is ~1,140 lookups, more than a whole
month's allowance — it would consume the month in one run and still not
finish), and **SerpApi has no overage billing**, so $25 is a hard ceiling
*unless* "Automatic Early Renewal" is on, which re-buys the plan the instant
the bucket empties. Leave that off.

**Paid lookups rotate by staleness, they don't chase demand alone.**
`rotationRoutes()` in `routeDemand.ts` fills whatever nightly slots real
demand doesn't. Demand still wins where it exists — someone actually asking
about a route is better evidence than a schedule — but before launch
`route_searches` is empty, so a purely demand-driven job re-bought the same
few routes every night and coverage never widened. Rotation is stalest-first
over ~171 routes (19 free origins × 9 arrival airports), and only
`serpapi_flights` rows count as "bought", so a Travelpayouts row or an
estimate leaves a route still unvisited. Measured: **200 lookups over 20
simulated nights covered all 171 routes with no repeats.** This is also what
gradually fixes international pricing, since international routes are in the
same rotation.

**Hotel lookups rotate stalest-first, exactly like flights** (2026-09-18).
They used not to. `runRefresh` walked months and resorts in config order and
called the provider for every pair, so the nightly hotel budget was spent by
whoever came first in the loop: Walt Disney World and Disneyland got real
off-property rates every single night, re-buying prices that had not moved,
while Shanghai and Hong Kong — further down the `RESORTS` array — had never
had a single real lookup. Position in an array decided which resorts had real
data, which is not a decision anybody made.

`rotateHotelSlots()` (`jobs/hotelRotation.ts`) now hands out the night's slots
never-bought-first, then oldest-first, over all 13 months the app prices —
78 resort/month slots, about 10 nights to cover every one at 8 a night, and
each one then stays ~10 days fresh. Same shape and same reasoning as
`rotationRoutes()` on the flight side. Two things to know:

- *It rotates over the whole year, not tonight's due months.* An off-property
  rate is bought one resort/month at a time and is worth re-buying on its own
  staleness, not on the flight tier it happens to share. So the hotel pass is
  its own loop, and a slot on a non-due month still gets its call.
- *Only `on_property = false` rows count as evidence of a pull.* On-property
  Disney rates are generated locally from `config.ts` and cost nothing, but
  `upsertHotels` tags them with the same `serpapi_hotels` source as rows the
  vendor really returned. Counting those would make every resort/month look
  freshly bought and the rotation would never move. **That mislabelling is
  still there and the real-pulls digest reads the same tag** — worth fixing
  properly rather than working around a second time.

**Getting out is a masthead control, and airports are listed by city**
(2026-09-18, owner's report: "I need to be able to sign out and I need to
have the airports in alphabetical order by their city").

- *Sign out was built but only reachable from the account dialog's footer.*
  It worked; nobody could find it. Signing out now has a button in the
  masthead beside the account button (`#signoutTop`), sharing one
  `doSignOut()` with the panel one. Same lesson as the buried override
  controls: a control you have to hunt for is one people conclude isn't
  there.
- *Both airport dropdowns were ordered by IATA code*, which reads as
  alphabetical and isn't — the free list ran Atlanta, Boston, Baltimore.
  Worse than an obviously arbitrary order, because it invites you to scan
  and then hides what you were scanning for. Both lists are now declared in
  city order and `config.test.ts` pins it, so adding an airport in the wrong
  place fails a test rather than quietly in a dropdown.
- *Free and Plus airports interleave rather than sitting in two blocks.*
  Somebody looking for Tampa should not first have to know which side of the
  paywall Tampa is on; the `(Plus)` / `(needs Plus)` label on the row says
  that, and the free/Plus split itself is unchanged — still two arrays
  server-side, still enforced in `setHomeAirport()`.
- *The order has one home.* `compareOriginsByCity()` and `ORIGINS_BY_CITY`
  live in `config.ts`; `/api/meta` sends `originOrder` as a list of codes
  rather than a third copy of the airports, and `originOptions()` in
  `prototype.html` just obeys it. Verified in a real browser: 41 options,
  city-ordered, Austin sitting between Atlanta and Baltimore.

**A profile is free; saved trips stay Plus** (2026-09-18). **>> SUPERSEDED
2026-09-24: saved trips are free too now (Plus is the PDF, full stop — see
the top of this file), and the "which airports you may KEEP" rule two bullets
down no longer exists at all — `setHomeAirport` never throws `plus_required`
any more, because there is no free/Plus split left for it to enforce.** The
rest of this note is kept for the reasoning that is still true: the first
field is `users.home_airport` — the airport you depart from, remembered per
account (`setHomeAirport()` in `auth.ts`, `PUT /api/profile`, shown in the
account panel). Free, deliberately: an account is free, and a remembered
dropdown is not monitoring. Paywalling it would be the already-rejected
search-quota idea wearing a different hat.

Three things that were decisions, not defaults (the second no longer applies
— see the supersession note above):

- *Null is a real value.* "I haven't said" and "I fly from Atlanta" are
  different facts, so the column is nullable with no default and the form
  offers a blank "ask me each time" option that clears it. A first save you
  could never undo would be a trap.
- *Which airports you may KEEP follows the same free/Plus split as picking
  one.* A free account cannot save one of the 22 Plus airports —
  `setHomeAirport` throws `plus_required` and `PUT /api/profile` answers 402.
  Claude initially built the opposite (any airport savable, on the grounds
  that the board already prices a downgraded trip from one) and the **owner
  reversed it**: the smaller airports are what Plus buys, and a free account
  quietly holding one forever hollows the split out. Plus is read from
  `plus_until` inside the function, never passed in — a caller-supplied flag
  would be a way to grant the tier from the client, the same rule exact-fare
  follows. Disabling the option in the form is only the cosmetic half;
  verified by calling the API directly past the disabled control.
- *A lapsed account keeps what it saved while it was Plus.* Deleting a
  setting because a subscription ran out is a punishment nobody asked for,
  and the trip still prices — `resolveOrigin()` downgrades to the nearest
  free metro and the board says which it used. They simply cannot move it to
  another Plus airport until they renew, and moving to a free airport or
  clearing it always works, so nobody is stuck.
- *It feeds the drive/fly default.* The saved airport is what
  `defaultGettingThere()` reads, so an LA user opens Parkfare already on
  "drive to Disneyland, fly everywhere else" without touching anything.
  Verified in a browser: save LAX, reload, and both the origin and the preset
  are right with nothing typed.

It lives on `users` because there is one field. **If the profile grows past a
handful — a souvenir budget, attraction preferences — move it to a
`user_profile` table**: identity and entitlement sharing a row with free-form
taste data gets muddy fast.

**The airfare override's floor is advisory, not enforced** (2026-09-19,
owner's reversal of an earlier decision — recorded so the old rule isn't
restored by someone reading only the older note above). Typing a fare
below the cheapest known one used to be silently raised to that floor, so
the box overruled what you typed and showed a total nobody asked for. Your
number now stands; `fareBelowFloor` is reported and the card says the cache
has nothing that cheap. **Warn, don't overrule** — the same rule the `est.`
chip and the `dataConfidence` badges already follow. Still floored at zero:
a trip can be cheap, never negative.

**The food override is a whole-party daily total, not per person**
(2026-09-19, owner's call). "We spend about $250 a day" is a number people
know about themselves; a per-head figure is one they have to work out. The
cost, said in the UI rather than hidden: per-age scaling stops applying, so
changing the party size afterwards no longer moves it. Part-days still do.
A dining plan still wins — there is nothing to estimate about food already
bought.

**On-property rooms link to Disney, never a reseller.** Every hotel row
used to link to a Booking.com search for its name, Disney's own included.
Walt Disney World publishes a page per category and the owner asked for
the category page, so somebody pricing Moderate lands on the Moderate
list. `onPropertyHotelUrl()` in `config.ts` is the one home for the rule;
`config.test.ts` pins that no resort sends an on-property guest to a
reseller. The four international URLs are **unverified from this
environment**, same standing as the `goodToKnow` visa notes.

**Disney's pages take a party size in the URL and cannot take dates —
settled by the owner clicking, not deferred** (2026-09-19). None of this is
documented anywhere and the page is a JavaScript app that can't be fetched
from this sandbox, so it was established the only way available:

- *The query must sit BEFORE the fragment.*
  `.../resorts/?numAdults=4#/moderate/` opens on 4 adults.
  `.../resorts/#/moderate/?numAdults=4` is ignored — it's a fragment, not a
  query string. Appending naively produces the second, silently-dead form,
  which is exactly the first mistake made here.
- *Dates are not addressable, and there is no parameter left to find.*
  Entering dates by hand on Disney's own page **leaves the URL unchanged**,
  so they live in page state, not the address. That is a stronger finding
  than "the name I guessed didn't work" and closes the question — don't
  re-open it by guessing more names.
- *Children cannot be carried either — `numChildren` was tested and does
  nothing* (owner clicked `?numAdults=3&numChildren=2`: three adults came
  through, no children). So a party with children gets the plain link, which
  is deliberate: sending `numAdults` alone for a family would open a page
  quietly priced for fewer people than are travelling — a wrong number
  presented as a real one, which is worse than sending nothing. Closed; do
  not guess further names.
- *Beware the default when testing a parameter.* The first test used
  `numAdults=2`, which is Disney's own default, so "it came in with the
  adults" could not be told apart from the page doing what it always does.
  Test with a non-default value.

**Hotel bases are a category median with the per-hotel spread kept around
it** (2026-09-19). The owner supplies a researched range per category, each
category's median lands on it, and `config.test.ts` pins every median so
nudging a base is a test failure rather than a silent change to which
resort wins the board. Walt Disney World moved a long way (Deluxe roughly
doubled) because it was built on older rack rates.

**All six were re-baselined together, and that mattered more than the
numbers.** Fixing Orlando alone would have made it lose to resorts still
carrying older, lower guesses — not because they are cheaper, but because
their numbers are staler. That is precisely the six-resort comparison this
app exists to get right, so a better number for one resort can make the
product worse. Disneyland didn't move (already on midpoints of researched
per-hotel ranges). **Paris, Tokyo, Shanghai and Hong Kong are Claude
drafts from web search for the owner to correct**, same standing as the
starter attraction rows; Hong Kong is the weakest, since the only figures
found were "starts at" rates during an active 40%-off promotion, which is
neither a median nor a rack rate.

**"Compare both" now says what it found.** >> REMOVED ENTIRELY 2026-09-25 —
see "What actually shipped today" (item 9) at the top of this file. The
owner found it "isn't working right" in practice, so rather than debug it
further it and `stayCompare`
were deleted outright. Kept below for the original reasoning. It always
widened the hotel pool
to on- and off-property and picked the cheaper — correctly and completely
silently, so the owner's read that the control did nothing was fair. Each
board row carries the gap per night and over the trip, **parking and
transfers included**, that last part being exactly the cost people leave
out when they conclude off-property is cheaper. Computed in `priceTrip`
from the book slice already loaded: no extra request, no provider call.

**No Airbnb/VRBO rates, decided rather than deferred** (2026-09-19). Airbnb
killed its affiliate program in 2021 and has no public API; Vrbo has an
affiliate program but no rate-data API (MarketMaker is host-side). So the
only options were a hand-maintained guess or a paid scraper, and the owner
declined both — "I don't want to maintain that". A made-up per-resort
Airbnb number could flip which resort wins with nothing to defend it,
which is the souvenir-basket trap in another costume. **Deluxe Villas is
also deliberately out**: it's a Walt Disney World-only category and the
model has three tiers.

**Other resellers worth knowing about, if a second hotel source is ever
wanted:** Expedia's Travel Creator Program covers Expedia, Hotels.com AND
Vrbo from one account (Rapid, the real API, still wants a corporate
entity); Priceline pays ~3% on hotels and is joined through Sovrn Commerce,
not directly; and the Travelpayouts account this project already has
brokers Booking.com and Agoda, which is the cheapest path of the three.

**Weather is a generated table, and the generator runs in Actions because it
cannot run here** (2026-09-20). Each resort's detail view carries a weather box
— average high, average low, rainy days for the month being priced, plus a
season note. Four decisions, so nobody re-derives them:

- *Normals, not last year.* The owner asked for "rain days last year". A
  thirty-year average answers the question better and is the honest number: one
  year is a sample of one, and a dry September in 2025 says nothing about
  September 2027. The card says "typically" and states that it is neither a
  forecast nor last year.
- *A table, not a request path.* Same call as ticket prices. Normals move once
  a decade, so a per-render provider call would spend money on stale-proof
  data. `npm run climate-normals` writes `src/climateData.ts`; nothing in the
  request path fetches weather.
- *Generated numbers and hand-written notes live in SEPARATE FILES.*
  `climateData.ts` holds only rows and is overwritten wholesale. The season
  notes ("Atlantic hurricane season", "spring break is the busiest week") stay
  in `config.ts` because they are editorial judgement no API produces. That
  split is the whole reason the generator is safe to re-run.
- *Open-Meteo, not NOAA — and the reasoning is the six-resort comparison.*
  NOAA's NCEI publishes the authoritative US normals and would be better for
  Orlando and Anaheim, but covers no other resort; `api.weather.gov` is neither
  (forecasts and current observations only, also US-only — checked, not
  assumed). Four parks are outside the US, and one consistent method across all
  six beats two better-but-different methods for two of them. Same argument as
  re-baselining all six hotels together. Validate against NCEI for the two US
  parks if the method is ever in doubt.

**The first real run failed on Open-Meteo's rate limit, and the fix was to
learn that the other end has a budget** (2026-09-20). The run got through
Orlando, Anaheim and Paris and then died on Tokyo with `429 — "Minutely API
request limit exceeded"`. Six resorts x twenty years is 120 requests fired as
fast as the network allows, and Open-Meteo bills by how much data a request
asks for rather than per request, so a burst of year-long, three-variable
calls empties the per-minute budget in seconds. Nothing was wrong with the
fetching; what was missing was any notion of pacing.

Three rules now, each with a test:

- *There is always a pause between requests, and hitting the ceiling doubles
  it for the rest of the run.* One 429 means the pace was wrong, not that one
  call was unlucky — retrying at the same speed walks into the same wall.
- *One pace is shared by all six resorts.* Per-resort pacing would reset to
  full speed at each resort and hit the ceiling again; the budget belongs to
  the account, not to the request.
- *A limit that waiting cannot clear fails immediately.* Open-Meteo answers
  429 for the minutely, hourly and daily budgets alike. A minute is worth
  sitting out; a day is not, and spending eight minute-long retries
  discovering that produces the same failure half an hour later with nothing
  learned. The hourly/daily case says so and says to run with fewer years.

A 400 is never retried either — a wrong argument does not become right. The
job takes minutes now rather than seconds, which is free for a manual dispatch
that runs once every few years, and `timeout-minutes: 45` is there so a stuck
run ends by itself.

**The generator HAS now been run** (2026-09-20, from Actions, commit
`369d5fa`): Open-Meteo ERA5 daily observations, 2006-2025, all six resorts,
20 years each. `CLIMATE_SOURCE` says so. The paragraph below describes why it
could never be run from here, which is still true and still why the workflow
exists.

**Settled: the rain-day threshold is 1mm, not a rain gauge's 0.01in**
(2026-09-20, owner picked option 2 below). `RAIN_DAY_INCHES = 0.04`. The
reasoning, and why the mismatch with the US "measurable" convention is
deliberate:

ERA5 counts more rain days than a rain gauge does. Orlando's July came back at **27** wet days; the
hand-seeded figure it replaced was 17, which had been sanity-checked against
summaries of NOAA's 1991-2020 normals. Hong Kong's July is 27 and Paris runs
12-17 every month of the year. The temperatures look right (Orlando July
89/75°F against NOAA's ~92/74); it is specifically the rain-day count that
is high, and the reason is structural rather than a bug: ERA5 is a
**reanalysis on a grid**, so a convective shower that a single gauge would
miss is smeared across the whole cell and the day is counted as wet. A
station record and a grid cell are answering slightly different questions.

0.01in is the convention for "measurable" at a **station**, which is a single
point. A grid cell is an average across tens of kilometres, so a shower that
soaks one side of Orlando and misses the other leaves the whole cell showing
a trace and the day counts as wet. 1mm is the standard wet-day cut-off for
gridded precipitation for exactly that reason — chosen so the number means
what a person reading "10 rainy days" thinks it means. `climateNormals.test.ts`
pins the constant, so lowering it back to a gauge's threshold fails loudly.

The two options NOT taken, recorded so they are not re-proposed as new:
*leave it* (rejected — the bias is not uniform, since Anaheim's dry summers
barely move while Orlando's storms inflate a lot, so it distorts the
comparison and not just the absolute number), and *validate against NCEI
first* (still the right check if this is ever revisited, and still only
possible for Orlando and Anaheim).

**Do not quietly hand-edit `climateData.ts` to "fix" a number.** It is
overwritten wholesale on the next run; the threshold is the lever.


Every weather source — NCEI, api.weather.gov, Open-Meteo, every climate site —
is refused by this sandbox's egress proxy, tested rather than assumed. GitHub
Actions is not restricted that way (it reaches SerpApi and Resend nightly), so
`.github/workflows/climate-normals.yml` is where the fetch actually happens; it
typechecks and re-runs the climate tests against the regenerated file before
committing it. Manual dispatch, not scheduled — a nightly run would rewrite
identical numbers. Until it is run, the committed rows are Claude's hand-seeded
figures and `CLIMATE_SOURCE` says so.

The response to "written to a documented shape, never run" was to make the part
that CAN be checked airtight: the aggregation is pure and heavily tested (rain
days per year not per window, nulls skipped rather than read as zero, garbage
dates dropped), the whole job runs end to end against a stubbed fetch across all
six resorts, and **a partial fetch aborts rather than overwriting a good
table** — the refresh job's upsert-on-success-only rule, applied to a file.

**The owner's numbers live in the database, and the code holds the
defaults** (2026-09-20). The owner's ask was plain: "I don't want to depend
on AI to update this site." So `src/settings.ts` declares 73 editable
numbers — every hotel base, every resort's parking-and-transfers rate, the
hopper differentials, the rental-car rate — and `owner_settings` stores the
ones actually changed.

The rules, each a decision rather than a default, and each with a test:

- *The database OVERRIDES the shipped defaults, never replaces them.* An
  empty table, a wiped row or a value the registry no longer considers valid
  must leave the app pricing exactly as it did before any of this existed.
  That is the whole safety property; `settings.test.ts` pins it directly by
  pricing a trip with the hook removed.
- *A stored value outside its bounds falls back to the default rather than
  poisoning a price.* Bounds get tightened later, and a row written under
  the old ones is the shape of thing that would otherwise quietly reach a
  traveller. The admin view shows it as not applied.
- *A spreadsheet applies completely or not at all.* A half-applied import
  leaves pricing in a state nobody intended and nobody can identify, so
  every bad row is named at once, by its spreadsheet row number, and
  nothing is written.
- *A duplicated key is refused, not last-one-wins*, because silently taking
  the last one hides a real editing mistake.
- *A blank cell means back to the default, not zero.* "I never set this"
  and "I set it to nothing" are different facts — the same reasoning as the
  nullable home airport.
- *`null`, not "type the default back in", is how you clear one.* Same
  reason.
- *A typed dollar sign or comma is accepted.* People paste currency;
  stripping it is kinder than refusing it.
- *The values reach pricing through `PriceBook.setting`*, so `pricing.ts`
  stays pure and synchronous. The I/O happens once when the book is loaded,
  exactly as it does for fares and rooms.

**The screen is `/admin`** (2026-09-20), and the decisions in it:

- *Owner-only means ONE account, named by `OWNER_EMAIL`, resolved from the
  session cookie on every route* — never a role column, because a role is a
  thing that can be set, and the only person who should be able to change
  every price in the app is whoever holds the environment variable. With
  `OWNER_EMAIL` unset nobody is the owner and the page is simply closed:
  "no owner configured, so let anyone in" would open every rate in the app to
  the internet the moment a deploy forgot a variable. It also requires a
  verified address, since this is the account that decides what travellers
  are quoted.
- *The page is behind the same check as the data.* Serving the form to
  anyone and refusing the saves is just a confusing way to say no, so a
  non-owner gets a 404 that tells them to sign in if they're the owner.
- *A link in the masthead, shown only to the owner.* Same lesson as the
  buried sign-out: a page you have to know the URL of is one nobody uses.
  `/api/auth/me` carries an `owner` flag purely so the button can appear; a
  client that lied about it would reach a page it still cannot save from.
- *Saving is a deliberate act.* The Save button is dead until something
  changes, and typing is not saving — a number that moves every price in the
  app should not be committed by a blur.
- *A refused value says what to do.* The server's message names the bound
  and says that if the real value is genuinely outside it, the range needs
  changing rather than the value forcing through. The page prints it as
  written rather than replacing it with "invalid".
- *Inputs are 16px, which is not a style choice* — anything smaller makes
  iOS Safari zoom the page on focus, and on a form of 73 boxes that is
  unusable. The owner said a phone is where they'd be doing this.

**A hotel rate needed two things, not one.** The number reaches a traveller
through the nightly `hotel_rates` cache, so:

- *Saving re-seeds that resort's on-property rows immediately*
  (`src/reseed.ts`), across the whole 13-month window rather than the months
  due tonight — the owner changed what a room costs, and that is as true in
  March as in the month the refresh happens to be looking at. It calls no
  provider (on-property rates are generated locally), touches only
  `on_property = true` rows for the one resort, and upserts, so a vendor's
  real off-property rates are never rewritten from a guess and a failure
  leaves yesterday's rows standing. The page reports the row count, because
  "we stored your number" and "travellers are being quoted it" are different
  claims.
- *And the generator itself reads the owner's value* (`src/onProperty.ts`,
  `effectiveBase()`). Without this the nightly refresh would rebuild every
  rate from `config.ts` and silently undo the correction by morning, with the
  admin page still showing the number the owner typed. That is the `www` trap
  in another costume: a setting nothing reads back, so nothing can notice it
  stopped applying. There is a test named for exactly that failure.

The one awkward part, stated rather than hidden: providers generate rows
synchronously, deep in a loop over every night of a month, so the effective
base comes from a small process-wide cache (`primeSettingsCache`) rather than
being threaded through the provider interface. Every read names its own
fallback — the shipped default — so forgetting to prime degrades to what the
app ships with rather than to zero, and only short-lived jobs prime it.

**Typing a date and picking one are different acts, and only one of them
was working** (2026-09-20, owner's report: "the calendar is fine but hand
entering dates doesn't work"). Two bugs, both ours, both invisible to a
picker because a picker commits one whole in-range date at once.

- *Assigning `input.min` or `input.max` as a PROPERTY discards a value that
  currently falls outside the new bound.* `syncExactDatesUi()` ran on every
  keystroke and reassigned both every time, and a date being typed is out of
  bounds for most of its life — a year arrives one digit at a time, so "2027"
  is 0002, then 0020, then 0202. The box blanked itself on the second digit,
  forever. Re-assigning the SAME string still triggers it, so `setBound()`
  compares before it writes; that comparison is the fix, not an optimisation
  around one.
- *Our own "a return on or before departure is impossible" rule ran per
  keystroke too*, and a return on its way to 15 March passes through 1 March.
  Corrections now happen on `focusout`: **nothing may judge a date that is
  still being typed.**
- *The return box deliberately has NO `max`.* When a date input's min and max
  fall in the same calendar year, Chrome decides the year is known, fills it
  in, and sends the rest of what you type back into the day segment —
  "03152027" typed into a box bounded to 2027 lands as 27 March, silently.
  The departure box is safe by construction (a 13-month window always
  straddles two years), but the return's floor is the departure date, so the
  pair shares a year for any trip departing in `CAL_TO`'s year. A wrong date
  presented as a real one is worse than an unbounded box, so the far end is
  checked in `dateUsable()` instead, where it can say what happened.
- *Every automatic clear now says why* — past date, beyond the 13-month
  window, or return before departure. A box that empties itself silently is
  how somebody concludes the feature is broken, which is exactly what
  happened here.

**Verify a form control by driving it key by key, not with `fill()`.**
Playwright's `fill()` sets a complete value in one step, which is the picker's
behaviour, not a person's — it would have passed against every version of
this bug. Also worth knowing for the next test: `click()` lands the caret on
whichever date segment sits under the pointer, so type from a known segment
or the keystrokes go somewhere you didn't mean.

**A wrong fare becomes evidence, not an edict** (2026-09-20 designed,
2026-09-21 BUILT — `src/fareCorrections.ts`, the Fares section of `/admin`). The owner's example was the site estimating $7,000 from Oregon to
LAX. The instinct is to let them overwrite it; the decision was the opposite,
in their own words: it "should become another data point, a weighted data
point to help us update our estimated cache price". So a correction joins the
same machinery `observedSince()` already uses to let a bought fare move a
route's estimate, and the result stays labelled an estimate. Low/Medium/High
bands map to p25/median/p75 so someone can say "that's the cheap end" rather
than having to claim a single true number; corrections are deletable by id,
because a typo must be removable; and they expire, because a 2026 fare should
not still be steering a 2029 estimate.

As built, with the parts that are decisions:

- *Its own table, not a row in `flight_prices`.* That table is what a VENDOR
  returned. A hand-typed figure sitting in it would make the real-pulls
  digest report a pull that never happened and would feed the fare trend a
  number nobody quoted — the trend's whole job is measuring what providers
  charge. Mock and unlabelled rows are already excluded there and footnoted;
  a person's figure is the same kind of thing. A test pins that adding a
  correction writes nothing to `flight_prices`.
- *Each band moves its own statistic.* "Typical" speaks for the median,
  "low" for p25, "high" for p75, and a band nobody spoke for keeps the
  median's movement so the spread keeps its shape. The three are sorted
  afterwards, because a low above a high is nonsense however the arithmetic
  got there — and mixing a typed number with a scaled one can get there.
- *The owner's own middle outranks a measured correction, which outranks the
  global trend.* Each is better evidence about THIS route than the next.
- *Two staleness guards, both in the SQL* (`countingCorrections`), so no
  caller can read the table and forget one: a row stops counting past its
  `expires_on`, and separately once its own travel date has passed. A fare
  for a trip that already happened is history, not evidence — and is refused
  at entry rather than stored inert.
- *An expired row is still LISTED, marked as not counting.* "Where did my
  correction go?" is a worse question than seeing it greyed out.
- *Its own spreadsheet, separate from the settings one* — the owner's call:
  "I think it would be too much to have ALL of it on one sheet." A fare is
  per route and per date, so 171 domestic routes plus 95 international across
  thirteen months would bury the 73 settings. Same all-or-nothing import rule
  and the same row-numbered errors.
- *`ownerCorrected` rides on the estimate* so the board can say a human has
  corrected this route rather than quietly bending the number. It stays an
  estimate: typing $500 here does not make the board show $500, and the page
  says so in those words.

**You save a SEARCH, not a trip, and you pick which park leads**
(2026-09-21, the owner's case: "I am the researcher in my family and I want
to price out everything and send it to my wife saying, 'Check this out, I
priced all of this and I think Shanghai is doable.' I don't want her to just
see Shanghai. I want her to be able to see all of it").

Saving one resort threw away the six-resort comparison at the exact moment it
was shared, which is the product. So a saved row now carries every resort's
own typed numbers, and the saver chooses which park **leads** rather than
which park survives.

- *The table did not change and `resortId` still holds one resort.* The alert
  job re-prices one saved resort at a time and that shape was not this
  change's to break. It is now the highlighted one — which is also the one
  worth watching.
- *`overrides` was already a map keyed by resort*, so saving all six was a
  change to what the client sends, not to the schema.
- *The highlight picker lists every priced resort with its total*, cheapest
  first, so the choice is made against the numbers rather than from memory.
- *Deleting asks first, and the standalone panel is gone.* The owner deleted
  a trip by accident: a Remove button sat one careless click from the thing
  they meant to open, with no undo behind it. Deleting now confirms by name.
- *Custom expenses moved to where the trip is.* They were the only live thing
  in the panel the owner read as having "nothing to do" — a box floating
  above every search, usable only for a trip you had not opened. They now sit
  under the collapsed trip bar, visible only while a saved search is open,
  which is the only time they mean anything.

**The PDF opens on a cover, and the chosen park goes first** (2026-09-21,
the owner: "the print to PDF starts with a blank page. That is useless").

It was not blank — it was the search form, a page of dropdowns nobody can use
on paper, before the reader reached a single number. Now:

- *A print-only cover* names the destination ("Let's go to Disneyland
  Paris!") and says in one sentence who planned it, for when, for how many,
  flying or driving from where, and what it comes to. Built fresh on
  `beforeprint` as well as on the button, so printing from the browser's own
  menu cannot produce a cover describing a different comparison.
- *The highlighted park leads, in the print stylesheet only* (`order:-1` on
  one row of a flex board). On screen the board stays in price order, which
  is the app's one job; the rank number travels with the row so the price
  order is still legible on paper.
- *Everything that is a control rather than an answer is dropped* — the form
  panel, the masthead, the legend, the footer, and the selects and buttons
  inside cards. A dropdown you cannot open reads as a broken document.
- *The disclosures stay closed.* `<details>` prose is hidden in print; the
  numbers and their sources are what a shared PDF is for.

**The Plus-airport notice moved out of the form's grid** (2026-09-21, the
owner: the "Getting There" and "Departing From" boxes "get all wonky" for a
signed-out visitor). `.fields` bottom-aligns its columns, so a note — and
worse, a "Get Plus" button — growing inside one cell pushed that cell's
select down and left the two dropdowns on different lines. Both notices are
now a full-width strip beneath the pair, where they cannot distort a column.
Verified in a browser: both selects at the same y, to the pixel.

**An annual pass is a counterfactual, not a cost line; DVC points are
take-home, not the rental price** (2026-09-21, the owner's ask: for a pass
holder "we need them to be able to see what happens if they don't buy their
AP", and for DVC a box for "how many points they would rent and what the TAKE
HOME would be (not the rental actual)"). `src/memberships.ts` holds the
catalogue and the arithmetic; nothing about it is a new kind of cost.

The decisions, each with a test:

- *A pass you hold zeroes what you pay at the gate, and its own yearly price
  is reported beside the trip rather than added to it.* An annual pass is not
  bought for one trip. Charging its full price to whichever trip is on screen
  makes a four-night visit look absurd; spreading it over a guessed number of
  trips a year means inventing the single number that decides the answer. So
  it does neither, and the traveller compares the two figures themselves —
  which is exactly the comparison the owner described (four passes at Walt
  Disney World against the same money spent on tickets somewhere else).
- *A holding names its resort.* A Magic Key does not get you into Magic
  Kingdom, and this board prices six resorts at once, so "I have a pass" as
  one flat flag would have been wrong on five of them.
- *Tickets are computed PER TRAVELLER now, not as one running total.* Zeroing
  a share of a lump sum happens to land near the right answer for a party of
  all adults and is wrong for every other party.
- *Passes cover the dearest tickets first, and the card says so.* Nothing here
  knows which member of a family holds which pass. That is the optimistic
  reading, so it is stated rather than allowed to pass as a fact.
- *The parking perk lands on parking.* It comes off the parking-and-transfers
  line, where the cost actually is — on property that line is usually zero
  already and the perk correctly does nothing.
- *A pass holder does not buy park hopping twice.* Every current tier at both
  resorts includes it; `hopperIncluded` exists so a future tier that doesn't
  can say so.
- *A retired tier is DROPPED, not thrown.* Disneyland replaced the Enchant Key
  with the Explore Key in January; anybody holding a saved trip that named it
  must still get a board. Same rule as an unknown attraction id. Saved trips
  are re-normalised through `parsePassHoldings` at SAVE time, because the
  alert job re-prices straight from that row months later.
- *DVC is a credit on the TOTAL, never a discount on the room.* What you can
  rent points for has nothing to do with what a room at this resort costs, and
  folding it into the hotel line would break the six-resort comparison. Floored
  at zero — a trip can be free, never negative.
- *Take-home, not the rental price.* Asking what a renter pays and quietly
  assuming a commission would be the app inventing the part that matters.
- *Free, not Plus.* These are unverified claims a traveller makes about their
  own finances that never leave their own board — the same class of thing as
  the per-resort overrides, which are free for the same reason.
- *Every price is in the settings registry*, because Disney raises them roughly
  once a year and that must never need a deploy.

**The figures were checked by web search on 2026-09-21, not fetched** — same
standing as the hotel baselines and the visa notes; Disney and the DVC broker
sites are refused by this sandbox's egress proxy. Walt Disney World:
Incredi-Pass $1,629, Sorcerer $1,099, Pirate $869, Pixie Dust $489.
Disneyland: Inspire Key $1,899, Believe $1,474, Explore $999, Imagine $599.
**The owner's own DVC research was checked and is conservative**: they had
$20 rented / $16 take-home, and the current market reads as renters paying
roughly $19-21 and members taking home roughly $18-20 through a broker
(David's publishes $18/$20/$23 by home resort; DVC Rental Store advertises
"up to $24"). The shipped default is $18 and the traveller can type their own,
because a member renting privately keeps more than one going through a broker
and only they know which they are doing.

**The four international resorts have no pass programme here, deliberately.**
They sell annual passes, but the tiers and prices are published in other
languages and other currencies, and a guessed pass price would flow straight
into the comparison the app exists to get right.

**Five wrong passwords shut the door, and a reset is the way back in**
(2026-09-20, the owner's ask). Two scopes counted separately: the email
address, and the IP. Both are needed — without the IP scope an attacker just
moves to the next address and trips nothing; without the email scope they
use a fresh IP per attempt and trip nothing.

Three parts worth not re-deriving:

- *An address with no account locks exactly like one that has an account.*
  Otherwise "too many attempts" would mean "this address is registered", and
  the lockout becomes the enumeration oracle that sign-in's single error
  message exists to prevent.
- *The IP limit is much higher than the email one (25, not 5), and testing
  against a live server is what showed why.* A home, an office and a coffee
  shop share one address, so five typos from one person would have locked
  out everyone else behind that connection. The IP scope exists to stop a
  script working through a list, which takes far more than five tries.
- *The lock is a brake, not a trap.* It lasts minutes rather than forever,
  and a password reset works while locked — so the account holder always has
  a way in that doesn't involve waiting. The accepted cost, stated rather
  than hidden: somebody can deliberately lock a person out by guessing wrong
  five times.

A reset also **signs out every device** (that is what makes it an answer to
"someone shared their password", not just to "I forgot mine"), **confirms the
email** (clicking a link proves control of the inbox, which is the entire
thing `email_verified_at` records), and **clears the lockout**. A weak new
password is refused *without* consuming the link, or one typo would force the
whole flow to start again. `PUBLIC_BASE_URL` carries the same warning it
always did, with more force: a reset link addressed to a hostname that
doesn't resolve locks people out rather than merely failing to confirm them,
and nothing in the program can detect that — only a human clicking.

**Every detail card is "unit x quantity = total"** (2026-09-20, the owner's
report: the weather box read well and nothing around it did). The weather
tiles stopped being a one-off and became `.kpi`/`.kpitile`, used by tickets,
flights, driving, hotel, food and weather alike. Long prose — the estimate
derivation, the ticket disclaimer, the driving assumptions — moved into a
native `<details>` disclosure: this project's honesty was being set at the
same weight as the prices it explains, so the prose won and the numbers lost.
Every word still ships.

Three things that are decisions:

- *Cards in a row share a height and pin their footer*, so the booking links
  land on one line. The cost, said rather than hidden: a thin card carries
  visible empty space above its footer. That is the price of the alignment.
- *A number is printed once.* "Party of N", "Hotel total" and the
  dining-plan summary row each repeated the figure now in the total tile.
  What those rows uniquely said is kept — the lap-infant rule has a row of
  its own, and only when there is a lap infant.
- *Labels wrap rather than clip*, found in a browser and not by reading the
  CSS. `white-space:nowrap` with `overflow:hidden` on a flex container
  rendered "Average high" and "Average low" as two tiles both reading
  "AVERAGE", with no ellipsis, because `text-overflow` does not apply to an
  anonymous flex item. **A cut-off label is worse than a two-line one
  precisely because nothing says it was cut** — the same rule as the `est.`
  chip: never present a partial thing as a whole one.

**A shared PDF is a document, and you choose who is in it** (2026-09-21,
the owner: "The PDF download is still wrong. It shouldn't just be a
screenshot"). It was one. The print stylesheet dropped the controls off the
live page and reordered the board, which makes a tidier screenshot and still
a screenshot — a reader got four coloured bars and a legend and had to
already know how the app works to read it.

- *It is built, not styled into existence.* `#printDoc` is a SIBLING of
  `.wrap`, so print is one rule — hide the app, show the document — rather
  than a list of selectors every future card has to remember to join.
- *Every sentence comes from data we hold, and a section with nothing real
  to say is DROPPED rather than softened.* A document somebody forwards is
  the worst place to invent a number and the only artefact here that
  outlives the session that made it.
- *An estimate says so in words.* On paper there is no `est.` chip to hover.
- *The resorts are chosen.* Six is the product and also a lot to send
  somebody who has already agreed on Tokyo. The cover's sentence follows
  that choice — it cannot promise "the other five" when two are in the file.
  The choice clears on a new search.
- *Ctrl+P builds it too.* Printing from the browser's own menu skips the
  dialog, and without a `beforeprint` handler that produces a blank sheet —
  the original complaint, one layer down.

**Three things the owner asked for that are deliberately absent**, each
because the honest version does not exist yet:

- *A per-month nightly RANGE per hotel.* The seasonality curve is the mock
  provider's and is explicitly not in the real pricing path, and the API
  exposes only the hotel we picked, not the pool. The figure is the annual
  average and the sentence says so.
- *A route's carrier list* ("Air France and Shanghai Airlines fly nonstop").
  We cache one carrier per fare. The document names the carrier on the
  cheapest cached fare and says it is not the only one flying.
- *"Your dollar goes further."* An exchange rate cannot say that. The
  document converts a price instead, and separately compares food using our
  own per-resort figures, labelled as being about food prices.

**An exchange rate is a conversion, never a cost-of-living claim**
(2026-09-21). `src/exchangeData.ts` is generated from ECB reference rates
via Frankfurter — free, no key, a thin wrapper over the ECB's own daily
publication rather than an aggregator with opinions. It is SCHEDULED monthly
where the climate generator is manual, and the difference is the data:
normals move once a decade, a rate moves every working day. A partial fetch
writes nothing, and a response based on anything but USD is refused —
reading EUR-based rates as USD-based would misprice every conversion by ten
percent with nothing reporting a problem. The warning about what a rate is
NOT lives in the generator's template so it survives regeneration.

**The owner maintains the attraction list, and the database OVERLAYS the
code** (2026-09-21). `owner_attractions` holds rows that replace, add or
hide entries in `config.ts`'s `ATTRACTIONS`; an empty table leaves the app
behaving exactly as it shipped.

*A list needs that safety property MORE than a price does.* With
`owner_settings` the worst a lost row does is restore a shipped price. Here,
"the database is the truth" would mean a failed migration or a bad import
silently emptying the picker for everybody — and nothing would report it,
because an empty list is a legal list. So a database that throws returns the
shipped list, and a row naming only resorts that no longer exist is marked
not-applied rather than becoming an attraction belonging nowhere.

Two things found by testing rather than reading, both worth not repeating:

- *The spreadsheet wrote resort ids space-separated and the parser split on
  commas alone*, so a downloaded sheet could not be read back — every row
  refused for naming a resort called "wdw dlr". It shows nowhere but in a
  round trip, and there is a test for it now.
- *A row identical to the shipped one is stored as NOTHING.* Sending the
  sheet back unchanged is what happens when you edit one row out of ten;
  storing all ten marked every one "yours" and offered to revert them,
  burying the single real edit among nine that only looked like edits. Same
  instinct as a blank settings cell meaning "back to the default".

On a shipped attraction the button says **Revert**, not Delete, because
taking the owner's row away puts the shipped one back. "Only here" stays
DERIVED throughout — adding Tokyo to Mystic Manor stops the exclusivity
claim with no flag to remember.

**Tokyo's ticket link is the purchase flow, and its tracking token was
stripped** (2026-09-21). The owner supplied a click-tested URL carrying
`_gl=1*...`, Google Analytics' cross-domain linker value — short-lived and
tied to one browsing session, so shipping it would hard-code an expired
session into every traveller's link. `lang=en` is the part that means
something.

**Paris: the bundling constraint runs ONE way** (2026-09-21, the owner
asked). Park tickets on their own are sold online normally, dated or
undated, no hotel attached. What Disney will not sell online is a **room
WITHOUT tickets**. The old wording could be read as "you cannot buy Paris
tickets separately", which is false and would send somebody to a phone they
did not need to pick up.

**Wait times: all six are covered, but not the way the card needs**
(2026-09-21, researched, not built). Queue-Times has all six resorts, free,
no key, requiring a "Powered by Queue-Times.com" credit; Thrill Data has the
monthly averages. The catch is that Queue-Times' documented API is
**live-only** — a monthly historical average is not in it — and every one of
these hosts is refused by this sandbox's egress proxy, same wall as Disney
and every weather source. The owner's condition is worth keeping: "only
valuable if we can get it for all the parks", which is the same argument
that put weather on Open-Meteo rather than NOAA.

The owner chose **probe first, then collect**.
`.github/workflows/debug-wait-times.yml` answers, from where the network
works, which resorts have parks and their ids, whether any historical route
returns JSON, and what a live payload literally contains — that last part
because four providers here were written to a documented shape and never
run, and the one finally exercised failed on first contact. **It cannot be
dispatched until this branch merges**: GitHub only lists `workflow_dispatch`
workflows present on the default branch.

**Estimates lean HIGH, and the near-miss that got there is the lesson**
(2026-09-22). The owner priced IAH-MCO for March 2027 and got $139 a person
against real fares of $250-350: "$300 would be much more accurate."

**A halving bug was diagnosed, written, tested — and was wrong.** $139 doubled
is $278, squarely in that range, and BTS's own documentation describes
DB1BMarket as holding a "prorated market fare" for a "directional" market with
a round trip as two entries. That reads unambiguously like MktFare being one
leg, which would mean every domestic estimate in the app was half. The fix was
about to be committed.

*The fare trend stopped it.* `trimmedMultiplier`'s low and high are the MIN and
MAX of the observed ratios, and the live row is x0.945 across 74 routes with a
range of 0.580-1.242 — real round-trip SerpApi fares measured against BTS
baselines. Had the baseline been one leg, every one of those 74 ratios would
have sat near 2.0 and not one reached 1.25. So `MktFare` really is the whole
round trip, the parser's original claim was right, and doubling would have put
every domestic price on the board at twice its value. **Do not re-open this on
the strength of the documentation alone.**

Two guards so nobody re-runs that argument: `npm run coverage` prints our
national passenger-weighted average beside BTS's published ~$390 average
domestic itinerary fare, and the DB1B debug workflow now finds a two-market
itinerary and prints every row of it with the fares and their sum. Its old
`grep -m 5` returned five *different* itineraries and could never have answered
the question it existed for.

**The real cause was not a bug at all.** A DB1B median is the median fare PAID
across a whole quarter — Q1 includes January — largely by people who booked
months ahead, including deep-discount carriers. That is a different quantity
from what somebody is quoted today for one March date, and it is structurally
lower. The statistic was answering a different question.

So `leanedFare()` interpolates p25 -> median -> p75 and the shipped default is
**100, the dear end**. The reasoning is this project's oldest rule: showing
$100 and landing on $200 is the failure the estimate machinery exists to
prevent, and showing high and finding it cheaper costs nobody a booking.

- *It is not a fudge factor.* Every value it can produce lies between three
  real observed statistics of that route's own distribution, so it can only
  choose among numbers people actually paid.
- *Piecewise, not a straight line*, because a lean of 50 has to land exactly on
  the median and a straight interpolation misses it whenever the spread is
  lopsided — which on real fares it usually is.
- *Which number WINS is still decided on the median.* A real cached fare beats
  the estimate at or above it. Comparing the real row against the leaned figure
  would start overriding genuine fares far more often — a different change
  wearing this one's clothes.
- *Owner-editable* (`flight.estimateLean`), because the right lean is a
  judgement about how people react to a number.
- *Found by a test, not by reading:* the leaned figure went into the total
  while `flightPick` kept the plain median, so a reader adding up the card
  would have got a different answer from the board. Two places holding the same
  number is how that happens; there is a test across every lean now.

**A single bought fare no longer fully overrides a route's estimate — it's
blended, weighted by how much evidence backs it** (2026-09-25). The owner's
report was a crisis of confidence, not a bug report: "someone searching in
December or November can have wildly different pricing. I have no idea why
someone would use this tool anymore." Tracing it down, `book.ts`'s
`flightEstimate()` had exactly the mechanism to cause that, already half-
documented in its own comment ("one bought date could be a peak date that
doesn't represent its quarter") — but the comment only labelled the risk,
it didn't stop it: ONE real fare bought for a route+quarter (by the nightly
rotation or an exact-fare click) fully replaced that route's multiplier for
EVERY date in the quarter, no matter how small a sample of one thing is.
A single unlucky or genuinely-peak sample could swing a route 30-50% with
no real price change behind it, and since which routes get bought rotates
night to night, the same route's number could look wildly different a few
weeks apart for no reason a traveller could see.

- *The fix is the same one `INTL_BASELINE_MIN_SAMPLES` already made for
  international baselines* — one data point isn't evidence — just not
  applied to this domestic route-correction path until now.
  `ROUTE_CORRECTION_MIN_SAMPLES` (default 3, matching that precedent) is how
  many real fares a route+quarter needs before its own evidence is trusted
  at full weight.
- *Below that, the correction is BLENDED toward the global trend, not gated
  off entirely.* The owner explicitly wanted both: a floor below which one
  sample doesn't fully swing things, AND for that one sample to still nudge
  the number a little rather than being ignored outright until three arrive.
  `routeM = baseM + (rawRouteM - baseM) × min(n / ROUTE_CORRECTION_MIN_SAMPLES, 1)`
  — one sample moves a third of the way, three or more moves the whole way,
  exactly matching the old (buggy) full-override behavior once there's
  enough evidence to trust it.
- *`baseM` is what the route would show with NO route-specific evidence at
  all* — the global trend, or 1 for a baseline the trend must never touch
  (a live-sampled international baseline, per the existing "must never be
  moved by the trend" rule). Computing it explicitly, rather than repeating
  `h.applyTrend ? trend!.m : 1` inline with a non-null assertion, also
  closed a latent crash: that assertion could fire if `applyTrend` were true
  with no trend row loaded but an owner correction present for `low`/`high`
  only (not `typical`) — a real path through the code, never previously
  exercised by a test.
- *`ROUTE_CORRECTION_DAYS` (the 45-day lookback for what counts as a real
  fare) is UNCHANGED.* The owner considered widening it too and rejected
  that specifically: "the lookback window will drag us down" — a longer
  window smooths swings by making stale evidence linger, which trades one
  kind of wrongness (a fare too fresh to be enough evidence) for another
  (a fare too old to still be true). The sample-size fix doesn't have that
  trade-off: it only changes how much a real observation moves things,
  never how recent it has to be.
- *Not a cosmetic change to the number shown — this sits on top of the
  actual comparison.* Flights are the largest single line for four of the
  six resorts (Tokyo/Shanghai/Hong Kong routinely price $5,000+/person in
  the smoke fixture), so a single-sample swing large enough could flip
  which resort the board ranks cheapest — not just make one number look
  wrong, but make the comparison itself untrustworthy, which is the one
  thing this app exists to get right.
- Two tests in `exactFare.test.ts` pin both halves: one bought fare moves
  the estimate a third of the way (not all the way), and three bought fares
  (matching `ROUTE_CORRECTION_MIN_SAMPLES`) restore the old full-trust
  behavior exactly.

**"Pin exact dates" is gone, replaced by named holiday weeks — one canonical
range, priced identically at all six resorts** (2026-09-25). The owner's own
framing settled the design: "Paris doesn't move during Thanksgiving. That's
the point. A week in Paris during Thanksgiving might beat a week in
Disneyland in May." A free-text date pair implied day-level precision the
flight model never had (see the fare-blending entry above) and, worse,
priced ONE fixed day rather than scanning for a real typical one. Named
weeks do neither.

`src/holidayWindows.ts` (pure, tested, no I/O — same shape as pricing.ts and
crowds.ts) is the one home for this:

- *December always splits the same way, whatever the year* — "Before
  Christmas" (Dec 1–23) and "Around Christmas" (Dec 24–31) are fixed MM-DD
  ranges, since Christmas doesn't move.
- *Thanksgiving is REAL calendar math, not a fixed range* — the 4th Thursday
  of November, computed per year (`thanksgivingDate()`), with a window from
  two days before through four days after (Tue arrival through the following
  Monday) — chosen to match the real WDW crowd-window finding already built
  this project (Nov 24-26 arrival days, Nov 27-30 the weekend after), so the
  two features agree on what "Thanksgiving week" means. A hardcoded MM-DD
  range would have quietly drifted wrong the next year Thanksgiving fell on
  a different date.
- *Two were deliberately left out, both checked against real data rather
  than guessed:* July 4th/Labor Day (Disneyland's own real 2026 chart
  explicitly says these "barely move the price at all" — see
  seasonality.ts's `dlr` comment; building a window for a premium that isn't
  real would be the ERA5 rain-day mistake in another costume) and spring
  break (real, but genuinely resort-shaped rather than one calendar week —
  WDW spikes hard for exactly one week then stays elevated through April,
  Disneyland's real data barely moves, Paris ramps differently again; it
  also spans two calendar months, which the single-month picker isn't
  shaped for yet — a follow-up, not forced into this one).
- *The client never computes or sends dates for a window — only an id.*
  Same rule a curated promo's effect follows: `/api/meta` sends
  `holidayWindows` (id + label per "YYYY-MM", for the ~14 months the picker
  offers) purely so the dropdown can render itself, and `compare()` resolves
  the id back to real dates itself via the same `holidayWindowsFor()`. A
  client that lied about the dates would just get an unrecognised id and
  fall back to the whole month.
- *A saved trip stores the id (`params.window`), not raw dates* — the alert
  job re-derives the same real range from `params.month` + `params.window`
  months later, the same way it already re-derives everything else from a
  saved row rather than trusting stored numbers to still be true.
- *Verified against a live server, not just tests*: WDW's December scan
  landed on Dec 22 (whole month) vs. Dec 27 at $1,296/night (Around
  Christmas) — a real, materially different day and price. Disneyland
  Paris's Thanksgiving-week hotel line came back **byte-for-byte identical**
  to its whole-November scan ($766.47 either way), while WDW's moved
  ($866.93) — the exact "Paris doesn't move, Disneyland does" comparison the
  owner described, working for real rather than asserted.

**Flights get a real, sourced holiday premium too — deliberately NOT derived
from Parkfare's own BTS pipeline** (2026-09-25, the owner: "we have years of
BTS data ... use that big brain and find the pattern"). Worth stating
plainly why that specific ask can't be met the way it was asked: BTS DB1B is
reported by QUARTER ONLY, with no month or day field at all. Thanksgiving
and an ordinary November Tuesday both fall in Q4 and are statistically
indistinguishable in DB1B — no amount of cleverness extracts a day-level
pattern from data that was never collected at day-level granularity. This is
structural, the same category of limit as "BTS is a US-domestic survey, so
international routes get sampled instead" above, not a bug to fix later.

What's used instead: a real, cited third-party fare study (Upgraded Points,
2025 season — real Google Flights data across the 10 busiest US domestic
routes, 40,000+ flights, comparing an early-November control week against
the Thanksgiving and Christmas travel windows: **+55% and +58%**
respectively, with the weekend right after Thanksgiving spiking hardest of
all). Same standing as the IRS mileage rate or the hopper differentials — a
real, sourced number, owner-editable (`flight.thanksgivingPremiumPct`,
`flight.christmasPremiumPct`) because trusting a national average against
any one route is a judgement call, not something this app measured itself.

- *Applies to the calendar DATE, independent of the search UI.* A Dec 26
  flight is pricier whether you scanned the whole month or picked "Around
  Christmas" — `holidayFlightPremium(date)` is pure calendar math, computed
  in `pricing.ts` from `start` directly, never from which window (if any)
  the search happened to use.
- *Never touches a REAL cached fare, only the fallback estimate.* A real
  per-date fare already reflects whatever the market actually charges for
  that date; layering a synthetic national-average premium on top would
  double-count. Computed AFTER the `useRow` decision (which real-vs-estimate
  comparison uses the RAW, unadjusted estimate) so the premium can never
  itself tip a real row into looking "too cheap" and getting overridden.
- *A test pins each half*: a Thanksgiving-week date with no real fare gets
  the premium (and reports `holidayPremiumPct`/`holidayLabel` so the card
  can say so); the same date WITH a real cached fare shows the real fare,
  completely unmoved; the setting is genuinely owner-editable.

**Food gets a real breakdown, not a random range — designed, not yet
built** (2026-09-25, the owner: "Eating at Hoopty Doo Review is a lot more
than Casey's Corner and we can help the user estimate that if we are clear
rather than just giving them a box"). Agreed direction, deliberately
deferred rather than rushed: the four existing dining styles (grocery /
quick-service / mix / table-service) are already effectively discrete real
options with genuinely different numbers, closer to the hotel-category
spread than to an invented low-high band. The owner has a more specific
idea for how to build this and ran out of tokens mid-session — pick this up
fresh next time rather than guessing at what "help the user estimate that"
means without asking.

**The exact-fare caps bound ONE BUTTON, not searching** (2026-09-22, the owner:
"I don't want the entire site limited to six exact searches"). Worth stating
plainly because the names do not say it. Comparing six resorts, twelve months
of fare calendars, cheapest dates and every override are unlimited and free
forever — they read a cache already paid for. `EXACT_FARE_PER_USER_PER_DAY`
and `EXACT_FARE_GLOBAL_PER_DAY` apply only to the "exact fare" button, which
spends one real SerpApi search per press — free for any signed-in account
since the 2026-09-24 launch decision, but still capped for the same reason
it always was: the spend, not the plan. At 3 and 6 two friends exhaust the
site for the day.

**The Developer month: one sweep, international, then back to Starter**
(2026-09-22, the owner's plan — "one or two total runs a month ... leave the
rest of the room for individuals to search with"). The shape is right and the
README has the runbook. What is worth not re-deriving:

- *Fix the free things first.* The coverage basis check and the estimate lean
  both cost nothing and may be most of the problem. Buying real fares to
  correct a number a setting could fix is paying cash for a free fix.
- *International only.* Domestic has a free real BTS baseline; international
  has none. `intl-sweep` is also the only job that CAN do a complete pass —
  `popular-routes` buys a fixed number of routes for one rotation month per
  run by design. **Do not build a domestic sweep.**
- *`INTL_SWEEP_DATES=2`.* `INTL_BASELINE_MIN_SAMPLES` is 3 and one date a month
  gives exactly three per quarter, so one route returning nothing drops that
  quarter below the floor and no baseline is built at all.
- *One run, not two.* A second sweep re-buys fares that have barely moved.
- *It does not buy a real fare for every date.* 363 routes across a year is
  132,495 pairs. The 13-month window also rolls, so this is a boost with a
  half-life.

**Wait times are RECORDED and shown to nobody** (2026-09-22). The owner asked
for a card beside the weather box and withdrew it on the evidence; the
recording survived.

- *Why no card.* Every automated source records POSTED waits — Thrill Data has
  done exactly this since 2019 off the parks' own public APIs, as would we.
  TouringPlans measure ACTUAL waits with a stopwatch in their app and staff
  paid to stand in queues, and publish that Disney over-states by roughly
  11.5-15.5 minutes a day. That bias is harmless only if all six resorts
  inflate equally, and Tokyo is run by Oriental Land Co. while Paris and
  Shanghai post on their own systems. A non-uniform bias distorts the
  comparison, not just the number — the ERA5 rain-day trap again.
- *Why record anyway.* Elapsed time cannot be bought later. Thrill Data has a
  2019 archive only because it started in 2019.
- *Thrill Data's terms require permission for this*, not just attribution:
  "contact ... if you intend to build a database or other application off of
  the ability to download data. Permission is required." The owner chose to
  skip them rather than ask.
- *9am-7pm LOCAL only*, the owner's call — single-digit rope-drop and
  last-hour waits describe an experience nobody has. Twelve evenly-spaced UTC
  slots are evenly spaced in every timezone, so one schedule serves six of
  them.
- *`local_hour` is stored at write time and is load-bearing.* Aggregating the
  raw rows later would weight whichever local hours happened to get sampled.
  The intended aggregation is written into `src/jobs/waitTimes.ts`: by local
  hour first, then across hours, with a floor of distinct days, and all six
  resorts or none.
- *A closed park records nothing, not zeros.* That is how operating hours are
  handled without an hours table.
- *The park ids are a DRAFT* and the name check makes that safe — a park whose
  returned name disagrees is refused and the log prints what they call it.
  The probe workflow settles them and **needs this branch merged first**.

**Crowds are a band, a forecast, and never a reason to reorder the board**
(2026-09-22, the owner: they hold DVC points charts and can read demand off
them). `CROWDS` in `config.ts`, `src/crowds.ts` for the logic.

- *Five bands, never a number.* "Crowd level 7.2" implies a precision nobody
  here has and starts arguments about 7.2 versus 7.6. Same reasoning as the
  Low/Medium/High fare-correction bands.
- *A points chart is better evidence than it looks, and worse than it
  sounds.* It is Disney's own demand forecast — published months ahead,
  backed by real inventory — and it carries NONE of the bias that killed the
  wait-times card, because a price is not a posted wait time and no operator
  is inflating it. It is still a forecast of demand, not a count of people,
  and every basis note says so. There is a test that no note claims to have
  measured anything.
- *`basis` is per resort, because DVC is.* Only Walt Disney World and
  Disneyland have inventory to read; the other four are judgement from school
  and national holidays. A test pins that only those two may claim
  `dvcPoints`, so an international resort can never print a source that does
  not exist for it.
- *Sensitivity annotates, it never sorts.* At "somewhat" only a peak month
  flags; at "a lot" a busy one does too and quieter months at the same resort
  are offered. The board stays in price order — the app's one job — and "the
  cheapest week is also the busiest" is a trade-off to make knowingly.
  Identical rule and reasoning to the attraction matcher.
- *Thresholds live server-side, in `crowds.ts` only.* The browser renders what
  it is handed, so the chip and the detail card cannot disagree about whether
  there is anything to say.
- *An alternative month must be TWO bands quieter.* One band is noise when the
  data is bands to begin with.
- *The cross-resort note fires only on a two-band spread.* A note that appears
  every month, saying some resort is marginally quieter, is one people stop
  reading by March.
- *The shipped rows are placeholders and say so*, `CROWDS_ARE_PLACEHOLDER`.
  Flip it in the same commit that replaces them — a forgotten flag means the
  app presents a guess as researched.

**Hand-maintained data now nags on a clock** (2026-09-22, the owner: "make
sure you nag me on anything that is hand maintained and not done"). Ticket
rows had a staleness check and nothing else did, so each new hand-maintained
list arrived with a bespoke reminder or none. `REVIEWABLE` in
`ownerTasks.ts` is the registry: a last-reviewed date kept beside the data
itself, plus how long that data stays believable.

- *A date constant, not the file's git mtime.* Reformatting a file is not
  reviewing it, and a git date would silently reset the clock every time the
  file was touched.
- *The interval comes from how often the world republishes it*, not from how
  often we would like to look. Points charts and ticket prices are annual.
- *Nothing here is blocking.* Stale is not broken — it is what becomes broken
  while nobody is looking, which is what a nightly nag is for.
- *Placeholder flags are separate from the clock* and each earns its own row
  until flipped, because a placeholder nobody replaces is the real failure:
  the UI admits it is a guess, in small text, forever.

**The board quotes a typical day, and the traveller can ask for the
cheapest** (2026-09-22). It used to price the cheapest date in the month and
show that date's numbers, which reads as a quote and behaves as a floor: the
owner's October calendar for Houston to Orlando ran $87 to $1,122 a person
and the board showed $143. The $87 was real, and it was a dawn flight on
Halloween.

`typicalIn()` prices every date, drops the cheapest and dearest 10% of days,
averages what is left and quotes the real day nearest that average. Against
that October calendar: mean $354, median $222, trimmed mean $309, and the
trim drops exactly $87/$94/$112 and $760/$1,049/$1,122.

- *The owner's reasoning is what settled the statistic, and it is not this
  project's older median-not-mean rule.* There one tail was unrepresentative;
  here BOTH are. The dear days are dear because that is when people fly, and
  the rock-bottom days are cheap because those seats go out empty. Neither
  describes a trip anybody takes.
- *The quoted day is a REAL day, never a composite.* A total averaged across
  days belongs to no bookable trip and every line under it would contradict
  it. The average picks the day; the day supplies the numbers. The month's
  average is printed in words beside it.
- *The cheapest day is still computed, returned, and named with its date.*
  Hiding the floor to protect a headline is the same dishonesty one rung up.
- *The alert job moved in the same commit, and that is not tidiness.* It
  re-prices saved trips against the total the board quoted, so leaving it on
  the cheapest day would have fired an instant "the price dropped" email
  about a drop that never happened. The basis is STAMPED on a saved trip for
  the same reason.
- *"Which day should we price?" is a SEARCH parameter, not a resort card
  control* (owner's correction). It always applied to all six — a board
  quoting one resort's best day against another's typical day compares
  nothing — and the owner's framing is sharper: somebody chasing a cheap
  fare to Shanghai is not also looking for first class to Orlando.
- *The trim is owner-editable* (`search.typicalTrimPct`, 0-45).

**"Check live fares" goes to Kayak, and the regression before it is the
lesson** (2026-09-22).

- *Why it broke.* A pass had replaced a `q=` search with Google's `#flt=`
  structured form. `#flt=` is a URL FRAGMENT — never sent to the server, only
  the page's own JavaScript sees it — and it is an old internal format Google
  no longer honours. An unrecognised fragment is silently ignored, so it
  failed by showing a blank form rather than an error.
- *Why Kayak.* It puts the route, both dates, the adults and every child's
  AGE in the path. Google's `q=` carries the route and dates and no party
  size at all. Kayak's segment is `children-1-4` — the ages, ascending, not a
  count; a first pass guessed `/2children` and Kayak ignored it, dropping
  both children silently. Ages are also why the link is worth having: an
  airline prices a four-year-old and a lap infant differently.
- *No conflict with SerpApi, which was the owner's question.* SerpApi is
  where the app's fare DATA comes from, server-side and overnight. This is
  where a traveller is sent to BOOK. Unrelated choices.
- *Both links shipped side by side for exactly one round*, because
  kayak.com and google.com are both refused by this sandbox's egress proxy
  and the Google link had just been confirmed working. Swapping a working
  link for an untestable one is how `#flt=` happened. The owner's click
  settled it; Google's link is gone.
- *Kayak's `ucs=` and `fs=` are stripped*, same reason Tokyo's ticket link
  lost its `_gl=` token: session state, not routing.
- **Anything that cannot be fetched from this sandbox needs the owner's
  click, and the card prints what it is asking for so a mismatch is visible.**

**`1fr` is `minmax(auto,1fr)`, and that clipped a price** (2026-09-22). The
mobile KPI tiles sat on different lines with the total stranded in a
half-width cell and "$1,273" cut to "$1,27". Two causes, both worth knowing:

- *A `1fr` track refuses to shrink below its own content.* These tiles hold
  a monospace nowrap number, so 66px of fare would not fit a 58px track and
  the digits were cut. `minmax(0,1fr)` fixes it. **A clipped NUMBER is worse
  than a clipped label** — "$1,27" reads as a real price — which is the
  `text-overflow` lesson already in this file, one level up in severity.
- *The phone media query had NEVER applied.* It sat above the base rule with
  the same specificity, so the base rule won on source order and three
  columns were being squeezed into 296px the whole time. A media query that
  loses on source order fails silently and looks like a layout bug.

**Cache-first. Users never call a provider API.**
One search in the prototype triggers ~1,265 price lookups. Travelpayouts caps the
calendar endpoint at 300 req/min, so live per-search fetching doesn't just cost money,
it fails outright at the second concurrent user. A scheduled job fetches ~1,710 calls
each morning into Postgres; everything else reads the database. **Cost scales with
coverage (how many origin airports), not with usage.** This is the decision the whole
economic model rests on.

**Node/TypeScript, not Python.**
Not a language preference. The pricing logic runs in three places — the API that shows
a user a number, the alert job that decides whether it dropped, and the tests. A second
implementation in another language would drift, and drift means emailing a customer
about a price the site never showed them. `src/pricing.ts` is the single source of truth.

**The tool is free. Plus ($9 / 90 days, $19/yr) buys memory and monitoring.**
All six resorts, twelve-month fare calendars, cheapest dates, line items, booking links
and user overrides are free and unlimited. Plus = saved trips, saved overrides, price-drop
alerts, multiple trips.
- A trip pass, not an annual sub, because people plan a Disney trip once every 1–3 years;
  an annual renewal for something unopened in ten months generates refunds and 1-star reviews.
- $49/yr was rejected: TouringPlans charges $24.97/yr for far more.
- Affiliate commission (~$90–165 per booked trip) likely exceeds subscription revenue, so a
  hard paywall that blocks booking clicks is counterproductive.
- Alerts are cheap to serve (the alert job reads the cache, zero API calls), which is what
  makes this pricing viable.

**Plus is comped by email for friends, not sold — for now.** The owner does not want
friends to pay to test the app, but does want them to see what's actually behind the
paywall (not have it faked or hidden). So: no search quota on free comparisons
(explicitly rejected — see below), the paywall UI stays honest about what's locked,
and `npm run grant-plus` grants real Plus status without a payment step. This is a
demo-stage decision, not a permanent pricing change.

**The paywall does not promise a cheaper trip** (2026-09-18, owner's
correction). It used to be headed "Want to make it cheaper?" — which the app
cannot deliver and frequently contradicts: the exact fare a Plus lookup
returns is often HIGHER than the free estimate, and that is the feature
working, not failing. It now reads "Plan your specific trip" and says in the
body that a real number may come back higher, because a number you can book
against beats a cheerful one you can't. Same rule as the `est.` chip and the
`dataConfidence` badges: never let the copy write a cheque the data won't
cash.

**Sign up leads, sign in follows, and there is only one auth surface.** The
paywall used to carry its own email box posting to `/api/auth/signin` with
no password and `if(!res.ok) return` — so for the owner it did nothing at
all, silently, and once passwords became mandatory it could never have
worked. It now hands off to the real dialog. `requestPlus()` had the same
shape of bug (a bare `return` when signed out) and now says what to do.
**Never end a click handler with a silent `return`**: the user cannot tell
that from a broken build.

**No search quota on free comparisons — considered and rejected.** A "N free searches
a day" limit was floated to nudge Plus conversion. Rejected because it contradicts the
app's own thesis: comparisons read a cache that's already been paid for, so a quota
saves no money, it would only be a psychological lever — and the paywall copy already
promises "you should never have to pay to see what a trip costs." If growth ever
requires revisiting this, it needs its own conversation, not a quiet default.

**Airport transport and promos are new cost/discount categories, not folded into
existing ones.** Airport transport is a sibling line to flights/tickets/hotel/food
(`TripPrice.airportTransport`), not part of the existing resort-side `transport` field
— they're different things (getting to your home airport vs. parking at the resort).
Promos are not a new resort-scoped override type invented from scratch — a personal
discount reuses `ResortOverride` because it's exactly the same shape of thing overrides
already are (a personal correction, free to try, Plus to persist).

**User overrides are free, per resort.**
Hotel estimates are the model's weakest line. A free user who sees a wrong number and
can't correct it concludes the app is inaccurate and leaves — don't paywall the fix for
your own biggest credibility risk. Overrides are **per resort**, never one flat global
number: a $200 room in Orlando and a $200 room at Tokyo Disney are different products,
and flattening them breaks the comparison the app exists to make.

**The airfare override has a hard floor** at the cheapest fare found for those dates.
You can assume you'll pay more, never less. Tested (`pricing.test.ts`).

**A nightly rate the user sets is treated as flat** — a rate you found is a rate you
found, so it doesn't flex with season.

**Trip lengths bucket to 4 / 7 / 11 nights.** Caching every exact length triples row
count for accuracy nobody notices.

**Refresh is tiered.** 0–60 days daily, 61–180 every third day, 181–365 weekly.
Found the hard way while getting the first real deploy live: this means a
brand-new, empty database only gets the near tier on its first run — the far
tier needs about a week of daily cron runs before it's rotated through the
whole year, so a friend searching six months out would see "no cached price"
until then. `npm run refresh` now takes `REFRESH_BACKFILL=true` (also a
checkbox on the GitHub Actions "Parkfare refresh" workflow) to fill every
tier's months in one run instead of just today's due one — meant as a
one-time catch-up right after first deploying, not a replacement for the
normal tiered cron.

**Off-property totals include parking and transfers** ($35/day Orlando, $40 Anaheim,
$10–14 at transit-served international resorts). Without it, off-property looks cheaper
than it is — this is the comparison people get wrong.

---

## Verified facts (checked against sources during design)

- **Disneyland Paris sells on-property hotel stays bundled with park tickets by default.**
  Booking directly through Disney's own website, you can only book a Hotel + Ticket
  package — tickets included for every day of your stay, one combined price. A genuine
  room-only stay exists but isn't sold online (call Disney directly, or book through a
  third-party site like Booking.com/Expedia). This matters because `pricing.ts` prices
  Disneyland Paris hotel and tickets as two fully separate line items, same as every other
  resort — which matches a room-only stay, not Disney's own default package. Surfaced as a
  `goodToKnow` note on the resort's detail page rather than changed in the pricing math:
  changing the actual numbers would require real package pricing data, which isn't
  published, so a wrong "fix" risks being less honest than the current, clearly-labeled
  room-only assumption.
- **Amadeus self-service API was decommissioned 17 July 2026.** Not an option.
  ([PhocusWire](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers))
- **Travelpayouts**: free to join, no per-request charge, rate-limited (300/min calendar,
  60/min monthly), 30-day cookie, $50 payout minimum. Open to solo developers. The pick.
- **Duffel**: $3 per confirmed order, no IATA accreditation, but $0.005/search above a
  1500:1 look-to-book ratio. Only relevant if you ever sell tickets yourself.
- **Expedia Rapid** requires a corporate entity and trading history. Out of reach for now.
- **No public ticket-pricing API exists at any of the six resorts.** Hand-maintained table.
- **Disney has confirmed airline-style dynamic ticket pricing** is coming to WDW and
  Disneyland after the Disneyland Paris trial. Makes a static ticket table go stale faster,
  and makes "when should we go" more valuable.
- **WDW Disney Dining Plan 2027**: Quick Service $62.78 adult / $25.82 child per night;
  Table Service $99.87 / $31.94; Deluxe $163.01 / $46.85. Dining child band = ages 3–9.
  Under-3s eat free from an adult's plate. Plans require an on-property stay.
- **WDW hotel rack rates**: Value $118–307, Moderate $248–328, Deluxe $425–857.
- **Disneyland Resort hotels**: Pixar Place $355–466, Disneyland Hotel $464–631,
  Grand Californian $584–767.
- **Tokyo Disney age bands** (official): Adult 18+, Junior 12–17, Child 4–11, free 3 and under.
- **Disneyland Paris**: child ticket 3–11, adult 12+.
- **TouringPlans** charges $24.97/yr — the pricing benchmark to sit under.
- **Resend**: free to 3,000 emails/month, capped at 100/day, one verified sending domain.
  ([Resend](https://resend.com/blog/new-free-tier), [Automation Atlas](https://automationatlas.io/answers/resend-free-tier-explained-2026/))
  Fits the same "free, no minimums, solo-developer" bar Travelpayouts was picked on.
- **2026 published one-day ticket prices**: WDW $119–209, Disneyland $104–224 (web search
  at write time). Used to recalibrate `config.ts`'s ticket `base` constants so the two
  resorts' off-peak floor is no longer inverted (see "Mistakes made" below) — not a claim
  that the resulting curve matches real per-date pricing, which is genuinely tiered and
  which this flat curve can only approximate.
- **2026 IRS standard mileage rate**: $0.725/mile (Jan–Jun), $0.76/mile (Jul–Dec) —
  wired into every driving trip's `wearAndTearUsd` line via `irsMileageRate()` in
  `config.ts`. **Year-aware since 2026-09-17**: rates live in `IRS_MILEAGE_RATES`,
  one row per year, each tagged with the year it was published for. The IRS sets a
  new rate each December and adding it is a manual job — see the year-awareness
  decision below for what happens until you do.
- **Nominatim** (OpenStreetMap geocoding) and **ip-api.com** (IP geolocation): both free,
  keyless, no per-request charge — Nominatim capped at 1 req/sec with a caching
  requirement (see `src/geo/cache.ts`), ip-api at ~45 req/min for non-commercial use.
  Neither needs a key to gate on, unlike every other real provider here — see
  `src/geo/pick.ts` for why they're still mocked by default.

## NOT verified — check before relying on these

- **Visa/entry notes in `goodToKnow`** (Japan, mainland China, Hong Kong) cite
  travel.state.gov and US consulate pages, checked via web search at write time — closer
  to a primary source than the first pass, but still not fetched directly from the
  government site itself, and visa policy changes over time. All three are scoped
  explicitly to U.S. passport holders (the app doesn't collect nationality, so this can't
  be made accurate for other travelers without asking). Re-check before relying on the
  specific numbers (e.g. "240-hour transit", "90 days visa-free") for anything real.
- **The Disneyland Paris Space Mountain closure date (end of 2027) in `goodToKnow`** was
  checked via web search across several Disney-fan-news sources reporting an official
  announcement — not fetched from Disney's own site directly (blocked from this
  environment's network). Re-check closer to booking; multi-year construction projects
  slip.
- **Hong Kong's age bands** come from model knowledge, not a source. Configured as free
  under 3 / child 3–11 / adult 12+ — still unverified against Hong Kong Disneyland's own
  ticket page, hence its own `dataConfidence` badge. **Shanghai's are no longer in this
  category** (resolved 2026-09-23): the owner confirmed the same 3–11/12+ split against
  Shanghai's real purchase flow, which also settled that Shanghai bands by *age*, not
  *height* as an earlier, unsourced assumption here claimed.
- **Ticket affiliate commission rates** (used ~3–6% in the revenue estimate). This is the
  largest commission line and the least certain number in the business case.
- **Travelpayouts response shapes.** `providers/travelpayouts.ts` was written to the
  documented shape, never run against a live key.
- **Resend request shape.** `email/resend.ts` was written to the documented shape (one
  `POST /emails` call), never run against a live account. `ALERT_FROM_EMAIL` needs a
  domain verified in Resend before it can send to anyone but the account owner.
- ~~Vendor hosting prices (~$25–50/month total). Indicative only.~~ Superseded:
  the app now deploys for **$0/month** on Neon (free Postgres) + Render (free
  web service) + GitHub Actions (free scheduled refresh/alerts) — checked
  against each vendor's current 2026 terms, not guessed. See README.md's
  "Deploy for free" section. The one real trade-off: Render's free web
  service sleeps after 15 minutes idle and takes ~1 minute to wake on the
  next visit.
- **Off-property hotel base rates** are informed estimates, not published rates.
- **Food rates** are from budget guides. No API will ever give you food exactly.
- **The three example promo rows** (`seedPromos.ts`) are illustrative, not real offers —
  replace with actual, dated promotions before this means anything to a user.
- **Park Hopper differentials** (`ticket.hopperAdultUsd`/`hopperChildUsd` in `config.ts`):
  WDW (+$90) and Disneyland (+$75) came from an actual 2026 web-search check; Tokyo (+$38)
  and Paris (+$45) are unresearched guesses (roughly 20% of base ticket price), explicitly
  weaker confidence — refine before relying on either.
- ~~Rental car pricing (`CAR_RENTAL.dailyRateUsd`) is one flat national-average guess.~~
  **REMOVED ENTIRELY 2026-09-25** — see "What actually shipped today" (item 13) at
  the top of this file. The owner's
  call: it priced identically across all six resorts in a comparison, so it never
  actually changed which resort won. Kept here so the per-city-rate research below
  isn't accidentally redone for a feature that no longer exists: Travelpayouts also
  brokers car rentals via partners including DiscoverCars, same account, if this is
  ever revisited as its own thing rather than a comparison-board line item.

---

**Flight numbers are either a real per-date fare or a labelled estimate — never a
curve.** The owner's spec, and the reasoning behind each part:

- *Free data is the base.* BTS DB1B (US DOT itinerary survey) is real, free and
  keyless. It is quarterly, not monthly — that is the finest seasonal grain real
  fare data exists at, so "the same time last year" means the same **quarter**, and
  the UI says quarter rather than implying month precision.
- *Median, not mean.* The mean is dragged down by deep-discount and partial
  itineraries nobody pricing a family trip gets quoted. Low/High are the route's own
  p25/p75 — a real observed spread, not a percentage invented around the midpoint.
- *Buy real fares only where people look.* `route_searches` records demand (route and
  month only — no user id, no session, no IP; keep it that way). `popular-routes`
  buys genuine round trips for the busiest of those.
- *Move everything else by what those real fares measured.* If the bought routes sit
  12% above their own baselines, every unsearched route's **own** median moves 12%.
  Denver→Orlando is priced from Denver→Orlando's history, never from Atlanta's.
- *The accuracy bar is the click-through.* Showing $200 and landing on $700 is the
  failure this exists to prevent. That is why the median is the headline, why the
  trend excludes untrusted sources, and why `price_insights.lowest_price` is
  deliberately not used as the shown number.

**Travelpayouts' calendar endpoint cannot price a specific date — verified, not
assumed.** Asked for ATL→MCO departing 2027-03 over 7 nights, the live key returned
six dates in Sep/Oct 2026, destination `ORL` (the city, not MCO), durations of 0–3
nights, and $36–$200 fares expiring within the hour. It is a "cheapest fares our
users recently found" feed. The strict filter added earlier is correct and must not
be loosened to raise row counts — loosening it stores a 2-night fare under a 7-night
label. Its rows are tagged `travelpayouts` and excluded from the trend.

**Estimates are free; the exact fare is Plus.** Decided 2026-09-13, and it does
change an earlier decision — the paywall used to promise nothing about precision
and the copy now says explicitly what free gets (a real estimate, with its range,
unlimited) versus what Plus adds (the exact live fare for one date). The reasoning:
an exact fare costs metered money per lookup, so the person who triggers the cost
should be the person paying. It also could not be a blanket upgrade — six cheapest
dates is 6 lookups, one month's calendar ~30, all six resorts for a year ~2,190, so
one curious session would burn a month's budget. It is per-date, on demand, behind
a button.

Four bounds, in the order checked: cache first (a repeat question is free AND does
not consume the allowance — revisiting a trip must not be punished), per-user daily
cap, site-wide daily cap, provider budget. A failed lookup still counts, because the
provider bills for a search that finds nothing; otherwise an unserved route is a free
infinite retry.

**The loop back to the free product is the point**: a bought fare is written to the
shared cache tagged `serpapi_flights`, so the next re-price uses it as a real fare
(the estimate and its chip disappear on their own) and it feeds the trend every free
estimate is built from. A Plus user's spend improves what free users see. Never gate
this on anything the client sends — a client-supplied `plus` flag would be a way to
spend the owner's money; it is resolved from the session cookie against the database,
and that is verified against a live server including a spoofed payload.

**A bought fare corrects that route's estimate** (2026-09-13, owner's ask after
seeing $382 estimated against $511 exact). Where real fares exist for a route and
quarter, their median sets the correction instead of the global trend — route
evidence beats an average of other routes, so one exact lookup moves every other
date in that quarter. **Only fares newer than the baseline count**, or it is
circular: an international baseline is built FROM sampled fares, so measuring
those same fares against it always yields 1.0 and would claim "0% adjustment" as
though something had been checked. `routeSamples` is surfaced because a
correction built on one fare (possibly a peak date) deserves less confidence than
one built on ten.

**The IRS mileage rate knows its own year, and going stale is an owner
problem, not a user one** (2026-09-17). `irsMileageRatePerMile()` read only the
month and handed back the 2026 figure for any date in any year — so a 2029 trip
was priced on a three-year-old rate with nothing, anywhere, saying so. Now
`IRS_MILEAGE_RATES` holds one row per year and `irsMileageRate()` returns which
year's rate it used and whether that rate is the trip's own.

Three parts, each decided rather than defaulted:

- *A year with no rate on file still prices.* The app books 365 days ahead, so
  from 1 January every driving comparison would refuse until the new figure was
  typed in — and the IRS doesn't publish until mid-December. Refusing would break
  the product for months by design. The newest rate is carried forward instead,
  flagged as such.
- *But not forever.* `MILEAGE_RATE_CARRY_FORWARD_YEARS = 1` is the limit, which
  is exactly the booking window: the furthest bookable trip is at most one
  calendar year past the current one, so a one-year allowance never breaks normal
  operation, and anything past it means the warnings were ignored for a full
  year. Past the limit `priceTrip` returns `{ok:false, reason}` — no guess.
- *The warning goes to the owner, not to users.* Owner's explicit call. A
  stale-rate banner on a trip page is noise to a traveller, and the figure barely
  moves year to year. `mileageRateStatus()` drives a note in the existing
  owner-only news-digest email — riding that cron rather than adding a workflow,
  so it repeats until dealt with — which names the missing year and says to look
  up "IRS standard mileage rates" at irs.gov. It forces an email of its own only
  in the urgent case, where trips genuinely won't price. `drivingPick.mileageRate`
  is in the API payload so the calculation stays inspectable and testable;
  nothing in `prototype.html` renders it.

**Never hardcode a future year's rate.** An unpublished figure is exactly what
the warning exists to tell you about.

**Airports are tiered: 19 free metros, 22 more `PLUS_ORIGINS` — but as of the
2026-09-24 launch decision, that tier no longer governs picking, only
pre-caching.** Every origin multiplies the pre-caching bill, so the nightly
refresh's free list stays at the big metros — but "nearest big airport" was a
real compromise (Raleigh only offered Charlotte, three hours away; against the
same data CLT→MCO prices $387/seat and RDU→MCO $350), which is exactly why
picking one of the 22 smaller airports is no longer gated at all: `resolveOrigin()`
now just resolves any known origin to itself, with no free-metro downgrade
path. BTS ingests baselines for BOTH lists — the survey is one file covering
every US airport, so withholding data would cost nothing and buy nothing — so
an unpre-cached origin still prices fine from its own BTS-baseline estimate,
just without the nightly cache's freshness. **Real travel dates** (Mar 18-24,
not "sometime in March") were free for everyone too, via the `date` param
compare() already had, with nights derived from the gap — **since REPLACED
2026-09-25 by named holiday weeks (`holidayWindows.ts`)**, a different
mechanism entirely; see that decision note for why a free-text date pair
was replaced rather than kept alongside the new picker.

**Timestamps: never `String(aDate)` to compare them.** Postgres returns
timestamptz as JS Date objects and `String()` formats to WHOLE SECONDS, silently
dropping milliseconds — which made a just-bought fare fail to count as newer than
the baseline it was meant to correct. Use `tsOf()` in `book.ts`. Same shape of bug
as the `dateStr()` one above, one type down, and it took a test to see it.

**All six resorts launch; the weak ones are badged, not hidden.** Considered
launching with Paris and Tokyo only and holding Shanghai/Hong Kong back. Rejected
on three findings: (1) flights are not the blocker — a live probe of JFK→PVG
returned a full set of real itineraries at $935–965/person; (2) cost barely moves,
since dropping two airports takes the monthly sweep from 1,140 to 684 lookups and
both sit inside the same $75 plan; (3) the per-resort gaps are not where you would
guess — Paris has a structural one (Disney sells hotel+ticket bundles by default,
the app prices them separately) while Hong Kong is the simplest of the four. So
the real gaps are in how the cost model matches each resort, and they are labelled:
`dataConfidence` in `config.ts` badges Shanghai (children priced by height,
1.0–1.4m, not modelled), Hong Kong (age bands never checked against a source), and
Disneyland Paris (Disney bundles hotel+tickets; we price them as two separate
lines, a room-only basis that isn't bookable on Disney's own site — deliberately
not "fixed" in the math, since package rates aren't published and inventing one
would be less honest than a labelled assumption). Same reasoning
as the override controls and the "why is X cheaper?" explainer — explain a shaky
number, don't hide it, because the six-resort comparison *is* the product.
**Remove a badge when its gap is actually fixed**; `config.test.ts` pins which
resorts carry one so it can't drift.

**International routes have no free baseline, and are sampled instead.** BTS DB1B
is a US *domestic* survey — grepping a real 2024 Q4 file (8.5M rows) for `CDG`
returns zero matches, so Paris/Tokyo/Shanghai/Hong Kong have nothing to fall back
on. `intl-sweep` (monthly) buys real fares across all 95 international routes and
`intlBaseline` turns them into per-quarter baselines, so one bought date anchors a
whole quarter instead of covering only itself. ~1,140 metered lookups a month.
**BVA and SHA were dropped as arrival airports** (2026-09-10): no US service, so
every lookup returned nothing while still costing a search — 29% of the bill for
no data.

**A live-sampled baseline must never be moved by the trend.** The multiplier's job
is to carry an OLD survey forward to today. A baseline built from fares sampled
this month is already at today's prices, so applying it would inflate a current
fare by that percentage a second time — the exact "shown price is nowhere near the
click-through" failure. Live-sampled rows are tagged `sampled_live`, get no trend
(`TREND_APPLIES_TO` in `book.ts`), and are excluded from computing it, since
measuring bought fares against a baseline built from those same fares yields a
ratio of ~1.0 and drags the real multiplier toward "no change". Both directions
have a test.

**The trend needs anchor routes, not just demand.** The multiplier requires three
routes with both a real fare and a BTS baseline. Searches cluster, and international
routes have no DB1B coverage at all, so one busy day of Tokyo searches would leave
the trend uncomputable and knock out *every* estimate in the app simultaneously. The
nightly job tops up with the highest-sample domestic routes for exactly this reason.
Found by testing an all-international demand day, not in production.

## Mistakes made in this project — don't repeat them

1. **Claimed a 12-year-old is a child at Disneyland Paris.** Wrong — Paris child tops out
   at 11, same practical effect as Orlando. The age the resorts actually disagree about is
   **11** (adult in the US parks, child everywhere else) and **12–17** (Junior at Tokyo
   alone). A test caught this. The prototype's hint text and demo ages are corrected.
2. **Set hotel base rates as if they were floor prices when the model treats them as annual
   averages**, then applied a seasonal discount on top — producing $70/night Orlando rooms.
   Owner caught it against a real $150 booking. Fixed by raising bases and flooring the
   seasonal multiplier at 0.86. **If you touch the pricing model, sanity-check output
   against a real booking, not against intuition.**
3. **Presented an API call count in a cost table without units**, which read as "$1,400 per
   search." Always label units when discussing money.
4. **Buried the override controls** at the bottom of a card six cards down. Owner couldn't
   find them. They now sit in a highlighted panel at the top of the detail view.
5. **Used the word "clamps"** in an explanation to a non-engineer. Plain language.
6. **Set Disneyland's placeholder ticket `base` (148) higher than WDW's (132)** — backwards
   from real 2026 published pricing, where WDW's off-peak floor ($119/day) sits above
   Disneyland's ($104/day). The owner caught it by pricing a real Las Vegas → both-resorts
   trip and finding WDW came back cheaper, which contradicted a real price they'd looked
   up ($2,960 WDW vs. $1,890 Disneyland for a comparable December trip). Fixed by
   recalibrating both `base` values against researched 2026 ranges — still an
   approximation of a genuinely tiered system, not a claim of exact accuracy, and now
   disclosed as such on the Park Tickets card. Added a client-side "why is X cheaper?"
   explainer alongside the fix, on the same reasoning as override controls above: a user
   who sees a number they can't explain concludes the app is wrong and leaves.

## Bugs the tests caught (both would have shipped silently)

- **`trendAnchorRoutes()` claimed to pick the best-evidenced routes and
  actually picked the alphabetically-first ones.** Its SQL was
  `select distinct on (origin, destination) ... order by origin, destination,
  passengers_sampled desc limit 3` — which reads as "biggest BTS sample
  first", but Postgres requires `distinct on`'s *leading* ORDER BY terms to
  match its distinct columns, so `passengers_sampled` only broke ties within
  one route and never influenced which routes came back. Proven against a
  real query, not reasoned about: with ATL/MCO (90,000 passengers), ORD/MCO
  (70,000) and BWI/MCO (10) in the table, the old query returned **ATL and
  BWI** — anchoring the entire app's fare trend partly on a ten-passenger
  sample. The existing test asserted only `anchors.length === 2` and never
  which routes, which is exactly how it survived; it now asserts the routes.
  Ranking by sample size has to happen in an outer query over the
  de-duplicated rows. Caught by the owner asking whether the nightly job
  would keep pulling the same routes — it would have, forever.

- **The hotel lookup asked for a check-in date in the past for half of every
  month** (found 2026-09-18, in a real Actions log, not by a test). The sampled
  stay was hard-coded to the 1st of the month plus 13 days — the 14th — so from
  the 15th onward the current month's lookup was a guaranteed Google Hotels 400,
  `check_in_date cannot be in the past`, for all six resorts. The budget counter
  charges *before* the call (deliberately — a failing lookup must not be a free
  infinite retry), so six of the night's eight lookups were being paid for and
  thrown away, roughly 90 of ~240 monthly hotel lookups. The run stayed green
  throughout: each error was caught, logged, and treated as "off-property
  degrades to cached", which is the right behaviour for a *transient* failure
  and total camouflage for a permanent one. `sampleCheckIn()` in
  `providers/serpapi.ts` now returns mid-month when mid-month is still ahead,
  the soonest bookable night otherwise, and null when the month has no night
  left — and the rotation applies the same rule, so a slot is never handed to a
  month that cannot be priced.
- **The refresh asked for flights from LAX to LAX.** LAX is both a departure
  airport and one of Disneyland's arrival airports, so every run requested
  LAX→LAX — and LAX→SNA, which fails identically because Travelpayouts resolves
  SNA to the Los Angeles city code. Eighteen guaranteed 400s a night, logged and
  ignored. Free at the refresh (Travelpayouts does not charge) but **not** free
  everywhere: both pairs sit in `rotationRoutes()`' 171-route pool, and since a
  route that can never return an itinerary can never be recorded as bought, they
  sat permanently at the *front* of a stalest-first queue — real SerpApi money,
  every cycle, forever. `isLocalRoute()` in `config.ts` is the one shared rule,
  used by the refresh, the paid rotation, the demand-driven buy and exact-fare.
  It is 100 miles, picked against the measured distances rather than by feel:
  LAX→Disneyland 36, SAN→Disneyland 77, TPA→WDW 81, then a clear gap to
  RSW→WDW 133, JAX→WDW 144, MIA→WDW 193, LAS→Disneyland 226 — the last four
  being genuine, regularly-flown routes that must never be withheld.
  **Resolved the same day:** `defaultGettingThere()` in `gettingThere.ts`
  pre-selects the matching drive preset (`driveDlr` from LAX or SAN,
  `driveWdw` from TPA) so the local resort prices as a drive and the other
  five still price as flights — one board, no gap. Verified in a real
  browser, not just in tests: LAX + November prices Disneyland at "Driving
  $80" with flights on the other five. The suggestion is served from
  `/api/meta` (`origin.suggestedGettingThere`) rather than recomputed in
  `prototype.html`, so the distance rule has one home; and it stops the
  moment the traveller picks a preset themselves, because flying LAX→SNA on
  points is a real thing people do.
- Postgres returns `date` columns as JS `Date` objects; string-slicing them mangled every
  date and made all six resorts return "unavailable" with **no error at all**. See
  `dateStr()` in `src/book.ts`.
- The alert job compared against the cheapest hotel of *any* category — it would have
  emailed someone about a Value resort when they'd chosen Moderate.
- `findAlerts()` treated a user with no `plus_until` as alert-eligible
  (`plus_until is null OR plus_until >= today`) — a brand-new, never-upgraded account
  would have gotten real Plus alert emails. Caught while wiring real accounts; a test
  (`alerts.test.ts`) now pins a never-Plus user to zero candidates.
- `MockProvider.flightMonth` matched the requested destination against a resort's
  primary `iata` only, so any alternate arrival airport (Tampa alongside MCO for WDW)
  silently returned zero rows, forever — no error, just a permanently empty cache for
  that airport. Caught by actually seeding and querying an alternate, not just by
  typechecking. Fixed to match either the primary or any alternate airport.
- The anomaly-suppression rail (built to catch "many *trip* prices moved suspiciously
  in one refresh — that's bad data, send nothing") was also catching the new gas-price
  alert, because it reused the same `dropPct` field to carry a percent move. A single
  real 33% gas-price swing, checked against a population of just itself, looked
  identical to 100% of trips moving wildly and got silently suppressed. Fixed to
  exclude `gas_price_change` from that tally — a shared external number moving isn't
  the same kind of signal as many independent trip prices moving at once.
- Driving mode had no domestic/international check at first, so "driving" from Atlanta
  to Shanghai priced a straight-faced, technically-computed dollar figure for crossing
  an ocean. Caught by actually looking at the rendered board, not just green tests.
  Fixed to fail cleanly for any non-domestic resort.
- When the single global `transportMode` field was replaced with per-resort "Getting
  there" presets, `POST /api/trips` kept saving the raw preset name
  (`gettingThere: "driveWdw"`) into `saved_trips.params` — but the alert job re-prices
  *one* saved resort at a time and has no notion of presets, so it would have silently
  read `params.transportMode` as `undefined` (defaulting to "fly") for every saved
  driving trip, forever, with no error. Caught during review, not by a test — fixed by
  resolving the preset to a concrete `transportMode`/`originPoint`/`rentalCar` for that
  one resort *at save time*, in `server.ts`, so the alert job keeps working on the same
  flat shape it always has.
- Elements hidden via the `hidden` attribute inside `.f`/`.fields`/`.gt-sub` containers
  weren't actually hiding — those classes set an explicit `display` that beats the
  `[hidden]` UA-stylesheet rule. Caught by Playwright (`isHidden()` returning `false`
  for elements that should've been hidden), not by eye. Fixed with a global
  `[hidden]{display:none!important}` rule — a lesson for any future hidden toggle on
  a styled container, not just this one.

---

## Architecture invariants — keep these true

- `src/pricing.ts` is pure and synchronous, does no I/O, and is the **only** place trip cost
  is computed. Load a `PriceBook` slice first, then price hundreds of dates in memory.
- `priceTrip` returns `{ ok: false, reason }` and **never throws or returns NaN**. A cache gap
  must surface as "no cached fare for ATL-MCO on 2027-03-04", never as `$NaN` or a bogus alert.
- The refresh job **upserts on success only**. A failed run never deletes rows — yesterday's
  price beats no price.
- The alert job **never calls a provider**. Ten subscribers or ten thousand, the provider sees
  the same refresh traffic.
- Alerts have two rails: a per-user daily cap, and anomaly suppression (if a large share of
  trips move a large amount in one run, that's a data error, not a sale — send nothing).
  Always run alerts through `runAlerts()`, never `findAlerts()` + `applyCap()` directly —
  skipping `suppressAnomalies()` is exactly how `smoke.ts` shipped a demo that looked fine
  but bypassed the anomaly rail.
- `price_alerts` is inserted **before** the email is sent, and `notified_at` is only stamped
  on a successful send. A failed send is retried on the next `runAlerts()` call, not lost.
- Store the affiliate deep link **in the same row as the price**. Reconstructing links at
  render time is how tracking parameters go missing and commissions vanish.
- Prices are stored in USD. Currency display is a presentation concern.
- **Plus gating happens server-side, in `compare()`/`calendar()`/`overridesFrom()`, not
  just in the UI.** A non-Plus request never gets promo effects even if the query string
  asks for them — hiding the control in `prototype.html` is only the cosmetic half.
  Custom expenses and saved trips are gated the same way, directly on the `/api/trips*`
  routes. Never trust a client-supplied `isPlus`/`plus` flag; always resolve it from the
  session cookie against the database.
- A curated promo's *effect* (`effectKind`/`effectValue`) is always looked up
  server-side from `promosFor()` — only its `id` is ever taken from the client. A
  `personalPromo`'s value/kind *are* client-supplied, and that's fine: it's the user's
  own unverified claim about their own price, never shared with anyone else.
- **Users never call a provider API — except one deliberate exception.** The driving-mode
  city search (`GET /api/geocode`, `GET /api/geolocate`, `src/geo/`) calls Nominatim/
  ip-api live, on a user's own request, because it's on-demand interactive autocomplete —
  there's no fixed set of routes to pre-cache "every city someone might type" the way
  flights/hotels/tickets are pre-cached every morning. Bounded by: mock by default
  (`GEOCODE_LIVE=true` to go live), a real `geocode_cache` table so a repeated query never
  calls out twice, and both free/keyless services with generous limits for a friends-scale
  demo. If this ever needs to scale past that, it needs its own conversation — the same
  caveat the project already applies to the "no search quota" pricing decision.

---

## Build order (from the design doc)

1. ~~Schema and one route~~ — done
2. ~~Refresh job~~ — done, tiered, logged
3. ~~Point the frontend at the cache~~ — done
4. ~~Tier the refresh~~ — done
5. ~~Accounts and saved trips~~ — done: real email-only accounts, real Plus
   entitlement, plus airport transport, discounts/promos, and two free filters
   (see "Step 5" above)
6. ~~Alert job and email~~ — done, console by default, Resend if configured

7. ~~Deploy for free~~ — done: `render.yaml` (Render free web service) +
   `.github/workflows/{refresh,alerts,news-digest}.yml` (free scheduled cron via
   GitHub Actions) + Neon (free Postgres) for `DATABASE_URL`. Steps for the owner
   to actually go live are in README.md's "Deploy for free" section — signing
   up for Neon/Render is a human step, not something done from inside this repo.
8. ~~A round of owner UX feedback~~ — done: trip-form reorder (Adults → Children →
   Arriving → Getting There → Need a hotel? → Park Days/Hopper → Where you Stay →
   Resort Category → Food), the ticket-price recalibration and "why is X cheaper?"
   explainer above, Park Hopper, a real "Need a hotel?" (`stay: "none"`) state, a
   richer driving overnight stop (nights × cost/night), a real geocoded/IP-autofill
   "Departing from" search for driving, airport-transport pricing removed in favor
   of a redefined Plus (monitoring, saved trips, deal/gas alerts, custom planning
   expenses), and a loading indicator on "Compare six resorts."
9. ~~Mixed drive/fly comparison, rental car, wear-and-tear~~ — done: five "Getting
   there" presets (`src/gettingThere.ts`) let different resorts get there
   differently in the *same* six-resort board — drive to WDW only, drive to
   Disneyland only, drive to both domestic resorts (fly the four international
   ones either way), or fly to all (plain or with miles). Real IRS wear-and-tear
   cost, and a free optional rental car either for the drive (replaces
   wear-and-tear) or at the destination after flying. This absorbed what was
   previously planned as a separate "Compare Flying vs. Driving" page — turned out
   a preset on the main board served the actual ask better than a second page.

**Attractions: what a resort HAS, next to what it costs** (2026-09-18, built).
`ATTRACTIONS` in `config.ts` (hand-maintained, same pattern as `goodToKnow`),
matching in `src/attractions.ts` (pure, no I/O, like `pricing.ts`), picks in
`user_attractions`, and a chip on each board row.

Four decisions worth not re-deriving:

- **"Only here" is DERIVED from the resort list, never asserted per row.**
  An attraction names every resort that has it and `isOnlyAt()` is
  `resortIds.length === 1`, so a clone opening elsewhere can never leave a
  stale exclusivity claim behind. See the correction below for why.
- **It never touches the sort.** The board stays ordered by price — that is
  the app's one job — and the match says what a cheaper total would cost
  you. "The cheapest option doesn't have the one thing you came for" is a
  decision people should make knowingly, not a reason to quietly reorder
  their results. Verified live: with Zootopia and Ratatouille picked, the
  board still ran WDW-first on price while Shanghai (5th) carried "Only
  place with Zootopia".
- **The list is free to browse; picking yours used to be Plus.**
  **>> SUPERSEDED 2026-09-22, then again 2026-09-24: attraction picks AND
  applying a promo are FREE**, and as of the 2026-09-24 launch decision
  (Plus is the PDF, full stop — see the top of this file) that is no longer
  even a Plus-adjacent feature, just an ordinary free one gated on being
  signed in. The reasoning immediately below is kept because it was sound
  for the question it originally answered — which side of a paywall a
  curated list belongs on — and only the economics changed. **This IS now
  built**: `GET /api/attractions` is public; `PUT /api/profile/attractions`
  answers 401 (sign-in required) rather than 402, and `compare()` reads the
  picks from the user's own row so a signed-out request never carries
  matches at all. Verified by PUTting straight to the API past the disabled
  checkboxes.
- **An unknown pick id is dropped, not thrown.** Saved picks outlive edits
  to the list; an attraction that closes and is removed would otherwise break
  the board of everyone who had picked it.

The shipped rows are a **starter set Claude is confident about, not a
researched catalogue** — treat them like `seedPromos.ts`'s example rows. The
owner is supplying the real list.

**Building the real attraction list — scraping is out; the hard part is not
collecting names** (2026-09-19). The owner asked whether Claude could scrape
`disneyworld.disney.go.com/attractions/`. Findings, so nobody re-derives
them:

- **Not from this sandbox.** The egress proxy refuses Disney, Wikipedia and
  Disney fan sites alike (`EGRESS_BLOCKED` / `CONNECT tunnel failed, 403`).
  Web *search* works and returns titles and summaries; fetching a page to
  read it does not. This is an environment limit, not a Disney one.
- **That page could not be scraped anyway.** Its `#/sort=alpha` route is
  client-side, so the HTML is a shell — you would need a headless browser,
  against a site that runs bot protection.
- **It would only cover Walt Disney World.** One of six resorts, and the
  other five publish in different shapes and partly other languages.

**The real obstacle is clone matching, and no scrape can solve it.** A
scraper yields `Remy's Ratatouille Adventure` (EPCOT) and `Ratatouille:
L'Aventure Totalement Toquée` (Walt Disney Studios) as two unrelated rows
sharing no words. Load those and `isOnlyAt()` returns true for **both** —
the app then tells a user that Paris is the only place to ride Ratatouille
*and* that EPCOT is. That is precisely the confident-wrong-claim the
derived-not-asserted model exists to prevent, and it is human judgment, not
data collection.

**Volume is the other trap: a scrape gives too much, not too little.** Magic
Kingdom alone has 40+ attractions; all six resorts is several hundred rows,
most of which nobody picks a destination over. The picker is a checklist
someone scans, so the useful list is roughly **40–80 headline attractions
across all six resorts** — the ones that would genuinely move a decision.
Completeness is the wrong goal here.

**The agreed route** (recommended, owner to start): *paste-and-structure*
for Walt Disney World and Disneyland, where the owner can sanity-check a
name instantly — paste the names in any rough form, Claude turns them into
`ATTRACTIONS` rows and **flags every candidate cross-resort match for the
owner to confirm or reject**, never asserting one itself. For the four
international resorts, Claude drafts from its own knowledge and the owner
corrects, which carries the same caveat as today's starter rows and must be
labelled that way until checked. A locally-run Playwright scraper was
considered and is a poor trade: fragile against markup changes, and it still
hands back the clone problem unsolved.

**An "only here" attraction list must not assume uniqueness** (2026-09-18).
Recorded before building it because the obvious data model is wrong:
Claude offered "Ratatouille is only at Paris" as an example and the owner
corrected it — Remy's Ratatouille Adventure is at EPCOT *and* Ratatouille:
L'Aventure Totalement Toquée at Walt Disney Studios. Clones across resorts are
common, so an attraction has to be able to belong to several resorts, and
"only at X" has to be derived from the data rather than asserted per row.
Same honesty rule as `dataConfidence`: a confident wrong claim about what a
resort has is worse than a plain list. **Staleness is NOT the main risk
here** — Claude argued it was and the owner corrected that too: major
attractions stand for years or decades, unlike ticket prices or promos. What
moves is openings and closures, which is what the news digest already
watches.

**Souvenir spending is a basket, not a budget — thinking, not built**
(2026-09-18). The owner's point: the same money buys more merchandise in
Shanghai than in Orlando, and the model should be able to say so. A flat USD
souvenir budget cannot: it is the same number at all six resorts, so it
raises every total equally and never changes which resort wins. The version
that carries real information is a small hand-maintained **basket** of
representative items (a spirit jersey, an ear headband, a popcorn bucket)
priced per resort, so the line becomes "the same haul costs $X here and $Y
there" — verifiable against each resort's own shop, explainable to a user,
and the same no-API/maintain-by-hand pattern as tickets. Two traps worth
recording before anyone builds it: merchandise is priced in local currency at
locally-set levels, so this is **not** an exchange-rate conversion; and
because a per-resort multiplier CAN flip the ranking, it needs to be sourced
rather than guessed, which the ticket curve never had to be.

Then: the 10-mile off-property hotel radius filter (needs a `distanceMiles` field
on `HotelDef`, none exists today), a real per-city rental-car rate (a
Travelpayouts/DiscoverCars adapter is the researched building block, see "NOT
verified" above), a day-by-day trip planner (itinerary, checklist, dining tracker,
budget, per-day notes, special-event floor pricing — deliberately deferred, see
above), Travelpayouts token, hotel endpoint approval, a real ticket-price table,
Stripe, Resend domain verification, and a "prices as of ..." line in the UI.

## What the live database actually holds (checked 2026-09-18)

Run the **"Parkfare debug coverage"** workflow to re-check any of this — it is
select-only, makes no provider calls, and reads the real Neon database from
inside Actions, so nobody has to handle the connection string. Findings that
matter:

- **The fare trend is fine, and "trend: skipped" in a refresh log does not
  mean estimates are broken.** `fare_trend` holds real rows — x0.945 (low
  x0.580, high x1.242) from **74 routes** — and `book.ts` keeps using the last
  good one, exactly as designed. "Skipped" only means no NEW row was computed
  that night. Worth watching rather than fixing: the newest row is 2026-09-09,
  so the multiplier every estimate is scaled by is drifting out of date even
  though nothing looks wrong.
- **BTS baseline coverage is good**: ~38-40 origins each for MCO, SNA, LAX and
  TPA. Florida and California short hops are absent from their neighbours
  (MCO has no baseline from JAX, RSW or TPA), which is DB1B agreeing with the
  local-route rule rather than a gap.
- **Real cached fares run about three months out**, then fall back to labelled
  estimates — the tiered refresh working as intended on a database that has
  only been live a few weeks.
- **`alerts` reports `0 trips checked`**: no saved trips exist yet, so the
  alert path has never run against real data.
- The news digest is still printing `1 new item(s) found but OWNER_EMAIL is
  not set`, and now also `IRS mileage rate missing for 2027` — the
  carry-forward warning from the decision above, working, and reaching nobody.

## Email works now — sent, delivered, and the domain is verified (2026-09-19)

This section used to read "Nothing has ever actually emailed in production."
That is no longer true, and the change is load-bearing enough that the old
text would actively mislead: **real mail now leaves this project and arrives.**

Established against real logs and real DNS, not assumed:

- **A real email sent from GitHub Actions** on 2026-09-18 23:06 UTC. The
  "Parkfare test email" run printed `sender: resend` … `Sent.` and it
  arrived. So the Actions environment has `RESEND_API_KEY` and
  `ALERT_FROM_EMAIL`.
- **Render has them too**, plus `PUBLIC_BASE_URL` — a sign-up confirmation
  email went out from the live site carrying an absolute link.
- **`pricingthemagic.com` is verified in Resend**, with DKIM/SPF as Bluehost
  CNAMEs and a `_dmarc` TXT record (`v=DMARC1; p=none;`) added after the
  first delivered mail landed in spam.
- **The owner's own account is confirmed.** `kajones3@gmail.com` has a real
  `email_verified_at`, so the alert job will finally email it.
- **DNS:** apex → `216.24.57.1`, `www` → CNAME to
  `magic-around-the-world.onrender.com`. Both resolve.

**Still unconfirmed, and each has one cheap check:**

| Unknown | How to settle it |
|---|---|
| ~~Is `OWNER_EMAIL` set in **Actions**?~~ | **Settled 2026-09-19: yes.** The real-pulls digest run would have logged "OWNER_EMAIL is not set, not sent" and instead reported a send. `RESEND_API_KEY` and `ALERT_FROM_EMAIL` are confirmed there too. |
| Is `REQUIRE_VERIFIED_EMAIL=true` on Render? | The nightly job list drops the `verify-gate` row once it is on. Or sign out and back in — it still works either way for a confirmed account. |
| Is `PUBLIC_BASE_URL` now the apex? | Sign up a throwaway address and look at the link in the mail. |

### The www trap — the one config value whose wrongness is invisible

`PUBLIC_BASE_URL` was set to `https://www.pricingthemagic.com` while the
`www` CNAME in Bluehost pointed at itself and did not resolve. So every
verification link was addressed to a hostname that does not exist: mail sent
fine, Resend reported success, the owner clicked, got "site can't be
reached", and the account stayed unverified with **nothing anywhere
reporting a problem**.

That is structural, not a one-off. The program only ever *composes* that URL
(`verifyUrl()`); it never fetches it, so no test, log line or health check
can tell you the host is wrong — only a human clicking a link in a real
inbox can. Treat `PUBLIC_BASE_URL` as the one setting that must be confirmed
end to end by an actual click, and prefer the **apex** over `www`: the apex
is what Render verifies first and what resolved throughout.

### "Sent" means accepted, not delivered — and now says so (2026-09-19)

The owner didn't receive a nightly real-pulls digest. The trail: the workflow
ran, exited 0, and logged `pulls digest: 160 routes, 101 hotels, sent`. That
was every piece of evidence in existence, and it was not enough to tell a run
Resend accepted from a run that reached an inbox.

What was established, in this order, and worth not re-deriving:

- **The job is scheduled and did run.** `pulls-digest.yml` exists, cron
  `10 11 * * *`, `conclusion: success`. GitHub starts scheduled runs late
  under load — the run fired at 14:19 UTC, not 11:10. Not a fault.
- **`OWNER_EMAIL` IS set in Actions.** The note would have read
  "OWNER_EMAIL is not set, not sent" otherwise. That settles one of the three
  loose ends above.
- **Resend really ran, not the console fallback.** The digest text in the log
  is the CLI's own `console.log(r.text)`; the console SENDER prefixes
  `[email:console]`, which appears nowhere. So `RESEND_API_KEY` is set too.
- **Resend accepted it.** `ResendEmailSender` checks `res.ok` and throws, so a
  resolved send means a 2xx. The message left the building.

So the fault is between Resend and the inbox — spam placement, a bounce, or
filtering — **none of which this program can observe**. That is the real
defect the episode exposed: `sent` was set by "the sender didn't throw", and
the response body was thrown away, so nothing survived that a human could
trace. It is the `PUBLIC_BASE_URL` trap in another costume: the program only
ever sees its own half of the exchange.

Fixed by recording the handle that reaches the other half. `ResendEmailSender`
now logs Resend's message id with every accepted send and says in the same
line that acceptance is not delivery — **look the id up in the Resend
dashboard** to see delivered vs bounced vs spam. All four email paths gain it
from one change. `fetch_runs` notes say "handed to resend" rather than "sent".
`resend.test.ts` pins that a rejected send throws (callers treat a resolved
promise as sent and stamp it into `price_alerts`), that the id is surfaced,
and that a missing `ALERT_FROM_EMAIL` names the setting instead of failing at
the provider.

**Do not read "sent" anywhere in this project as "arrived."** Nothing here can
know that.

**`npm run test-email -- you@example.com`** (or the workflow, which runs with
the Actions secrets) remains the loud check. It reports Resend's own words
rather than treating "couldn't send" as "nothing to send" — but note what it
cannot catch: it proves mail *sends*, never that a link inside it *works*.

**Do not add a fourth email job without checking all of the above.**

### The owner's manual jobs ride the news digest (2026-09-18)

`src/ownerTasks.ts` computes what the owner still has to do by hand and
`renderOwnerTasks()` puts it at the top of the nightly digest — the one
message that reliably reaches a human. Every row says **[FREE]**, **[PLUS]**
or **[FREE+PLUS]** (the owner's ask: a broken free feature is everybody's
problem, a broken Plus feature is a paying customer's) and whether it is
**[BLOCKING]**.

The split that keeps it honest:

- **Checked** tasks are computed from real state — an empty env var, a ticket
  row over `TICKET_STALE_DAYS` old, a resort with no `on_property = false`
  vendor pull, a failed feed on the last run. They appear when true and
  **disappear on their own** when fixed. This is also where the
  ticket-staleness alarm CLAUDE.md has wanted since the beginning finally
  lives.
- **Standing** tasks cannot be detected from inside the program (was a rate
  checked against a real booking? is a list still the placeholder?). They
  stay until someone flips `done` in `STANDING_TASKS`. Kept deliberately few:
  a long list of un-checkable reminders is how a digest becomes noise and
  stops being read, which is the exact failure it exists to prevent.

A blocking task now earns an email on a quiet news day, generalising the rule
that used to apply only to an unpriceable mileage year. The one exception is
the email-secrets task itself, which is circular — there is nowhere to send
the warning that there is nowhere to send warnings.

## Known gaps in the code

- `TravelpayoutsProvider.hotelMonth` **throws deliberately** — flights are wired, hotels
  need whichever Hotellook endpoint you get approved for. It fails loudly so a
  half-configured deploy breaks at the refresh job instead of quietly showing users nothing.
- `seedTickets()` fills `ticket_prices` from a placeholder curve — recalibrated once
  against real 2026 pricing (see "Mistakes made" #6) but still a coarse two-parameter
  approximation, not real per-date Disney pricing. Replace with maintained rows and
  **alarm on any resort whose rows are >30 days old** — nothing fails loudly here.
- `NominatimGeocodeProvider`/`IpApiLocateProvider` (`src/geo/`) were written to each
  service's documented shape, never run against live traffic from this environment
  (proxied/restricted network) — same caveat as every other real provider here. Leave
  `GEOCODE_LIVE` unset and the mock providers handle driving-mode city search instead,
  so the feature still runs end to end with no account.
- **No 10-mile (or any) distance filter for off-property hotels.** `HotelDef` has no
  `distanceMiles`/`lat`/`lon` field, only a free-text `descriptor` — building this needs
  new structured data across ~30-40 hotels, deliberately deferred (the owner picked the
  cheaper "Need a hotel?" toggle for this round instead).
- ~~The trip form's "Arriving" field is a month picker, with real travel dates as a
  separate Plus control beside it.~~ **REPLACED 2026-09-25**: free-text "pin exact
  dates" is gone entirely. A month that has a real named holiday week (December,
  Thanksgiving) now shows a "Which week" sub-picker instead — see the decision note
  above for why and how `holidayWindows.ts` works.
- **Disney's own hotel pages cannot accept dates in a URL** — established, not assumed;
  see the decision note above. The card carries the party size instead and tells the
  traveller to enter their dates. Whether Disney has a children parameter is the one
  part still unknown, and a party with children gets the plain link until it's checked.
- `ResendEmailSender` needs a domain verified in Resend, and its request shape hasn't
  been run against a live account. Until then, leave `RESEND_API_KEY` unset — the
  console sender prints every alert instead, so the job still runs end to end.
- `EiaGasProvider` (`src/gas/eia.ts`) was written to the EIA Open Data API v2's
  documented request shape, never run against a live key — same caveat as
  Travelpayouts/Resend. Leave `EIA_API_KEY` unset and the mock national gas price is
  used instead, so driving-mode pricing and the refresh job both still run end to end.
- **`src/exchangeData.ts` is generated and still hand-seeded.** The rates in
  it are Claude's approximations, not observed, until somebody runs the
  "Parkfare exchange rates" workflow; `EXCHANGE_IS_PLACEHOLDER` is true until
  then and the PDF says so in words. Never hand-edit rows there — they are
  overwritten wholesale.
- **`parkList`'s lands are a Claude draft.** Lands get renamed and rebuilt
  often enough that an unchecked row is plausible, not confirmed — Shanghai
  gained Zootopia, Hong Kong gained World of Frozen, Walt Disney World is
  rebuilding DinoLand. The wait-time probe prints Queue-Times' own land
  names, which would be a real source to check them against.
- **`src/climateData.ts` is generated and still hand-seeded.** The numbers in it
  are Claude's, not observations, until somebody runs the "Parkfare climate
  normals" workflow — `CLIMATE_SOURCE` in that file says which it currently is.
  Never hand-edit rows there; they are overwritten wholesale. Season notes are
  in `config.ts` and survive regeneration.
- **`fetchDaily()` in `climateNormals.ts` was written to Open-Meteo's documented
  shape and has never run against the live API** — same caveat as Travelpayouts,
  Resend and EIA. The difference is that this one has somewhere to run: the
  workflow. If the first run fails, the error names the status and body.
- **`NEWS_FEEDS` (`config.ts`) are best-guess RSS URLs, not confirmed reachable from
  this environment** (this sandbox's network is proxied/restricted, so a real fetch
  attempt here returns a blocked-looking error regardless of whether the URL is
  actually right). Check the first real GitHub Actions "Parkfare news digest" run's
  log for per-feed errors before assuming these are correct.
- Shanghai height-based ticket banding is not modelled.
- **Every account requires a password (owner's call, 2026-09-18) — but still no email
  verification.** The opt-in scheme is gone: `signUp()` and `signIn()` in `auth.ts` are
  two separate operations, `/api/auth/signup` and `/api/auth/signin` are two routes, and
  email-only sign-in no longer exists anywhere. Sign-in never creates an account, so a
  typo'd address can't silently become a second empty one the way it used to.
  **Legacy accounts are claimed, not bricked**: an account with no hash keeps its id,
  its saved trips and any comped Plus, and gets a password the first time someone signs
  up with that address. That migration is what the old opt-in design was waiting for.
  **The open risk is unchanged and now sharper**: nothing verifies that an address
  belongs to whoever typed it, so claiming a legacy account is first-come — set
  passwords for comped friends with `npm run set-password` before someone else does.
  `--clear` is now the password-reset path rather than "back to email-only": it makes
  the account unreachable until re-claimed through Sign up. A one-time emailed link
  through `EmailSender` is still the real fix, and it needs the email secrets set.
  Sign-in keeps one message for every failure so it can't be used to enumerate
  addresses; **sign-up necessarily leaks that an email is registered**, which is
  unavoidable on any sign-up form without verification.
- **Email verification exists but does not block sign-in yet** (`src/verifyEmail.ts`,
  2026-09-18). Sign-up issues a single-use link (48h, one live link per account —
  asking for a new one kills the old), `GET /api/auth/verify` consumes it and answers
  with a readable page rather than JSON. **The gate is where the harm is: the alert job
  now requires `email_verified_at`, so this app never emails an address nobody
  confirmed.** Sign-in still works unverified, deliberately: no email has ever actually
  been delivered from this project, so a hard gate today would lock out every user
  including the owner, with the key printed into a server log. `REQUIRE_VERIFIED_EMAIL=true`
  turns the hard gate on, and the owner's nightly job list says when that is safe.
  **Existing accounts were NOT backfilled as verified** — claiming an address was
  confirmed when nobody checked is the kind of comfortable lie the rest of this project
  refuses to tell. `PUBLIC_BASE_URL` sets the link's host; unset gives a relative link,
  which works locally but not in a real email.
- **A password is only as good as the transport.** The session cookie now carries
  `Secure` whenever `DATABASE_URL` is set (i.e. on Render, over https), off locally
  where the dev loop is plain http, and forceable either way with `SECURE_COOKIES`.
  Guessing is now rate-limited as well — five wrong answers per address, more per
  IP; see the throttle decision below.
- **No admin UI for `promos`, `goodToKnow`, or `closuresUrl`.** All are hand-maintained
  directly in code/database (`goodToKnow`/`closuresUrl`/`closuresLabel` live in
  `config.ts`, right on each `Resort`) — same pattern as `ticket_prices`, and just
  as easy to let go stale silently. No alarm-on-staleness exists for any of them yet.
  `goodToKnow` is the one most worth re-checking periodically: it currently holds
  visa/entry information (sourced from travel.state.gov and US consulate pages, for U.S.
  passport holders only) and one dated attraction-closure fact (Disneyland Paris's Space
  Mountain, confirmed closing end of 2027), both of which change over time and carry real
  consequences if wrong. No live ride-status/closure API exists anywhere for any of the
  six resorts — WDW and Disneyland Anaheim have official Disney closure-calendar pages
  (linked via `closuresUrl`); the other four resorts don't, so `closuresUrl` points at the
  best available third-party tracker instead, with `closuresLabel` always saying plainly
  when a link is unofficial rather than implying it's Disney's own.
- **The promo effect vocabulary is deliberately small** (`room_pct_off`,
  `room_flat_off`, `free_dining`, `ticket_pct_off`, `flat_off_total`) — enough for the
  discounts discussed, but a genuinely unusual promo (e.g. a free park-hopper upgrade)
  has nowhere to go yet.
- **The day-by-day trip planner is not built** — itinerary, checklist, dining tracker,
  budget breakdown, per-day notes, and special hard-ticket-event floor pricing (like
  Mickey's Not So Scary) are confirmed, wanted scope, deliberately deferred to its own
  follow-up plan once this foundation has been used.
- **"Getting there" is three fixed presets, not a fully general per-resort picker**:
  you can drive to WDW-only, Disneyland-only, or both domestic resorts (flying
  everywhere else in that same board), but there's no way to independently choose a
  mode per resort beyond that grouping. Good enough for the owner's actual asks so
  far; would need a real per-resort control (bigger UI change) to go further.
