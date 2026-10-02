# Plus: what to charge for, and how to find out

Brainstorm notes, 2026-10-02. Nothing here is built or decided. These are ideas to
come back to.

## Where things stand

- Plus today is the price calendar, saved searches, the PDF and deal emails
  ($9 a week, $15 a month, $25 for 6 months, paid once, never renewing).
- Payments aren't built. "Get Plus" just emails the owner.
- The site records nothing about what visitors do: no count of Plus clicks,
  booking-link clicks, or how many people open a resort's details.

## Four observations

1. **The tool's value hits once, at the moment of deciding.** In the owner's
   words: "Once you pick your trip, the tool kinda becomes useless." So charge
   at the decision, or just after it, not for access.
2. **The free version answers the whole question.** That's good for word of
   mouth, but it leaves Plus as a set of extras, and people rarely pay for
   extras. App Store freemium works because the free version is basic. Ours
   isn't, deliberately.
3. **The bigger money may be affiliate commission, not Plus.** Earlier notes
   estimate about $90–165 per booked trip, against $9–25 for Plus. The booking
   links don't carry affiliate tags yet.
4. **In travel, people pay for "when should I book?"** Hopper built its business
   on that. For us it would mean watching the one trip someone picked until they
   book it.

## Testing without constantly changing prices

- **Watch behavior, not opinions.** "If I asked people what they wanted they'd
  say a faster horse." A click on a price is an answer; a survey reply isn't.
- **The "Get Plus" button is already a fake-door test.** It just isn't being
  counted. Add the four counters described below.
- **Hold one price for a set number of visitors** (say 300 who open a resort's
  details), not a set number of days. Then change it once and compare. Traffic
  is too small to show two prices at the same time.
- **Watch five real people plan a trip, without helping.** Note where they slow
  down, and where they say "oh, nice".

## Three Plus shapes to try, one at a time

- **A. "Decide" pass:** calendar, PDF and saved searches (today's Plus).
- **B. "Book at the right time":** watch 1–2 chosen trips (flights and
  off-property hotels) until they're booked, with an email when the price drops.
  Costs SerpApi searches (about $3–9 per member over 3 months), and needs the
  $75 SerpApi plan once there are members.
- **C. Free tool plus affiliate links:** Plus kept tiny, or dropped.

## Counting visitors without third-party tracking (and why cookies don't come into it)

**The idea:** our own server counts four kinds of actions in our own database.
No Google Analytics or anything like it, no cookie, no name, no email, no IP
address:

1. A comparison was run.
2. A resort's details were opened (which resort).
3. A booking link was clicked (which resort, and Kayak, Disney or tickets).
4. A Plus button was clicked (which pass).

Each one is a row like "2026-10-02, booking link, Tokyo, Kayak". The site
already does exactly this for flight searches (`route_searches` stores only the
route and the month, deliberately nothing about the person), so it's an
existing pattern, not a new kind of thing.

**Why cookies don't come into it.** Cookie rules are about storing something on
a visitor's device, or tracking a person across visits and sites. Counting
"someone clicked Kayak" on our own server does neither.

- **Europe (GDPR and the ePrivacy rules)** requires consent for non-essential
  cookies. Counting with no cookie and no personal data needs no consent banner.
  This matters because some visitors will be looking at Paris.
- **The US** has no general cookie-consent law. California's privacy law
  (CCPA) applies to businesses with roughly $25 million or more in revenue, or
  that handle data on 100,000+ people, or make money selling personal data. As
  far as I know, North Carolina has no comprehensive privacy law yet. Check
  that before launch.
- **The cookies the site already sets** (staying signed in, and the
  coming-soon password) count as "strictly necessary", which every regime
  exempts.

**The trade-off.** With no cookie we count actions, not people. One person
clicking Kayak three times counts as three. For "do people click Plus at $15?"
that's fine: what matters is the clicks out of every 100 detail views.

**Still worth one line in the privacy policy** (drafts are in `docs/legal/`),
something like: "We count anonymous page actions, such as which resorts are
viewed and which booking links are clicked, without cookies or anything that
identifies you."

**The ready-made alternative:** Plausible or Fathom are paid, cookie-free
analytics services (about $9 a month or more). Less to build, but they are a
third party and one more monthly bill.

None of the above is legal advice. It's a summary to check with whoever
reviews the terms and privacy pages.
