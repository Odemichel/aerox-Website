-- supabase/tests/diagnostic_purchases/stubs.sql
--
-- Socle minimal imitant Supabase et l'état de production (2026-09-24) des
-- objets touchés par la migration `20260924_diagnostic_purchases.sql` :
-- rôles, auth.uid(), droits par défaut du schéma public, table users,
-- diagnostic_basic et ses tables filles, policies, triggers de compteurs.
-- Tests locaux uniquement : `run.sh` l'exécute dans un Postgres jetable.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create extension if not exists pgcrypto;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Droits par défaut de Supabase : tout objet créé dans public est ouvert aux
-- trois rôles, la RLS fait le tri.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text, name text, firstname text,
  created_at timestamp default now(), updated_at timestamp default now(),
  profile_picture text, bio text, role text default 'user',
  preferences jsonb default '{}'::jsonb, is_active boolean default true,
  banned_until timestamp, login_attempts integer default 0,
  device_ids jsonb default '[]'::jsonb, height integer, weight numeric,
  ftp double precision, hr_max integer, hr_rest integer, licencetype text,
  "Cd" jsonb, phonenumber text, age smallint, last_login_at_ timestamptz,
  birthdate date, massvelo numeric default 7,
  onboarding_completed boolean default false, studio_name text, website text,
  lang text default 'fr', first_session_completed boolean default false,
  diagnostic_basic_paid boolean not null default false,
  diagnostic_basic_paid_at timestamptz, weight_updated_at timestamptz,
  setup_correction double precision, setup_anchor jsonb
);
alter table public.users enable row level security;

-- Copie conforme de la définition historique de prod (table non qualifiée,
-- pas de search_path) : la migration 20260929 doit la corriger.
create function public.is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin');
$$;
create function public.get_my_role() returns text language sql stable security definer as $$
  select role from public.users where id = auth.uid();
$$;

create policy "Every user read their row" on public.users for select using (auth.uid() = id);
create policy "Allow insert for authenticated users" on public.users for insert with check (auth.uid() = id);
-- Policy de prod depuis 20261005_fix_users_update_policy_recursion.sql.
create policy user_update_own_row on public.users for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id and (
    role is not distinct from public.get_my_role()
    or (public.get_my_role() is null and role = any (array['rider', 'pending_bf']))));

create type public.diagnostic_basic_status as enum ('in_progress', 'completed', 'expired', 'archived');

create table public.diagnostic_basic (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status public.diagnostic_basic_status not null default 'in_progress',
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '21 days'),
  completed_at timestamptz,
  s1_sessions_count integer not null default 0 check (s1_sessions_count between 0 and 4),
  s1_positions_count integer not null default 0 check (s1_positions_count between 0 and 10),
  s2_sessions_count integer not null default 0 check (s2_sessions_count between 0 and 4),
  best_s2_id uuid,
  aero_zone text,
  stability_zone text,
  recommendation_key text,
  best_s1_position_id uuid
);
create unique index uniq_diagnostic_basic_in_progress on public.diagnostic_basic (user_id)
  where status = 'in_progress';

create table public.diagnostic_basic_positions (
  id uuid primary key default gen_random_uuid(),
  diagnostic_id uuid not null references public.diagnostic_basic (id) on delete cascade,
  s1_session_index integer not null check (s1_session_index between 1 and 4),
  name text not null,
  aero_score double precision,
  mask_png bytea not null,
  captured_at timestamptz not null default now()
);

create table public.diagnostic_basic_s2 (
  id uuid primary key default gen_random_uuid(),
  diagnostic_id uuid not null references public.diagnostic_basic (id) on delete cascade,
  session_index integer not null check (session_index between 1 and 4),
  duration_s integer not null,
  stability_score double precision not null,
  validated boolean not null,
  captured_at timestamptz not null default now()
);

alter table public.diagnostic_basic enable row level security;
alter table public.diagnostic_basic_positions enable row level security;
alter table public.diagnostic_basic_s2 enable row level security;

create policy user_read_own_diag on public.diagnostic_basic for select using (auth.uid() = user_id);
create policy user_insert_own_diag on public.diagnostic_basic for insert with check (auth.uid() = user_id);
create policy user_update_own_diag on public.diagnostic_basic for update using (auth.uid() = user_id);

create policy user_read_own_diag_pos on public.diagnostic_basic_positions for select using (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));
create policy user_insert_own_diag_pos on public.diagnostic_basic_positions for insert with check (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));
create policy user_update_own_diag_pos on public.diagnostic_basic_positions for update using (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));
create policy user_delete_own_diag_pos on public.diagnostic_basic_positions for delete using (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));

create policy user_read_own_diag_s2 on public.diagnostic_basic_s2 for select using (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));
create policy user_insert_own_diag_s2 on public.diagnostic_basic_s2 for insert with check (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));
create policy user_update_own_diag_s2 on public.diagnostic_basic_s2 for update using (
  exists (select 1 from public.diagnostic_basic d where d.id = diagnostic_id and d.user_id = auth.uid()));

-- Triggers de compteurs, copiés de la production (SECURITY INVOKER).
create function public.recompute_diagnostic_basic_s1_counts() returns trigger language plpgsql as $$
declare target_id uuid := coalesce(new.diagnostic_id, old.diagnostic_id);
begin
  update public.diagnostic_basic
  set s1_positions_count = (select count(*) from public.diagnostic_basic_positions where diagnostic_id = target_id),
      s1_sessions_count = (select count(distinct s1_session_index) from public.diagnostic_basic_positions where diagnostic_id = target_id)
  where id = target_id;
  return null;
end; $$;
create function public.recompute_diagnostic_basic_best_s1() returns trigger language plpgsql as $$
declare target_id uuid := coalesce(new.diagnostic_id, old.diagnostic_id);
begin
  update public.diagnostic_basic
  set best_s1_position_id = (select id from public.diagnostic_basic_positions
    where diagnostic_id = target_id and aero_score is not null
    order by aero_score desc, captured_at asc limit 1)
  where id = target_id;
  return null;
end; $$;
create function public.recompute_diagnostic_basic_s2_count() returns trigger language plpgsql as $$
declare target_id uuid := coalesce(new.diagnostic_id, old.diagnostic_id);
begin
  update public.diagnostic_basic
  set s2_sessions_count = (select count(*) from public.diagnostic_basic_s2 where diagnostic_id = target_id)
  where id = target_id;
  return null;
end; $$;
create function public.recompute_diagnostic_basic_best_s2() returns trigger language plpgsql as $$
begin
  update public.diagnostic_basic
  set best_s2_id = (select id from public.diagnostic_basic_s2
    where diagnostic_id = new.diagnostic_id and validated = true
    order by stability_score desc, captured_at desc limit 1)
  where id = new.diagnostic_id;
  return null;
end; $$;

create trigger trg_recompute_s1_counts after insert or delete on public.diagnostic_basic_positions
  for each row execute function public.recompute_diagnostic_basic_s1_counts();
create trigger trg_recompute_best_s1 after insert or delete or update of aero_score on public.diagnostic_basic_positions
  for each row execute function public.recompute_diagnostic_basic_best_s1();
create trigger trg_recompute_s2_count after insert or delete on public.diagnostic_basic_s2
  for each row execute function public.recompute_diagnostic_basic_s2_count();
create trigger trg_recompute_best_s2 after insert or update of stability_score, validated on public.diagnostic_basic_s2
  for each row execute function public.recompute_diagnostic_basic_best_s2();

-- Cron d'expiration (tourne en postgres).
create function public.expire_stale_diagnostic_basic() returns integer language plpgsql as $$
declare affected int;
begin
  update public.diagnostic_basic set status = 'expired' where status = 'in_progress' and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end; $$;
