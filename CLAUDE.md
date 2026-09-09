# Parkfare — project context

Compares the **total cost of a Disney trip across all six global resorts at once**, and
tells you *when* to go. Walt Disney World, Disneyland Resort, Disneyland Paris, Tokyo
Disney Resort, Shanghai Disney Resort, Hong Kong Disneyland.

Nobody else prices "should we do Orlando or Tokyo this spring?" side by side. That
comparison is the product; everything else supports it.

Owner is non-technical-to-semi-technical. Explain trade-offs in plain language and
say when something is a guess.

---

## Current state

| Piece | State |
|---|---|
| Backend (`src/`, `db/`) | **Working.** 82 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline — refresh, pricing, a saved trip, and now a sent (console) alert email — with no accounts or network. |
| Multiple arrival airports | **Wired, free.** Five of six resorts (all but Hong Kong) have alternates (`altArrivalAirports` in `config.ts` — Tampa/WDW, LAX/Disneyland, Beauvais/DLP, Haneda/Tokyo, Hongqiao/Shanghai). Refresh fetches flights to each; a resort's detail view picks among only its own airports, never a bare code trusted from elsewhere. |
| "Getting there" — mixed drive/fly, rental car, wear-and-tear | **Wired, free.** Five presets on the trip form (`src/gettingThere.ts`'s `resortTransportMode()`): Flying to all, Flying to all with miles (0-100% off the cash fare, no floor), Driving to WDW only, Driving to Disneyland only, Driving domestically (both) — each drive preset flies every other resort in the *same* six-resort comparison, so "drive to WDW, fly to Disneyland" is one board, not two searches. Driving cost now includes wear-and-tear at the real IRS standard mileage rate (`irsMileageRatePerMile()` in `config.ts`, month-only lookup). A rental car is a free, optional add-on either for the drive (replaces wear-and-tear — you don't wear out a car you don't own) or at the destination after flying (`CAR_RENTAL.dailyRateUsd`, one flat national guess, always its own cost line). Plus-only add-on unchanged: an alert when the cached gas price has moved since a driving trip was saved. |
| Park Hopper | **Wired, free.** A flat per-ticket add-on at the four multi-park resorts (WDW, Disneyland, Tokyo, Paris); silently has no effect at Hong Kong or Shanghai, which each have one park. WDW/Disneyland's differentials are researched against real 2026 pricing; Tokyo/Paris are unresearched guesses, flagged weaker-confidence below. |
| "Need a hotel?" | **Wired, free.** A real `stay: "none"` state (not just "off property") prices $0 hotel/transport with no pick, for day-trippers or anyone staying with family/friends. |
| Driving-mode city search | **Wired, free — the one live-provider exception.** `src/geo/` (Nominatim geocoding + ip-api.com IP lookup, both free/keyless, mock by default, `GEOCODE_LIVE=true` to go live) backs a real "Departing from" search box and a "use my location" button for driving mode. See the architecture-invariants note below on why this is a deliberate exception to "users never call a provider API." |
| Disney news digest | **Wired, owner-only.** `npm run news-digest` reads a few RSS feeds (`NEWS_FEEDS` in `config.ts`) and emails whatever's new — never shown to end users automatically; the owner reviews and hand-adds anything worth surfacing to a resort's `goodToKnow`. |
| Frontend (`public/prototype.html`) | **Wired to the real API.** Every price on the page comes from `/api/compare` and `/api/calendar` — no in-browser pricing model left. `src/server.ts` now also serves the prototype itself at `/`, so `npm start` + open `http://localhost:PORT/` is the whole dev loop, same origin, no CORS. |
| Live provider data | **Partly connected.** Travelpayouts + SerpApi keys are set in production. Flights now come from real per-date SerpApi Google Flights lookups on searched routes, and from real BTS DB1B medians moved by a measured trend everywhere else — see "How a flight number is arrived at" in README.md. |
| Flight pricing model | **Reworked (2026-09-09).** Median-not-mean, same-quarter-not-newest, demand-driven real lookups, honest `est.` labelling on the board itself. See the decision note below. |
| Alert emails | **Wired.** `runAlerts` sends through `src/email/` — console by default (no account), Resend if `RESEND_API_KEY` is set. Now also fires a `new_promo` "we found a deal" alert. |
| Accounts | **Real, minimal.** Email-only sign-in (no password), a real `sessions` table, real `plus_until`-based entitlement. The owner comps Plus via `npm run grant-plus -- email days` — no payment processor yet. |
| Promos, custom expenses | **Wired, Plus-only.** Curated + personal discounts are real cost lines in `pricing.ts`, gated server-side. `custom_expenses` lets a Plus user attach free-form planning-expense line items (VIP tours, PhotoPass, anything not modeled) to a saved trip — this, not airport ground-transport pricing (built earlier, since removed), is what "extra planning of expenses" turned out to mean once the owner used the app: monitoring, saved trips, deal/gas alerts, and room for costs the model can't guess at. |
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
- **2026 IRS standard mileage rate**: $0.725/mile (Jan–Jun), $0.76/mile (Jul–Dec) — now
  wired into every driving trip's `wearAndTearUsd` line via `irsMileageRatePerMile()`
  in `config.ts` (month-only lookup, same "ignore the year" convention `seasonality.ts`
  already uses). Needs a real annual refresh — the IRS sets a new rate each December.
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

Then: the 10-mile off-property hotel radius filter (needs a `distanceMiles` field
on `HotelDef`, none exists today), a real per-city rental-car rate (a
Travelpayouts/DiscoverCars adapter is the researched building block, see "NOT
verified" above), a day-by-day trip planner (itinerary, checklist, dining tracker,
budget, per-day notes, special-event floor pricing — deliberately deferred, see
above), Travelpayouts token, hotel endpoint approval, a real ticket-price table,
Stripe, Resend domain verification, and a "prices as of ..." line in the UI.

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
- **The trip form's "Arriving" field is still a month picker, not a real date.** Reordered
  in this round per the owner's spec, but "Arriving Date" was interpreted as a relabel of
  the existing control, not a scope change — flag if a real single-date picker is wanted.
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
- **Accounts have no password and no email verification.** Anyone who knows a friend's
  email can sign in as them. Correct trade-off for a friends demo where the owner is
  comping accounts by hand; needs a real verification step (e.g. a one-time emailed
  link through the existing `EmailSender` interface) before any public launch.
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
