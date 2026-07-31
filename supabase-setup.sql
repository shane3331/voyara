-- Voyara persistence. Paste this whole file into the Supabase SQL editor
-- and press Run. Safe to run twice.

-- ============================================================
-- WAITLIST . real demand capture, works before you can sell anything
-- ============================================================
create table if not exists waitlist (
  id          bigserial primary key,
  email       text not null,
  name        text,
  source      text default 'site',
  referrer    text,
  created_at  timestamptz not null default now()
);
create unique index if not exists waitlist_email_key on waitlist (lower(email));

-- ============================================================
-- AUDIT EVENTS . hash chained, append only
-- Each row hashes the row before it. Editing a row directly in the
-- database breaks the chain and verification reports where.
-- ============================================================
create table if not exists audit_events (
  seq            bigserial primary key,
  type           text not null,
  actor          text not null default 'system',
  subject_type   text,
  subject_id     text,
  payload        jsonb not null default '{}'::jsonb,
  previous_hash  text not null,
  event_hash     text not null unique,
  occurred_at    timestamptz not null default now()
);
create index if not exists audit_subject_idx on audit_events (subject_type, subject_id);

-- Append is done inside a single transaction with a lock so two
-- concurrent writers cannot both read the same previous hash and
-- fork the chain. This is the part that makes it real rather than
-- decorative.
create or replace function append_audit(
  p_type text,
  p_actor text,
  p_payload jsonb,
  p_subject_type text default null,
  p_subject_id text default null
) returns audit_events as $$
declare
  v_prev text;
  v_at   timestamptz := now();
  v_hash text;
  v_row  audit_events;
begin
  perform pg_advisory_xact_lock(hashtext('voyara_audit_chain'));

  select event_hash into v_prev
    from audit_events order by seq desc limit 1;
  if v_prev is null then
    v_prev := repeat('0', 64);
  end if;

  v_hash := encode(digest(
    v_prev || '|' || p_type || '|' || to_char(v_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || p_payload::text,
    'sha256'), 'hex');

  insert into audit_events (type, actor, payload, subject_type, subject_id, previous_hash, event_hash, occurred_at)
  values (p_type, p_actor, p_payload, p_subject_type, p_subject_id, v_prev, v_hash, v_at)
  returning * into v_row;

  return v_row;
end;
$$ language plpgsql security definer;

-- digest() lives in pgcrypto
create extension if not exists pgcrypto;

-- ============================================================
-- TRIPS . so a saved trip survives a refresh
-- ============================================================
create table if not exists trips (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  title       text not null,
  starts_on   date,
  ends_on     date,
  status      text not null default 'MONITORED',
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists trips_email_idx on trips (lower(email));

-- ============================================================
-- Row level security. These tables are only ever written by the
-- server using the service role key, never from the browser.
-- ============================================================
alter table waitlist enable row level security;
alter table audit_events enable row level security;
alter table trips enable row level security;

-- ============================================================
-- MEMBERSHIPS . the actual revenue line
-- ============================================================
create table if not exists memberships (
  id                     uuid primary key default gen_random_uuid(),
  email                  text not null,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  tier                   text not null default 'founding',
  status                 text not null default 'pending',
  amount_minor           integer,
  currency               text default 'usd',
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists memberships_email_key on memberships (lower(email));
create index if not exists memberships_status_idx on memberships (status);

-- ============================================================
-- WEBHOOK EVENTS . idempotency
-- Stripe retries webhooks. Without this table a retry would upgrade a
-- membership twice or double count revenue. The primary key is Stripe's
-- own event id, so a repeat is rejected by the database, not by a guess.
-- ============================================================
create table if not exists webhook_events (
  id           text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

alter table memberships enable row level security;
alter table webhook_events enable row level security;

-- ============================================================
-- VILLAS . curated supply, the part competitors cannot copy
-- Edit these rows directly in the Supabase Table Editor as you sign
-- real properties. No code change needed to add a villa.
-- ============================================================
create table if not exists villas (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  location        text not null,
  region          text,
  bedrooms        integer,
  sleeps          integer,
  nightly_minor   integer not null,
  currency        text not null default 'EUR',
  commission_pct  numeric(4,3) default 0.150,
  keep_pct        numeric(4,3) default 0.040,
  summary         text,
  image_id        text,
  status          text not null default 'AVAILABLE',
  sort_order      integer default 100,
  created_at      timestamptz not null default now()
);
create index if not exists villas_status_idx on villas (status, sort_order);

create table if not exists villa_requests (
  id            uuid primary key default gen_random_uuid(),
  villa_slug    text not null,
  email         text not null,
  name          text,
  arrive_on     date,
  depart_on     date,
  guests        integer,
  notes         text,
  status        text not null default 'NEW',
  created_at    timestamptz not null default now()
);
create index if not exists villa_requests_status_idx on villa_requests (status, created_at desc);

alter table villas enable row level security;
alter table villa_requests enable row level security;

-- Seed collection. Replace these with real properties as you sign them.
insert into villas (slug, name, location, region, bedrooms, sleeps, nightly_minor, currency, summary, image_id, sort_order)
values
 ('casa-aurelia','Casa Aurelia','Amalfi Coast, Italy','Mediterranean',5,10,420000,'EUR','Cliffside terraces above Praiano. Staffed, with a boat on call.','photo-1516483638261-f4dbaf036963',10),
 ('villa-thalia','Villa Thalia','Mykonos, Greece','Greek Islands',6,12,510000,'EUR','Whitewashed and end of the road, with an infinity pool facing the sunset.','photo-1613395877344-13d4a8e0d49e',20),
 ('lacustre','Lacustre','Lake Como, Italy','Italian Lakes',4,8,385000,'EUR','A restored boathouse in Ossuccio. Private jetty, wood fired kitchen.','photo-1520250497591-112f2f40a3f4',30),
 ('mas-de-lourmarin','Mas de Lourmarin','Luberon, France','Provence',5,10,295000,'EUR','A working olive farm with a long table under plane trees.','photo-1502602898657-3e91760cbb34',40),
 ('finca-benirras','Finca Benirras','Ibiza, Spain','Balearics',6,12,440000,'EUR','Above the bay, twenty minutes from anywhere you want to be at 2am.','photo-1566073771259-6a8506099945',50),
 ('riad-el-fenn','Casa Zahra','Marrakech, Morocco','North Africa',4,8,215000,'EUR','A riad three streets from Jemaa el Fna, silent behind its own door.','photo-1539020140153-e479b8c22e70',60),
 ('podere-santa-lucia','Podere Santa Lucia','Val d''Orcia, Italy','Tuscany',5,10,265000,'EUR','Cypress drive, stone farmhouse, the whole valley to yourself.','photo-1523906834658-6e24ef2386f9',70),
 ('maison-des-vents','Maison des Vents','St Barths','Caribbean',4,8,680000,'EUR','Gustavia harbour below, trade winds through the whole house.','photo-1512453979798-5ea266f8880c',80)
on conflict (slug) do nothing;

-- ============================================================
-- COLLECTIONS . curated destinations that run a live search
-- A collection is editorial framing plus a real place. Opening one
-- searches live inventory for that destination, so the copy is curated
-- but the rates are never stale.
-- ============================================================
create table if not exists collections (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  subtitle    text,
  destination text not null,
  narrative   text,
  image_id    text,
  nights      integer not null default 5,
  lead_days   integer not null default 45,
  status      text not null default 'PUBLISHED',
  sort_order  integer default 100,
  created_at  timestamptz not null default now()
);
create index if not exists collections_status_idx on collections (status, sort_order);
alter table collections enable row level security;

insert into collections (slug, title, subtitle, destination, narrative, image_id, nights, lead_days, sort_order)
values
 ('la-dolce-vita','La dolce vita','Amalfi Coast, Italy','Positano',
  'Cliffside terraces, lemon groves, and a coastline best seen from a boat. Go in shoulder season and the road is yours.',
  'photo-1516483638261-f4dbaf036963',5,45,10),
 ('milano-quietly','Milan, quietly','Lombardy, Italy','Milan',
  'Not the fashion week Milan. Courtyards behind heavy doors, aperitivo at six, and the Last Supper booked eight weeks out.',
  'photo-1520440229-6469a149ac59',4,30,20),
 ('cyclades','Meet me in the Cyclades','Mykonos, Greece','Mykonos',
  'White walls, hard light, and a sea that stays warm into October. Book the ferry before the flight.',
  'photo-1613395877344-13d4a8e0d49e',6,60,30),
 ('tokyo-after-dark','Tokyo after dark','Tokyo, Japan','Tokyo',
  'The city rearranges itself at night. Stay central, walk more than you plan to, and let the trains close without you.',
  'photo-1540959733332-eab4deabeeaf',6,75,40),
 ('long-weekend-paris','The long weekend','Paris, France','Paris',
  'Four nights is enough if you stop trying to see everything. One museum, one long lunch, one walk with no destination.',
  'photo-1502602898657-3e91760cbb34',4,21,50),
 ('marrakech','Behind the red walls','Marrakech, Morocco','Marrakech',
  'The medina is loud until you step through a door, and then it is not. Riads are cool, dark, and entirely silent.',
  'photo-1539020140153-e479b8c22e70',5,50,60),
 ('costa-del-sol','The long Spanish summer','Marbella, Spain','Marbella',
  'Late lunches that become dinners. The old town is worth the twenty minutes it takes to walk into.',
  'photo-1566073771259-6a8506099945',7,40,70),
 ('new-york-december','The city in December','New York, USA','New York',
  'Cold enough to justify the coat, bright enough to walk from downtown to the park without noticing.',
  'photo-1496442226666-8d4d0e62e6e9',4,120,80)
on conflict (slug) do nothing;

-- ============================================================
-- FARE WATCH . scan booked flights, act when they get cheaper
--
-- Airlines do not refund a fare drop in cash. There are exactly three
-- windows where a drop can be captured, and this schema records which
-- one was used so every action is explainable afterwards:
--
--   VOID_WINDOW   inside 24h of booking and 7+ days from departure.
--                 US DOT requires a full refund. Rebook clean, cash back.
--   CREDIT        after that. Rebooking issues airline credit, not cash.
--                 Needs traveller approval because it is not strictly better.
--   SCHEDULE      the airline moved the flight materially, which opens
--                 rebooking or refund rights regardless of fare rules.
-- ============================================================
create table if not exists watched_orders (
  id                uuid primary key default gen_random_uuid(),
  order_id          text not null unique,
  email             text not null,
  origin            text not null,
  destination       text not null,
  depart_on         date not null,
  cabin             text not null default 'economy',
  passengers        integer not null default 1,
  carrier           text,
  flight_numbers    text[],
  stops             integer default 0,
  bag_included      boolean default false,
  paid_minor        integer not null,
  currency          text not null default 'USD',
  booked_at         timestamptz not null default now(),
  status            text not null default 'WATCHING',
  best_seen_minor   integer,
  checks_run        integer not null default 0,
  last_checked_at   timestamptz,
  saved_minor       integer not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists watched_status_idx on watched_orders (status, depart_on);
create index if not exists watched_email_idx on watched_orders (lower(email));

-- Every scan is recorded, whether or not anything happened. This is what
-- makes "we checked 412 times" a fact rather than a marketing claim.
create table if not exists fare_checks (
  id              bigserial primary key,
  watched_id      uuid not null references watched_orders(id) on delete cascade,
  checked_at      timestamptz not null default now(),
  best_minor      integer,
  currency        text,
  delta_minor     integer,
  window_type     text,
  match_quality   text,
  actionable      boolean not null default false,
  reason          text
);
create index if not exists fare_checks_watch_idx on fare_checks (watched_id, checked_at desc);

create table if not exists fare_actions (
  id              uuid primary key default gen_random_uuid(),
  watched_id      uuid not null references watched_orders(id) on delete cascade,
  kind            text not null,
  window_type     text not null,
  from_minor      integer not null,
  to_minor        integer not null,
  benefit_minor   integer not null,
  currency        text not null,
  status          text not null default 'PROPOSED',
  idempotency_key text not null unique,
  new_order_id    text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index if not exists fare_actions_status_idx on fare_actions (status, created_at desc);

alter table watched_orders enable row level security;
alter table fare_checks enable row level security;
alter table fare_actions enable row level security;

-- ============================================================
-- SIGNATURE HOTELS . the properties you actually want to be known for
--
-- Bedbank feeds skew mid market, so the best hotels either sit buried or
-- are absent entirely. This is a hand written list. On every search the
-- platform looks for these by name in the live feed:
--   found     pinned to the top with live rates and a Signature mark
--   not found shown as request to book, sourced by an operator
--
-- Add a property here and it appears immediately. No deploy.
-- ============================================================
create table if not exists signature_hotels (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  aliases     text[],
  city        text not null,
  country_code text,
  brand       text,
  note        text,
  image_url   text,
  status      text not null default 'PUBLISHED',
  sort_order  integer default 100,
  created_at  timestamptz not null default now()
);
create index if not exists signature_city_idx on signature_hotels (lower(city), status, sort_order);
alter table signature_hotels enable row level security;

create table if not exists signature_requests (
  id           uuid primary key default gen_random_uuid(),
  hotel_slug   text not null,
  email        text not null,
  arrive_on    date,
  depart_on    date,
  guests       integer,
  notes        text,
  status       text not null default 'NEW',
  created_at   timestamptz not null default now()
);
create index if not exists signature_requests_idx on signature_requests (status, created_at desc);
alter table signature_requests enable row level security;

insert into signature_hotels (slug, name, aliases, city, country_code, brand, note, sort_order) values
 ('the-setai','The Setai',array['Setai Miami Beach'],'Miami','US','Independent','Art deco bones, three pools at different temperatures, and the quietest stretch of sand on Collins.',10),
 ('faena-miami','Faena Hotel Miami Beach',array['Faena'],'Miami','US','Faena','Theatrical in a way nowhere else in Miami attempts. The gilded mammoth is not a joke.',20),
 ('fs-surf-club','Four Seasons Hotel at The Surf Club',array['Surf Club','Four Seasons Surf Club'],'Miami','US','Four Seasons','A 1930s beach club restored by Richard Meier. Le Sirenuse runs the restaurant.',30),
 ('1-hotel-south-beach','1 Hotel South Beach',array['1 Hotel'],'Miami','US','1 Hotels','Reclaimed wood and living walls. The rooftop pool is adults only and worth it.',40),
 ('ritz-south-beach','The Ritz-Carlton South Beach',array['Ritz Carlton South Beach'],'Miami','US','Ritz-Carlton','Morris Lapidus building, properly restored.',50),
 ('mandarin-miami','Mandarin Oriental Miami',array['Mandarin Miami'],'Miami','US','Mandarin Oriental','On Brickell Key, which means water on three sides and no traffic.',60),

 ('portrait-milano','Portrait Milano',array['Portrait Hotel Milano'],'Milan','IT','Lungarno','A former seminary with the largest private courtyard in the city.',10),
 ('bulgari-milano','Bulgari Hotel Milano',array['Bulgari Milan'],'Milan','IT','Bulgari','A private garden bigger than most Milanese parks, hidden behind Via Manzoni.',20),
 ('fs-milano','Four Seasons Hotel Milano',array['Four Seasons Milan'],'Milan','IT','Four Seasons','A fifteenth century convent. The cloister rooms are the ones to ask for.',30),
 ('mandarin-milan','Mandarin Oriental Milan',array['Mandarin Milano'],'Milan','IT','Mandarin Oriental','Four townhouses knitted together off Via Monte Napoleone.',40),
 ('armani-milano','Armani Hotel Milano',array['Armani Milan'],'Milan','IT','Armani','Every object in the room chosen by one man. Severe and calming.',50),

 ('le-sirenuse','Le Sirenuse',array['Sirenuse'],'Positano','IT','Independent','Still family run. The pool terrace at seven in the evening is the whole point of the coast.',10),
 ('il-san-pietro','Il San Pietro di Positano',array['San Pietro Positano'],'Positano','IT','Independent','Carved into the cliff with a lift down to a private beach.',20),
 ('palazzo-avino','Palazzo Avino',array['Palazzo Sasso'],'Positano','IT','Independent','Twelfth century villa in Ravello, above the crowds and the traffic.',30),

 ('bill-and-coo','Bill & Coo Mykonos',array['Bill and Coo'],'Mykonos','GR','Independent','Adults only above Megali Ammos, facing the sunset squarely.',10),
 ('kalesma','Kalesma Mykonos',array['Kalesma'],'Mykonos','GR','Independent','Cycladic architecture done seriously rather than as decoration.',20),
 ('santa-marina','Santa Marina Mykonos',array['Santa Marina'],'Mykonos','GR','Luxury Collection','Its own beach on Ornos Bay, which on Mykonos is close to unheard of.',30),

 ('aman-tokyo','Aman Tokyo',array['Aman'],'Tokyo','JP','Aman','The top six floors of the Otemachi Tower. The lobby is thirty metres tall.',10),
 ('park-hyatt-tokyo','Park Hyatt Tokyo',array['Park Hyatt'],'Tokyo','JP','Park Hyatt','Yes, that one. The New York Bar still earns it.',20),
 ('peninsula-tokyo','The Peninsula Tokyo',array['Peninsula Tokyo'],'Tokyo','JP','Peninsula','Facing the Imperial Palace gardens, which is the view to pay for.',30),
 ('mandarin-tokyo','Mandarin Oriental Tokyo',array['Mandarin Tokyo'],'Tokyo','JP','Mandarin Oriental','Above Nihonbashi, with the best breakfast in the city.',40),

 ('le-bristol','Le Bristol Paris',array['Bristol Paris'],'Paris','FR','Oetker','A courtyard garden in the eighth, and a cat called Fa-Raon.',10),
 ('george-v','Four Seasons Hotel George V',array['George V','George Cinq'],'Paris','FR','Four Seasons','The flowers alone justify the walk through the lobby.',20),
 ('crillon','Hotel de Crillon',array['Crillon'],'Paris','FR','Rosewood','On Place de la Concorde. Four years of restoration, finished properly.',30),
 ('cheval-blanc-paris','Cheval Blanc Paris',array['Cheval Blanc'],'Paris','FR','LVMH','The Seine on one side, the Samaritaine on the other.',40),

 ('the-carlyle','The Carlyle',array['Carlyle'],'New York','US','Rosewood','Bemelmans Bar. Nothing else needs saying.',10),
 ('the-mark','The Mark',array['Mark Hotel'],'New York','US','Independent','Off Madison at 77th, a block from the Met.',20),
 ('aman-new-york','Aman New York',array['Aman NY'],'New York','US','Aman','The Crown Building on Fifth. The garden terrace is five floors up.',30),
 ('greenwich-hotel','The Greenwich Hotel',array['Greenwich Hotel'],'New York','US','Independent','Tribeca, and the Shibui Spa is in a reassembled Kyoto farmhouse.',40),

 ('la-mamounia','La Mamounia',array['Mamounia'],'Marrakech','MA','Independent','Twenty acres of gardens inside the walls, some of them two centuries old.',10),
 ('royal-mansour','Royal Mansour',array['Mansour'],'Marrakech','MA','Independent','Individual riads rather than rooms, each with its own roof terrace.',20),
 ('el-fenn','El Fenn',array['Fenn'],'Marrakech','MA','Independent','A riad in the medina run with more taste than almost anywhere.',30),

 ('marbella-club','Marbella Club Hotel',array['Marbella Club'],'Marbella','ES','Independent','The one that started the Costa del Sol, and still the best of it.',10),
 ('puente-romano','Puente Romano Beach Resort',array['Puente Romano'],'Marbella','ES','Independent','An Andalusian village that happens to be a hotel, with Nobu inside.',20),
 ('finca-cortesin','Finca Cortesin',array['Cortesin'],'Marbella','ES','Independent','Inland toward Casares, and worth the twenty five minutes.',30)
on conflict (slug) do nothing;

-- ============================================================
-- VOYARA CASH . earn on air, burn on stays
--
-- Airlines pay roughly 1%, so air rewards cannot fund themselves. They are
-- funded by hotel margin, which is why Cash is earned on flights and can
-- only be spent against stays. Closed loop, never withdrawable, which also
-- keeps it clear of money transmitter licensing.
-- ============================================================
create table if not exists cash_ledger (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  kind          text not null,                    -- EARN | BURN | EXPIRE | REVERSAL
  amount_minor  integer not null,                 -- positive earn, negative burn
  currency      text not null default 'USD',
  state         text not null default 'PENDING_TRAVEL',
  source        text,
  reference     text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists cash_email_idx on cash_ledger (lower(email), state);
create unique index if not exists cash_ref_idx on cash_ledger (kind, reference) where reference is not null;

-- ============================================================
-- CANCELLATIONS . the half of booking nobody builds
-- ============================================================
create table if not exists cancellations (
  id              uuid primary key default gen_random_uuid(),
  booking_id      text not null,
  vertical        text not null default 'HOTEL',
  email           text not null,
  reason          text,
  policy_snapshot jsonb,
  refund_minor    integer,
  penalty_minor   integer,
  currency        text,
  status          text not null default 'REQUESTED',
  idempotency_key text not null unique,
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index if not exists cancellations_status_idx on cancellations (status, created_at desc);

-- ============================================================
-- INBOUND EMAIL . forwarded confirmations
-- Content hash is the primary key so the same forward twice cannot create
-- two reservations, which is the failure everyone hits first.
-- ============================================================
create table if not exists inbound_emails (
  content_hash  text primary key,
  from_address  text,
  subject       text,
  received_at   timestamptz not null default now(),
  parsed        boolean not null default false,
  parse_result  jsonb,
  trip_id       uuid
);
create index if not exists inbound_parsed_idx on inbound_emails (parsed, received_at desc);

-- ============================================================
-- FLIGHT STATUS OBSERVATIONS . what the disruption engine reads
-- ============================================================
create table if not exists flight_observations (
  id             bigserial primary key,
  ident          text not null,
  observed_at    timestamptz not null default now(),
  status         text,
  scheduled_out  timestamptz,
  estimated_out  timestamptz,
  delay_minutes  integer default 0,
  gate           text,
  terminal       text,
  source         text default 'aeroapi'
);
create index if not exists obs_ident_idx on flight_observations (ident, observed_at desc);

create table if not exists disruptions (
  id            uuid primary key default gen_random_uuid(),
  watched_id    uuid references watched_orders(id) on delete cascade,
  ident         text not null,
  kind          text not null,
  state         text not null default 'DETECTED',
  delay_minutes integer,
  detail        text,
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists disruptions_state_idx on disruptions (state, detected_at desc);

alter table cash_ledger enable row level security;
alter table cancellations enable row level security;
alter table inbound_emails enable row level security;
alter table flight_observations enable row level security;
alter table disruptions enable row level security;

-- ============================================================
-- EXECUTIONS . durability without a workflow engine
--
-- A serverless function can die between calling a supplier and recording
-- what happened. That leaves a real booking nobody knows about, which is
-- the worst failure this system has.
--
-- So: write the intent BEFORE touching the supplier, advance it after each
-- step, and let a recovery pass reconcile anything left stranded. Every
-- step is idempotent, so resuming is always safe.
--
--   STARTED -> SUPPLIER_CALLED -> VERIFIED -> COMPLETE
--                              \-> AMBIGUOUS  (needs reconciliation)
--                              \-> FAILED     (terminal, nothing happened)
-- ============================================================
create table if not exists executions (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  kind             text not null,                 -- HOTEL_BOOK | HOTEL_CANCEL | AIR_BOOK
  state            text not null default 'STARTED',
  intent           jsonb not null default '{}'::jsonb,
  result           jsonb,
  supplier_ref     text,
  attempts         integer not null default 0,
  last_error       text,
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index if not exists exec_state_idx on executions (state, started_at);
create index if not exists exec_stale_idx on executions (state, updated_at)
  where state not in ('COMPLETE', 'FAILED');

alter table executions enable row level security;
