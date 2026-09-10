# Parkfare backend

Prices a Disney trip across all six global resorts, out of a cache you own.

**The one rule this codebase exists to enforce: users never talk to a travel API.**
A scheduled job does, once each morning, and everything else reads Postgres. That
is what keeps cost tied to how many *routes* you cover rather than how many people
use the site.

## Run it right now, with no accounts

```bash
npm install
npm run smoke
```

`smoke` applies the schema to a throwaway in-memory Postgres, runs a full refresh
through the mock provider, prices all six resorts out of the cache, saves a trip
and runs the alert job. No API key, no database, no network. Expect something like:

```
1. refresh (mock provider, 4 origins, all 6 resorts, 1 month)
   78 provider calls -> 3,968 rows, 0 errors, 2346ms
2. price all six resorts from the cache
   loaded + priced 25 dates x 6 resorts in 62ms

   1. Walt Disney World        $ 6,076  flights $  557  tickets $ 1714  hotel $ 1624  food $ 2181
   ...
3. save a trip and run the alert job
[email:console] to=you@example.com subject="Parkfare: your trip just got $495 cheaper"
Walt Disney World fell to $6311 for arrival 2027-03-04
...
   1 trip checked, 1 alert(s), 1 emailed, 0 provider calls
   -> [total_drop] Walt Disney World fell to $6311 for arrival 2027-03-04 (7.3% better)
```

That last block is the product: the alert job re-priced a saved trip, decided it
crossed the threshold, and sent the email — all **zero** provider calls. With no
`RESEND_API_KEY` set it prints instead of sending, so this runs with no account.

```bash
npm test         # 82 tests, no database needed
npm run typecheck
```

## Then, for real

```bash
cp .env.example .env       # set DATABASE_URL; leave the token unset to stay on mock data
npm run migrate
npm run refresh
npm run seed-promos        # a few illustrative example promos, optional
npm start                  # API on :8080
```

To let someone in as Plus (no payment processor exists yet — this is how the owner
comps friends, and how you'd grant your own account for testing):

```bash
npm run grant-plus -- friend@example.com 90    # Plus for 90 days
```

To see whether the cache actually holds real fares for the months people
search — which the refresh job's own "N calls, M rows" summary cannot tell
you — run the coverage report:

```bash
COVERAGE_ORIGIN=ATL npm run coverage    # real fare / estimate / gap, month by month
```

**If you're on the default embedded PGlite database (no `DATABASE_URL` set), stop
`npm start` before running any script against the same `.pgdata` directory** —
`migrate`, `refresh`, `grant-plus`, `seed-promos`, all of them. PGlite doesn't support
two processes sharing one data directory; at best the running server never sees the
write, at worst the store corrupts. A real Postgres doesn't have this limitation, so
none of this applies once you're pointed at Neon below.

## Deploy for free, so friends can actually sign in

This is the whole app, live, with real accounts — $0/month. Three free
services, none needing a credit card, checked against their current (2026)
terms rather than assumed:

- **[Neon](https://neon.tech)** — free Postgres, no card, never expires,
  0.5 GB storage. This is `DATABASE_URL`, replacing PGlite.
- **[Render](https://render.com)** — free web service for the API itself.
  512 MB RAM, 750 free hours/month. The one real trade-off: it spins down
  after 15 minutes with no traffic and takes about a minute to wake back up
  on the next visit — fine for a friends demo, not for anything you'd want
  instant. (Render's *own* free Postgres expires after 30 days, which is
  why Neon is doing the database instead.)
- **GitHub Actions**, already part of this repo — runs the refresh, alert,
  and news-digest jobs on a schedule, for free, instead of needing a
  separate always-on cron worker.

Steps:

1. **Create a Neon project** at neon.tech (email sign-up, no card). Copy
   the connection string it gives you — it already includes
   `?sslmode=require`, which Postgres needs for a remote connection. That
   string is your `DATABASE_URL`.
2. **Deploy to Render**: New → Blueprint → point it at this repo/branch.
   Render reads `render.yaml` (already in this repo) and creates the web
   service automatically. When it asks for environment variables, paste
   your Neon connection string in as `DATABASE_URL`. Leave
   `TRAVELPAYOUTS_TOKEN`/`RESEND_API_KEY` blank for now — mock pricing data
   and console-logged alert emails still work fine over a real deploy.
   First deploy runs `npm run migrate` automatically (see `render.yaml`),
   so the schema is ready before the app starts.
3. **Add the same `DATABASE_URL` as a GitHub Actions secret**: this repo's
   Settings → Secrets and variables → Actions → New repository secret. The
   three workflows in `.github/workflows/` (`refresh.yml`, `alerts.yml`,
   `news-digest.yml`) need it to populate the *same* cache Render's app
   reads from — same cron schedule this project has always documented
   (`0 4 * * *` refresh, `20 4 * * *` alerts, `40 4 * * *` news digest, all
   UTC). The news digest also needs an `OWNER_EMAIL` secret if you want it
   to actually send — it's a private digest to you, not something friends see.
4. **Run the refresh workflow once by hand, with backfill on** (Actions tab
   → "Parkfare refresh" → Run workflow → tick the **backfill** checkbox
   → Run workflow). The tiered refresh (see "Decisions worth knowing"
   below) is built to spread the far-out months across a week of daily
   cron runs, which is right for a warm cache but means a brand-new,
   empty database only gets the *next ~60 days* on day one — dates further
   out (like a trip six months from now) would show "no cached price"
   until the weekly tier had rotated all the way through. Backfill fills
   the whole year in one run instead. You only need this once; the plain
   scheduled runs after that keep it fresh.
5. **Grant friends Plus** the same way as local dev, just pointed at Neon
   instead of PGlite — and unlike PGlite, there's no "stop the server
   first" step, since real Postgres allows more than one process at a time:
   ```bash
   DATABASE_URL="<your neon connection string>" npm run grant-plus -- friend@example.com 90
   ```

Nothing here needs Stripe, a domain, or a paid tier — everyone signs in
with just an email (see "Accounts have no password" in What is not done
below before treating this as more than a friends demo).

## Layout

| Path | What it is |
|---|---|
| `db/schema.sql` | Thirteen tables. Safe to re-run. |
| `src/config.ts` | The six resorts: age bands, ticket rules (including Park Hopper differentials), food rates, hotels, transport, the IRS mileage rate, and the flat rental-car guess. |
| `src/gettingThere.ts` | Pure resolver: turns one "Getting there" preset (fly / fly-with-miles / drive-to-WDW / drive-to-Disneyland / drive-domestic) into a per-resort transport mode, so one six-resort comparison can drive to some resorts and fly to others. |
| `src/pricing.ts` | **The single source of truth for what a trip costs.** Pure, synchronous, no I/O. |
| `src/book.ts` | Loads one slice of cache into memory so pricing can stay synchronous. |
| `src/providers/` | `mock.ts` works today. `travelpayouts.ts` needs a token but **cannot price a specific date** — see "How a flight number is arrived at" below. `serpapiFlights.ts` is the real per-date fare source. |
| `src/routeDemand.ts` | What people search (route + month, never who). Decides where the nightly paid fare lookups go. |
| `src/jobs/popularRoutes.ts` | Nightly, metered. Buys real fares for the busiest searched routes, bounded three ways. |
| `src/jobs/intlSweep.ts` | Monthly, metered. The only way international routes get priced — see below. Sharded one airport per job. |
| `src/jobs/intlBaseline.ts` | Turns bought international fares into a per-quarter baseline, so one bought date covers the whole quarter. |
| `src/jobs/coverage.ts` | Read-only: for a departure city, is each month a real fare, an estimate, or a gap? |
| `src/geo/` | Geocoding + IP lookup for the driving-mode "Departing from" search. `mock.ts` works today; `nominatim.ts`/`ipapi.ts` are free and keyless but off by default (`GEOCODE_LIVE=true` to enable) — the one place the app calls a live provider on a user's own request instead of a pre-refreshed cache. |
| `src/jobs/refresh.ts` | The morning refresh, tiered by how far out the date is. Also seeds the daily gas price. |
| `src/jobs/alerts.ts` | Re-prices saved trips from the cache and sends the drop, gas-price, and new-promo "deal found" emails. Never calls a provider. |
| `src/jobs/newsDigest.ts` | Private, owner-only: checks a few Disney-news RSS feeds and emails what's new. |
| `src/gas/` | `mock.ts` works today; `eia.ts` needs a free EIA key. Same interface as `src/email/`/`src/providers/`. |
| `src/email/` | `console.ts` prints instead of sending, works today; `resend.ts` needs an API key. Same interface. |
| `src/auth.ts` | Email-only sign-in, session cookies, the one real `isPlus()` entitlement check. |
| `src/grantPlus.ts` | `npm run grant-plus` — the one way to grant Plus (comping a friend, or your own testing). |
| `src/seedPromos.ts` | A few illustrative example promo rows. Not wired into the daily refresh — promos are sparse, hand-curated content. |
| `src/server.ts` | The API. `node:http` and nothing else, also serves `public/prototype.html`. |

### Why pricing.ts is shared

It runs in three places: the API that shows someone a number, the alert job that
decides whether that number dropped, and the tests. If the alert job had its own
copy of this logic, the two would drift, and you would eventually email a customer
about a price your own site never showed them. One module, no drift.

### How a flight number is arrived at

Every flight figure in the app is one of two things, and the UI always says
which:

**A real fare.** Someone searched that route recently, so the nightly
`popular-routes` job bought a genuine round-trip quote for it. Shown plain.

**An estimate.** Nobody has searched that route, so there is nothing bought
for it. Instead: take what people *actually paid* on that exact route in the
same quarter (the median of real US DOT DB1B itinerary data — free, no key),
and move it by the percentage that the routes we *do* buy for real have
shifted since their own baselines. Shown with an `est.` chip, a
low–high range, and its basis quarter.

So an unsearched Denver→Orlando trip is priced from Denver→Orlando's own
history, moved by a currently-measured market trend — not from another
route's number and not from an invented curve.

**International routes work differently, because they have to.** BTS is a US
*domestic* survey — grepping a whole real DB1B quarterly file (8.5 million
rows) for `CDG` returns nothing at all. So Paris, Tokyo, Shanghai and Hong
Kong have no free baseline to fall back on, and without help every
international date would read "no cached price".

Instead, `intl-sweep` runs monthly and samples real fares across all 95
international routes, then `intlBaseline` turns them into that route's
baseline for the quarter. One bought date anchors the whole quarter, exactly
as DB1B does for domestic routes. Cost: 19 origins x 5 airports x 12 travel
months x 1 date = **1,140 metered lookups a month**.

The trap to know about: a baseline built from fares sampled *this month* is
already at today's prices. The trend multiplier exists to carry an **old**
survey forward, so applying it to a fresh sample would add that percentage a
second time. Live-sampled baselines are tagged `sampled_live`, get no trend,
and are excluded from computing it (measuring bought fares against a baseline
built from those same fares gives a ratio of 1.0 and drags the real
multiplier toward "no change"). See `TREND_APPLIES_TO` in `book.ts`.

Beauvais (BVA) and Shanghai Hongqiao (SHA) were dropped as arrival airports:
neither has US service, so every lookup returned nothing while still costing
a metered search — 29% of the international bill for no data.

Three decisions inside that are worth not undoing:

- **Median, not mean.** A mean is dragged down by deep-discount and partial
  itineraries nobody pricing a family trip is quoted. Low/High are the
  route's own p25/p75, a real observed spread rather than a percentage
  invented around the midpoint.
- **Same quarter, not the newest one.** Fares are seasonal. Pricing a March
  trip off a July baseline reports summer as a price rise and then applies
  that "rise" everywhere. Where only an off-season baseline exists it is
  still used, but flagged, and the UI says so.
- **The trend only measures sources we trust.** It moves every estimated
  route in the app, so it is computed from real per-date fares only.
  Travelpayouts' calendar rows are excluded (see below).

**Travelpayouts' `/v1/prices/calendar` cannot price a specific date.** Asked
for ATL→MCO departing 2027-03 with a 7-night trip, the live key returns six
dates in Sep/Oct 2026, destination `ORL` (the city, not the MCO airport
requested), durations of 0–3 nights, and $36–$200 prices expiring in an hour.
It is a "cheapest fares our users recently found" feed, not a fare calendar.
The adapter's strict filter correctly discards nearly all of it — which is
why the months people actually search were coming back empty and falling
through to estimates. Don't "fix" this by loosening the filter; that just
stores a 2-night fare under a 7-night label.

### Why nothing throws

`priceTrip` returns `{ ok: false, reason }` rather than throwing or returning
`NaN`. A gap in the cache shows as "no cached fare for ATL-MCO on 2027-03-04",
never as `$NaN` on a page or a bogus alert. `cheapestIn` skips unpriceable dates
instead of failing the whole search.

## Decisions worth knowing before you change anything

**Trip lengths are bucketed** to 4, 7 and 11 nights. Caching every exact length
would triple the row count for accuracy nobody would notice. `bucketFor()` picks
the nearest.

**Refresh is tiered.** Dates inside 60 days refresh daily, 61–180 every third day,
beyond that weekly — about 1,710 calls a day for roughly 131,000 price points.
A departure eleven months out does not move enough to justify a daily fetch.

**Upsert on success only.** A failed run never deletes rows. Yesterday's price is
worth far more than no price.

**Overrides have a floor.** A user can say they expect to pay more than the cheapest
fare found, never less. `priceTrip` clamps it; there is a test.

**A nightly rate the user sets does not flex with season.** A rate you found is a
rate you found.

**Alerts have two rails.** A per-user daily cap, and anomaly suppression — if a
large share of trips move by a large amount in one run, that is a data error, not
a sale, and nothing is sent.

**A failed email send never loses the alert.** `price_alerts` is inserted *before*
the send is attempted; a successful send stamps `notified_at`, a failed one leaves
it null. The next run of `runAlerts` retries every row still sitting at
`notified_at is null` before it looks for anything new — so an email outage delays
an alert, it doesn't drop it.

**Plus gating happens server-side.** `compare()`, `calendar()` and `overridesFrom()`
all resolve the caller's session from the cookie and decide what to honor from the
query string — a non-Plus request never gets promo effects, whatever it asks for.
Saved trips and custom planning expenses are gated the same way, directly on the
`/api/trips*` routes. The UI hiding those controls for a free user is only the
cosmetic half; never trust a client-supplied "am I Plus" flag.

**A curated promo's effect is looked up server-side, never trusted from the client
beyond its id.** A personal promo's value *is* client-supplied — that's fine, it's
the user's own unverified claim about their own price, and it never affects anyone
else's number. Composition order, in case you touch this: a curated room discount is
skipped if the user has typed their own nightly rate (a guess shouldn't second-guess
a rate they already found); a personal discount always applies, even on top of that
rate, because it's their own claim; `flat_off_total` clamps the trip at $0.

## What is not done

- **`TravelpayoutsProvider.hotelMonth` throws.** Flights are wired to the documented
  calendar endpoint; hotels need whichever Hotellook endpoint you get approved for.
  It throws loudly rather than returning nothing, so a half-configured deployment
  fails at the refresh job instead of quietly showing users empty results.
- **Ticket prices are seeded from a placeholder curve.** No public API exists at any
  of the six resorts. `seedTickets()` fills the table so the system runs; replace it
  with rows you maintain against each resort's published calendar, and alarm on any
  resort whose rows go stale. When Disney's dynamic ticket pricing lands, this table
  needs the same tiered refresh as flights. The `base` constants were recalibrated
  against real 2026 published pricing after an owner-reported bug (see CLAUDE.md), but
  it's still a coarse two-parameter curve, not real per-date accuracy. Park Hopper's
  differentials are similarly a flat guess — researched for WDW/Disneyland, unresearched
  for Tokyo/Paris.
- **Travelpayouts flights are effectively superseded.** Verified against the live key
  (2026-09-09): the calendar endpoint cannot be asked for a specific date, so almost
  everything it returns is discarded. It still runs, and its rows are still tagged
  `travelpayouts` and excluded from the trend. Deciding whether to switch it off
  entirely is a cost question, not a correctness one — it is free, and it occasionally
  lands a usable row.
- **`TRAVELPAYOUTS_MARKER` is unset in production**, so affiliate deep links carry an
  empty `marker=` and any booking through them earns no commission. Set it in the
  Render dashboard and as a GitHub Actions secret. This is a revenue leak, not a
  pricing bug — worth doing before sharing the site with anyone.
- **SerpApi Google Flights is metered per lookup.** `popular-routes` is the only job
  that spends. Defaults to at most 12 routes x 3 dates = 36 lookups a night, with a
  hard per-run ceiling (`SERPAPI_FLIGHTS_BUDGET`). Raising coverage means raising the
  bill — check the plan's monthly search allowance before increasing any of them.
- **Verify the Resend request shape** against current docs before relying on it — it
  was written to the documented shape (a single `POST /emails` call), not run against
  a live account. `ALERT_FROM_EMAIL` needs a domain verified in Resend before it will
  send to anyone but the account owner.
- **Accounts have no password or email verification.** Signing in is just typing an
  email. Fine for a friends demo where the owner grants Plus by hand; needs a real
  verification step (e.g. a one-time link through the existing `EmailSender`
  interface) before a public launch.
- **Promo data has no admin UI.** Hand-maintained directly in the database, same as
  `ticket_prices` — and just as easy to let go stale silently; no alarm-on-staleness
  exists yet.
- **Nominatim/ip-api (`src/geo/`) haven't been run against live traffic** from this
  environment (proxied/restricted network) — same caveat as every other real provider
  here. `GEOCODE_LIVE` is unset by default, so driving-mode city search runs on the
  mock providers until you turn it on.
- **No 10-mile (or any) off-property hotel distance filter.** `HotelDef` has no
  `distanceMiles`/`lat`/`lon`, only a free-text `descriptor` — deliberately deferred
  in favor of the simpler "Need a hotel?" toggle.
- **A day-by-day trip planner is not built** (itinerary, checklist, dining tracker,
  budget, per-day notes, special-event floor pricing) — confirmed scope, deliberately
  deferred to its own follow-up.
- **`CAR_RENTAL.dailyRateUsd` is one flat national-average guess, not a per-city rate.**
  Rental car pricing (and the real IRS wear-and-tear rate) are wired into `pricing.ts`
  and the "Getting there" trip-form presets, but the rental number itself is a single
  hand-picked constant — a real per-city rate (ideally from a real provider, e.g. a
  Travelpayouts/DiscoverCars adapter) is still future work.
- **"Getting there" is three fixed drive presets, not a fully general per-resort
  picker.** You can drive to WDW only, Disneyland only, or both domestic resorts
  (flying everywhere else in the same comparison) — there's no way to pick a mode for
  each resort independently beyond that grouping.

## Currency

Prices are stored in USD. Local-currency display is a presentation concern; a live
FX feed belongs in front of the UI, not in the cache.
