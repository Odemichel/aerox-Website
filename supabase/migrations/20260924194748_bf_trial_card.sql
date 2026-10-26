-- supabase/migrations/20260925090000_bf_trial_card.sql
--
-- Essai bike fitter : 2 analyses, débloquées par l'enregistrement d'une carte
-- bancaire (0 € débité, Checkout en mode « setup »). Une carte = un essai :
-- l'empreinte Stripe de la carte (`card.fingerprint`, identique pour un même
-- numéro, quel que soit le compte) est unique dans `bf_trial_cards`. C'est ce
-- qui empêche un cycliste — ou un studio — d'enchaîner les comptes pour
-- cumuler les essais.

alter table public.bf_billing
  add column trial_state text not null default 'needs_card'
    check (trial_state in ('needs_card', 'granted', 'card_already_used'));

-- Comptes déjà servis par l'ancien essai (sans carte) : rien à débloquer.
update public.bf_billing b set trial_state = 'granted'
where exists (select 1 from public.bf_credits c where c.user_id = b.user_id and c.source = 'trial')
   or b.plan <> 'trial';

create table public.bf_trial_cards (
  fingerprint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.bf_trial_cards is
  '[BikeFit] Empreintes de cartes ayant déjà ouvert un essai (une carte = un essai). service_role uniquement.';

alter table public.bf_trial_cards enable row level security;
revoke all on public.bf_trial_cards from anon, authenticated;

-- L'inscription crée la ligne de facturation, sans crédit : l'essai attend la carte.
create or replace function public.bf_start_trial(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.bf_billing (user_id, plan, status, trial_state)
  values (p_user, 'trial', 'active', 'needs_card')
  on conflict (user_id) do nothing;
end;
$$;

revoke execute on function public.bf_start_trial(uuid) from public, anon, authenticated;
grant execute on function public.bf_start_trial(uuid) to service_role;

-- Appelée par le webhook après l'enregistrement de la carte.
-- Renvoie 'granted', 'card_already_used' ou 'already_granted'.
create or replace function public.bf_grant_trial(p_user uuid, p_fingerprint text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  _inserted integer;
begin
  if exists (select 1 from public.bf_credits where user_id = p_user and source = 'trial') then
    return 'already_granted';
  end if;

  insert into public.bf_trial_cards (fingerprint, user_id)
  values (p_fingerprint, p_user)
  on conflict (fingerprint) do nothing;
  get diagnostics _inserted = row_count;

  if _inserted = 0 then
    -- Rejeu du webhook pour le même compte : la carte est déjà la sienne.
    if exists (select 1 from public.bf_trial_cards where fingerprint = p_fingerprint and user_id = p_user) then
      return 'already_granted';
    end if;
    update public.bf_billing set trial_state = 'card_already_used'
    where user_id = p_user and trial_state = 'needs_card';
    return 'card_already_used';
  end if;

  insert into public.bf_credits (user_id, granted, remaining, expires_at, source)
  values (p_user, 2, 2, now() + interval '20 days', 'trial')
  on conflict (user_id, source) do nothing;
  update public.bf_billing set trial_state = 'granted' where user_id = p_user;
  return 'granted';
end;
$$;

revoke execute on function public.bf_grant_trial(uuid, text) from public, anon, authenticated;
grant execute on function public.bf_grant_trial(uuid, text) to service_role;

create or replace function public.bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _role text;
  _billing public.bf_billing%rowtype;
  _credit public.bf_credits%rowtype;
  _analysis_id uuid;
  _existing public.bf_analyses%rowtype;
begin
  select role into _role from public.users where id = p_uid;
  if _role is null or _role not in ('bike-fitter', 'admin') then
    return jsonb_build_object('status', 'refused', 'reason', 'not_bike_fitter');
  end if;

  -- Le client doit appartenir au bike fitter.
  perform 1 from public.bf_clients where id = p_client_id and bf_user_id = p_uid;
  if not found then
    return jsonb_build_object('status', 'refused', 'reason', 'client_not_found');
  end if;

  -- Sérialise les appels concurrents pour un même client : sans ce verrou,
  -- deux démarrages simultanés compteraient deux analyses.
  perform pg_advisory_xact_lock(hashtextextended('bf_analysis:' || p_client_id::text, 0));

  -- Compte bike fitter sans ligne de facturation (activé à la main par un
  -- admin, ou antérieur à la facturation) : on lui ouvre l'essai.
  select * into _billing from public.bf_billing where user_id = p_uid for update;
  if not found then
    perform public.bf_start_trial(p_uid);
    select * into _billing from public.bf_billing where user_id = p_uid for update;
  end if;

  -- Re-test dans les 30 jours : gratuit, rien n'est compté. Vérifié avant
  -- l'accès : un client déjà compté (ou tracé « uncredited ») ne génère
  -- jamais une seconde ligne dans la fenêtre.
  select * into _existing
  from public.bf_analyses
  where client_id = p_client_id and counted_at > now() - interval '30 days'
  order by counted_at desc
  limit 1;

  if public.bf_access_level(_billing.status, _billing.grace_until) <> 'full' then
    if p_origin = 'session_backstop' and _existing.id is null then
      insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
      values (p_uid, p_client_id, 'uncredited', p_origin);
    end if;
    return jsonb_build_object('status', 'refused', 'reason', 'read_only', 'plan', _billing.plan);
  end if;

  if _existing.id is not null then
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
    where user_id = p_uid and remaining > 0 and expires_at > now()
    order by expires_at
    limit 1
    for update;

    if not found then
      if p_origin = 'session_backstop' then
        insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
        values (p_uid, p_client_id, 'uncredited', p_origin);
      end if;
      -- Essai pas encore débloqué : l'app renvoie vers l'ajout d'une carte.
      if _billing.plan = 'trial' and _billing.trial_state = 'needs_card' then
        return jsonb_build_object('status', 'refused', 'reason', 'needs_card', 'plan', _billing.plan);
      end if;
      return jsonb_build_object('status', 'refused', 'reason', 'no_credits', 'plan', _billing.plan);
    end if;

    update public.bf_credits set remaining = remaining - 1 where id = _credit.id;

    insert into public.bf_analyses (user_id, client_id, billing_mode, credit_id, origin)
    values (p_uid, p_client_id, _billing.plan, _credit.id, p_origin)
    returning id into _analysis_id;

    return jsonb_build_object(
      'status', 'counted',
      'analysis_id', _analysis_id,
      'plan', _billing.plan,
      'credits_remaining', (
        select coalesce(sum(remaining), 0) from public.bf_credits
        where user_id = p_uid and remaining > 0 and expires_at > now()
      )
    );
  end if;

  if _billing.plan = 'studio' then
    _analysis_id := gen_random_uuid();
    insert into public.bf_analyses (id, user_id, client_id, billing_mode, stripe_meter_event_identifier, origin)
    values (_analysis_id, p_uid, p_client_id, 'studio', _analysis_id::text, p_origin);

    return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', 'studio', 'meter_pending', true);
  end if;

  -- unlimited, unlimited_launch, legacy : on enregistre seulement.
  insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
  values (p_uid, p_client_id, _billing.plan, p_origin)
  returning id into _analysis_id;

  return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan);
end;
$$;

revoke execute on function public.bf_register_analysis_for(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bf_register_analysis_for(uuid, uuid, text) to service_role;

-- Résumé de l'espace bike fitter : état de l'essai en plus.
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
    'trial_state', (select trial_state from b),
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
