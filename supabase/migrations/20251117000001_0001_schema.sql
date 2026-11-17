-- MeetSync 3D — 0001: core schema
-- Extensions, tables, constraints, indexes, triggers, invite-code generator.
-- Apply with: supabase db push   (or paste into the Supabase SQL editor, in order)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Secure invite-code generator: 6 chars from an unambiguous alphabet
-- (no 0/O, 1/I/l) using gen_random_bytes (cryptographically random).
create or replace function public.generate_invite_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea;
  code text := '';
  i int;
begin
  bytes := gen_random_bytes(6);
  for i in 0..5 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- meeting_rooms
-- NOTE: finalized_spot_id FK is added AFTER candidate_spots exists
-- (the two tables reference each other).
-- ---------------------------------------------------------------------------

create table if not exists public.meeting_rooms (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null default public.generate_invite_code(),
  title text not null check (char_length(btrim(title)) between 3 and 60),
  host_auth_uid uuid,
  status text not null default 'lobby'
    check (status in ('lobby', 'discovering', 'comparing', 'finalized', 'expired')),
  finalized_spot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint meeting_rooms_invite_code_unique unique (invite_code),
  constraint meeting_rooms_invite_code_format
    check (invite_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$')
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meeting_rooms (id) on delete cascade,
  auth_uid uuid not null,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 30),
  avatar_color text not null default '#3B82F6',
  is_host boolean not null default false,
  is_ready boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint participants_room_auth_unique unique (room_id, auth_uid)
);

create table if not exists public.participant_locations (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null unique references public.participants (id) on delete cascade,
  room_id uuid not null references public.meeting_rooms (id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  label text not null default '',
  accuracy_m integer,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours')
);

create table if not exists public.candidate_spots (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meeting_rooms (id) on delete cascade,
  name text not null,
  category text not null default 'Spot',
  address text not null default '',
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  rating numeric(2, 1) not null default 0 check (rating between 0 and 5),
  price_level integer not null default 1 check (price_level between 1 and 3),
  open_now boolean not null default true,
  created_at timestamptz not null default now(),
  source text not null default 'manual'
);

-- Now the circular FK can be added safely.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meeting_rooms_finalized_spot_fk'
  ) then
    alter table public.meeting_rooms
      add constraint meeting_rooms_finalized_spot_fk
      foreign key (finalized_spot_id) references public.candidate_spots (id) on delete set null;
  end if;
end
$$;

create table if not exists public.route_estimates (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meeting_rooms (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  spot_id uuid not null references public.candidate_spots (id) on delete cascade,
  mode text not null check (mode in ('walk', 'bike', 'car', 'transit')),
  distance_m integer not null check (distance_m >= 0),
  duration_min integer not null check (duration_min >= 0),
  created_at timestamptz not null default now(),
  constraint route_estimates_unique unique (room_id, participant_id, spot_id, mode)
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meeting_rooms (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  spot_id uuid not null references public.candidate_spots (id) on delete cascade,
  rank integer not null check (rank >= 1),
  created_at timestamptz not null default now(),
  constraint votes_unique unique (room_id, participant_id, spot_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists idx_meeting_rooms_invite_code on public.meeting_rooms (invite_code);
create index if not exists idx_meeting_rooms_expires_at on public.meeting_rooms (expires_at);
create index if not exists idx_participants_room_id on public.participants (room_id);
create index if not exists idx_participants_auth_uid on public.participants (auth_uid);
create index if not exists idx_participant_locations_room_id on public.participant_locations (room_id);
create index if not exists idx_participant_locations_expires_at on public.participant_locations (expires_at);
create index if not exists idx_candidate_spots_room_id on public.candidate_spots (room_id);
create index if not exists idx_route_estimates_room_id on public.route_estimates (room_id);
create index if not exists idx_votes_room_id on public.votes (room_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

drop trigger if exists set_updated_at on public.meeting_rooms;
create trigger set_updated_at
  before update on public.meeting_rooms
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.participant_locations;
create trigger set_updated_at
  before update on public.participant_locations
  for each row execute function public.set_updated_at();
