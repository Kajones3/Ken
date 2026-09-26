# Which numbers are real, and which to test first

Written 2026-09-26 for the owner's testing against real plans and AI
searches. Ordered by how much each line moves a typical trip total, so the
first rows are where a wrong number does the most damage.

**How to use it.** Price a trip in Parkfare, price the same trip for real,
and compare line by line: flights, hotel, tickets, food. When a line is off:

- If the table says **/admin**, change it there. It takes effect with no
  deploy, and your number beats the built-in one.
- If it says **code**, send the real number (a screenshot works) and Claude
  changes it.
- For **flights**, use the Fares section of /admin: type the fare you saw,
  and it pulls that route's estimate toward it.

## Guesses to test, biggest first

| Line | What it is now | Where it lives | What to check it against |
|---|---|---|---|
| **Food, all six resorts** | Per-person daily rates from budget guides, per dining style. About 40% of a typical total. | code (`food` on each resort in config.ts) | What you actually spend per day, or a real day's menu prices |
| **All-character dining** | Claude's guess: 1.5× that resort's table-service rate, the same multiplier everywhere. Also sets "some character meals". | code | One real character-meal price: Cinderella's Royal Table, 'Ohana, Chef Mickey's |
| **Paris hotels** | Claude's drafts from web search. | /admin → Hotel rates — Disneyland Paris | A real room-only rate on your dates. Disney's own site only sells hotel + tickets, so check Booking.com, or subtract the ticket price. |
| **Tokyo hotels** | Mostly guesses. Only Disney Ambassador Hotel is real. | /admin → Hotel rates — Tokyo Disney Resort | Tokyo Disney Resort's own booking page |
| **Hong Kong Deluxe hotel** | Worked out from a ratio, not seen. The others at Hong Kong and Shanghai are real (your screenshots). | /admin → Hotel rates — Hong Kong Disneyland | Hong Kong Disneyland Hotel's own rate |
| **Paris tickets** | Still a two-number curve, not a real price table. | code | Disneyland Paris's ticket page: 1- to 5-day, adult and child |
| **Park Hopper, Paris** | A guess (+$45). Tokyo, Hong Kong and Shanghai have no hopper and price $0. | /admin → Park Hopper | Paris's 2-park ticket upgrade price |
| **Off-property parking and transfers** | $35/day Orlando, $40 Anaheim, $10–14 at the transit-served resorts. Estimates. | /admin → parking and transfers, off property | What a hotel shuttle or a day's parking actually costs you |
| **Driving** | 25 mpg, road miles = 1.25× straight-line miles, $120 for an overnight stop if you don't type one. Guesses. Gas price is real (EIA). | code (`DRIVING` in config.ts) | A real drive's miles on a map app; your car's mpg |
| **Flight holiday premium** | +55% Thanksgiving week, +58% Christmas week, from a third-party study of US routes. Used only when no real fare is cached. | /admin → Flight estimates | A real Thanksgiving or Christmas fare on your route |
| **Flight estimates in general** | Domestic: real government fare data (BTS) moved by real fares bought nightly. International: real fares sampled overnight. Shown high on purpose. | /admin → Fares (type what you saw), and "Flight estimates" | Kayak or Google Flights on the same dates |
| **Shanghai crowd levels** | Judgment from school and national holidays; no points chart exists. Tokyo and Paris only rank their own months. | code (`CROWDS`) | Nothing reliable to check against |
| **Annual pass prices** | Found by web search 2026-09-21, not taken from Disney. | /admin → pass prices | Disney's pass pages (prices change about once a year) |
| **DVC take-home per point** | $18. The traveler can type their own. | /admin → DVC | What a broker pays you |
| **Promos: Tokyo, Hong Kong, Shanghai** | None. WDW, Disneyland and Paris have real ones. | code (`seedPromos.ts`); no admin screen yet | Each resort's own offers page, pasted in |
| **Lands and attraction list** | Yours now. See `docs/attractions/`. | /admin → attraction list | The resort maps |

## Real, and not worth re-testing unless something looks off

| Line | Source |
|---|---|
| WDW and Disneyland tickets, 1–7 and 1–5 days, adult and child, plus Park Hopper | Published 2026 prices |
| Tokyo, Hong Kong and Shanghai tickets, including senior prices | You checked each resort's own purchase flow |
| WDW and Disneyland on-property hotel medians | Your research against 2026 published ranges (WDW set to your 305/700 call) |
| Hong Kong and Shanghai hotels (except Hong Kong Deluxe) | Your screenshots |
| Off-property hotels | Real Google Hotels prices bought overnight. Each is a one-night sample, so a specific hotel may be sold out on your dates. |
| WDW Disney Dining Plan | Disney's published 2027 prices |
| Crowd levels at WDW, Disneyland and Hong Kong (Apr–Dec) | DVC points charts |
| Weather | Open-Meteo, 20 years of daily observations |
| Exchange rates | European Central Bank, refreshed monthly |
| IRS mileage rate, 2026 | IRS. 2027 is missing, carried forward from 2026 until you add it (reminder snoozed until after Thanksgiving). |

## When you test against an AI search

AI answers about Disney prices are often a year or two stale and rarely say
which dates they mean. Treat one as a lead to check, not as a correct
number. A real checkout screen, even one you abandon, is the best evidence,
and a screenshot of one is exactly what the planned screenshot scanner
would read.
