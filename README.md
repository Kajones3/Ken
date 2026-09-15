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

### If you deploy on mock data (no TRAVELPAYOUTS_TOKEN), international prices need one extra step

**Six-resort comparison is the whole product** — a wrong international number
doesn't just look off, it makes the "WDW or Disneyland Paris?" question the
app exists to answer come out wrong. This was caught and fixed 2026-09-15
after a real deploy was showing Tokyo/Shanghai flights around $600–720 when
real fares run $1,000–1,250 (verified against live Google Flights results).

**Root cause**: with no `TRAVELPAYOUTS_TOKEN` set (the README's own
recommended first deploy, so mock pricing "still works fine"), the daily
refresh job fills `flight_prices` — the exact-cache table that always wins
over an estimate — using `MockProvider.flightMonth()`
(`src/providers/mock.ts`). Its international price formula was a simple
distance curve (`245 + dist*0.062` for transatlantic, `330 + dist*0.058` for
transpacific, floor $420) that was never checked against real fares and
landed close to *domestic* trip money instead. Because a real-looking cached
row always beats the `est.`-labelled fallback, this wrong number is what
users saw — not a missing-data problem, a wrong-formula problem, and no
`historical_fares` seeding could fix it while stale rows sat in
`flight_prices` ahead of it.

**Fixed**: the mock formula now targets researched 2026 medians (US→Europe
~$754, US→Asia ~$1,087 — see "How a flight number is arrived at" below) —
`200 + dist*0.124` (Europe, floor $550) and `350 + dist*0.109` (Asia/Pacific,
floor $700). Checked against real routes: ATL→CDG ≈ $677, LAX→CDG ≈ $834,
ATL→NRT ≈ $1,135, IAH→PVG ≈ $1,176 — all within researched range.

**This fix does not retroactively touch rows already cached in production.**
The tiered refresh (see "Decisions worth knowing" below) only touches
near-term dates daily; a date 6+ months out sits in the weekly tier and could
show the old wrong price for up to a week. After deploying this fix, force a
full recache once:

```bash
DATABASE_URL="<your neon connection string>" REFRESH_BACKFILL=true npm run refresh
```

(Same backfill flag as the first-deploy step above — also runnable from the
Actions tab → "Parkfare refresh" → Run workflow → tick backfill, if
`DATABASE_URL` is already set as a repo secret.) This overwrites every cached
international fare with the corrected formula in one pass, rather than
waiting on the cron tiers to rotate through.

**If you get a real `TRAVELPAYOUTS_TOKEN` later**, this whole class of bug
goes away for domestic routes (real per-date fares replace mock ones), but
international routes still need `intl-sweep`/`intl-baseline` (metered, see
below) or `npm run seed-intl` (`src/seedInternational.ts`, free, synthetic —
2,460 rows of the same researched medians used above, tagged `sampled_live`
so no trend multiplier is needed) as the `historical_fares` fallback for any
date the exact-fare cache hasn't reached yet.

**A real token being set now does not mean old mock-era rows are gone.**
`pickProvider()` picks the flights provider once, for the whole run, from
`TRAVELPAYOUTS_TOKEN` — so a deploy that already has a real token uses
`TravelpayoutsProvider` for every route, mock included nowhere. But
Travelpayouts' calendar endpoint is documented above as unreliable for
international routes specifically (strict date/duration filtering discards
most of what it returns), so it can go a long time genuinely failing to
overwrite a stale `flight_prices` row that dates back to before the token was
added — "upsert on success only" means a bad old row just sits there, silent,
until something actually succeeds in replacing it. If international prices
still look wrong after a `REFRESH_BACKFILL` run with a real token configured,
check the run's own log for the specific route: a real 400/429 there (not a
missing token) means Travelpayouts genuinely can't price that route, and the
fix is `seed-intl` or `intl-sweep`, not the mock formula.

### If SerpApi hotel quota runs out, on-property data used to die with it

Found 2026-09-15 from a real refresh log: every resort's hotel refresh
(`shdr`, `hkdl`, `wdw`, `dlr`, `dlp`, `tdr`, every month attempted) came back
`serpapi hotels ... -> 429 { "error": "Your account has run out of
searches." }` — the SerpApi account's real search quota was exhausted.

**Cached hotel prices are still safe to rely on** — refresh only upserts on
success (see "Decisions worth knowing" below), so a failed run never deletes
existing `hotel_rates` rows. But nothing was being refreshed either, for a
reason bigger than the quota itself: `SerpApiHotelProvider.hotelMonth()`
(`src/providers/serpapi.ts`) used `Promise.all([onPropertyMonth(...),
offPropertyMonth(...)])` — on-property Disney hotel estimates need no
network call and always succeed, but bundling them with the real off-property
SerpApi call meant *one* 429 on the off-property half failed the *whole*
call, so on-property data stopped refreshing too, for no reason related to
its own reliability. Fixed: `offPropertyMonth()` failures are now caught and
logged individually, and on-property rows are written regardless — a SerpApi
outage or exhausted quota now degrades to "off-property data goes stale,
on-property keeps refreshing normally" instead of "nothing refreshes at all."

This doesn't fix the underlying quota exhaustion — check your SerpApi
account's plan/usage dashboard for when it resets or whether it needs
upgrading. Off-property hotel prices will keep serving whatever was last
successfully fetched until then.

### On-property hotel rates are a static guess, not live data — recalibrated once, 2026-09-15

`src/providers/serpapi.ts`'s file header claims on-property Disney hotels
are "already reasonably trustworthy" as pure `config.ts` guesses, reasoning
that "Disney doesn't discount transactionally the way a random off-property
chain hotel does." **That reasoning doesn't hold** — real 2026 research
found Tokyo, Shanghai, and Paris on-property rates swing 2–3x by season, the
same as anywhere else. Off-property hotels get a real live SerpApi Google
Hotels search every refresh; on-property never has, purely on that
assumption.

Recalibrated the worst gaps in `config.ts`'s `base` values against real 2026
nightly rates (researched in local currency and converted — see the dated
comments on each resort's `hotels:` array for the actual JPY/CNY/EUR figures
and sources):

- **Tokyo**: Celebration Hotel and Toy Story Hotel were too low; Tokyo
  Disneyland Hotel and MiraCosta were too high. Fixed. MiraCosta and Fantasy
  Springs specifically had wide source disagreement (themed suites vs.
  standard rooms aren't distinguished by this model) — treat those two as a
  rougher estimate than the other three.
- **Shanghai**: both hotels were below the low end of the researched range.
  Fixed.
- **Paris**: Santa Fe, Cheyenne, Sequoia Lodge, and Newport Bay Club were
  all below researched "from" prices. Fixed. Disneyland Hotel (the flagship)
  had no comparably reliable research figure — left as a guess.
- **WDW, Disneyland Anaheim, Hong Kong**: checked against real research and
  already landed close (Animal Kingdom Lodge: $509 config vs. $508
  researched) — left unchanged.

**This is a one-time patch, not a durable fix**, and it will drift the same
way the original numbers did. The durable fix is extending
`SerpApiHotelProvider` to search on-property hotels by name through the same
Google Hotels lookup off-property already uses — real numbers instead of a
number someone typed in once. Deliberately not done here: it multiplies
SerpApi call volume (one more search per on-property hotel per resort per
month) against a quota that's already exhausted (see above) — a real cost
trade-off the owner should decide on, not something to change silently.
Don't add a `dataConfidence` badge for this — `config.test.ts` pins badges
to exactly `["dlp","hkdl","shdr"]` as "a launch decision, not an
implementation detail" for *structural* cost-model gaps (Paris bundles
hotel+ticket, Shanghai bands by height, Hong Kong's age bands are
unverified). Every resort's on-property line shares the same "static guess"
limitation equally — it isn't a gap unique to one resort, so it isn't what
that badge is for.

### A "your rate" hotel override leaked across tiers in the "every category" comparison

Found 2026-09-15 from a real screenshot: a WDW search with a $150/night
nightly-rate override set showed **Value, Moderate, AND Deluxe all at
exactly $150/night** in the detail view's "every category, same 6 nights"
comparison — a Deluxe room at $150/night isn't a real option anywhere at
WDW, which is what made this obviously wrong rather than just imprecise.

Root cause: the "every category" comparison (`hotelAtTier()` in
`public/prototype.html`) fetches `/api/calendar` once per tier to show what
Value/Moderate/Deluxe would each independently cost. But `calendarQuery()`
always attached the full `overrides` object, including any nightly-rate
override — which is a claim about the ONE tier the user actually priced, not
every tier at that resort (see "User overrides are free, per resort" in
CLAUDE.md — they were never meant to be per-tier, but nothing stopped them
leaking into a per-tier comparison). The server has no way to know "only
apply this to the tier I originally set it for" because the query never said
so, so it just applied the same flat nightly rate to all three tier
requests.

Fixed: `calendarQuery()` takes an optional `stripNightly` flag that removes
just the `nightly` override for that resort (keeping any `farePerSeat`
override, which genuinely doesn't vary by hotel tier) before building the
query string; `hotelAtTier()` passes it for every tier except the one
actually being priced. Verified with Playwright against a WDW search with a
$150 override set: before the fix, Value/Moderate/Deluxe all read
$150/night; after, they read $205/$150/$586 — three real, distinct
model-based estimates, with only the tier you actually overrode reflecting
your own number.

### Per-resort "I've already got this sorted" checkboxes — excluding hotel/flights from the total

The numeric "your rate" override above solves a different problem than a
user raised next: sometimes there's no rate to type in at all — the hotel is
free (family, points, a day trip) or flights are already booked separately.
Forcing a $0 override through the numeric field worked but read as a
placeholder/bug, not a deliberate choice.

Added, per resort, alongside the numeric override (not replacing it — the
owner explicitly wants to keep typing hypothetical fares too, e.g. "what if
I fly free to Shanghai on miles" vs. "what if I only pay $500 to Tokyo," to
compare deals across resorts): two checkboxes, "I've already got a room/
flights sorted — don't count it in the total." `ResortOverride` gained
`excludeHotel?: boolean` / `excludeFlights?: boolean` (`src/pricing.ts`).

- `excludeHotel` folds into a `stayForResort` local (`ov.excludeHotel ?
  "none" : params.stay`), reusing the *existing* `stay === "none"` handling
  entirely — zero new hotel-pricing branches. This also disables a dining
  plan and zeroes on-site transport automatically, same as the global "Need
  a hotel? No" toggle already did, and hides the "every category" tier
  comparison for free (it's gated on the same `hotelId==="none"` sentinel).
- `excludeFlights` is a new early-bypass branch, *before* the cache-gap
  check — it deliberately does **not** go through the fare floor (never
  claim less than the cheapest real fare found): that floor guards against
  an unrealistic price *claim*, and excluding a line isn't a price claim at
  all. This also means a trip with a genuine cache gap for that route now
  still prices successfully once flights are excluded, instead of hard-
  failing.
- Defensive precedence (if a request somehow carries both an exclude flag
  and its matching numeric override): the exclude flag always wins, and it
  falls out of branch ordering for free — no extra code needed.

One easy-to-miss correctness trap during implementation: `excludeHotel`
reusing the `hotelId==="none"` sentinel means the frontend's pre-existing
`noHotel` check (already used to hide the tier comparison) also becomes true
the moment the checkbox is checked — including in the one place that must
**not** react to it, the panel-visibility gate that decides whether to show
the hotel control at all. Gating that on `noHotel` would hide the checkbox
(and the only way to uncheck it) the instant it's checked. Fixed with a
separate `hotelWantedGlobally = params.stay !== "none"` check, so only the
*global* toggle hides the control entirely — a per-resort exclude keeps its
checkbox visible and clickable.

12 new tests in `src/pricing.test.ts` cover both flags: zeroing, dining-plan/
promo interaction, precedence when both a flag and its numeric field are set,
the floor-bypass specifically, and that a per-resort exclude never leaks into
another resort's pricing in the same compare. All 174 tests pass.

### Driving mode's wear-and-tear line can dwarf gas — now optional

Real user report, 2026-09-15: a driving-mode breakdown showed $511 in gas
against **$2,822** in "wear and tear" for the same trip — 5.5x the gas cost,
which reads as broken even though the number is technically correct. The
IRS standard mileage rate (`irsMileageRatePerMile()`, `config.ts`) is a
full-cost-of-ownership figure — it bundles depreciation, maintenance and
insurance into one per-mile number, not just gas — so it dwarfs gas on any
long drive, and someone who doesn't mentally allocate their own car's
depreciation to one trip reasonably reads a $2,822 "wear and tear" line as
a mistake.

Decided **not** to drop it by default: this app's own established principle
(see "off-property carries its parking and transfer cost" below) is that an
option shouldn't look artificially cheap by omitting a real cost — the same
reasoning applies here. Instead, added `TripParams.includeWearAndTear`
(`src/pricing.ts`), defaulting to `true` (unset behaves identically to
today), with a form toggle — "Include wear & tear on your car?" — that
appears next to "Rent a car for the drive?" whenever a driving preset is
selected, and is itself hidden when renting (already zero either way, since
a rental's own fee covers it). Turning it off prices gas only; the line
item itself just disappears from the breakdown rather than showing $0.

Server-side (`gettingThereParams()` in `server.ts`): default is inclusion,
so only an explicit `driveWearAndTear=0` in the query string turns it off —
matches the "presence of the flag means true" convention every other
boolean flag in this function already uses, just inverted, since the
default here is `true` rather than `false`.

Also reworded the wear-and-tear line's own hint text in the detail view to
say what the IRS rate actually bundles in and that it can be turned off —
same "don't hide a shaky number, explain it" reasoning as the override
controls and the "why is X cheaper?" explainer elsewhere in this app.

3 new tests in `src/pricing.test.ts`: dropping it lowers the total and
zeroes the driving pick's own field, unset behaves identically to explicit
`true`, and it's a no-op on a rental (already zero regardless). All 187
tests pass.

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
`popular-routes` job bought a genuine round-trip quote for it — or a Plus
user paid to look that exact date up. Shown plain.

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

**A bought fare corrects that route's estimate.** Evidence from the route
itself beats an average measured across other routes, so where real fares
exist for a route and quarter, their median sets the correction instead of the
global trend. Buy one $511 fare on a route the model thought was $382, and
every other date in that quarter moves to $511 — the estimate learns.

Only fares seen **after** the baseline was written count. Without that cutoff
the correction is circular: an international baseline is built *from* sampled
real fares, so measuring those same fares against it always yields 1.0 and
would report "0% adjustment" as though something had been verified.

`routeSamples` says how many real fares the correction rests on, and the UI
shows it — one sample is real evidence but could be a peak date that doesn't
represent its quarter.

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

**A real cached fare can itself be unrepresentative — the median wins when
it's higher.** Decided 2026-09-15, after a real report that even domestic
fares were "vastly underestimated." Root cause: the rows Travelpayouts *does*
pass its strict filter are still, by the endpoint's own nature, a "cheapest
recently found" number rather than a typical one — and until now, `priceTrip`
treated **any** real row as automatically superior to the route's own honest
BTS median, without ever comparing the two. A rock-bottom deal-feed price
could silently beat a far more representative estimate just for being "real."

Fixed: `priceTrip` now always computes the median estimate alongside a real
row (previously only computed when no row existed at all — `flightEstimate()`
is a cheap in-memory lookup, so this costs nothing extra) and shows whichever
is **higher**. A real fare at or above the median still shows plain, with its
carrier and booking link, unchanged from before. A real fare below the median
gets shown as the median instead — honestly labelled `est.`, not passed off
as the real quote it replaced. The farePerSeat override floor is unaffected:
"never claim below the cheapest fare we know of" still means the real row's
price specifically, not the corrected median — your own number just needs to
beat what's actually achievable, not the model's best guess at what's typical.

This pairs with a related, separate fix the same day: `SerpApiFlightProvider.
roundTrip()` (`src/providers/serpapiFlights.ts`) was picking the single
cheapest itinerary out of everything Google Flights returned for a route/
date — often a few dozen options across every airline/time/stop combination —
now picks the **median-priced** itinerary instead. That function backs three
things at once: the nightly domestic trend job, the international sweep, and
the Plus "exact fare" feature people pay to check — so the old min-pick made
even the *paid* lookup unrepresentative. Together, these two fixes are the
direct answer to "I don't want the cheapest price, I want the median, because
the cheapest flight won't be available to everyone."

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

### Estimates are free; the exact fare is Plus

The free plan's flight number is a real estimate — this route's actual median
with the range it sits in, labelled `est.` It costs nothing per user because
it reads a cache someone already paid to fill, and it is unlimited.

A Plus user can additionally ask for the **exact live fare on one specific
date** (`POST /api/exact-fare`, `src/exactFare.ts`). That is the one place in
the app where a user's click spends metered provider money, which is exactly
why it is paywalled: the people who cost money are the people paying.

It could not be a blanket upgrade of every number on the page. Six resorts'
cheapest dates is 6 lookups, but one month's calendar is ~30 and all six
resorts across a year is ~2,190 — one curious session would burn a month's
budget. So it is per-date and on demand, a button on the Flights card.

Four things bound it, checked in this order:

1. **Cache first**, before the quota is even considered. A fare already
   bought for that exact route/date/length and still fresh is returned free
   and does not touch the user's allowance — revisiting a trip is not
   punished. The second person to ask the same question pays nothing.
2. **Per-user daily cap** (`EXACT_FARE_PER_USER_PER_DAY`, default 25).
3. **Site-wide daily cap** (`EXACT_FARE_GLOBAL_PER_DAY`, default 90 — sized
   so the month still fits the plan alongside the two nightly jobs).
4. **Provider budget**, the same hard ceiling every paid job here has.

A failed lookup still counts: the provider bills for a search that finds
nothing, so an unserved route is not a free infinite retry.

The payoff loops back to the free product. A bought fare is written into the
shared cache tagged `serpapi_flights`, so the next re-price uses it as a real
fare and drops the estimate — and it feeds the trend that every free estimate
is built from. **A Plus user's spend improves what free users see.**

Plus is resolved from the session cookie against the database on every
request. A client-supplied "I am Plus" flag would be a way to spend the
owner's money, so it is never trusted — verified against a live server,
including a request that put `"plus": true` in the payload.

### Which airport you can leave from

Free users pick from 19 big metros — the ones the cache is pre-filled for,
since every origin multiplies the nightly and monthly bill. Plus adds 22
smaller airports people actually live near.

That gap is real, not cosmetic: someone in Raleigh is offered Charlotte, three
hours away, and the fare they'd really pay is a different number. Priced
against the same seeded data, CLT→MCO comes out at $387/seat and RDU→MCO at
$350.

A free user who picks a Plus airport is **not** shown an error. The server
prices the nearest free metro by great-circle distance and returns
`originDowngrade`, so the board still works and the page says which airport it
actually used. Enforced in `resolveOrigin()` — the picker in the UI is only
the cosmetic half.

Plus airports are still fully covered by BTS (the survey is one file spanning
every US airport, so `originIatas()` includes both lists) — they just aren't
pre-cached, and a Plus user can pay to check any specific date exactly.

### Pinning real travel dates

Free searches scan a whole month for the cheapest arrival. Plus can set the
actual departure and return dates — "March 18–24" rather than "sometime in
March" — and the trip length is derived from the gap rather than the separate
nights picker. Uses the `date` parameter `/api/compare` already had.

## Saying how confident we are, per resort

Two things in the app are labelled rather than hidden, on the same reasoning:
a user who sees a number they cannot explain concludes the whole app is
wrong and leaves, so explain it instead.

- **Flights** carry an `est.` chip and a low–high range whenever the number
  is an estimate rather than a real fare (see above).
- **Resorts** carry a `dataConfidence` badge when the way we break a trip
  into lines does not match how that resort actually sells one — a gap the
  general "tickets are approximate" disclaimer does not cover. Three do
  today:
  - **Disneyland Paris** — Disney sells hotel and tickets as one bundle by
    default; we price them as two separate lines (a room-only basis, which
    isn't even bookable on Disney's own site). Deliberately not "fixed" in
    the math: package rates aren't published, so inventing one would be less
    honest than a clearly-labelled assumption.
  - **Shanghai** — children are priced by height (1.0–1.4m), not age, which
    the model does not represent at all.
  - **Hong Kong** — age bands have never been checked against an official
    source.

All six resorts still price in full — badging is not a soft launch. The
six-resort comparison is the product, so the answer to a weak line is to say
so plainly, not to drop a resort from the board.

`dataConfidence` is hand-maintained in `config.ts`, same pattern as
`goodToKnow`. **Remove the entry when the underlying gap is actually
fixed** — a badge that outlives its reason trains people to ignore badges.
`config.test.ts` pins which resorts carry one, so adding or removing a badge
has to be deliberate.

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
