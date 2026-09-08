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
