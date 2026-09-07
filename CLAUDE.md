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
| Backend (`src/`, `db/`) | **Working.** 36 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline — refresh, pricing, a saved trip, and now a sent (console) alert email — with no accounts or network. |
| Frontend (`public/prototype.html`) | **Wired to the real API.** Every price on the page comes from `/api/compare` and `/api/calendar` — no in-browser pricing model left. `src/server.ts` now also serves the prototype itself at `/`, so `npm start` + open `http://localhost:PORT/` is the whole dev loop, same origin, no CORS. |
| Live provider data | Not connected. Mock provider only, so the real numbers are cache-real but not yet market-real. |
| Alert emails | **Wired.** `runAlerts` sends through `src/email/` — console by default (no account), Resend if `RESEND_API_KEY` is set. |
| Accounts | **Real, minimal.** Email-only sign-in (no password), a real `sessions` table, real `plus_until`-based entitlement. The owner comps Plus via `npm run grant-plus -- email days` — no payment processor yet. |
| Airport transport, promos | **Wired, Plus-only.** Parking/rideshare/transit cost and curated + personal discounts are real cost lines in `pricing.ts`, gated server-side. |
| Payments | Not built. Stripe is stubbed in the prototype. |
| Deployment | **Ready, $0/month.** `render.yaml` + Neon (free Postgres) + two GitHub Actions cron workflows (`refresh`, `alerts`). Owner still has to click through the actual Neon/Render sign-ups by hand — see README.md's "Deploy for free" section — but nothing else is missing. |

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

## NOT verified — check before relying on these

- **Visa/entry notes in `goodToKnow`** (Japan, mainland China, Hong Kong) were checked via
  web search at write time, not a primary government source — and visa policy changes
  over time. Re-check before relying on the specific numbers (e.g. "240-hour transit",
  "90 days visa-free") for anything real; the text is deliberately hedged ("check current
  requirements for your passport") rather than stated as a guarantee.
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
- **All 18 origin airports' parking/rideshare/transit costs** (`AIRPORT_TRANSPORT_GUESSES`
  in `config.ts`) are rough placeholder guesses for the demo, not checked against current
  rates. Refine per-airport before relying on them for anything real.
- **The three example promo rows** (`seedPromos.ts`) are illustrative, not real offers —
  replace with actual, dated promotions before this means anything to a user.

---

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
  just in the UI.** A non-Plus request never gets airport-transport pricing or promo
  effects even if the query string asks for them — hiding the control in
  `prototype.html` is only the cosmetic half. Never trust a client-supplied
  `isPlus`/`plus` flag; always resolve it from the session cookie against the database.
- A curated promo's *effect* (`effectKind`/`effectValue`) is always looked up
  server-side from `promosFor()` — only its `id` is ever taken from the client. A
  `personalPromo`'s value/kind *are* client-supplied, and that's fine: it's the user's
  own unverified claim about their own price, never shared with anyone else.

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
   `.github/workflows/{refresh,alerts}.yml` (free scheduled cron via GitHub
   Actions) + Neon (free Postgres) for `DATABASE_URL`. Steps for the owner
   to actually go live are in README.md's "Deploy for free" section — signing
   up for Neon/Render is a human step, not something done from inside this repo.

Then: a day-by-day trip planner (itinerary, checklist, dining tracker, budget,
per-day notes, special-event floor pricing — deliberately deferred, see above),
Travelpayouts token, hotel endpoint approval, a real ticket-price table, Stripe,
Resend domain verification, and a "prices as of ..." line in the UI.

## Known gaps in the code

- `TravelpayoutsProvider.hotelMonth` **throws deliberately** — flights are wired, hotels
  need whichever Hotellook endpoint you get approved for. It fails loudly so a
  half-configured deploy breaks at the refresh job instead of quietly showing users nothing.
- `seedTickets()` fills `ticket_prices` from a placeholder curve. Replace with maintained
  rows and **alarm on any resort whose rows are >30 days old** — nothing fails loudly here.
- `ResendEmailSender` needs a domain verified in Resend, and its request shape hasn't
  been run against a live account. Until then, leave `RESEND_API_KEY` unset — the
  console sender prints every alert instead, so the job still runs end to end.
- Shanghai height-based ticket banding is not modelled.
- **Accounts have no password and no email verification.** Anyone who knows a friend's
  email can sign in as them. Correct trade-off for a friends demo where the owner is
  comping accounts by hand; needs a real verification step (e.g. a one-time emailed
  link through the existing `EmailSender` interface) before any public launch.
- **No admin UI for `airport_transport`, `promos`, or `goodToKnow`.** All three are
  hand-maintained directly in code/database (`goodToKnow` lives in `config.ts`, right on
  each `Resort`) — same pattern as `ticket_prices`, and just as easy to let go stale
  silently. No alarm-on-staleness exists for any of them yet. `goodToKnow` is the one
  most worth re-checking periodically: it currently holds visa/entry information, which
  changes over time and carries real consequences if wrong.
- **The promo effect vocabulary is deliberately small** (`room_pct_off`,
  `room_flat_off`, `free_dining`, `ticket_pct_off`, `flat_off_total`) — enough for the
  discounts discussed, but a genuinely unusual promo (e.g. a free park-hopper upgrade)
  has nowhere to go yet.
- **The day-by-day trip planner is not built** — itinerary, checklist, dining tracker,
  budget breakdown, per-day notes, and special hard-ticket-event floor pricing (like
  Mickey's Not So Scary) are confirmed, wanted scope, deliberately deferred to its own
  follow-up plan once this foundation has been used.
