-- supabase/migrations/20260924120000_bf_billing.sql
--
-- Facturation des bike fitters : offre, crédits, analyses comptées.
--
-- Principe : le client (site, application desktop) ne fait que LIRE ses
-- lignes. Toute écriture passe par des fonctions SECURITY DEFINER :
--   - register_analysis(client_id)  → appelée par l'application avec le jeton
--     du bike fitter, décide seule si l'analyse compte ;
--   - bf_* réservées au service_role → appelées par le webhook Stripe (Vercel).
--
-- Définition d'une analyse : un bf_clients analysé, décompté une seule fois
-- par période glissante de 30 jours. Les re-tests dans la fenêtre sont gratuits.


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.bf_billing (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'trial'
    check (plan in ('trial', 'pack', 'studio', 'unlimited', 'unlimited_launch', 'legacy')),
  -- active    : accès complet
  -- past_due  : paiement en échec, accès complet jusqu'à grace_until
  -- read_only : consultation seulement (grâce dépassée, abonnement résilié…)
  status text not null default 'active' check (status in ('active', 'past_due', 'read_only')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.bf_billing is
  '[BikeFit] Offre et statut de facturation d''un bike fitter. Écriture : service_role uniquement.';

create table public.bf_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  granted integer not null check (granted > 0),
  remaining integer not null check (remaining >= 0),
  expires_at timestamptz not null,
  -- id de la session Checkout Stripe, ou 'trial'. Unique par utilisateur :
  -- un rejeu du webhook ne crédite jamais deux fois.
  source text not null,
  created_at timestamptz not null default now(),
  constraint bf_credits_remaining_le_granted check (remaining <= granted),
  constraint bf_credits_user_source_key unique (user_id, source)
);

comment on table public.bf_credits is
  '[BikeFit] Crédits d''analyses (pack payé ou essai). Décrémentés par register_analysis.';

create index bf_credits_available_idx on public.bf_credits (user_id, expires_at) where remaining > 0;

create table public.bf_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- set null : la ligne reste une pièce de facturation si le client est supprimé.
  client_id uuid references public.bf_clients (id) on delete set null,
  counted_at timestamptz not null default now(),
  billing_mode text not null
    check (billing_mode in ('trial', 'pack', 'studio', 'unlimited', 'unlimited_launch', 'legacy', 'uncredited')),
  credit_id uuid references public.bf_credits (id) on delete set null,
  -- Studio uniquement : identifiant du meter event Stripe (= id de l'analyse,
  -- pour l'idempotence côté Stripe) et état de l'envoi.
  stripe_meter_event_identifier text unique,
  meter_reported_at timestamptz,
  meter_last_error text,
  -- 'app' : register_analysis ; 'session_backstop' : séance enregistrée sans
  -- appel préalable (voir lot 4).
  origin text not null default 'app' check (origin in ('app', 'session_backstop'))
);

comment on table public.bf_analyses is
  '[BikeFit] Analyses comptées (1 par client par fenêtre glissante de 30 jours).';

create index bf_analyses_client_recent_idx on public.bf_analyses (client_id, counted_at desc);
create index bf_analyses_user_recent_idx on public.bf_analyses (user_id, counted_at desc);
create index bf_analyses_credit_idx on public.bf_analyses (credit_id);
create index bf_analyses_meter_pending_idx on public.bf_analyses (counted_at)
  where billing_mode = 'studio' and meter_reported_at is null;

-- Idempotence du webhook Stripe : un événement déjà traité est ignoré.
create table public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

comment on table public.stripe_events is
  '[Billing] Événements Stripe déjà traités par le webhook (idempotence). service_role uniquement.';

create trigger trg_bf_billing_set_updated_at
  before update on public.bf_billing
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS : lecture de ses propres lignes, aucune écriture côté client.
-- ---------------------------------------------------------------------------

alter table public.bf_billing enable row level security;
alter table public.bf_credits enable row level security;
alter table public.bf_analyses enable row level security;
alter table public.stripe_events enable row level security;

create policy bf_billing_select_own on public.bf_billing
  for select to authenticated using ((select auth.uid()) = user_id or (select public.is_admin()));
create policy bf_credits_select_own on public.bf_credits
  for select to authenticated using ((select auth.uid()) = user_id or (select public.is_admin()));
create policy bf_analyses_select_own on public.bf_analyses
  for select to authenticated using ((select auth.uid()) = user_id or (select public.is_admin()));
-- stripe_events : aucune politique → invisible hors service_role.

-- Défense en profondeur : sans politique d'écriture RLS bloque déjà tout,
-- mais on retire aussi les privilèges accordés par défaut par Supabase.
revoke insert, update, delete, truncate on public.bf_billing, public.bf_credits, public.bf_analyses
  from anon, authenticated;
revoke all on public.stripe_events from anon, authenticated;
revoke all on public.bf_billing, public.bf_credits, public.bf_analyses from anon;

-- ---------------------------------------------------------------------------
-- Essai : 3 analyses valables 20 jours.
-- ---------------------------------------------------------------------------

create or replace function public.bf_start_trial(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.bf_billing (user_id, plan, status)
  values (p_user, 'trial', 'active')
  on conflict (user_id) do nothing;

  insert into public.bf_credits (user_id, granted, remaining, expires_at, source)
  values (p_user, 3, 3, now() + interval '20 days', 'trial')
  on conflict (user_id, source) do nothing;
end;
$$;

revoke execute on function public.bf_start_trial(uuid) from public, anon, authenticated;
grant execute on function public.bf_start_trial(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Niveau d'accès calculé (la grâce de 7 jours expire sans attendre un job).
-- ---------------------------------------------------------------------------

create or replace function public.bf_access_level(p_status text, p_grace_until timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_status = 'active' then 'full'
    when p_status = 'past_due' and p_grace_until is not null and p_grace_until > now() then 'full'
    else 'read_only'
  end;
$$;

-- ---------------------------------------------------------------------------
-- register_analysis : seul point d'entrée du comptage.
-- ---------------------------------------------------------------------------

create or replace function public.register_analysis(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _role text;
  _billing public.bf_billing%rowtype;
  _credit public.bf_credits%rowtype;
  _analysis_id uuid;
  _existing public.bf_analyses%rowtype;
begin
  if _uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select role into _role from public.users where id = _uid;
  if _role is null or _role not in ('bike-fitter', 'admin') then
    return jsonb_build_object('status', 'refused', 'reason', 'not_bike_fitter');
  end if;

  -- Le client doit appartenir au bike fitter appelant.
  perform 1 from public.bf_clients where id = p_client_id and bf_user_id = _uid;
  if not found then
    return jsonb_build_object('status', 'refused', 'reason', 'client_not_found');
  end if;

  -- Sérialise les appels concurrents pour un même client : sans ce verrou,
  -- deux démarrages simultanés compteraient deux analyses.
  perform pg_advisory_xact_lock(hashtextextended('bf_analysis:' || p_client_id::text, 0));

  -- Compte bike fitter sans ligne de facturation (activé à la main par un
  -- admin, ou antérieur à cette migration) : on lui ouvre l'essai.
  select * into _billing from public.bf_billing where user_id = _uid for update;
  if not found then
    perform public.bf_start_trial(_uid);
    select * into _billing from public.bf_billing where user_id = _uid for update;
  end if;

  if public.bf_access_level(_billing.status, _billing.grace_until) <> 'full' then
    return jsonb_build_object('status', 'refused', 'reason', 'read_only', 'plan', _billing.plan);
  end if;

  -- Re-test dans les 30 jours : gratuit, rien n'est compté.
  select * into _existing
  from public.bf_analyses
  where client_id = p_client_id and counted_at > now() - interval '30 days'
  order by counted_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'status', 'already_counted',
      'analysis_id', _existing.id,
      'counted_at', _existing.counted_at,
      'free_until', _existing.counted_at + interval '30 days',
      'plan', _billing.plan
    );
  end if;

  if _billing.plan in ('trial', 'pack') then
    -- Crédit qui expire le plus tôt d'abord. FOR UPDATE + re-vérification de
    -- `remaining > 0` par Postgres : deux clients différents ne peuvent pas
    -- consommer le même dernier crédit.
    select * into _credit
    from public.bf_credits
    where user_id = _uid and remaining > 0 and expires_at > now()
    order by expires_at
    limit 1
    for update;

    if not found then
      return jsonb_build_object('status', 'refused', 'reason', 'no_credits', 'plan', _billing.plan);
    end if;

    update public.bf_credits set remaining = remaining - 1 where id = _credit.id;

    insert into public.bf_analyses (user_id, client_id, billing_mode, credit_id)
    values (_uid, p_client_id, _billing.plan, _credit.id)
    returning id into _analysis_id;

    return jsonb_build_object(
      'status', 'counted',
      'analysis_id', _analysis_id,
      'plan', _billing.plan,
      'credits_remaining', (
        select coalesce(sum(remaining), 0) from public.bf_credits
        where user_id = _uid and remaining > 0 and expires_at > now()
      )
    );
  end if;

  if _billing.plan = 'studio' then
    _analysis_id := gen_random_uuid();
    insert into public.bf_analyses (id, user_id, client_id, billing_mode, stripe_meter_event_identifier)
    values (_analysis_id, _uid, p_client_id, 'studio', _analysis_id::text);

    return jsonb_build_object(
      'status', 'counted',
      'analysis_id', _analysis_id,
      'plan', 'studio',
      'meter_pending', true
    );
  end if;

  -- unlimited, unlimited_launch, legacy : on enregistre seulement.
  insert into public.bf_analyses (user_id, client_id, billing_mode)
  values (_uid, p_client_id, _billing.plan)
  returning id into _analysis_id;

  return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan);
end;
$$;

revoke execute on function public.register_analysis(uuid) from public, anon;
grant execute on function public.register_analysis(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Résumé pour l'espace bike fitter (site et application).
-- ---------------------------------------------------------------------------

create or replace function public.bf_usage_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select * from public.bf_billing where user_id = (select auth.uid())
  ),
  window_start as (
    select coalesce((select current_period_start from b), date_trunc('month', now())) as ts
  )
  select jsonb_build_object(
    'plan', (select plan from b),
    'status', (select status from b),
    'access', (select public.bf_access_level(status, grace_until) from b),
    'grace_until', (select grace_until from b),
    'current_period_start', (select ts from window_start),
    'current_period_end', (select current_period_end from b),
    'has_stripe_customer', (select stripe_customer_id is not null from b),
    'analyses_in_period', (
      select count(*) from public.bf_analyses
      where user_id = (select auth.uid()) and counted_at >= (select ts from window_start)
    ),
    'credits_remaining', (
      select coalesce(sum(remaining), 0) from public.bf_credits
      where user_id = (select auth.uid()) and remaining > 0 and expires_at > now()
    ),
    'credits_next_expiry', (
      select min(expires_at) from public.bf_credits
      where user_id = (select auth.uid()) and remaining > 0 and expires_at > now()
    )
  );
$$;

revoke execute on function public.bf_usage_summary() from public, anon;
grant execute on function public.bf_usage_summary() to authenticated;

-- ---------------------------------------------------------------------------
-- Offre de lancement : places restantes (lues par la page tarifs publique).
-- ---------------------------------------------------------------------------

create or replace function public.bf_launch_seats_remaining()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    0,
    20 - (
      select count(*)::integer from public.bf_billing
      where plan = 'unlimited_launch' and status in ('active', 'past_due')
    )
  );
$$;

revoke execute on function public.bf_launch_seats_remaining() from public;
grant execute on function public.bf_launch_seats_remaining() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Crédit d'un pack (webhook). Idempotent grâce à (user_id, source).
-- ---------------------------------------------------------------------------

create or replace function public.bf_grant_credits(p_user uuid, p_amount integer, p_expires_at timestamptz, p_source text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  _inserted integer;
begin
  insert into public.bf_credits (user_id, granted, remaining, expires_at, source)
  values (p_user, p_amount, p_amount, p_expires_at, p_source)
  on conflict (user_id, source) do nothing;
  get diagnostics _inserted = row_count;
  return _inserted = 1;
end;
$$;

revoke execute on function public.bf_grant_credits(uuid, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.bf_grant_credits(uuid, integer, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- Inscription : un bike fitter est actif immédiatement, avec l'essai.
-- (Remplace l'ancien passage par `pending_bf` et la validation manuelle.)
-- ---------------------------------------------------------------------------

create or replace function public.handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _is_bf boolean := coalesce(new.raw_user_meta_data ->> 'profile_type', '') = 'bike-fitter';
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    insert into public.users (id, email, phonenumber, role, is_active, onboarding_completed, studio_name)
    values (
      new.id,
      new.email,
      new.raw_user_meta_data ->> 'phone',
      case when _is_bf then 'bike-fitter' else 'rider' end,
      _is_bf,
      false,
      case when _is_bf then nullif(new.raw_user_meta_data ->> 'studio_name', '') end
    )
    on conflict (id) do nothing;

    if _is_bf then
      perform public.bf_start_trial(new.id);
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notification admin « nouveau BF » (fonction Edge notify-admin-new-bf).
-- Le secret partagé est lu dans le Vault : sans lui, rien ne part (la
-- fonction Edge refuserait de toute façon).
-- ---------------------------------------------------------------------------

create or replace function public.notify_admin_new_bf()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret text;
begin
  if new.role <> 'bike-fitter' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role = 'bike-fitter' then
    return new;
  end if;

  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'notify_admin_new_bf: secret bf_notify_secret absent du Vault, notification non envoyée';
    return new;
  end if;

  perform net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-new-bf',
    body := jsonb_build_object('record', jsonb_build_object(
      'id', new.id, 'email', new.email, 'firstname', new.firstname, 'name', new.name,
      'studio_name', new.studio_name, 'lang', new.lang, 'created_at', new.created_at
    )),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
  return new;
end;
$$;

create trigger trg_notify_admin_new_bf
  after insert or update of role on public.users
  for each row execute function public.notify_admin_new_bf();

-- ---------------------------------------------------------------------------
-- Existant : les bike fitters déjà actifs (Founding Partner) et l'admin
-- passent en « legacy », illimité, sans rien changer à leur abonnement.
-- Les comptes pending_bf ne sont pas touchés.
-- ---------------------------------------------------------------------------

insert into public.bf_billing (user_id, plan, status)
select id, 'legacy', 'active' from public.users where role in ('bike-fitter', 'admin')
on conflict (user_id) do nothing;

