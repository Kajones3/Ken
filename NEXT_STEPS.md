# Parkfare: Handoff Note for Getting Real Data

**Date**: 2026-09-08  
**Status**: Research complete; ready to wire real data  
**Next Session**: Read this entire file for full context before starting implementation

---

## What Parkfare Is

Compares the **total cost of a Disney trip across all six global resorts at once**, and tells you **when** to go. Walt Disney World, Disneyland Resort, Disneyland Paris, Tokyo Disney Resort, Shanghai Disney Resort, Hong Kong Disneyland. The product is the side-by-side comparison; everything else supports it.

**Current State:**
- Backend: Working. 82 tests pass, typecheck clean. `npm run smoke` runs the whole pipeline with no accounts or network.
- Frontend: Wired to real API at `/`. `npm start` + open `http://localhost:PORT/` is the whole dev loop.
- Data: **Mock provider only today.** Flights/hotels/gas prices come from hardcoded stubs in `src/providers/mock.ts`. Ticket prices come from `seedTickets()` — a flat two-parameter formula, not real per-date pricing. The **economic model works**: cost scales with coverage (how many origin airports we cache), not with usage.
- Deployment: Ready at $0/month (Neon + Render + GitHub Actions), but accounts/domains still need manual setup by the owner.

---

## What You're Getting Real

Research conducted this session found that **three APIs actually exist and are accessible** to solo developers:

### 1. **Flights, Hotels, and Rental Cars — Travelpayouts**

**Status:** Owner already has a `TRAVELPAYOUTS_TOKEN` reference in `src/providers/travelpayouts.ts`, but it's not wired in the actual function calls yet (mocked away). Everything else is ready.

**Access:**
- Sign up free at https://travelpayouts.com/ (email + password, no credit card)
- Flights: Calendar endpoint is wired, just needs the token plugged in
- Hotels: Hotellook endpoint (Travelpayouts' hotel product) — open to solo devs, just like flights. No business registration required, unlike Hotelbeds.
- Rental Cars: DiscoverCars partnership via Travelpayouts — same account, no new vendor relationship

**What to do:** 
- User: Get your real `TRAVELPAYOUTS_TOKEN` from https://travelpayouts.com/developers/
- Save it to `.env` as `TRAVELPAYOUTS_TOKEN=your_actual_token`
- Next session (Claude): Wire the token into flight calls (already half-wired), add Hotellook hotel endpoint, add DiscoverCars rental-car endpoint

**Files to touch:** `src/providers/travelpayouts.ts`, `src/server.ts`, `src/config.ts`, `db/schema.sql` (hotel/rental tables exist, no schema change needed)

---

### 2. **Disney Ticket Prices — Screenshots + Manual Transcription**

**Status:** No public API exists at any Disney resort. This is the **original honest plan** — use real published pricing.

**What to do:**
- User: Screenshot Disney's official ticket calendar for WDW and/or Disneyland when convenient (both resorts publish per-date pricing on their own sites)
- Next session (Claude): Transcribe real price points into `db/schema.sql`'s `ticket_prices` table, replacing `seedTickets()`'s flat curve
- This gives us honest data that matches what the owner saw when they price a real trip (the bug report that triggered this whole investigation came from finding our curve was inverted vs. real pricing)

**Files to touch:** `db/schema.sql` (`ticket_prices`), `src/jobs/refresh.ts` (`seedTickets()` — replace or deprecate)

---

### 3. **Gas Prices — EIA API (Free Key)**

**Status:** Already wired but mocked. Free EIA key available.

**What to do:**
- User (optional): Get a free EIA Open Data API key at https://www.eia.gov/opendata/ (email signup, no account approval delay)
- Save to `.env` as `EIA_API_KEY=your_key`
- Next session: Wire it in (already half-stubbed in `src/gas/eia.ts`)

---

## Architecture Invariant: Users Never Call APIs (Except One)

The whole economic model is "users read a cache fetched once each morning by a scheduled job." Users call the API once, the API reads Postgres. This is why cost scales with *coverage* (how many routes to cache) not *usage* (how many people use the site).

**The one exception:** Driving-mode city search (`GET /api/geocode`, `GET /api/geolocate`) calls Nominatim/ip-api live, because it's on-demand interactive autocomplete — there's no fixed set of routes to pre-cache. Already built and working, mocked by default (`GEOCODE_LIVE=true` to go live).

---

## Decision Made This Session

**Wait for your real TRAVELPAYOUTS_TOKEN before implementing Hotellook.** Don't code against the documented shape — code against a live key, like we did for flights. Travelpayouts' response shape hasn't changed, but a live run catches integration surprises (rate limits, auth failures, field names that diverge from docs). This is the proven pattern this codebase already follows.

---

## Next Steps in Order

### What You Do Now (User)

1. **Sign up for Travelpayouts** (https://travelpayouts.com/)
   - Create account with email
   - Get your API token from https://travelpayouts.com/developers/
   - Save to `.env` as `TRAVELPAYOUTS_TOKEN=your_token`

2. **Screenshot Disney's ticket calendars** (optional, do when you have time)
   - WDW: https://disneyworld.disney.go.com/experience/ticket-options/
   - Disneyland: https://disneyland.disney.go.com/experience/ticket-options/
   - Grab a few data points (off-peak floor, peak price, date ranges) for each resort
   - Paste into the next session's chat so Claude can transcribe them

3. **EIA API key** (optional, low priority)
   - https://www.eia.gov/opendata/ if you want real gas prices
   - Saves to `.env` as `EIA_API_KEY=your_key`
   - Otherwise the mock gas price keeps working

4. **Push this file to the repo**
   - Saves context for future sessions
   - You tell the next Claude: "See NEXT_STEPS.md in the Ken repo"

### What the Next Claude Session Does

**Prerequisites:** You've already signed up for Travelpayouts and set `TRAVELPAYOUTS_TOKEN` in `.env`

1. **Wire real flights** (half-done already)
   - `src/providers/travelpayouts.ts`: the flight call is already structured, just uses the mock
   - Swap the mock for the real token, test against a live key
   - `npm run smoke` should fetch real flights by then

2. **Add hotel pricing (Hotellook endpoint)**
   - `src/providers/travelpayouts.ts`: new `hotelMonth()` method (mirrors the flight one)
   - `src/book.ts`: query the new hotel cache
   - `src/server.ts`: wire into `compare()` and `calendar()`
   - `src/jobs/refresh.ts`: fetch hotels on the same tiered schedule as flights
   - Test: `npm run smoke` should fetch real hotels

3. **Add rental car pricing (DiscoverCars via Travelpayouts)**
   - Same pattern as hotels — new endpoint in Travelpayouts, new cache table, new query in `book.ts`
   - `src/pricing.ts`: `rentalCarUsd` is already wired (from the plan shipped last round), just needs a real data source
   - Test: `npm run smoke` should fetch real rental rates

4. **Transcribe ticket data** (if screenshots are provided)
   - Insert real price points into `db/schema.sql`'s `ticket_prices` table
   - Delete or deprecate `seedTickets()` that generates the flat curve
   - Test: `npm run smoke` should price tickets against real data, no longer inverted WDW vs. Disneyland

5. **Wire EIA gas prices** (if key is available)
   - `src/gas/eia.ts`: swap mock for real key
   - Test: `npm run smoke` should fetch real gas prices

### Testing Checklist

After wiring each provider:
- `npm run typecheck` — no type errors
- `npm test` — all 82 tests pass (may need to update mocks in tests if the real response shape diverges from docs)
- `npm run smoke` — the full pipeline (refresh, pricing, alerts, email) runs with real data
- `npm start` + open http://localhost:8080 — the UI shows real prices, not mock stubs

---

## Files You'll Touch

| File | What changes |
|---|---|
| `src/providers/travelpayouts.ts` | Wire real token; add Hotellook endpoint; add DiscoverCars endpoint |
| `src/book.ts` | Add hotel + rental cache queries |
| `src/server.ts` | Wire new cache into `/api/compare` and `/api/calendar` |
| `src/jobs/refresh.ts` | Fetch hotels + rentals on tiered schedule; delete or deprecate `seedTickets()` |
| `db/schema.sql` | Already has `hotel_prices` + `rental_prices` tables (from earlier round); may need new fields |
| `db/migrations/` | If schema needs changes (unlikely) |
| `.env` | Add `TRAVELPAYOUTS_TOKEN` and optionally `EIA_API_KEY` |

No changes to `src/pricing.ts` needed — the rental car cost line is already there, just needs real data to feed it.

---

## Known Gaps (Not Blocking)

These were noted during this session's research but aren't part of "getting real data":

1. **Hotelbeds Disney API** (initially researched as an option) requires business registration + trading history — too gated for a solo dev. Travelpayouts' Hotellook is the right call instead.

2. **Resend email sending** — already wired, just needs `RESEND_API_KEY` from https://resend.com/ (free tier: 3,000 emails/month). Alerts still work with console output if the key isn't set.

3. **CLAUDE.md needs updates** — when real data is wired, update the "NOT verified" section to reflect which APIs are now live, and update the "Decisions worth knowing" section if any assumptions change (e.g. if Travelpayouts' Hotellook response shape diverges from docs).

---

## One More Thing

The plan file at `/root/.claude/plans/distributed-stirring-sutton.md` contains the full architectural vision for the app (mixed drive/fly presets, rental cars, wear-and-tear, the lot). That's the **next feature round** after real data is wired. Right now, just focus on getting Travelpayouts → flights/hotels/rentals and real ticket data flowing.

---

## How to Reference This

Next session, just tell Claude:  
**"I've set `TRAVELPAYOUTS_TOKEN` in `.env` and taken screenshots of ticket calendars. Read NEXT_STEPS.md in the Ken repo for full context, then wire the real data sources."**

That's it. No need to re-paste everything.
