# Which numbers are real, and which to test first

Written 2026-09-26 for the owner's testing against real plans and AI
searches. Ordered by how much each line moves a typical trip total, so the
first rows are where a wrong number does the most damage.

**How to use it.** Price a trip in Pricing the Magic, price the same trip for real,
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
| **Food, all six resorts** | Since 2026-10-15: a price RANGE per meal (quick service, table service, character, snack, a day of groceries) per resort, from web research of menu prices; we use the middle, add US sales tax and an 18% tip on US table-service and character meals. A dining style is a day of meals (`DAY_OF_MEALS` in meals.ts). Children 63% of an adult. | /admin → Rates & settings → "Food — <resort>" | A real menu price for any meal type |
| Food: weakest seeds | **Hong Kong table service** (HK$250-400) has NO source, a placeholder. Tokyo table service (¥4,000-8,000, from one Magellan's course), Shanghai's ranges (one travel FAQ), Paris quick service (about €16, range put around it). Groceries: USDA's at-home figure ($11-13 a day) x each place's grocery price level, likely LOW for vacation shopping. Whether Hong Kong table-service meals add a 10% service charge is unchecked. | /admin → Rates & settings | A menu photo or receipt |
| **Character meals** | No longer a 1.5x guess (since 2026-10-15). Walt Disney World uses your $50-75; the other five come from menu prices found by web search (Disneyland $58-79, Paris €65-100, Tokyo ¥8,100-9,000, Hong Kong HK$400-488, Shanghai CNY 200-500 + 15% service charge). | /admin → Rates & settings → "Food — <resort>" | One real character-meal price at a resort other than Walt Disney World |
| **Paris hotels** | Claude's drafts from web search. | /admin → Hotel rates — Disneyland Paris | A real room-only rate on your dates. Disney's own site only sells hotel + tickets, so check Booking.com, or subtract the ticket price. |
| **Tokyo hotels** | Mostly guesses. Only Disney Ambassador Hotel is real. **Your 2026-09-27 sheet (Dec 17–22, 5 nights)** against what the app charges those nights: Ambassador Superior ¥74,300/night ≈ $473 vs app $463 (+2%); Tokyo Disneyland Hotel Superior Alcove ¥100,500 ≈ $639 vs $501 (+28%); Celebration Discover/Wish ¥50,000 ≈ $318 vs $196 (**+62%**). Assumes the sheet's Rate is the whole stay for one room. Christmas week, so one peak data point each. No rate was changed. Once the sheet is uploaded in /admin → Prices you've checked, these checks nudge the estimates (Celebration about +16%, Tokyo Disneyland Hotel +7%, Ambassador +1%). | /admin → Hotel rates — Tokyo Disney Resort | Tokyo Disney Resort's own booking page; the same hotels in a quiet month would show whether Celebration's base is too low all year or only at Christmas |
| **Hong Kong Deluxe hotel** | Worked out from a ratio, not seen. The others at Hong Kong and Shanghai are real (your screenshots). | /admin → Hotel rates — Hong Kong Disneyland | Hong Kong Disneyland Hotel's own rate |
| **Walt Disney World tickets by DATE** | **About 25% low on real 2027 dates.** Your 2026-10-21 check, Oct 8 2027, 5-day: Disney $771.77 adult, $752.12 child (3-9), plus 6.5% tax (now added); we priced $576 / $557 before tax. Cause: our 1-7 day table (2026 "standard" prices, 5-day $565) sits near Disney's CHEAPEST dates (2027 "from $103/day" = $515 for 5 days), and our season curve is the DVC points chart squeezed to 55%, which rates October middling (x1.02) when Disney's ticket calendar prices it near the top (~$145-160/day for a 5-day ticket all month). The child share (0.966) is right (Disney 0.975). | /admin → Ticket calendars (drop Disney's calendar screenshots; imported dates use Disney's price, the rest the curve; each length is kept separately and a trip uses its own length, else the nearest held) | Disney's ticket calendars for the lengths people pick most (start with 5-day, then 4 and 3) ("Calendar shows the price per day"), one screenshot per month, Dec 2026 to Aug 2027 |
| **Disneyland tickets** | **2-5 day: real.** Disneyland sells them at one price for any date (no calendar on its site; your screenshot 2026-10-28: 2-day $168/day, 3-day $142, 4-day $120, 5-day $104), and the board now prices them exactly that, with no season curve. **1-day: a guess** inside Disney's $104-$224 range (our season curve), **except months whose 1-day calendar you saved in /admin → Ticket calendars** (December 2026 can be: $154-$224). | code (`multiDayAdultUsd` on `dlr` in `src/config.ts`) | Disneyland's 1-day ticket price on a few dates, if you want 1-day trips exact |
| **Paris tickets** | **Real when you've saved them (2026-10-31).** /admin → Ticket calendars reads Paris's UK site in pounds: the dated calendar (week starting Monday) and the cart for an undated ticket (one price any day). A date with a dated calendar uses it; every other date uses the undated 1-day price (adult £114.27, child £106.30 saved 2026-10-31); only with neither is it our old curve (about 43% low). A trip of 2+ days uses an undated ticket of its own length if saved, else the 1-day price × our length discount (a guess: 3-day ≈ 86% a day). Child share 0.93 from Disney's own prices. | /admin → Ticket calendars | Undated 2-, 3-, 4-day carts (one screenshot each) make multi-day trips exact |
| **Park Hopper, Paris** | A guess (+$45). Tokyo, Hong Kong and Shanghai have no hopper and price $0. | /admin → Park Hopper | Paris's 2-park ticket upgrade price |
| **Off-property parking and transfers** | $35/day Orlando, $40 Anaheim, $10–14 at the transit-served resorts. Estimates. | /admin → parking and transfers, off property | What a hotel shuttle or a day's parking actually costs you |
| **Driving** | Road miles come from a map (OpenStreetMap routing) since 2026-10-31, kept once per route; the old straight-line × 1.25 guess ran 5-15% long (Atlanta to Walt Disney World 506 vs 441 road miles). Still guesses: 25 mpg, $120 for an overnight stop if you don't type one. Gas price is real (EIA). | code (`DRIVING` in config.ts) | Your car's mpg |
| **Flight holiday premium** | Learned from our own fares since 2026-10-31 (`holidayLearning.ts`): holiday-week dates against the same route's ordinary dates that month, from every fare we keep (mostly the free feed, which covers the next few months day by day), shrunk toward the study's +55% / +58% until enough routes back it. /admin → Rates & settings → What the formulas learned shows both. Used only when no real fare is held for the date. | /admin → Flight estimates (a value you set wins) | A real Thanksgiving or Christmas fare on your route |
| **Flight estimates in general** | Domestic: real government fare data (BTS) moved by real fares bought nightly. **Until 2026-09-29 every domestic estimate was about half a round trip (the government file stores one leg); now doubled.** Re-check a domestic route you tested before that date. International: real fares sampled overnight. Shown high on purpose. | /admin → Fares (type what you saw), and "Flight estimates" | Kayak or Google Flights on the same dates |
| **Flight formula's settings** (what travelers see since 2026-10-16) | The formula LEARNS its numbers from fares we buy, but how cautiously it learns is Claude's choice: an effect counts halfway after 2 fares, and a destination needs 20 of our fares before the plain formula is used (else the older lever formula, whose own caution settings are also Claude's). | code (`src/fareModel.ts`) | The before-buying grades in /admin and the morning email; if one group keeps leaning one way, these are the dials |
| **Shanghai crowd levels** | Judgment from school and national holidays; no points chart exists. Tokyo and Paris only rank their own months. | code (`CROWDS`) | Nothing reliable to check against |
| **Annual pass prices** | Found by web search (Disneyland 2026-09-21; Walt Disney World re-checked 2026-10-08 after the 2026-10-06 increase), not taken from Disney. Passes, DVC points and your own discount are entered on the budget page only (2026-10-31). | /admin → pass prices | Disney's pass pages (prices change about once a year) |
| **DVC take-home per point** | $18. The traveler can type their own. | /admin → DVC | What a broker pays you |
| **Promos: Tokyo, Hong Kong, Shanghai** | None. WDW, Disneyland and Paris have real ones. | code (`seedPromos.ts`); no admin screen yet | Each resort's own offers page, pasted in |
| **Prices compared with Orlando** (Good to know, and the PDF) | Eating out only, from World Bank price surveys against Orlando (US government regional prices): Tokyo about 30% less, Shanghai 50% less, Hong Kong 40% less, Paris about the same, Disneyland area 5% more. **The groceries sentence was removed (2026-10-31)**: two sources disagreed by 34 points for Tokyo. A day of groceries is still priced (meals.ts) and lands inside what travel guides report: Tokyo ¥2,120 vs ¥1,500-2,500, Shanghai ¥77 vs ¥40-110, Hong Kong HK$127 vs HK$100-300; Paris €11 may be low. | /admin → Rates & settings → Food (grocery day per resort) | A supermarket or convenience-store receipt |
| **"Beyond the parks" travel times** (detail view and PDF) | Claude, from general knowledge, not checked: Paris ~40 min on RER A, Tokyo Station ~15 min from Maihama, Shanghai ~1 hour by metro, Hong Kong 30-40 min by MTR, LA and the beaches 30-60 min by car, Kennedy Space Center ~1 hour from Orlando. | code (`beyondParks` in config.ts) | A map app or the transit operator's journey planner |
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
