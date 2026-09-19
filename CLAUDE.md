# Parkfare — project context

Compares the **total cost of a Disney trip across all six global resorts at once**, and
tells you *when* to go. Walt Disney World, Disneyland Resort, Disneyland Paris, Tokyo
Disney Resort, Shanghai Disney Resort, Hong Kong Disneyland.

Nobody else prices "should we do Orlando or Tokyo this spring?" side by side. That
comparison is the product; everything else supports it.

Owner is non-technical-to-semi-technical. Explain trade-offs in plain language and
say when something is a guess.

---

## Where things stand — 2026-09-19 (read this first in a new session)

**Latest session: a round of owner UX fixes.** Five trip-form bugs, the
hotel links, an all-six hotel re-baseline, free-text override boxes, and
saved trips you can get back to. Read the decision notes below before
re-litigating any of them; the short version:

- *Dates.* Typed travel dates no longer vanish, a half-filled pair is
  refused instead of silently falling back to the month, the return date
  is guarded on a phone as well as a laptop, and both inputs cap at the
  13-month booking horizon.
- *Hotels.* On-property rooms link to Disney's own site (Walt Disney World
  by category), and every resort's category medians were re-based
  together. **The four international sets are Claude drafts the owner is
  correcting**, and the four international hotel URLs have never been
  fetched — the egress proxy blocks every Disney domain.
- *Your numbers.* The airfare slider is gone and its floor is now advisory
  — a reversal, on the owner's instruction. Food can be typed as a
  whole-party daily total.
- *Saved trips.* Named on save, reopened from a "My trips" masthead
  dropdown. "Save as PDF" prints the board.

**Open with the owner:** whether Disney's hotel pages accept dates in the
URL (a candidate link is with them to click-test), and corrections to the
four international hotel baselines.

**Live at https://pricingthemagic.com**, serving the current `master`
(`18f12f4`). Version check in the browser: the paywall reads "Plan your
specific trip" and there is a **Sign out** button in the masthead. If you see
"Want to make it cheaper?" instead, Render is serving a stale build —
Manual Deploy → Deploy latest commit.

Shipped in the last two sessions: mandatory passwords, email verification
that actually delivers, honest paywall copy, a masthead sign-out, airports
listed by city, attractions (starter data), and the owner's manual-job list
riding the nightly digest.

**The next piece of work is the real attraction list** — see "Building the
real attraction list" below for why scraping is out and what the agreed
route is. Short version: the owner pastes Walt Disney World and Disneyland
names in any rough form, Claude structures them into `ATTRACTIONS` rows and
**flags candidate cross-resort clones for the owner to confirm**, never
asserting one itself; the four international resorts get a Claude draft the
owner corrects. Aim for 40–80 headline attractions total, not a complete
inventory.

**Three loose ends, each with a one-line check** (details in the email
section below): is `OWNER_EMAIL` set in GitHub Actions; is
`REQUIRE_VERIFIED_EMAIL=true` on Render; is `PUBLIC_BASE_URL` pointed at the
apex rather than `www`.

**Still unbuilt and deliberately so:** the day-by-day trip planner, the
souvenir basket, a per-city rental-car rate, the 10-mile hotel radius
filter, and Stripe.

## Current state

| Piece | State |
|---|---|
| Backend (`src/`, `db/`) | **Working.** 82 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline — refresh, pricing, a saved trip, and now a sent (console) alert email — with no accounts or network. |
| Multiple arrival airports | **Wired, free.** Five of six resorts (all but Hong Kong) have alternates (`altArrivalAirports` in `config.ts` — Tampa/WDW, LAX/Disneyland, Beauvais/DLP, Haneda/Tokyo, Hongqiao/Shanghai). Refresh fetches flights to each; a resort's detail view picks among only its own airports, never a bare code trusted from elsewhere. |
| "Getting there" — mixed drive/fly, rental car, wear-and-tear | **Wired, free.** Five presets on the trip form (`src/gettingThere.ts`'s `resortTransportMode()`): Flying to all, Flying to all with miles (0-100% off the cash fare, no floor), Driving to WDW only, Driving to Disneyland only, Driving domestically (both) — each drive preset flies every other resort in the *same* six-resort comparison, so "drive to WDW, fly to Disneyland" is one board, not two searches. Driving cost includes wear-and-tear at the real IRS standard mileage rate (`irsMileageRate()` in `config.ts`, year-aware — see the decision note). A rental car is a free, optional add-on either for the drive (replaces wear-and-tear — you don't wear out a car you don't own) or at the destination after flying (`CAR_RENTAL.dailyRateUsd`, one flat national guess, always its own cost line). Plus-only add-on unchanged: an alert when the cached gas price has moved since a driving trip was saved. |
| Park Hopper | **Wired, free.** A flat per-ticket add-on at the four multi-park resorts (WDW, Disneyland, Tokyo, Paris); silently has no effect at Hong Kong or Shanghai, which each have one park. WDW/Disneyland's differentials are researched against real 2026 pricing; Tokyo/Paris are unresearched guesses, flagged weaker-confidence below. |
| "Need a hotel?" | **Wired, free.** A real `stay: "none"` state (not just "off property") prices $0 hotel/transport with no pick, for day-trippers or anyone staying with family/friends. |
| Driving-mode city search | **Wired, free — the one live-provider exception.** `src/geo/` (Nominatim geocoding + ip-api.com IP lookup, both free/keyless, mock by default, `GEOCODE_LIVE=true` to go live) backs a real "Departing from" search box and a "use my location" button for driving mode. See the architecture-invariants note below on why this is a deliberate exception to "users never call a provider API." |
| Real-pulls digest | **Wired, owner-only.** `npm run pulls-digest` emails a daily list of every flight route and hotel a real provider actually returned prices for in the last 15 days (`PULLS_WINDOW_DAYS` to change it), grouped by route/hotel and source, with the departure/stay dates covered and when it was last pulled. Sends even when the answer is "nothing" — a quiet cache is the signal worth having. Mock and unlabelled rows are excluded and footnoted, never folded in. `hotel_rates.source` was added for this: without it there was no way to tell a rate a vendor returned from one the mock provider invented. Read-only; no provider calls. |
| Disney news digest | **Wired, owner-only.** `npm run news-digest` reads a few RSS feeds (`NEWS_FEEDS` in `config.ts`) and emails whatever's new — never shown to end users automatically; the owner reviews and hand-adds anything worth surfacing to a resort's `goodToKnow`. |
| Frontend (`public/prototype.html`) | **Wired to the real API.** Every price on the page comes from `/api/compare` and `/api/calendar` — no in-browser pricing model left. `src/server.ts` now also serves the prototype itself at `/`, so `npm start` + open `http://localhost:PORT/` is the whole dev loop, same origin, no CORS. |
| Live provider data | **Partly connected.** Travelpayouts + SerpApi keys are set in production. Flights now come from real per-date SerpApi Google Flights lookups on searched routes, and from real BTS DB1B medians moved by a measured trend everywhere else — see "How a flight number is arrived at" in README.md. |
| Flight pricing model | **Reworked (2026-09-09).** Median-not-mean, same-quarter-not-newest, demand-driven real lookups, honest `est.` labelling on the board itself. See the decision note below. |
| Alert emails | **Wired.** `runAlerts` sends through `src/email/` — console by default (no account), Resend if `RESEND_API_KEY` is set. Now also fires a `new_promo` "we found a deal" alert. |
| Accounts | **Real, minimal, and now visible.** Signing in is a real dialog (`#authModal`) reached from a **Sign in** button, not two inputs wedged into the masthead; once you're in, an account button carries your initial, email and plan, and opens a panel showing who you are, your plan, when Plus runs out, how many trips you've saved, and your **home airport** (free, `users.home_airport` — see the profile decision below). The owner's report was "I have no real idea that I am signed in" — a small grey chip among other small grey chips. **Nothing about entitlement changed**: Plus is still resolved server-side from the session cookie on every request that matters; this is only the part that tells you about it. **Every account requires a password** (scrypt, salted, `node:crypto`, no new dependency) — sign-up and sign-in are separate operations and email-only sign-in no longer exists anywhere. A real `sessions` table, real `plus_until`-based entitlement. **Email verification is live and links genuinely arrive**; the alert job refuses any address without `email_verified_at`, and `REQUIRE_VERIFIED_EMAIL=true` additionally blocks sign-in. Signing out has a masthead button, not just the account panel's footer. Reset a password with `npm run set-password -- email 'value'` (`--clear` makes the account unreachable until re-claimed through Sign up). The owner comps Plus via `npm run grant-plus -- email days` — no payment processor yet. |
| Promos, custom expenses | **Wired, Plus-only.** Curated + personal discounts are real cost lines in `pricing.ts`, gated server-side. `custom_expenses` lets a Plus user attach free-form planning-expense line items (VIP tours, PhotoPass, anything not modeled) to a saved trip — this, not airport ground-transport pricing (built earlier, since removed), is what "extra planning of expenses" turned out to mean once the owner used the app: monitoring, saved trips, deal/gas alerts, and room for costs the model can't guess at. |
| Exact live fares | **Wired, Plus-only.** Free = a labelled estimate with its range, unlimited. Plus = the real fare for one specific date (`POST /api/exact-fare`, `src/exactFare.ts`), cache-first and capped per-user + site-wide. The one route where a user's click spends metered money. |
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
  unlock" — but *applying* one is Plus. A personal discount (Annual Passholder, DVC,
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

**A profile is free; saved trips stay Plus** (2026-09-18). The first field is
`users.home_airport` — the airport you depart from, remembered per account
(`setHomeAirport()` in `auth.ts`, `PUT /api/profile`, shown in the account
panel). Free, deliberately: an account is free, saving and watching a *trip*
is Plus, and a remembered dropdown is neither. Paywalling it would be the
already-rejected search-quota idea wearing a different hat.

Three things that are decisions, not defaults:

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
reseller. **Dates are deliberately not appended** — Disney's category
pages are hash-routed and no date parameter has been confirmed to work, and
a link landing on an error page is worse than one landing on the right
page. The four international URLs are **unverified from this environment**,
same standing as the `goodToKnow` visa notes.

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

**"Compare both" now says what it found.** It always widened the hotel pool
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
- **Shanghai and Hong Kong age bands** come from model knowledge, not a source. Both are
  configured as free under 3 / child 3–11 / adult 12+. Shanghai actually bands by *height*
  (1.0–1.4m), which is not modelled at all.
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
- **Rental car pricing** (`CAR_RENTAL.dailyRateUsd` in `config.ts`, currently $65) is one
  flat national-average guess, not a per-city rate — real rates vary a lot by city
  (2026 research: ~$55–95/day generally, ~$49–78/day economy specifically; Miami runs
  cheap, Chicago runs pricey). A real per-city rate, ideally from a real provider
  (Travelpayouts, the existing flight provider, also brokers car rentals via partners
  including DiscoverCars — same account, no new vendor relationship needed), is future
  work; this session shipped the flat guess so the feature works end to end now rather
  than staying deferred.

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

**Airports are tiered: 19 free metros, 22 more with Plus.** Every origin
multiplies the pre-caching bill, so the free list stays at the big metros — but
"nearest big airport" is a real compromise (Raleigh gets offered Charlotte, three
hours away; against the same data CLT→MCO prices $387/seat and RDU→MCO $350).
A free user picking a Plus airport is NOT an error: `resolveOrigin()` prices the
nearest free metro and returns `originDowngrade` so the page says which airport it
used. BTS ingests baselines for BOTH lists — the survey is one file covering every
US airport, so withholding data would cost nothing and buy nothing. The split
governs which airports can be *picked*, not which have data. **Plus also pins real
travel dates** (Mar 18-24, not "sometime in March") via the `date` param compare()
already had, with nights derived from the gap.

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
- **The list is free to browse; picking yours is Plus.** Exactly the promos
  precedent — a curated promo is public to browse and Plus to apply — and
  the owner's "keep it on the Plus side". `GET /api/attractions` is public;
  `PUT /api/profile/attractions` answers 402 without Plus, and `compare()`
  reads the picks from the user's own row so a free request never carries
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
| Is `OWNER_EMAIL` set in **Actions**? | The next "Parkfare news digest" run (cron `40 4 * * *`). Its log says `OWNER_EMAIL is not set` if not. Nothing else in the repo reads it. |
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
- **The trip form's "Arriving" field is a month picker**, with real travel dates as a
  separate Plus control beside it. Filling both dates now stands the month down visibly
  and the search refuses a half-filled pair rather than falling back to the month —
  which is how a February trip came back priced for March, and how the Booking.com link
  then carried March's dates.
- **Disney's own hotel pages are not known to accept dates in a URL.** The card tells the
  traveller to enter their dates rather than guessing a parameter; confirming this needs
  a human clicking a real link, same as `PUBLIC_BASE_URL`.
- `ResendEmailSender` needs a domain verified in Resend, and its request shape hasn't
  been run against a live account. Until then, leave `RESEND_API_KEY` unset — the
  console sender prints every alert instead, so the job still runs end to end.
- `EiaGasProvider` (`src/gas/eia.ts`) was written to the EIA Open Data API v2's
  documented request shape, never run against a live key — same caveat as
  Travelpayouts/Resend. Leave `EIA_API_KEY` unset and the mock national gas price is
  used instead, so driving-mode pricing and the refresh job both still run end to end.
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
  There's no rate limiting on `/api/auth/signin`, so nothing slows down someone
  guessing; scrypt makes each guess cost real work, which is the only brake there is.
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
- **`CAR_RENTAL.dailyRateUsd` is one flat national-average guess**, not a per-city rate —
  same limitation as the old airport-transport guesses had, see "NOT verified" above.
  And **"Getting there" is three fixed presets, not a fully general per-resort picker**:
  you can drive to WDW-only, Disneyland-only, or both domestic resorts (flying
  everywhere else in that same board), but there's no way to independently choose a
  mode per resort beyond that grouping, and "Rent a car for the drive" applies to
  whichever resort(s) are driving as a group, not one at a time. Good enough for the
  owner's actual asks so far; would need a real per-resort control (bigger UI change)
  to go further.
