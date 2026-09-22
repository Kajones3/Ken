-- Parkfare schema. Safe to run repeatedly.

create table if not exists flight_prices (
  origin        char(3)      not null,
  destination   char(3)      not null,
  depart_date   date         not null,
  trip_length   smallint     not null,
  price_usd     numeric(9,2) not null check (price_usd > 0),
  carrier       text,
  stops         smallint     not null default 0,
  deep_link     text,
  fetched_at    timestamptz  not null default now(),
  primary key (origin, destination, depart_date, trip_length)
);
create index if not exists flight_prices_lookup
  on flight_prices (origin, destination, trip_length, depart_date);

create table if not exists hotel_rates (
  hotel_id      text         not null,
  resort_id     text         not null,
  hotel_name    text         not null,
  descriptor    text         not null default '',
  stay_date     date         not null,
  nightly_usd   numeric(9,2) not null check (nightly_usd > 0),
  tier          text         not null,
  on_property   boolean      not null,
  deep_link     text,
  fetched_at    timestamptz  not null default now(),
  primary key (hotel_id, stay_date)
);
create index if not exists hotel_rates_lookup
  on hotel_rates (resort_id, stay_date, tier);

-- No public API exists for park tickets at any of the six resorts.
-- These rows are maintained by hand against each resort's published calendar.
create table if not exists ticket_prices (
  resort_id     text         not null,
  park_date     date         not null,
  adult_usd     numeric(9,2) not null check (adult_usd > 0),
  child_usd     numeric(9,2) not null,
  junior_usd    numeric(9,2),
  source_url    text,
  updated_at    timestamptz  not null default now(),
  primary key (resort_id, park_date)
);

-- No official Disney promo API — fan sites and memory are the only source,
-- and nothing here is guaranteed to repeat. Hand-maintained by the owner,
-- same precedent as ticket_prices. Plus-only to apply; free to browse.
create table if not exists promos (
  id            uuid primary key,
  resort_id     text,                 -- null = applies to all resorts
  label         text not null,
  effect_kind   text not null check (effect_kind in
                  ('room_pct_off','room_flat_off','free_dining','ticket_pct_off','flat_off_total')),
  effect_value  numeric(8,3) not null default 0,
  starts_on     date not null,
  ends_on       date not null,
  historical    boolean not null default true,
  source_note   text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists promos_lookup on promos (resort_id, starts_on, ends_on) where active;

-- One row per day, national average only. Free EIA API when EIA_API_KEY is
-- set, mock (plausible, no account) otherwise — same pattern as everything
-- else with no live default. Small time series so the alert job can compare
-- "gas price when this trip was saved" against "gas price now".
create table if not exists gas_prices (
  as_of                date         primary key,
  price_per_gallon_usd numeric(6,3) not null,
  source               text         not null default '',
  fetched_at           timestamptz  not null default now()
);

create table if not exists users (
  id            uuid primary key,
  email         text unique not null,
  plus_until    date,
  created_at    timestamptz not null default now()
);

-- No password, no OAuth — an email identifies a session. Right call for a
-- friends demo, not for a public launch: anyone who knows a friend's email
-- can sign in as them. Cheap to upgrade later to a one-time emailed link.
create table if not exists sessions (
  token       text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '90 days'
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists saved_trips (
  id             uuid primary key,
  user_id        uuid not null references users(id) on delete cascade,
  label          text not null default '',
  params         jsonb not null,
  overrides      jsonb not null default '{}'::jsonb,
  baseline_total numeric(10,2) not null,
  baseline_at    timestamptz not null default now(),
  threshold_pct  numeric(4,1) not null default 5.0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists saved_trips_active on saved_trips (active) where active;

-- A free-form Plus feature: "extra planning expenses" (VIP tours, PhotoPass,
-- anything not modeled elsewhere) the user attaches to a saved trip. This is
-- the user's own claim about their own price, same trust model as a
-- personal promo or a typed nightly rate — never verified, never shared.
create table if not exists custom_expenses (
  id       uuid primary key,
  trip_id  uuid not null references saved_trips(id) on delete cascade,
  label    text not null,
  amount_usd numeric(10,2) not null check (amount_usd >= 0),
  created_at timestamptz not null default now()
);
create index if not exists custom_expenses_trip on custom_expenses (trip_id);

-- Geocode results cache for the driving-mode "Departing from" search box —
-- see src/geo/cache.ts. Nominatim's usage policy requires caching, and this
-- also means a repeated search (e.g. "Atlanta" typed by two different
-- people) costs one real lookup, not two.
create table if not exists geocode_cache (
  query_text text primary key,
  results    jsonb not null,
  cached_at  timestamptz not null default now()
);

create table if not exists price_alerts (
  id          uuid primary key,
  trip_id     uuid not null references saved_trips(id) on delete cascade,
  kind        text not null check (kind in ('total_drop','crossed_your_number','gas_price_change','new_promo')),
  resort_id   text,
  old_total   numeric(10,2) not null,
  new_total   numeric(10,2) not null,
  detail      text not null default '',
  fired_at    timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists price_alerts_trip on price_alerts (trip_id, fired_at desc);
-- create table if not exists is a no-op on a database that already has this
-- table, so the check constraint above never widens on its own — this
-- re-applies it every run, safe to run repeatedly like the rest of this file.
alter table price_alerts drop constraint if exists price_alerts_kind_check;
alter table price_alerts add constraint price_alerts_kind_check
  check (kind in ('total_drop','crossed_your_number','gas_price_change','new_promo'));

-- Tracks which RSS items the news-digest job has already emailed about, so
-- a re-run of the same feed only reports genuinely new items. See
-- src/jobs/newsDigest.ts and NEWS_FEEDS in config.ts — private, owner-only,
-- never surfaced to end users.
create table if not exists news_seen (
  url         text        primary key,
  first_seen  timestamptz not null default now()
);

-- Every refresh run is logged. When prices look wrong in three months,
-- this is how you find out why.
create table if not exists fetch_runs (
  id          uuid primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  calls       integer not null default 0,
  rows_written integer not null default 0,
  errors      integer not null default 0,
  note        text not null default ''
);

-- Historical baseline fares from the BTS DB1B Market survey (real US-carrier-
-- reported itinerary data, free, no API key — see src/jobs/btsBaseline.ts).
-- One row per (origin, destination, quarter) — quarters are never merged
-- into each other, since a fare from 2023 and one from 2025 aren't
-- fungible; the fare_trend multiplier is what turns an old quarter into a
-- present-day estimate, not averaging across quarters here.
create table if not exists historical_fares (
  origin              char(3)      not null,
  destination         char(3)      not null,
  year                smallint     not null,
  quarter             smallint     not null check (quarter between 1 and 4),
  avg_fare_usd        numeric(9,2) not null check (avg_fare_usd > 0),
  passengers_sampled  integer      not null default 0,
  itin_count          integer      not null default 0,
  source              text         not null default 'bts_db1b',
  fetched_at          timestamptz  not null default now(),
  primary key (origin, destination, year, quarter)
);
create index if not exists historical_fares_lookup on historical_fares (origin, destination);

-- The trend multiplier that turns a BTS historical baseline into a present-day
-- estimate: how much current real Travelpayouts fares differ from the BTS
-- baseline, averaged (trimmed) across whichever routes we have both for right
-- now. A time series like gas_prices, not a single upserted row — so when an
-- estimate looks wrong in three months, the history of how the multiplier
-- moved is still here. Read the latest row; see src/jobs/fareTrend.ts.
create table if not exists fare_trend (
  id               uuid primary key,
  multiplier       numeric(6,4) not null check (multiplier > 0),
  low_multiplier   numeric(6,4) not null check (low_multiplier > 0),
  high_multiplier  numeric(6,4) not null check (high_multiplier > 0),
  sample_routes    integer      not null default 0,
  basis_quarter    text         not null,
  computed_at      timestamptz  not null default now()
);
create index if not exists fare_trend_latest on fare_trend (computed_at desc);

-- A route average hides the thing a traveller actually cares about: the
-- spread. DB1B holds every itinerary's fare, so store real percentiles per
-- route/quarter rather than only the mean — the shown estimate is built on
-- the MEDIAN (p50), with p25/p75 as the Low/High band. Added after the
-- average alone produced estimates far below what a click-through actually
-- cost: an average is dragged down by deep-discount and partial-itinerary
-- fares that nobody searching a family trip will ever be quoted.
alter table historical_fares add column if not exists p25_fare_usd    numeric(9,2);
alter table historical_fares add column if not exists median_fare_usd numeric(9,2);
alter table historical_fares add column if not exists p75_fare_usd    numeric(9,2);

-- What people actually search. The nightly job spends its (paid, metered)
-- real-fare lookups on the busiest routes rather than on all 209 possible
-- ones, and every other route is estimated from its BTS median moved by the
-- trend those real lookups measure. One row per (origin, destination,
-- departure month); `searches` is a running count, never reset, and
-- `last_searched_at` is what decays an old-but-once-popular route out of
-- the nightly set. No user id and no session id — this is route popularity,
-- not per-person history, and it must stay that way.
create table if not exists route_searches (
  origin           char(3)     not null,
  destination      char(3)     not null,
  depart_month     char(7)     not null,          -- YYYY-MM
  searches         integer     not null default 0,
  last_searched_at timestamptz not null default now(),
  primary key (origin, destination, depart_month)
);
create index if not exists route_searches_popular
  on route_searches (searches desc, last_searched_at desc);

-- Which provider wrote a fare row. The trend multiplier that moves every
-- estimated route is only as good as the real fares it is measured from, so
-- it must be able to exclude a source it does not trust: Travelpayouts'
-- calendar endpoint returns city-level, wrong-duration, hour-expiry fares
-- that survive filtering only occasionally and skew cheap, and averaging
-- those into the trend would drag every estimate in the app down with them.
-- Nullable with no default so existing rows stay honestly unlabelled rather
-- than being retroactively claimed by whichever provider is current.
alter table flight_prices add column if not exists source text;
create index if not exists flight_prices_source on flight_prices (source);

-- Exact live fare lookups, the one thing a user can spend real money on by
-- clicking. Every lookup is metered by the provider, so both a per-user and
-- a whole-site daily ceiling are enforced server-side before any call goes
-- out. One row per user per day; `global` is a reserved user_id holding the
-- site-wide tally for that day, so one query answers both questions and
-- neither cap can be bypassed by the other being fine.
--
-- Deliberately only a counter — no route, no date, no trip contents. What a
-- Plus user looked up is their business; all this needs to know is how many.
create table if not exists exact_fare_usage (
  user_id   text        not null,       -- a users.id, or the literal 'global'
  day       date        not null,
  lookups   integer     not null default 0,
  spent_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- Optional password on an account. Nullable on purpose: an account with no
-- hash keeps the original email-only sign-in, so setting a password locks
-- down one account without breaking every comped friend account at once.
-- Stored as a scrypt hash with a per-account random salt, never plaintext.
-- See hashPassword()/verifyPassword() in src/auth.ts.
alter table users add column if not exists password_hash text;

-- Which provider wrote a hotel row, mirroring flight_prices.source above.
-- Without it there is no way to tell a rate a vendor actually returned from
-- one the mock provider invented, which is exactly the question the daily
-- real-pulls digest exists to answer (see src/jobs/pullsDigest.ts).
-- Nullable with no default, so rows written before this existed stay
-- honestly unlabelled rather than being claimed by whoever is current.
alter table hotel_rates add column if not exists source text;
create index if not exists hotel_rates_source on hotel_rates (source, fetched_at);

-- The digest scans flight_prices by when a row was fetched, not by route.
create index if not exists flight_prices_fetched_at on flight_prices (fetched_at);

-- ---------------------------------------------------------------------------
-- Profile: things a signed-in traveller tells us about themselves, as opposed
-- to things they tell us about one trip.
--
-- Free, deliberately. An account is free, saving a trip is Plus, and
-- remembering which airport you fly out of is neither — it is a convenience
-- that costs nothing to serve, and paywalling it would be the "no search
-- quota" mistake wearing a different hat.
--
-- Nullable with no default: "I haven't said" and "I fly from Atlanta" are
-- different facts, and a default would quietly turn the first into the
-- second for every account that already exists.
--
-- On `users` rather than its own table because there is one field. If the
-- profile grows past a handful (a souvenir budget, attraction preferences),
-- move it to a `user_profile` table keyed on user_id — identity and
-- entitlement living in the same row as free-form taste data gets muddy fast.
alter table users add column if not exists home_airport text;

-- Which attractions a traveller says they care about. Plus-only to SET (the
-- personalisation is the feature); the ATTRACTIONS list itself is public,
-- exactly as a curated promo is public to browse but Plus to apply.
--
-- Its own table rather than a column on users: it is a list, and the profile
-- had already reached the "move it out before it gets muddy" point flagged
-- when home_airport went on `users`.
--
-- attraction_id is a plain text key into config.ts's ATTRACTIONS, with no
-- foreign key — the list lives in code, not in the database, and a pick must
-- survive an attraction being removed from it (resolvePicks drops unknown
-- ids rather than breaking the board).
create table if not exists user_attractions (
  user_id       uuid not null references users(id) on delete cascade,
  attraction_id text not null,
  added_at      timestamptz not null default now(),
  primary key (user_id, attraction_id)
);

-- ---------------------------------------------------------------------------
-- Email verification. Nothing anywhere confirmed that an address belonged to
-- whoever typed it, which is the gap CLAUDE.md has flagged since accounts
-- were built: a password protects an existing account but does not stop
-- somebody claiming a fresh one on your address.
--
-- Nullable with no default, and NOT backfilled: an account that existed
-- before this is honestly unverified rather than grandfathered in, because
-- claiming it verified would be asserting something nobody ever checked.
alter table users add column if not exists email_verified_at timestamptz;

-- One outstanding link per account (primary key on user_id, upserted), so
-- asking for a new link silently invalidates the old one — a link sent to
-- the wrong person stops working the moment the right person asks again.
create table if not exists email_verifications (
  user_id     uuid primary key references users(id) on delete cascade,
  token       text unique not null,
  expires_at  timestamptz not null,
  sent_at     timestamptz not null default now()
);
create index if not exists email_verifications_token on email_verifications (token);

-- Owner-editable settings. The DEFAULT for every one of these still lives in
-- config.ts; a row here overrides it. That direction matters: an empty table
-- must behave exactly like the app did before this existed, so a fresh
-- database, a failed migration or a wiped table degrades to the shipped
-- values rather than to nothing.
--
-- Why a key/value table rather than a column per setting: the whole point is
-- that the owner can change a number without anyone editing code, and a new
-- editable value should not require a migration. The registry in config.ts
-- (SETTINGS) supplies the label, type and validation for each key, so this
-- table stays dumb and the meaning stays in one place.
--
-- note/updated_by exist because a hand-set number with no explanation is
-- indistinguishable from a typo six months later.
create table if not exists owner_settings (
  key        text primary key,
  value      jsonb not null,
  note       text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

-- Failed sign-in attempts, so guessing a password costs time.
--
-- Keyed by SCOPE rather than by user, and counted for addresses that have no
-- account at all, because the sign-in route must behave identically whether or
-- not an email is registered — a lockout that only happens for real accounts
-- is an account-enumeration oracle wearing a security feature's clothes.
--
-- Two scopes are counted independently: "email|someone@example.com" protects
-- one account, and "ip|1.2.3.4" stops somebody cycling through addresses from
-- one machine.
create table if not exists signin_attempts (
  scope         text primary key,
  fails         int not null default 0,
  first_fail_at timestamptz not null default now(),
  locked_until  timestamptz
);

-- One outstanding password-reset link per account, upserted on user_id exactly
-- like email_verifications: asking for a new link takes the old one out of
-- play, so a link that reached the wrong inbox stops working the moment the
-- right person asks again.
--
-- Shorter-lived than a confirmation link. A confirmation link only proves an
-- address; a reset link hands over an account.
create table if not exists password_resets (
  user_id    uuid primary key references users(id) on delete cascade,
  token      text unique not null,
  expires_at timestamptz not null,
  sent_at    timestamptz not null default now()
);
create index if not exists password_resets_token on password_resets (token);

-- Fares the owner has seen with their own eyes.
--
-- NOT a price the app then quotes. A correction is EVIDENCE: it joins the
-- same route/quarter machinery a bought SerpApi fare already feeds, moves
-- that route's estimate, and the result stays labelled an estimate. The
-- owner's words for it: "another data point, a weighted data point to help
-- us update our estimated cache price".
--
-- Deliberately its OWN table rather than a row in flight_prices, for three
-- reasons that are each a rule elsewhere in this project:
--   * flight_prices is what a vendor actually returned. Writing a person's
--     figure in beside them would make the real-pulls digest report a pull
--     that never happened, and would feed the fare trend a number no
--     provider quoted. Mock and unlabelled rows are excluded there and
--     footnoted, never folded in; a hand-typed fare is the same kind of
--     thing.
--   * a correction has a BAND — was that the cheap end, the usual, or the
--     expensive end — which a cached quote does not.
--   * a correction has to be removable. A typo must be deletable by id
--     without touching anything a provider paid for.
--
-- `expires_on` is the answer to "a 2026 fare should not still be steering a
-- 2029 estimate": a row stops counting after it, and separately stops
-- counting once its own travel date has passed.
create table if not exists fare_corrections (
  id           uuid primary key,
  origin       text not null,
  destination  text not null,
  depart_date  date not null,
  nights       int,
  price_usd    numeric(9,2) not null,
  -- low = "that was the cheap end", typical = "that is what it usually goes
  -- for", high = "that was the expensive end". They inform p25 / median / p75
  -- respectively rather than all pretending to be the midpoint.
  band         text not null default 'typical'
                 check (band in ('low','typical','high')),
  note         text not null default '',
  expires_on   date not null,
  created_by   text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists fare_corrections_route
  on fare_corrections (origin, destination, depart_date);

-- The owner's own attraction list, as an OVERLAY on the one in config.ts —
-- never a replacement for it. Same safety property as owner_settings, and for
-- the same reason: an empty table, a wiped row or a row the code no longer
-- considers valid must leave the app behaving exactly as it did before any of
-- this existed. A list is the one place where "the database is the truth"
-- would be genuinely dangerous — a failed migration or a bad import would
-- empty the attractions picker for everybody, silently.
--
-- Three things a row can do, decided by which fields it carries:
--   * an id that matches a shipped attraction REPLACES its name, resorts and
--     note;
--   * an id that matches nothing ADDS an attraction;
--   * hidden = true takes one out of the list, which is how a shipped row is
--     removed without editing code.
--
-- resort_ids is stored as a comma-separated text field rather than an array
-- so PGlite and Postgres behave identically — every other list in this schema
-- does the same. It is parsed and re-validated on the way out, so a resort id
-- that stops existing degrades to "this row is not applied" rather than to an
-- attraction that belongs to nowhere.
create table if not exists owner_attractions (
  id          text primary key,
  name        text not null default '',
  resort_ids  text not null default '',
  note        text not null default '',
  hidden      boolean not null default false,
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);

-- Wait-time observations, recorded and nothing else. NOTHING READS THIS YET
-- and that is deliberate.
--
-- The owner wanted an "average wait this month" card beside the weather box,
-- on the condition that all six resorts could have one. Two things killed the
-- card and neither killed the data:
--
--   * Every automated source records POSTED waits. TouringPlans, who measure
--     actual waits with a stopwatch, publish that Disney over-states by
--     roughly 11.5-15.5 minutes a day depending on season. So an average
--     built from any feed is an average of what a park CLAIMS.
--   * That bias is only harmless if all six inflate equally, and there is no
--     reason to think they do — Tokyo is run by Oriental Land Co. under
--     licence, and Paris and Shanghai post on their own systems. A
--     non-uniform bias distorts the comparison rather than just the number,
--     which is the same trap as the ERA5 rain-day count.
--
-- But elapsed time is the one input that cannot be bought later. Thrill Data
-- only has an archive going back to 2019 because it started in 2019. So this
-- records from today and the decision about what, if anything, to show with
-- it gets made in a year against real data.
--
-- local_hour is stored AT WRITE TIME and is load-bearing. A fixed UTC poll
-- time is a fixed LOCAL time per park, so without it Orlando would be sampled
-- at its quiet morning while Shanghai got its busy afternoon — a timezone
-- bias walking straight into the six-resort comparison. Aggregating later has
-- to average by local hour before averaging across hours.
create table if not exists wait_time_samples (
  park_id       int          not null,
  observed_at   timestamptz  not null,
  resort_id     text         not null,
  local_hour    smallint     not null,
  mean_wait_min numeric(5,1) not null,
  max_wait_min  int          not null,
  open_rides    int          not null,
  source        text         not null default 'queue_times',
  primary key (park_id, observed_at)
);
create index if not exists wait_time_samples_month
  on wait_time_samples (resort_id, observed_at);
