-- supabase/migrations/20260924130000_bf_analysis_counting.sql
--
-- Comptage des analyses, côté serveur uniquement.
--
-- 1. Le corps de register_analysis devient bf_register_analysis_for(uid, …),
--    appelable avec un utilisateur explicite. register_analysis(client_id)
--    reste le point d'entrée de l'application (utilisateur = jeton).
-- 2. Filet de sécurité : une séance enregistrée pour un client sans analyse
--    comptée dans les 30 jours (application ancienne, hors ligne, appel
--    contourné) est comptée à l'insertion dans `sessions`. Si l'offre la
--    refuse (plus de crédit, lecture seule), elle est tracée « uncredited ».
-- 3. Studio : chaque analyse comptée déclenche l'envoi du meter event Stripe
--    par la route Vercel /api/billing/report-usage/ ; un job pg_cron la
--    rappelle toutes les 10 minutes pour rejouer les envois en échec.

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

create or replace function public.register_analysis(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return public.bf_register_analysis_for(_uid, p_client_id, 'app');
end;
$$;

revoke execute on function public.register_analysis(uuid) from public, anon;
grant execute on function public.register_analysis(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Filet de sécurité sur les séances.
-- ---------------------------------------------------------------------------

create or replace function public.bf_count_session_backstop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.client_id is not null then
    -- Jamais d'échec propagé : perdre la séance d'un client serait bien pire
    -- qu'une analyse non comptée. L'incident reste visible dans les journaux.
    begin
      perform public.bf_register_analysis_for(new.user_id, new.client_id, 'session_backstop');
    exception when others then
      raise warning 'bf_count_session_backstop: séance % non comptée — %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke execute on function public.bf_count_session_backstop() from public, anon, authenticated;

create trigger trg_bf_count_session_backstop
  after insert on public.sessions
  for each row execute function public.bf_count_session_backstop();

-- ---------------------------------------------------------------------------
-- Envoi des meter events Studio (route Vercel, secret partagé dans le Vault).
-- ---------------------------------------------------------------------------

create or replace function public.bf_ping_usage_reporter()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret text;
begin
  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'billing_hook_secret' limit 1;
  if _secret is null then
    raise warning 'bf_ping_usage_reporter: secret billing_hook_secret absent du Vault';
    return;
  end if;
  perform net.http_post(
    url := 'https://aeroxbefaster.com/api/billing/report-usage/',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-hook-secret', _secret)
  );
end;
$$;

revoke execute on function public.bf_ping_usage_reporter() from public, anon, authenticated;

create or replace function public.bf_analysis_meter_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from inserted where billing_mode = 'studio') then
    perform public.bf_ping_usage_reporter();
  end if;
  return null;
end;
$$;

revoke execute on function public.bf_analysis_meter_notify() from public, anon, authenticated;

-- Une requête par instruction, pas par ligne, et seulement s'il y a une
-- analyse Studio : la route envoie tout ce qui est en attente d'un coup.
create trigger trg_bf_analysis_meter_notify
  after insert on public.bf_analyses
  referencing new table as inserted
  for each statement execute function public.bf_analysis_meter_notify();

-- Rejeu des envois en échec (Stripe indisponible, route en déploiement…).
select cron.schedule('bf-report-usage', '*/10 * * * *', $$ select public.bf_ping_usage_reporter() $$);

-- Marquage des envois, appelé par la route (service_role).
create or replace function public.bf_mark_meter_reported(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.bf_analyses
  set meter_reported_at = case when p_error is null then now() else meter_reported_at end,
      meter_last_error = p_error
  where id = p_id and billing_mode = 'studio';
$$;

revoke execute on function public.bf_mark_meter_reported(uuid, text) from public, anon, authenticated;
grant execute on function public.bf_mark_meter_reported(uuid, text) to service_role;
