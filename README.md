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

Nothing here needs Stripe or a paid tier. A domain is optional but it is
what lets you email anyone other than yourself — see the next section.

### Environment variables, and where each one goes

Three places read configuration, and they are not interchangeable. **Render**
runs the website, so it needs everything the site does at request time.
**GitHub Actions secrets** are what the nightly jobs read — the website's
settings are invisible to them. Some values belong in both.

| Variable | Render | Actions | What breaks without it |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | Everything. Both write to the same Neon database. |
| `RESEND_API_KEY` | yes | yes | No email sends anywhere; the console sender prints to a log. |
| `ALERT_FROM_EMAIL` | yes | yes | Sending throws by design, naming this variable. |
| `OWNER_EMAIL` | — | yes | The digests and your job list reach nobody. |
| `PUBLIC_BASE_URL` | yes | — | Confirmation links come out relative, so they are dead inside an email. |
| `REQUIRE_VERIFIED_EMAIL` | optional | — | Nothing — leave it unset until a link has genuinely arrived. |
| `TRAVELPAYOUTS_TOKEN`, `SERPAPI_KEY` | optional | yes | The nightly jobs buy the real prices, so Actions is where these matter. |

On **Render**: your service → **Environment** in the left sidebar → **Add
Environment Variable** for each, then **Save Changes**. Saving triggers a
redeploy, which also re-runs `npm run migrate`.

On **GitHub**: repo → **Settings → Secrets and variables → Actions → New
repository secret**.

### Using your own domain

Two separate jobs that both need DNS records, and they are independent —
do either, or both, in any order.

**To email anyone but yourself**, verify the domain in Resend. A brand-new
Resend account can only send FROM `onboarding@resend.dev` and only TO the
address you signed up with, which is fine for the owner-only digests and
useless for a friend's price alert.

1. Resend → **Domains → Add Domain** → enter your domain.
2. Resend generates DNS records for *your* domain — a DKIM `TXT`, an `MX`
   and `TXT` pair for the return path, usually on a `send.` subdomain. Copy
   the values it shows you; they are account-specific, so do not copy them
   from any guide, including this one.
3. Add those records wherever the domain's DNS lives (the registrar, or
   Cloudflare, or whoever you point the nameservers at).
4. Back in Resend, **Verify**. DNS usually settles in minutes and can take
   longer.
5. Then set `ALERT_FROM_EMAIL` to an address on that domain — it does not
   need a real mailbox behind it, because nothing here reads replies.

**To serve the site from your domain** rather than `*.onrender.com`:

1. Render → your service → **Settings → Custom Domains → Add Custom Domain**.
2. Render shows the record to create — a `CNAME` for a subdomain like
   `www`, or an `A` record if you are pointing the bare domain at it.
3. Add it at your DNS provider. Render issues the TLS certificate itself
   once it resolves.
4. Update **`PUBLIC_BASE_URL`** to the new address, or confirmation links
   will keep pointing at the old one.

Before treating any of this as more than a friends demo, read "Accounts"
in What is not done below.

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

### The city-search cache was passing the wrong case to the provider

Real report: typing "Raleigh" into the driving-mode "Departing from" box
returned a single suggestion labelled plain lowercase `raleigh`, no state or
country — exactly what `MockGeocodeProvider` looks like (it echoes its
input back as the label), not what a real Nominatim result looks like (a
full `display_name` like "Raleigh, Wake County, North Carolina, United
States").

Root cause, independent of which provider is active: `cachedGeocode()`
(`src/geo/cache.ts`) normalizes the query to a lowercase cache key —
correct for the cache lookup itself, so "Raleigh" and "raleigh" share one
row — but was then passing that *lowercased key* to `provider.search()`
instead of what was actually typed. Nominatim's own search is
case-insensitive so a live lookup would still resolve correctly, but its
label came from `display_name` regardless, and the mock's echoed label
came back permanently lowercase either way — this is a real bug independent
of whether `GEOCODE_LIVE` is set. Fixed: the provider now receives the
original trimmed (but not lowercased) query; only the cache's own
lookup/storage key is normalized. New test in `src/geo/cache.test.ts` pins
this — a fresh, uncached "Raleigh, NC" query reaches the provider exactly
as typed.

**Separately worth checking**: the lowercase, no-state result in that report
is also the exact signature of the *mock* geocoder being active rather than
real Nominatim — if `GEOCODE_LIVE=true` was set in Render's environment
variables but the result still looks like this after the fix above and a
redeploy, confirm the variable actually saved and the service redeployed
with it, since a driving-mode search still silently falls back to the mock
with no error if it's unset.

**Update, same day, `GEOCODE_LIVE` confirmed set**: real Nominatim was
active and "New York City" still only came back as "New York" — that's
OpenStreetMap's own place naming for NYC, not a bug in this app. Owner
asked for ZIP code search as a more unambiguous alternative. It already
worked with no code change needed — Nominatim's freeform `q` parameter
matches US postal codes the same way it matches city names — but two real
improvements went in anyway:

- `NominatimGeocodeProvider` (`src/geo/nominatim.ts`) now sends
  `countrycodes=us`. Driving mode only ever prices a real option to a US
  domestic resort (`priceTrip` refuses non-`"dom"` regions outright), so
  biasing every lookup to the US removes any chance a bare ZIP resolves to
  another country's postal system, and keeps city-name results from ever
  landing outside the country driving mode is scoped to.
- The "Departing from" placeholder now reads "Type a city or ZIP code..."
  instead of "Type a city..." — the capability existed but nothing told
  anyone it was there.

New `src/geo/nominatim.test.ts` (no test file existed for this provider
before): pins the `countrycodes=us` param, a ZIP code going through the
same freeform query untouched, empty-query/non-ok-response handling, and
that a row with an unparseable lat/lon is dropped rather than kept as
`NaN`. 193 tests total (188 existing + 5 new for this provider); 192 pass.
The one failure (`intlBaseline.test.ts`, unrelated to geocoding) is a
pre-existing, date-sensitive flake — `sampleDates()` in
`src/jobs/popularRoutes.ts` always samples day 15 for a single-date month,
and `date < today` skips it once the month passes the 15th, so sweeping
"this month" with one date silently buys nothing for the back half of
every month. Found while running the full suite here, not caused by
anything in this change — flagged, not fixed, since it's a separate,
pre-existing issue in an unrelated job.

### ZIP code only, not city-or-ZIP — superseding the change above, same day

Owner's follow-up after the change above shipped: don't offer a choice —
require a ZIP code, since it's unambiguous where a city name isn't
("Springfield" exists in multiple states; OpenStreetMap's own naming for a
place like New York City can itself surprise people). The "Driving from"
field (renamed **"Your ZIP code"**) now only ever asks for one.

- `public/prototype.html`: the field strips every non-digit character as
  you type and caps at 5 digits in JavaScript (`e.target.value.replace(/\D/g,
  "").slice(0, 5)`) — a paste or a stray letter from a physical keyboard
  gets cleaned up rather than accepted. The search itself only fires once 5
  digits are present (was: any 2+ characters), since a partial ZIP has
  nothing useful to look up. Deliberately **not** relying on the HTML
  `maxlength` attribute for the length cap — found live that `maxlength`
  truncates raw characters (letters included) before the strip-non-digits
  logic runs, so `maxlength="5"` plus a pasted `"abc27601xyz"` produced
  `"27"` (the first 5 raw characters, only 2 of them digits) instead of the
  intended `"27601"`. The JS-only approach strips first, then slices, so
  the 5 kept characters are always digits regardless of what surrounds them.
- `src/geo/nominatim.ts`: since a ZIP is now the *only* thing this field
  sends, `NominatimGeocodeProvider` uses Nominatim's **structured**
  `postalcode` search (plus `country`) for anything shaped like a 5-digit
  ZIP (`^\d{5}(-\d{4})?$`, using just the 5-digit part), instead of its
  general-purpose freeform `q`. Per Nominatim's own docs, `postalcode` and
  `q` are mutually exclusive in one request — sending both is undefined
  behavior, so this always picks exactly one. Structured search targets
  postal boundaries directly rather than making `q` guess whether a string
  of digits is a postcode, a street number, or something else, which is a
  real precision improvement, not just a formality. Anything not
  ZIP-shaped still falls back to freeform `q` — defensive only, since the
  UI itself never sends that path anymore.
- 2 more tests in `nominatim.test.ts` (7 total for this provider now): a
  ZIP+4 keeps just the 5-digit part, and a non-ZIP string still goes
  through freeform `q` untouched.

195 tests total (193 + 2 new), 194 pass — same pre-existing
`intlBaseline.test.ts` flake as above, still unrelated and still not
touched by this change.

### `countrycodes=us` does not reliably filter a bare postal-code search — verified live, fixed with a real response check

Real report, same day: searching ZIP `27540` returned the correct US match
(Holly Springs, NC) mixed in with matches in **Ukraine, Argentina, and
France** — despite `countrycodes=us` being set on the request. Plenty of
countries reuse 5-digit-shaped postal codes, and Nominatim's own
country-restriction filter evidently doesn't bind tightly enough to a
structured `postalcode`-only query to exclude them, whatever the docs
imply.

**Never trust a request-side filter you can't verify** — fixed by checking
what actually came back, not just what was asked for. `NominatimGeocodeProvider`
now sends `addressdetails=1`, which gets a structured `address.country_code`
on every row, and filters every result to `country_code === "us"` after the
fact. `countrycodes=us` stays on the request (costs nothing, may narrow the
upstream set even if imperfectly), but it is no longer the thing doing the
real work — the post-filter is. A row with no `address` block at all is
dropped rather than assumed to be a match, same "never fabricate a result"
reasoning as everywhere else real provider data is handled in this app.

Also dropped the redundant structured `country=United States` field from the
postal-code request — it wasn't preventing the problem above and added
nothing `postalcode` + the response-side filter don't already cover.

2 more tests in `nominatim.test.ts` (9 total for this provider): the exact
Ukraine/Argentina/France/Holly-Springs scenario from the real report,
confirming only the genuine US row survives, and a row missing `address`
entirely is dropped rather than assumed US. 197 tests total (195 + 2 new),
196 pass, same pre-existing unrelated `intlBaseline.test.ts` flake.

### The detail panel now expands inline under its own row, and "Your numbers" moved into the cards it corrects

Owner's report: opening "Details" jumped to a separate `<section id="detail">`
far below all six board rows, so an override you'd just typed was nowhere
near the comparison you were making it for — you had to scroll back and
forth to see the effect. Two changes, both frontend-only:

**Inline expand/collapse.** `#detail` is no longer a fixed section outside
the board — `renderBoard()` now creates it as a child of the `selected`
row itself (`grid-column:1/-1` lets it span the row's full width, breaking
onto its own line below that row's summary cells), only when a new
`detailOpen` flag is true. The "Details" button becomes "Collapse" for
whichever row is open, and clicking it collapses the row back in place —
no separate close control, no scrolling away from the board to get back to
comparing.

**Ordering matters now, where it didn't before.** `renderBoard()` must run
*before* `renderDetail()` on every path that calls both — `renderBoard()`
recreates the entire `<ol>`, including the empty `#detail` slot, so calling
it *after* `renderDetail()` would immediately wipe whatever was just
rendered. Fixed at both existing call sites that had it backwards
(a calendar-cell click, and the old open-detail handler) — `render()`
itself already had the right order. `renderDetail()` also gained a guard
(`if(!box) return`) for the ordinary case where nothing is expanded and
`#detail` doesn't exist anywhere yet.

Clicking "View" from Table view now also switches to Board view, since the
inline detail only ever renders inside a board row — Table itself doesn't
grow one.

**"Your numbers" is no longer a separate highlighted panel.** It was one
`.ovpanel` block above the six resort cards holding both the hotel-rate and
airfare controls together, with a "Save these numbers" button — removed,
since `setOv()`/`setExclude()` already save to `localStorage` the instant a
value changes; the button was a confirmation, not a requirement, per its
own comment in the code. `fareCtl` now renders inside the **Flights** card
itself (and is skipped entirely in *driving* mode, where an airfare
override never had any effect on the price anyway — a pre-existing minor
inconsistency this reorganization incidentally fixes), and `hotelCtl` now
renders inside the **Hotel** card. Each control sits directly above the
numbers it corrects, instead of both living together somewhere else on
the page.

Verified live with Playwright: `#detail` doesn't exist anywhere before a
row is opened; opening one creates it nested inside that exact `<li>`;
switching to a different row moves it there instead of creating a second
one; collapsing removes it and all six rows stay visible; and — the one
case worth double-checking given the reordering fix above — typing a
hotel rate for an open resort keeps that same resort's detail open and its
button on "Collapse" even when the price change re-sorts it to a different
position on the board.

### The US-only ZIP filter needed a second attempt — and a third fix beat guessing at Nominatim's schema twice

The `address.country_code` fix above (previous commit) did not actually
work: the owner reported a real "27540" search still returning France and
Poland alongside the correct Holly Springs, NC match, live, after that fix
had deployed. Two attempts at trusting a specific piece of Nominatim's
structured response (`countrycodes` on the request, then
`address.country_code` on the response) both let non-US results through
for a bare postal-code query — evidently neither is as reliable for this
query shape as documented, and guessing a third time at which field
*would* work risked shipping a third silent non-fix.

Fixed with `isUsResult()` (`src/geo/nominatim.ts`, now exported and unit
tested directly): a plain regex against `display_name` itself —
`/\bunited states( of america)?$/i` — rather than any structured field.
`display_name` is the one thing that has been correct in every real example
seen across both failed attempts: a genuine US result always ends
"...United States", and every leaked non-US result seen so far ended in
its own country's name instead ("...France", "...Polska",
"...Україна", "...Argentina") — never "United States". `countrycodes=us`
stays on the request as a harmless hint, but nothing is trusted from the
response's structure anymore; the string check is the only thing gating
US-only now. `addressdetails=1` was dropped from the request since nothing
reads it anymore.

7 new/changed tests in `nominatim.test.ts` (13 total for this provider):
`isUsResult()` tested directly against the real display_name strings from
both the first report (Ukraine, Argentina) and this one (France, Poland),
plus the genuine Holly Springs match and a case/whitespace check; `search()`
re-verified end to end against the exact mixed France/US/Poland response
the owner actually saw. 201 tests total (197 + ~4 net new — some replaced
the prior attempt's now-obsolete `address`-based cases), 200 pass, same
pre-existing unrelated `intlBaseline.test.ts` flake as every commit above.

**If this still doesn't work after deploying**, the next thing to check
isn't the filter logic — it's whether the deploy actually went out (Render
branch/auto-deploy settings have been the root cause of at least one earlier
"the fix isn't showing up" report this session). A `display_name` string
check has no schema left to get subtly wrong; if wrong results still appear
after a confirmed fresh deploy, capture the exact `display_name` values in
the response and check them against the regex directly rather than assuming
the code path is untouched.

## Filling the cache on the SerpApi Developer plan

The owner's ask, before letting friends test: "can you run a full API refresh
on everything so we can get accurate data across flights, hotels, etc." Here
is what that actually costs and what it does and does not fix. **Nothing below
needs new code** — every budget in the project is already an environment
variable, so this is a sequence of existing workflows run with bigger numbers.

### What "everything" measures

Counted from `config.ts` rather than estimated: 41 origins (19 free, 22 Plus)
against 9 arrival airports gives **363 priceable routes** — 158 domestic, 205
international, 6 local pairs correctly skipped. Restricted to the 19 free
origins it is **169 routes**: 74 domestic, 95 international. The app prices
**13 months**, and hotels are 6 resorts x 13 months = **78 slots**.

### The distinction that decides the order

Domestic routes already have a free baseline — the BTS DB1B survey — so they
price without buying anything. International routes have **none**: grepping a
real 2024 Q4 DB1B file for `CDG` returns zero rows, because it is a US
domestic survey. So a dollar spent on an international route buys an estimate
that does not otherwise exist, and a dollar spent on a domestic one improves
an estimate that already does. International goes first.

### A sequence that fits 5,000/month

| Step | Workflow | Inputs | Lookups |
|---|---|---|---|
| 1. International, free origins, whole year | Parkfare international sweep | months 13, dates 1, budget 260 | ~1,235 |
| 2. Hotels, every resort and month | Parkfare refresh | `REFRESH_BACKFILL=true`, `SERPAPI_HOTELS_BUDGET=80` | ~78 |
| 3. Domestic, widened nightly | Parkfare popular routes | limit 30, budget 30 | ~900/month |
| | | **Total** | **~2,200** |

That leaves roughly 2,800 of the 5,000 for the exact-fare button, which is
the part friends will actually press. Raise `EXACT_FARE_GLOBAL_PER_DAY` from
its default of 6 and `EXACT_FARE_PER_USER_PER_DAY` from 3 before inviting
anybody — at 6 a day site-wide, the first two people to try it spend the
whole day's allowance between them and everyone else sees the cap message.
2,800 a month is about 90 a day, which is exactly what these two were set to
before the plan was downgraded to Starter: **90 site-wide and 25 per person**.
Restoring those is the change, not inventing new ones.

Run step 1 first and check the run's summary before starting step 3: the
international sweep is sharded five ways and is the only step big enough to
be worth watching.

### What this does NOT fix, stated plainly

**It cannot give every date a real fare.** 363 routes across a year is
132,495 date-route pairs. Buying one date a month per route gives a real
fare for that one date and a better-anchored estimate for the other thirty.
Somebody who picks a specific Tuesday will still usually see an estimate.

**The mechanism for "the price I clicked was double" is the exact-fare
button, not the sweep.** That is the one thing that returns a real fare for
a real date, it is Plus-only because it spends metered money per press, and
its own bought fare is written back into the shared cache so the next person
asking gets it free. A bigger plan mainly buys a bigger cap on that button.

**Park ticket prices are untouched by any of this.** They come from a
maintained table with a two-parameter curve, not from SerpApi, and no Disney
park publishes a pricing API at any of the six resorts. If a friend reports
that admission is nearly double what the board said, spending more on
SerpApi will not move it by a cent — `ticket_prices` is the thing to fix.

**On-property hotel rates are untouched too.** SerpApi buys off-property
rates only; Disney-owned rooms are generated locally from the bases in
`config.ts`, four of which are still Claude drafts the owner has not
corrected. `/admin` is where those are changed.

### One thing worth fixing before spending more

On-property hotel rows are written with the provider's `serpapi_hotels`
source tag even though no vendor returned them (`refresh.ts`, and the note
is in the code). The rotation works around it by counting only
`on_property = false` rows, but the real-pulls digest reads the same tag —
so a bigger hotel budget makes a mislabelling that already exists report
more pulls that never happened.

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
2. **Per-user daily cap** (`EXACT_FARE_PER_USER_PER_DAY`, **default 3**).
3. **Site-wide daily cap** (`EXACT_FARE_GLOBAL_PER_DAY`, **default 6**).

   Both were retuned downward when the plan bought was SerpApi Starter
   (1,000/month) rather than Developer (5,000). The nightly flight rotation
   takes ~300 a month and hotels ~240, which leaves about 180 to reserve for
   on-demand lookups — roughly 6 a day. This paragraph documented the old
   Developer-sized figures (25 and 90) for a while after the code had moved;
   if you go back to Developer those are the numbers to restore, and they are
   what the runbook above recommends.
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
