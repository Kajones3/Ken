# Price checks — real prices you've seen

Upload them in **/admin → Prices you've checked**: a spreadsheet, one price at a
time, or a screenshot. The sample sheet in this folder is your Tokyo Christmas
sheet in this format.

## What happens to a price

- **It is always kept.** You'll see the day you pulled it, the dates it's for,
  how many days ahead that was, and what we were quoting for the same thing
  that day.
- **Nothing is overwritten.** Your hotel rates, fares and ticket prices stay
  exactly as they are.
- **If it matches something we price, it nudges that estimate.** That means a
  flight route from your airport, a Disney hotel, or a resort's tickets. One
  check moves it a quarter of the way toward what you saw, three checks
  halfway, and nine three-quarters. You can change this in /admin →
  "Your price checks". Estimates never move below half or above double.
- **It compares like with like.** A Christmas price is measured against our
  Christmas price, so the season doesn't count as a mistake.
- **Several rooms on one stay count once, at the cheapest.** Your base rate is
  a standard room. A family room at twice the price is a different product.
- **Some rows are kept but not counted, and the page says why.** These are
  food items, hotels we don't price, and routes with no estimate yet. So is
  anything more than 5× or less than 0.2× ours, which is almost always a
  currency mistake.

## Columns

Columns are matched by name, in any order. Only `resort`, `category` and
`amount` are required on every row.

| Column | What to put | Example |
|---|---|---|
| `trip` | Any label to group a trip's rows | Tokyo Christmas (expensive) |
| `checked_on` | The day you saw the price (blank = today) | 2026-09-27 or 9/27/2026 |
| `resort` | Name, city or id | Tokyo, tdr, Orlando |
| `category` | flight, hotel, ticket, food or other | hotel |
| `item` | Hotel name, ticket name, restaurant | Disney Ambassador Hotel |
| `detail` | Room type, age band, dish | Superior Room · Adult (18+) |
| `from_airport` | Flights only | RDU |
| `start_date` | Check-in, flying out, park day | 12/17/2026 |
| `end_date` | Check-out, flying home | 12/22/2026 |
| `adults`, `seniors`, `children_ages` | Only needed to split a whole-party total | 2, 0, "4, 8" |
| `amount` | The price as shown; "yen", ¥, $, HK$ are all read | 502500 yen |
| `currency` | USD, JPY, EUR, CNY or HKD. Wins over anything in `amount` | JPY |
| `price_is` | per_person, per_night, whole_stay, total, per_item or per_day | whole_stay |
| `source`, `notes` | Anything | Tokyo Disney Resort site |

Defaults when `price_is` is blank: flights and tickets are per person; hotels
are the **whole stay** (the page tells you it assumed so); food is per item.

**A blank currency is read as US dollars**, and at a non-US resort the upload
warns you. A yen price read as dollars is the mistake most likely to slip
through, and the 5× guard is the backstop.

**Uploading the same sheet again is safe.** A row identical to one already
stored is skipped, so add new rows at the bottom and re-upload.

## Open question from the Tokyo sheet

You weren't sure whether the Tokyo room prices were for the whole stay. They
went in as whole-stay prices over 5 nights. Disney Ambassador then comes out
within 2% of our own rate, which suggests that's right. If they turn out to be
per night, change `price_is` to `per_night`, delete the old rows in /admin, and
re-upload.
