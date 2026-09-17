# Parkfare — Project Map

A quick-orientation reference. **`CLAUDE.md` is the authority** on *why* decisions
were made and must not be contradicted; this file is the *what and where*.

Last updated: 2026-09-17

---

## What this is

Compares the **total cost of a Disney trip across all six global resorts at once**,
and tells you *when* to go — Walt Disney World, Disneyland Resort, Disneyland Paris,
Tokyo Disney Resort, Shanghai Disney Resort, Hong Kong Disneyland.

Nobody else prices "should we do Orlando or Tokyo this spring?" side by side. That
comparison is the product; everything else supports it.

**Stage:** pre-beta. Deployed and working, real paid data flowing, no public users yet.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript on Node 22** | ESM (`"type": "module"`), run directly via `tsx` — no build step |
| Server | **Node `http`, no framework** | `src/server.ts` also serves the frontend |
| Frontend | **One vanilla HTML file** | `public/prototype.html` — no framework, no bundler |
| Database | **Postgres** | Neon in production; embedded **PGlite** locally when `DATABASE_URL` is unset |
| Tests | **`node:test` via tsx** | 23 test files, 213 tests |
| Hosting | **Render** (web service) | Free tier sleeps after 15 min idle |
| Scheduling | **GitHub Actions cron** | 15 workflows — all jobs run here, not on Render |
| Deploy | Auto-deploy from **`master`** | Render watches that branch |

**No build step anywhere.** `tsx` runs TypeScript directly. `npm run typecheck` is
`tsc --noEmit` — type safety without compilation.

### External services

| Service | Role | Status |
|---|---|---|
| **SerpApi** | Real flight fares (Google Flights) + off-property hotels | **Paid — Starter $25/mo, 1,000 searches** |
| **Travelpayouts** | Flight calendar + affiliate links | Free; calendar data largely unusable (see CLAUDE.md) |
| **BTS DB1B** | US domestic historical fare baselines | Free, keyless, US-domestic only |
| **Neon** | Postgres | Free tier |
| **Render** | Hosting | Free tier (upgrade to $7/mo kills cold starts) |
| **Resend** | Alert emails | Free tier; **domain verification in progress** |
| **Nominatim / ip-api** | ZIP geocoding for driving mode | Free, keyless |
| **EIA** | Gas prices | Optional; mock used when unset |
| **Stripe** | Payments | **Not built.** Stubbed in the prototype only |

---

## Architecture in one picture

```
GitHub Actions (cron)          Neon Postgres              Render (web)
─────────────────────          ─────────────              ────────────
refresh      04:00 ──┐
popular-routes 04:10 ─┼──────▶  18 tables  ◀──────────── server.ts
alerts       04:20 ──┤         (the cache)               ├─ /api/compare
news-digest  ────────┘                                   ├─ /api/calendar
                                                         ├─ /api/trips
intl-sweep   (manual only)                               └─ serves prototype.html
```

**The load-bearing decision:** users never call a provider API. Scheduled jobs fill
the cache; every user request reads only the database. **Cost scales with coverage,
not with usage.** One search would otherwise trigger ~1,265 lookups.

The one deliberate exception is ZIP geocoding (`/api/geocode`), because you can't
pre-cache "every city someone might type."

---

## Directory map

### Core pricing — the heart of the app

| File | Role |
|---|---|
| **`src/pricing.ts`** | **The single source of truth for trip cost.** Pure, synchronous, no I/O. Returns `{ok:false, reason}` — never throws, never `NaN` |
| `src/book.ts` | Loads a `PriceBook` slice from Postgres, applies the fare trend, produces estimates |
| `src/config.ts` | Resorts, hotels, tickets, origins, seasons, IRS mileage, confidence badges |
| `src/seasonality.ts` | Seasonal multipliers by date |
| `src/gettingThere.ts` | The five drive/fly presets |
| `src/dates.ts` | Date helpers — **always use these**, never string-slice a Postgres date |

### Server and data access

| File | Role |
|---|---|
| `src/server.ts` | All HTTP routes; serves `prototype.html` at `/` |
| `src/db.ts` | Postgres (Neon) or PGlite, chosen by `DATABASE_URL` |
| `src/auth.ts` | Email-only sign-in, sessions, `isPlus()` entitlement |
| `src/exactFare.ts` | Plus-only live fare lookups — the one user click that spends money |
| `src/routeDemand.ts` | Records demand; picks which routes to buy (`rotationRoutes`, `trendAnchorRoutes`) |

### Scheduled jobs (`src/jobs/`)

| Job | Schedule | Spends? |
|---|---|---|
| `refresh.ts` | nightly 04:00 | **Yes** — hotels, capped 8/night |
| `popularRoutes.ts` | nightly 04:10 | **Yes** — flights, capped 10/night |
| `alerts.ts` | nightly 04:20 | No — reads cache only |
| `fareTrend.ts` | within refresh | No |
| `intlSweep.ts` | **manual only** | **Yes** — ~570 per full run |
| `intlBaseline.ts` | within sweep | No |
| `btsBaseline.ts` | manual | No — free BTS data |
| `coverage.ts` | manual | No — **read-only diagnostic** |
| `newsDigest.ts` | scheduled | No |

### Providers — swappable adapters

`src/providers/` (flights, hotels), `src/email/` (console vs Resend), `src/gas/`,
`src/geo/`. Every one follows the same shape: a `types.ts` interface, a `mock.ts`,
a real implementation, and a `pick.ts` that chooses based on whether a key is set.
**Everything runs end to end with zero credentials** — that's deliberate.

### Frontend

`public/prototype.html` — one file: board view, calendar, per-resort detail panels
that expand inline, per-card override controls, paywall UI. Every price comes from
the API; there is no pricing model left in the browser.

---

## Database — 18 tables

**Cache (filled by jobs):** `flight_prices`, `hotel_rates`, `ticket_prices`,
`historical_fares`, `fare_trend`, `gas_prices`, `geocode_cache`

**Users:** `users`, `sessions`, `saved_trips`, `custom_expenses`, `price_alerts`

**Operational:** `fetch_runs`, `route_searches`, `exact_fare_usage`, `promos`,
`news_seen`

---

## Budget — SerpApi Starter, 1,000 searches/month

| Job | Budget | Worst case/mo |
|---|---|---|
| `popular-routes` | 10/night | 300 |
| `refresh` hotels | 8/night | 240 |
| exact-fare | 6/day | 180 |
| Reserve | | 280 |

**Never enable SerpApi's "Automatic Early Renewal."** It re-buys the plan the instant
the bucket empties — the one way to be charged past $25.

Paid lookups **rotate by staleness**, not just demand: 200 lookups over 20 nights
covers all 171 routes with no repeats. Before this, the job re-bought the same ~15
routes nightly forever.

---

## Commands

```bash
npm start          # server + frontend at localhost:PORT
npm test           # 213 tests
npm run typecheck  # tsc --noEmit
npm run smoke      # whole pipeline, no network, no accounts
npm run coverage   # read-only cache coverage report
```

⚠️ **With local PGlite, stop the server before running any script.** Two processes
on one `.pgdata` directory corrupts it. Real Postgres has no such limit.

Admin jobs run from the **GitHub Actions tab**, not a terminal — that's how the
non-technical owner operates production.

---

## Known state as of today

### Working
Six-resort comparison · fare calendars · drive/fly presets with IRS wear-and-tear ·
Park Hopper · per-resort overrides · saved trips · promos · custom expenses ·
Plus entitlement · alert job · ZIP geocoding · rotation-based fare buying

### In progress
- **Resend domain verification** (`pricingthemagic.com`) — DNS records being added.
  Until done, alerts reach nobody but the owner.
- **Render custom domain** — CNAME `www` + A `@` → `216.24.57.1`

### Known weak spots

| Issue | Severity |
|---|---|
| **International fares don't vary by origin** — `RDU→Tokyo` = `LAX→Tokyo` = $1,196 | **High** — rotation is fixing this gradually |
| Sign-in has no password or verification | **High for public**, fine for friends |
| Render free tier: ~60s cold start | Medium — $7/mo fixes it |
| Ticket prices are an approximation curve | Medium — labelled in UI |
| Promo rows are fake examples | Medium — replace or hide before beta |
| Shanghai height-based pricing not modelled | Low — badged |
| Flat rental-car rate | Low |

### Known test flake
`intlBaseline.test.ts` — "the sweep's destination shard cannot be widened past the
app's own list" fails when the date is past the 15th. **Unrelated to any change.**
Always confirm a new failure isn't just this one.

---

## Immediate next steps

1. **Finish Resend verification** → send a real test alert. `ResendEmailSender` has
   never run against a live account; this is unproven code.
2. **Run "Parkfare popular routes" once by hand** — the fare trend is stale
   (Sep 9) and rotation should start immediately.
3. **Re-run coverage for `RDU` in ~1 week** — `est` markers should be becoming real
   counts as rotation works through the routes.
4. **Replace or hide the three fake promos.**
5. **Decide on Render $7/mo** before friends see the cold start.
6. **Then beta** with a handful of friends, Plus comped via `grant-plus`.

**Deliberately deferred:** Stripe (nobody to charge), day-by-day trip planner,
10-mile hotel radius filter, per-city rental rates, real ticket-price table.

---

## Working agreements

- **Develop on `claude/website-issue-fix-o0qhdn`**, PR into `master`. Render
  auto-deploys `master`. Restart the branch from `origin/master` after each merge.
- **Always** `npm run typecheck` + `npm test` before pushing.
- **Verify behaviour, don't assert it.** Several real bugs here were found only by
  running the thing — a simulation, a Playwright check, a live query. Green tests
  proved nothing in each case.
- **Explain trade-offs in plain language** and say when a number is a guess. The
  owner is non-technical-to-semi-technical.
- **Sanity-check pricing against a real booking**, never against intuition.
