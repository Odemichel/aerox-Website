-- supabase/migrations/20260927100000_bf_essential_trial.sql
--
-- Grille du 2026-09-27 et essai avec carte.
--
--  - Offre Essentiel (plan `essential`) : 20 € HT/mois + 15 € HT par analyse,
--    part variable facturée par le meter Stripe (comme l'était Studio).
--    À l'usage et Studio, jamais vendus, restent acceptés par les contraintes
--    pour l'historique.
--  - Essai : 14 jours gratuits sur un abonnement Stripe (carte enregistrée,
--    premier prélèvement à la fin de l'essai). L'identifiant d'entreprise
--    vérifié (SIRET, TVA, site validé) n'ouvre plus l'essai lui-même : il
--    autorise la souscription avec essai, une fois par entreprise.
--    `bf_billing.trial_ends_at` = fin de l'essai Stripe, posée par le
--    webhook ; renseignée, l'essai est utilisé.
--  - Pendant l'essai, les analyses sont gratuites (`billing_mode = 'trial'`) :
--    rien n'est envoyé au meter.
--  - Sans abonnement : essai pas encore démarré → `needs_card` (code lu par
--    l'application desktop : « démarrez votre essai ») ; essai déjà utilisé
--    → `no_credits` (« choisissez une offre »).

alter table public.bf_billing drop constraint bf_billing_plan_check;
alter table public.bf_billing add constraint bf_billing_plan_check
  check (plan in ('trial', 'pack', 'payg', 'studio', 'essential', 'unlimited', 'unlimited_launch', 'legacy'));

alter table public.bf_billing drop constraint bf_billing_offer_check;
alter table public.bf_billing add constraint bf_billing_offer_check
  check (offer in ('payg', 'studio', 'essential', 'unlimited', 'unlimited_annual', 'unlimited_launch', 'unlimited_launch_annual'));

alter table public.bf_billing drop constraint bf_billing_scheduled_offer_check;
alter table public.bf_billing add constraint bf_billing_scheduled_offer_check
  check (scheduled_offer in ('payg', 'studio', 'essential', 'unlimited', 'unlimited_annual', 'unlimited_launch', 'unlimited_launch_annual'));

alter table public.bf_analyses drop constraint bf_analyses_billing_mode_check;
alter table public.bf_analyses add constraint bf_analyses_billing_mode_check
  check (billing_mode in ('trial', 'pack', 'payg', 'studio', 'essential', 'unlimited', 'unlimited_launch', 'legacy', 'uncredited'));

-- File du meter : analyses Essentiel (et anciens modes mesurés).
drop index public.bf_analyses_meter_pending_idx;
create index bf_analyses_meter_pending_idx on public.bf_analyses (counted_at)
  where billing_mode in ('studio', 'payg', 'essential') and meter_reported_at is null;

create or replace function public.bf_analysis_meter_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from inserted where billing_mode in ('studio', 'payg', 'essential')) then
    perform public.bf_ping_usage_reporter();
  end if;
  return null;
end;
$$;

revoke execute on function public.bf_analysis_meter_notify() from public, anon, authenticated;

create or replace function public.bf_claim_meter_batch(p_limit integer)
returns table (id uuid, user_id uuid, counted_at timestamptz, stripe_customer_id text)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.bf_analyses a
    set meter_claimed_at = now()
    where a.id in (
      select p.id from public.bf_analyses p
      where p.billing_mode in ('studio', 'payg', 'essential')
        and p.meter_reported_at is null
        and (p.meter_claimed_at is null or p.meter_claimed_at < now() - interval '2 minutes')
      order by p.counted_at
      limit p_limit
      for update skip locked
    )
    returning a.id, a.user_id, a.counted_at
  )
  select c.id, c.user_id, c.counted_at, b.stripe_customer_id
  from claimed c left join public.bf_billing b on b.user_id = c.user_id;
$$;

revoke execute on function public.bf_claim_meter_batch(integer) from public, anon, authenticated;
grant execute on function public.bf_claim_meter_batch(integer) to service_role;

create or replace function public.bf_mark_meter_reported(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.bf_analyses
  set meter_reported_at = case when p_error is null then now() else null end,
      meter_last_error = p_error,
      meter_claimed_at = null
  where id = p_id and billing_mode in ('studio', 'payg', 'essential') and meter_reported_at is null;
$$;

revoke execute on function public.bf_mark_meter_reported(uuid, text) from public, anon, authenticated;
grant execute on function public.bf_mark_meter_reported(uuid, text) to service_role;

-- Entreprise vérifiée : la souscription avec essai est autorisée. L'essai
-- lui-même démarre avec l'abonnement Stripe (webhook).
create or replace function public.bf_open_trial_credits(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bf_billing set trial_state = 'granted' where user_id = p_user;
end;
$$;

revoke execute on function public.bf_open_trial_credits(uuid) from public, anon, authenticated;

-- Appelée par /api/billing/business-id/ (service_role) après les contrôles.
-- Renvoie 'granted', 'pending_review', 'already_used' ou 'already_granted'.
create or replace function public.bf_register_business_id(
  p_user uuid,
  p_key text,
  p_kind text,
  p_country text,
  p_name text,
  p_verified boolean,
  p_website text default null,
  p_email_match boolean default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  _owner uuid;
begin
  if exists (
    select 1 from public.bf_billing
    where user_id = p_user and (trial_state = 'granted' or trial_ends_at is not null)
  ) then
    return 'already_granted';
  end if;

  select user_id into _owner from public.bf_business_ids where id_key = p_key;
  if _owner is not null and _owner <> p_user then
    update public.bf_billing set trial_state = 'business_id_used'
    where user_id = p_user and trial_state <> 'granted';
    return 'already_used';
  end if;

  -- Un seul identifiant par compte : une saisie précédente (en attente) est remplacée.
  delete from public.bf_business_ids where user_id = p_user and id_key <> p_key;
  insert into public.bf_business_ids
    (id_key, user_id, kind, country, legal_name, status, verified_at, website, email_domain_match)
  values (p_key, p_user, p_kind, p_country, nullif(p_name, ''),
          case when p_verified then 'verified' else 'pending_review' end,
          case when p_verified then now() end, p_website, p_email_match)
  on conflict (id_key) do update
    set legal_name = excluded.legal_name,
        status = excluded.status,
        verified_at = excluded.verified_at,
        website = excluded.website,
        email_domain_match = excluded.email_domain_match;

  if p_verified then
    perform public.bf_open_trial_credits(p_user);
    return 'granted';
  end if;
  update public.bf_billing set trial_state = 'pending_review' where user_id = p_user;
  return 'pending_review';
end;
$$;

revoke execute on function public.bf_register_business_id(uuid, text, text, text, text, boolean, text, boolean)
  from public, anon, authenticated;
grant execute on function public.bf_register_business_id(uuid, text, text, text, text, boolean, text, boolean)
  to service_role;

-- Comptage d'une analyse.
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

  perform 1 from public.bf_clients where id = p_client_id and bf_user_id = p_uid;
  if not found then
    return jsonb_build_object('status', 'refused', 'reason', 'client_not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bf_analysis:' || p_client_id::text, 0));

  select * into _billing from public.bf_billing where user_id = p_uid for update;
  if not found then
    perform public.bf_start_trial(p_uid);
    select * into _billing from public.bf_billing where user_id = p_uid for update;
  end if;

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

  -- Sans abonnement : crédits éventuels (historique), sinon refus.
  if _billing.plan in ('trial', 'pack') then
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
      -- Essai jamais démarré : identifiant puis offre et carte, dans l'espace.
      if _billing.trial_ends_at is null then
        return jsonb_build_object('status', 'refused', 'reason', 'needs_card', 'plan', _billing.plan);
      end if;
      -- Essai utilisé, plus d'abonnement.
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

  -- Abonnement en essai gratuit : analyse comptée, jamais facturée.
  if _billing.plan <> 'legacy' and _billing.trial_ends_at is not null and _billing.trial_ends_at > now() then
    insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
    values (p_uid, p_client_id, 'trial', p_origin)
    returning id into _analysis_id;
    return jsonb_build_object(
      'status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'trial_ends_at', _billing.trial_ends_at
    );
  end if;

  -- Essentiel : analyse facturée par le meter Stripe.
  if _billing.plan in ('essential', 'studio', 'payg') then
    _analysis_id := gen_random_uuid();
    insert into public.bf_analyses (id, user_id, client_id, billing_mode, stripe_meter_event_identifier, origin)
    values (_analysis_id, p_uid, p_client_id, _billing.plan, _analysis_id::text, p_origin);

    return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'meter_pending', true);
  end if;

  insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
  values (p_uid, p_client_id, _billing.plan, p_origin)
  returning id into _analysis_id;

  return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan);
end;
$$;

revoke execute on function public.bf_register_analysis_for(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bf_register_analysis_for(uuid, uuid, text) to service_role;

-- Résumé de l'espace : + analyses facturables de la période (hors essai).
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
  biz as (
    select * from public.bf_business_ids where user_id = (select auth.uid())
  ),
  window_start as (
    select coalesce((select current_period_start from b), date_trunc('month', now())) as ts
  )
  select jsonb_build_object(
    'plan', (select plan from b),
    'offer', (select offer from b),
    'trial_state', (select trial_state from b),
    'trial_ends_at', (select trial_ends_at from b),
    'status', (select status from b),
    'access', (select public.bf_access_level(status, grace_until) from b),
    'grace_until', (select grace_until from b),
    'current_period_start', (select ts from window_start),
    'current_period_end', (select current_period_end from b),
    'cancel_at', (select cancel_at from b),
    'scheduled_offer', (select scheduled_offer from b),
    'scheduled_at', (select scheduled_at from b),
    'unpaid_amount', (select unpaid_amount from b),
    'unpaid_invoice_url', (select unpaid_invoice_url from b),
    'has_stripe_customer', (select stripe_customer_id is not null from b),
    'has_subscription', (select stripe_subscription_id is not null from b),
    'business', (
      select jsonb_build_object(
        'kind', kind,
        'id', regexp_replace(id_key, '^[A-Z]+:', ''),
        'country', country,
        'legal_name', legal_name,
        'website', website,
        'status', status
      ) from biz
    ),
    'analyses_in_period', (
      select count(*) from public.bf_analyses
      where user_id = (select auth.uid()) and counted_at >= (select ts from window_start)
    ),
    'billable_in_period', (
      select count(*) from public.bf_analyses
      where user_id = (select auth.uid()) and counted_at >= (select ts from window_start)
        and billing_mode in ('essential', 'studio', 'payg')
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
