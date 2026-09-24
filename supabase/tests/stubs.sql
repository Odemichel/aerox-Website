-- supabase/tests/stubs.sql
-- Socle minimal imitant Supabase (rôles, auth, vault, pg_net) et les objets
-- existants dont dépend la migration bf_billing. Pour les tests locaux
-- uniquement : `supabase/tests/run.sh` l'exécute dans un Postgres jetable.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create extension if not exists pgcrypto;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;

create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema net;
create table net.calls (url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as $$
  insert into net.calls values (url, body, headers) returning 1::bigint
$$;

create table public.users (
  id uuid primary key references auth.users (id),
  email text, name text, firstname text, phonenumber text, role text,
  is_active boolean, onboarding_completed boolean, studio_name text, lang text,
  created_at timestamp default now()
);
create table public.bf_clients (
  id uuid primary key default gen_random_uuid(),
  bf_user_id uuid references auth.users (id) on delete cascade,
  firstname text
);
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create function public.is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from users where id = auth.uid() and role = 'admin');
$$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Bike fitter déjà actif avant la migration (cas Founding Partner).
insert into auth.users (id, email, email_confirmed_at)
values ('00000000-0000-0000-0000-00000000a001', 'legacy@example.com', now());
insert into public.users (id, email, role, is_active)
values ('00000000-0000-0000-0000-00000000a001', 'legacy@example.com', 'bike-fitter', true);
-- Compte en attente : ne doit pas être touché par la migration.
insert into auth.users (id, email, email_confirmed_at)
values ('00000000-0000-0000-0000-00000000a002', 'pending@example.com', now());
insert into public.users (id, email, role, is_active)
values ('00000000-0000-0000-0000-00000000a002', 'pending@example.com', 'pending_bf', false);

-- Trigger existant en prod sur auth.users ; la migration remplace la fonction.
create function public.handle_email_confirmed() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger on_email_confirmed after update on auth.users
  for each row execute function public.handle_email_confirmed();
