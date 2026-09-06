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

create table if not exists users (
  id            uuid primary key,
  email         text unique not null,
  plus_until    date,
  created_at    timestamptz not null default now()
);

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

create table if not exists price_alerts (
  id          uuid primary key,
  trip_id     uuid not null references saved_trips(id) on delete cascade,
  kind        text not null check (kind in ('total_drop','crossed_your_number')),
  resort_id   text,
  old_total   numeric(10,2) not null,
  new_total   numeric(10,2) not null,
  detail      text not null default '',
  fired_at    timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists price_alerts_trip on price_alerts (trip_id, fired_at desc);

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
