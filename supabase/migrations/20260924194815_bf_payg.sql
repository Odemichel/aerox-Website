-- supabase/migrations/20260925100000_bf_payg.sql
--
-- Offre « À l'usage » (payg) : 0 € fixe, 20 € HT par analyse, facturée en fin
-- de mois par le meter Stripe, comme la part variable de Studio. Le Pack
-- (crédits prépayés) n'est plus vendu ; le plan `pack` reste valide pour
-- l'historique.

alter table public.bf_billing drop constraint bf_billing_plan_check;
alter table public.bf_billing add constraint bf_billing_plan_check
  check (plan in ('trial', 'pack', 'payg', 'studio', 'unlimited', 'unlimited_launch', 'legacy'));

alter table public.bf_analyses drop constraint bf_analyses_billing_mode_check;
alter table public.bf_analyses add constraint bf_analyses_billing_mode_check
  check (billing_mode in ('trial', 'pack', 'payg', 'studio', 'unlimited', 'unlimited_launch', 'legacy', 'uncredited'));

drop index public.bf_analyses_meter_pending_idx;
create index bf_analyses_meter_pending_idx on public.bf_analyses (counted_at)
  where billing_mode in ('studio', 'payg') and meter_reported_at is null;

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

  -- À l'usage et Studio : l'analyse est envoyée au meter Stripe (même meter,
  -- un seul abonnement actif par bike fitter).
  if _billing.plan in ('studio', 'payg') then
    _analysis_id := gen_random_uuid();
    insert into public.bf_analyses (id, user_id, client_id, billing_mode, stripe_meter_event_identifier, origin)
    values (_analysis_id, p_uid, p_client_id, _billing.plan, _analysis_id::text, p_origin);

    return jsonb_build_object('status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'meter_pending', true);
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

create or replace function public.bf_analysis_meter_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from inserted where billing_mode in ('studio', 'payg')) then
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
      where p.billing_mode in ('studio', 'payg')
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
  where id = p_id and billing_mode in ('studio', 'payg') and meter_reported_at is null;
$$;

revoke execute on function public.bf_mark_meter_reported(uuid, text) from public, anon, authenticated;
grant execute on function public.bf_mark_meter_reported(uuid, text) to service_role;
