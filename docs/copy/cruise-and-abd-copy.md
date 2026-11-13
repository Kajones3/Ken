# Cruise and Adventures by Disney copy (for the owner to rewrite)

Every piece of wording a traveler reads on the cruise and Adventures by Disney
pages, in one place. Write over any line below and send it back; Claude puts
it in. Text in {braces} is filled in by the site (a price, a date, a port).

## The headline (home page)
- Headline: **A World of Magic / in One Search.**
- Under it: The whole trip, flights, hotel, tickets and food, priced at every
  Disney resort in the world, with Disney cruises and Adventures by Disney too.

## The one line above the trips (not Planner Pro)
- Signed out: Disney Cruise Line sails and Adventures by Disney has trips in
  {month}. Button: Become a Planner, free, to learn more
- Free account: Also in {month}: {count} Disney Cruise sailings and an
  Adventures by Disney trip from under {$X} a person. Planner Pro prices them
  for your party. Button: See what Planner Pro adds

## Cruise page
- Cruise fare: {room} · taxes, fees and port expenses included
- Estimated for your party: Disney's price we have is for {party}. Disney
  charges the 3rd and 4th guest in a stateroom about {54}% of what the first
  two pay ... Check the exact price on Disney's site.
- Getting to the ship (flying): Disney asks you to land by {time} on sailing
  day, so no hotel the night before.
- Getting to the ship (driving, no fare yet): We haven't found a fare from
  {home} to {airport} for this sailing yet, so we priced driving.
- Gratuities: Disney's recommended amount, added to your onboard account
- Port adventures: One typical Disney port adventure for each guest at each
  stop (Disney's own listings) · under 3 free
- Where you'll go: one short paragraph + "Ideas" per port. These live in
  `src/portInfo.ts`; rewrite any of them here:
  - Galveston, Port Canaveral, Fort Lauderdale, San Diego, Vancouver
  - Castaway Cay, Lookout Cay, Nassau, Cozumel, Progreso, Ensenada, Cabo San
    Lucas, Catalina Island, Skagway, Juneau, Ketchikan
- Weather: What each port is typically like · averages, not a forecast
- On board the {ship}: comes from /admin -> Ships

## Adventures by Disney page
- Trip price: Adventures by Disney's own price for this departure, per person
- Flights: {home} to {airport} and back · {dates}. "Checked on Google Flights
  just now." / "Flights to {city} from the US fly overnight, so this leaves
  the evening before day 1."
- Not in this price yet: Meals the trip doesn't include · Tips for your
  Adventure Guides. "Adventures by Disney lists what's included on the trip's
  own page."
- Who it's for: Ages {N} and up. / This departure is for adults only.

## Not written yet (ideas for your copy)
- A short "What a Disney cruise includes" paragraph (meals, shows, kids clubs
  are in the fare; drinks, port adventures and gratuities are not).
- A short "What Adventures by Disney is" paragraph (small guided group, most
  meals and all activities included, Adventure Guides with you throughout).
- One line per ship for its card (the Ships page holds facts only).
