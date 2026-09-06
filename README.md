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
npm test         # 23 tests, no database needed
npm run typecheck
```

## Then, for real

```bash
cp .env.example .env       # set DATABASE_URL; leave the token unset to stay on mock data
npm run migrate
npm run refresh
npm start                  # API on :8080
```

Cron, once you deploy:

```
0 4 * * *   npm run refresh
20 4 * * *  npm run alerts
```

## Layout

| Path | What it is |
|---|---|
| `db/schema.sql` | Five tables. Safe to re-run. |
| `src/config.ts` | The six resorts: age bands, ticket rules, food rates, hotels, transport. |
| `src/pricing.ts` | **The single source of truth for what a trip costs.** Pure, synchronous, no I/O. |
| `src/book.ts` | Loads one slice of cache into memory so pricing can stay synchronous. |
| `src/providers/` | `mock.ts` works today; `travelpayouts.ts` needs a token. Same interface. |
| `src/jobs/refresh.ts` | The morning refresh, tiered by how far out the date is. |
| `src/jobs/alerts.ts` | Re-prices saved trips from the cache and sends the drop emails. Never calls a provider. |
| `src/email/` | `console.ts` prints instead of sending, works today; `resend.ts` needs an API key. Same interface. |
| `src/server.ts` | The API. `node:http` and nothing else, also serves `public/prototype.html`. |

### Why pricing.ts is shared

It runs in three places: the API that shows someone a number, the alert job that
decides whether that number dropped, and the tests. If the alert job had its own
copy of this logic, the two would drift, and you would eventually email a customer
about a price your own site never showed them. One module, no drift.

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

## What is not done

- **`TravelpayoutsProvider.hotelMonth` throws.** Flights are wired to the documented
  calendar endpoint; hotels need whichever Hotellook endpoint you get approved for.
  It throws loudly rather than returning nothing, so a half-configured deployment
  fails at the refresh job instead of quietly showing users empty results.
- **Ticket prices are seeded from a placeholder curve.** No public API exists at any
  of the six resorts. `seedTickets()` fills the table so the system runs; replace it
  with rows you maintain against each resort's published calendar, and alarm on any
  resort whose rows go stale. When Disney's dynamic ticket pricing lands, this table
  needs the same tiered refresh as flights.
- **No auth.** `saved_trips.user_id` is a foreign key waiting for whatever you choose.
- **Verify the Travelpayouts response shapes** against current docs. This was written
  to the documented shape, not against a live key.
- **Verify the Resend request shape** against current docs before relying on it — it
  was written to the documented shape (a single `POST /emails` call), not run against
  a live account. `ALERT_FROM_EMAIL` needs a domain verified in Resend before it will
  send to anyone but the account owner.

## Currency

Prices are stored in USD. Local-currency display is a presentation concern; a live
FX feed belongs in front of the UI, not in the cache.
