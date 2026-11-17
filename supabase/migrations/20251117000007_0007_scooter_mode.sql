-- MeetSync 3D — 0007: scooter travel mode in the route_estimates CHECK
-- ---------------------------------------------------------------------------
-- The app's travel modes changed: 'bike' (bicycle) was replaced by
-- 'scooter' (two-wheeler, user choice 2026-11-17). The route_estimates
-- CHECK constraint from migration 0001 still lists 'bike', so it must
-- allow 'scooter' too.
--
-- No rows are rewritten: nothing writes to route_estimates today
-- (estimates are computed client-side; the table is reserved for
-- future server-computed estimates), but 'bike' is RETAINED in the
-- allowed set so any pre-existing rows stay valid. The app no longer
-- emits 'bike'.
--
-- Idempotent: the old constraint is dropped only if its definition
-- still mentions 'bike', and the new constraint is added only if a
-- constraint of that name does not already exist. Apply via the
-- Supabase Dashboard SQL Editor, after migrations 0001–0006.
-- ---------------------------------------------------------------------------

do $$
declare
  v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.route_estimates'::regclass
    and pg_get_constraintdef(oid) like '%bike%';
  if v_conname is not null then
    execute format('alter table public.route_estimates drop constraint %I', v_conname);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'route_estimates_mode_check'
  ) then
    alter table public.route_estimates
      add constraint route_estimates_mode_check
      check (mode in ('walk', 'scooter', 'car', 'transit', 'bike'));
  end if;
end
$$;

comment on column public.route_estimates.mode is 'Travel mode: walk, scooter (two-wheeler), car, transit. bike is retained only for pre-existing rows; the app no longer emits it.';
