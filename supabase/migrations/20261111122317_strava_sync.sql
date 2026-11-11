-- feat-strava-sync : connexion Strava et envoi des séances d'entraînement.
--
-- Jetons OAuth lus et écrits par les Edge Functions seulement (service
-- role). L'app ne voit que les colonnes non sensibles de sa propre
-- connexion (droits par colonne + RLS) et ne modifie que `auto_upload`.

-- ---------------------------------------------------------------------------
-- Connexions aux services tiers (Strava aujourd'hui)
-- ---------------------------------------------------------------------------
create table public.user_integrations (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('strava')),
  provider_athlete_id text not null,
  athlete_name text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text not null,
  auto_upload boolean not null default true,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

comment on table public.user_integrations is
  'feat-strava-sync : jetons OAuth par utilisateur et service. Jetons réservés au service role.';

alter table public.user_integrations enable row level security;

revoke all on public.user_integrations from anon, authenticated;
grant select (user_id, provider, athlete_name, auto_upload, connected_at)
  on public.user_integrations to authenticated;
grant update (auto_upload) on public.user_integrations to authenticated;

create policy "user_integrations_select_own" on public.user_integrations
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "user_integrations_update_own" on public.user_integrations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- États OAuth (anti-CSRF, usage unique, 10 min) : service role seulement
-- ---------------------------------------------------------------------------
create table public.oauth_states (
  state uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('strava')),
  created_at timestamptz not null default now()
);

comment on table public.oauth_states is
  'feat-strava-sync : state OAuth à usage unique (10 min). Service role seulement.';

alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;

create index oauth_states_created_at_idx on public.oauth_states (created_at);

-- ---------------------------------------------------------------------------
-- Envois des séances : écrits par les Edge Functions, lus par le propriétaire
-- ---------------------------------------------------------------------------
create table public.session_exports (
  session_id uuid not null references public.sessions (id) on delete cascade,
  provider text not null check (provider in ('strava')),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('created', 'duplicate_updated', 'processing', 'error')),
  upload_id text,
  activity_id text,
  error text,
  updated_at timestamptz not null default now(),
  primary key (session_id, provider)
);

comment on table public.session_exports is
  'feat-strava-sync : état de l''envoi d''une séance vers un service tiers.';

alter table public.session_exports enable row level security;

revoke all on public.session_exports from anon, authenticated;
grant select on public.session_exports to authenticated;

create policy "session_exports_select_own" on public.session_exports
  for select to authenticated
  using ((select auth.uid()) = user_id);

create index session_exports_user_id_idx on public.session_exports (user_id);
