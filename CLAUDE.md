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
| Backend (`src/`, `db/`) | **Working.** 20 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline with no accounts or network. |
| Frontend (`public/prototype.html`) | Working prototype, self-contained HTML, **still on simulated data**. Not yet wired to the API. |
| Live provider data | Not connected. Mock provider only. |
| Auth, email send, payments | Not built. Stripe is stubbed in the prototype. |

Next task in the build order is **step 3: point the prototype at `/api/compare` and
`/api/calendar`**, replacing its in-browser pricing model. Nothing user-facing should
change except that the numbers get real.

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

**Off-property totals include parking and transfers** ($35/day Orlando, $40 Anaheim,
$10–14 at transit-served international resorts). Without it, off-property looks cheaper
than it is — this is the comparison people get wrong.

---

## Verified facts (checked against sources during design)

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

## NOT verified — check before relying on these

- **Shanghai and Hong Kong age bands** come from model knowledge, not a source. Both are
  configured as free under 3 / child 3–11 / adult 12+. Shanghai actually bands by *height*
  (1.0–1.4m), which is not modelled at all.
- **Ticket affiliate commission rates** (used ~3–6% in the revenue estimate). This is the
  largest commission line and the least certain number in the business case.
- **Travelpayouts response shapes.** `providers/travelpayouts.ts` was written to the
  documented shape, never run against a live key.
- **Vendor hosting prices** (~$25–50/month total). Indicative only.
- **Off-property hotel base rates** are informed estimates, not published rates.
- **Food rates** are from budget guides. No API will ever give you food exactly.

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
- Store the affiliate deep link **in the same row as the price**. Reconstructing links at
  render time is how tracking parameters go missing and commissions vanish.
- Prices are stored in USD. Currency display is a presentation concern.

---

## Build order (from the design doc)

1. ~~Schema and one route~~ — done
2. ~~Refresh job~~ — done, tiered, logged
3. **Point the frontend at the cache** ← next
4. ~~Tier the refresh~~ — done
5. Accounts and saved trips (schema exists, no auth)
6. Alert job and email (job works; no send wired)

Then: Travelpayouts token, hotel endpoint approval, a real ticket-price table, Stripe,
deploy (Neon/Supabase + a cron worker), and a "prices as of ..." line in the UI.

## Known gaps in the code

- `TravelpayoutsProvider.hotelMonth` **throws deliberately** — flights are wired, hotels
  need whichever Hotellook endpoint you get approved for. It fails loudly so a
  half-configured deploy breaks at the refresh job instead of quietly showing users nothing.
- `seedTickets()` fills `ticket_prices` from a placeholder curve. Replace with maintained
  rows and **alarm on any resort whose rows are >30 days old** — nothing fails loudly here.
- No auth. `saved_trips.user_id` is a foreign key waiting for a decision.
- No email send. The alert job writes the durable `price_alerts` row and leaves a marked
  handoff point, so a send failure can be retried without losing the alert.
- Shanghai height-based ticket banding is not modelled.
