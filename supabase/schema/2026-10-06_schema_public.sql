--
-- PostgreSQL database dump
--

-- Dumped from database version 15.14
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: diagnostic_basic_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.diagnostic_basic_status AS ENUM (
    'in_progress',
    'completed',
    'expired',
    'archived',
    'revoked'
);


--
-- Name: admin_set_my_diagnostic(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_my_diagnostic(p_action text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  case p_action
    when 'unlock' then
      if not public.has_diagnostic_entitlement() then
        insert into public.diagnostic_purchases
          (user_id, stripe_checkout_session_id, amount_total, currency, is_admin_test)
        values
          (v_uid, 'admin_test_' || gen_random_uuid(), 0, 'eur', true);
      end if;

    when 'block' then
      update public.diagnostic_basic
      set status = 'revoked'
      where user_id = v_uid and status = 'in_progress';

      delete from public.diagnostic_purchases
      where user_id = v_uid and is_admin_test and consumed_at is null;

    when 'reset' then
      delete from public.diagnostic_basic where user_id = v_uid;
      delete from public.diagnostic_purchases where user_id = v_uid and is_admin_test;

    else
      raise exception 'invalid_action' using errcode = '22023';
  end case;
end;
$$;


--
-- Name: bf_access_level(text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_access_level(p_status text, p_grace_until timestamp with time zone) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select case
    when p_status = 'active' then 'full'
    when p_status = 'past_due' and p_grace_until is not null and p_grace_until > now() then 'full'
    else 'read_only'
  end;
$$;


--
-- Name: bf_analysis_meter_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_analysis_meter_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if exists (select 1 from inserted where billing_mode in ('studio', 'payg', 'essential')) then
    perform public.bf_ping_usage_reporter();
  end if;
  return null;
end;
$$;


--
-- Name: bf_approve_business_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_approve_business_id(p_user uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update public.bf_business_ids set status = 'verified', verified_at = now()
  where user_id = p_user and status = 'pending_review';
  if not found then
    return 'nothing_pending';
  end if;
  perform public.bf_open_trial_credits(p_user);
  return 'granted';
end;
$$;


--
-- Name: bf_claim_meter_batch(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_claim_meter_batch(p_limit integer) RETURNS TABLE(id uuid, user_id uuid, counted_at timestamp with time zone, stripe_customer_id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: bf_count_session_backstop(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_count_session_backstop() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.client_id is not null then
    begin
      perform public.bf_register_analysis_for(new.user_id, new.client_id, 'session_backstop');
    exception when others then
      raise warning 'bf_count_session_backstop: séance % non comptée — %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;


--
-- Name: bf_find_user_by_email(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_find_user_by_email(_email text) RETURNS TABLE(id uuid, firstname text, name text, email text, role text, phonenumber text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF get_my_role() NOT IN ('bike-fitter', 'admin') THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  RETURN QUERY
  SELECT u.id, u.firstname, u.name, u.email, u.role, u.phonenumber
  FROM public.users u
  WHERE u.email = _email
  LIMIT 1;
END;
$$;


--
-- Name: bf_grant_credits(uuid, integer, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_grant_credits(p_user uuid, p_amount integer, p_expires_at timestamp with time zone, p_source text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: bf_grant_trial(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_grant_trial(p_user uuid, p_fingerprint text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: bf_launch_seats_remaining(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_launch_seats_remaining() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select greatest(
    0,
    20 - (
      select count(*)::integer from public.bf_billing
      where plan = 'unlimited_launch'
        and (
          status = 'active'
          or (status = 'past_due' and (stripe_subscription_id is not null or grace_until > now()))
        )
    )
  );
$$;


--
-- Name: bf_mark_meter_reported(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_mark_meter_reported(p_id uuid, p_error text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  update public.bf_analyses
  set meter_reported_at = case when p_error is null then now() else null end,
      meter_last_error = p_error,
      meter_claimed_at = null
  where id = p_id and billing_mode in ('studio', 'payg', 'essential') and meter_reported_at is null;
$$;


--
-- Name: bf_notify_business_review(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_notify_business_review() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  _secret text;
  _hook text;
  _site text;
  _approve text;
  _u record;
begin
  if new.status <> 'pending_review' then
    return new;
  end if;
  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'bf_notify_business_review: secret bf_notify_secret absent du Vault';
    return new;
  end if;
  select id, email, firstname, name, studio_name, lang, created_at into _u from public.users where id = new.user_id;
  select decrypted_secret into _hook from vault.decrypted_secrets where name = 'billing_hook_secret' limit 1;
  select decrypted_secret into _site from vault.decrypted_secrets where name = 'site_url' limit 1;
  if _hook is not null then
    _approve := coalesce(_site, 'https://aeroxbefaster.com') || '/api/billing/approve-business/?u=' || new.user_id
      || '&t=' || encode(extensions.hmac(new.user_id::text, _hook, 'sha256'), 'hex');
  end if;
  perform net.http_post(
    url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-new-bf',
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', _u.id, 'email', _u.email, 'firstname', _u.firstname, 'name', _u.name,
        'studio_name', _u.studio_name, 'lang', _u.lang, 'created_at', _u.created_at
      ),
      'review', jsonb_build_object(
        'kind', new.kind,
        'business_id', regexp_replace(new.id_key, '^[A-Z]+:', ''),
        'website', new.website,
        'email_domain_match', new.email_domain_match,
        'approve_url', _approve
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
  return new;
end;
$$;


--
-- Name: bf_open_trial_credits(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_open_trial_credits(p_user uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update public.bf_billing set trial_state = 'granted' where user_id = p_user;
end;
$$;


--
-- Name: bf_ping_usage_reporter(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_ping_usage_reporter() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  _secret text;
  _url text;
begin
  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'billing_hook_secret' limit 1;
  if _secret is null then
    raise warning 'bf_ping_usage_reporter: secret billing_hook_secret absent du Vault';
    return;
  end if;
  select decrypted_secret into _url from vault.decrypted_secrets where name = 'billing_report_url' limit 1;
  perform net.http_post(
    url := coalesce(_url, 'https://aeroxbefaster.com/api/billing/report-usage/'),
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-hook-secret', _secret)
  );
end;
$$;


--
-- Name: bf_register_analysis_for(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
      if _billing.trial_ends_at is null then
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

  if _billing.plan <> 'legacy' and _billing.trial_ends_at is not null and _billing.trial_ends_at > now() then
    insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
    values (p_uid, p_client_id, 'trial', p_origin)
    returning id into _analysis_id;
    return jsonb_build_object(
      'status', 'counted', 'analysis_id', _analysis_id, 'plan', _billing.plan, 'trial_ends_at', _billing.trial_ends_at
    );
  end if;

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


--
-- Name: bf_register_business_id(uuid, text, text, text, text, boolean, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_register_business_id(p_user uuid, p_key text, p_kind text, p_country text, p_name text, p_verified boolean, p_website text DEFAULT NULL::text, p_email_match boolean DEFAULT NULL::boolean) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: bf_send_unpaid_reminders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_send_unpaid_reminders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  _secret text;
  _base text;
  _row record;
  _sent integer := 0;
begin
  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'bf_send_unpaid_reminders: secret bf_notify_secret absent du Vault';
    return 0;
  end if;
  select decrypted_secret into _base from vault.decrypted_secrets where name = 'bf_functions_url' limit 1;

  for _row in
    update public.bf_billing b
    set unpaid_reminders = b.unpaid_reminders + 1
    from public.users u
    where u.id = b.user_id
      and b.unpaid_invoice_id is not null
      and b.unpaid_invoice_url is not null
      and (
        b.unpaid_reminders = 0
        or (b.unpaid_reminders = 1 and b.unpaid_since <= now() - interval '7 days')
        or (b.unpaid_reminders = 2 and b.unpaid_since <= now() - interval '21 days')
      )
    returning b.user_id, u.email, u.firstname, u.studio_name, u.lang,
      b.unpaid_amount, b.unpaid_invoice_url, b.unpaid_reminders
  loop
    perform net.http_post(
      url := coalesce(_base, 'https://agvksgrjqskpetokudda.supabase.co/functions/v1') || '/notify-bf-unpaid',
      body := jsonb_build_object(
        'email', _row.email,
        'firstname', _row.firstname,
        'studio_name', _row.studio_name,
        'lang', _row.lang,
        'amount', _row.unpaid_amount,
        'url', _row.unpaid_invoice_url,
        'reminder', _row.unpaid_reminders
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
    );
    _sent := _sent + 1;
  end loop;
  return _sent;
end;
$$;


--
-- Name: bf_start_trial(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_start_trial(p_user uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.bf_billing (user_id, plan, status, trial_state)
  values (p_user, 'trial', 'active', 'needs_business_id')
  on conflict (user_id) do nothing;
end;
$$;


--
-- Name: bf_unpaid_reset(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_unpaid_reset() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.unpaid_invoice_id is distinct from old.unpaid_invoice_id then
    new.unpaid_since := case when new.unpaid_invoice_id is null then null else now() end;
    new.unpaid_reminders := 0;
  end if;
  return new;
end;
$$;


--
-- Name: bf_usage_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bf_usage_summary() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: cleanup_position_masks_orphans(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_position_masks_orphans() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'storage'
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM storage.objects
    WHERE bucket_id = 'position-masks'
      AND created_at < now() - interval '24 hours'
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RAISE NOTICE 'cleanup_position_masks_orphans: % file(s) deleted', deleted_count;
  RETURN deleted_count;
END;
$$;


--
-- Name: crm_account_status(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_account_status(p_emails text[]) RETURNS TABLE(email text, user_id uuid, role text, is_active boolean, account_created_at timestamp with time zone, last_sign_in_at timestamp with time zone, plan text, billing_status text, trial_state text, trial_ends_at timestamp with time zone, has_business_id boolean, has_trial_card boolean, analyses_count integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.crm_is_member() then
    raise exception 'crm: accès réservé aux membres' using errcode = '42501';
  end if;
  return query
  select
    lower(u.email)::text,
    u.id,
    pu.role,
    pu.is_active,
    u.created_at,
    u.last_sign_in_at,
    b.plan,
    b.status,
    b.trial_state,
    b.trial_ends_at,
    exists (select 1 from public.bf_business_ids bi where bi.user_id = u.id),
    exists (select 1 from public.bf_trial_cards tc where tc.user_id = u.id),
    (select count(*)::int from public.bf_analyses a where a.user_id = u.id)
  from auth.users u
  left join public.users pu on pu.id = u.id
  left join public.bf_billing b on b.user_id = u.id
  where lower(u.email) = any (select lower(x) from unnest(p_emails) x);
end;
$$;


--
-- Name: crm_contacts_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_contacts_touch() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;


--
-- Name: crm_events_author(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_events_author() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end;
$$;


--
-- Name: crm_is_member(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_is_member() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (select 1 from public.crm_members where user_id = auth.uid());
$$;


--
-- Name: crm_login_allowed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_login_allowed(p_email text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (select 1 from public.crm_members where lower(email) = lower(trim(p_email)));
$$;


--
-- Name: crm_on_bf_signup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_on_bf_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  _contact uuid;
  _email text := lower(coalesce(new.email, ''));
  _slug text;
begin
  if new.role not in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role in ('bike-fitter', 'pending_bf') then
    return new;
  end if;
  if _email = '' then
    return new;
  end if;

  begin
    select c.id into _contact
    from public.crm_contacts c
    where lower(c.email) = _email or lower(c.email_alt) = _email
    limit 1;

    if _contact is null then
      _slug := regexp_replace(split_part(_email, '@', 1), '[^a-z0-9]+', '-', 'g')
               || '-' || substr(md5(_email), 1, 6);
      insert into public.crm_contacts (slug, name, email, segment, stage, ml_note, issue)
      values (
        _slug,
        coalesce(nullif(trim(coalesce(new.firstname, '') || ' ' || coalesce(new.name, '')), ''), split_part(_email, '@', 1)),
        _email,
        'bf',
        'lead',
        '',
        case when new.role = 'pending_bf' then 'Compte en attente d''activation (pending_bf)' else '' end
      )
      returning id into _contact;
    end if;

    insert into public.crm_events (contact_id, occurred_on, direction, summary)
    values (_contact, current_date, 'in', 'Inscription bike fitter sur le site');
  exception when others then
    raise warning 'crm_on_bf_signup: %', sqlerrm;
  end;
  return new;
end;
$$;


--
-- Name: diagnostic_basic_guard_client_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.diagnostic_basic_guard_client_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status <> 'in_progress' or old.expires_at <= now() then
    raise exception 'diagnostic_closed' using errcode = '42501';
  end if;
  if new.status not in ('in_progress', 'completed') then
    raise exception 'diagnostic_status_forbidden' using errcode = '42501';
  end if;
  return new;
end;
$$;


--
-- Name: diagnostic_is_writable(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.diagnostic_is_writable(p_diagnostic_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.diagnostic_basic d
    where d.id = p_diagnostic_id
      and d.user_id = auth.uid()
      and d.status = 'in_progress'
      and d.expires_at + interval '6 hours' > now()
  );
$$;


--
-- Name: expire_stale_diagnostic_basic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_stale_diagnostic_basic() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected INT;
BEGIN
  UPDATE public.diagnostic_basic
  SET status = 'expired'
  WHERE status = 'in_progress'
    AND expires_at < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;


--
-- Name: get_my_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT role FROM public.users WHERE id = auth.uid()
  $$;


--
-- Name: handle_email_confirmed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_email_confirmed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: has_diagnostic_entitlement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_diagnostic_entitlement() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.diagnostic_purchases
      where user_id = auth.uid() and consumed_at is null and refunded_at is null
    )
    or exists (
      select 1 from public.diagnostic_basic
      where user_id = auth.uid() and status = 'in_progress' and expires_at > now()
    )
  );
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'admin'
  );
$$;


--
-- Name: notify_admin_new_bf(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_admin_new_bf() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: notify_admin_pending_bf(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_admin_pending_bf() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare
  _payload jsonb;
  _edge_url text;
  _anon_key text;
begin
  -- Only fire when role becomes 'pending_bf'
  if NEW.role <> 'pending_bf' then
    return NEW;
  end if;

  -- Skip if role was already 'pending_bf' (UPDATE that didn't change role)
  if TG_OP = 'UPDATE' and OLD.role = 'pending_bf' then
    return NEW;
  end if;

  _edge_url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-admin-pending-bf';
  _anon_key := current_setting('app.settings.anon_key', true);

  -- If anon_key not in app.settings, fall back to the known key
  if _anon_key is null or _anon_key = '' then
    _anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndmtzZ3JqcXNrcGV0b2t1ZGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyODA4MTcsImV4cCI6MjA1NDg1NjgxN30.YxMG9QQCnLOcSttu5AlNMgRXl6cHoHiOPXYNe9c895M';
  end if;

  _payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', row_to_json(NEW)::jsonb,
    'old_record', case when TG_OP = 'UPDATE' then row_to_json(OLD)::jsonb else null end
  );

  -- Fire-and-forget HTTP POST via pg_net
  perform net.http_post(
    url     := _edge_url,
    body    := _payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _anon_key
    )
  );

  return NEW;
end;
$$;


--
-- Name: notify_client_post_fitting(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_client_post_fitting() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  _client_email TEXT;
  _payload jsonb;
  _edge_url TEXT;
  _anon_key TEXT;
  _already_sent BOOLEAN;
BEGIN
  IF NEW.client_id IS NULL THEN RETURN NEW; END IF;

  SELECT email INTO _client_email
  FROM public.bf_clients WHERE id = NEW.client_id;

  IF _client_email IS NULL OR _client_email = '' THEN RETURN NEW; END IF;

  -- Max 1 notification per client per day
  SELECT EXISTS(
    SELECT 1 FROM public.sessions
    WHERE client_id = NEW.client_id
      AND id != NEW.id
      AND created_at::date = CURRENT_DATE
  ) INTO _already_sent;

  IF _already_sent THEN RETURN NEW; END IF;

  _edge_url := 'https://agvksgrjqskpetokudda.supabase.co/functions/v1/notify-client-post-fitting';
  _anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndmtzZ3JqcXNrcGV0b2t1ZGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyODA4MTcsImV4cCI6MjA1NDg1NjgxN30.YxMG9QQCnLOcSttu5AlNMgRXl6cHoHiOPXYNe9c895M';

  _payload := jsonb_build_object(
    'session_id', NEW.id,
    'client_id', NEW.client_id,
    'bf_user_id', NEW.user_id
  );

  PERFORM net.http_post(
    url := _edge_url,
    body := _payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _anon_key
    )
  );

  RETURN NEW;
END;
$$;


--
-- Name: recompute_diagnostic_basic_best_s1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_diagnostic_basic_best_s1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET best_s1_position_id = (
        SELECT id
        FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
          AND aero_score IS NOT NULL
        ORDER BY aero_score DESC, captured_at ASC
        LIMIT 1
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;


--
-- Name: recompute_diagnostic_basic_best_s2(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_diagnostic_basic_best_s2() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.diagnostic_basic
  SET best_s2_id = (
        SELECT id
        FROM public.diagnostic_basic_s2
        WHERE diagnostic_id = NEW.diagnostic_id
          AND validated = TRUE
        ORDER BY stability_score DESC, captured_at DESC
        LIMIT 1
      )
  WHERE id = NEW.diagnostic_id;
  RETURN NULL;
END;
$$;


--
-- Name: recompute_diagnostic_basic_s1_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_diagnostic_basic_s1_counts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET s1_positions_count = (
        SELECT COUNT(*) FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
      ),
      s1_sessions_count = (
        SELECT COUNT(DISTINCT s1_session_index) FROM public.diagnostic_basic_positions
        WHERE diagnostic_id = target_id
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;


--
-- Name: recompute_diagnostic_basic_s2_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_diagnostic_basic_s2_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  target_id UUID := COALESCE(NEW.diagnostic_id, OLD.diagnostic_id);
BEGIN
  UPDATE public.diagnostic_basic
  SET s2_sessions_count = (
        SELECT COUNT(*) FROM public.diagnostic_basic_s2
        WHERE diagnostic_id = target_id
      )
  WHERE id = target_id;
  RETURN NULL;
END;
$$;


--
-- Name: record_diagnostic_refund(text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_diagnostic_refund(p_payment_intent_id text, p_amount_refunded integer, p_fully_refunded boolean) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_purchase_id uuid;
begin
  update public.diagnostic_purchases
  set amount_refunded = greatest(amount_refunded, p_amount_refunded),
      refunded_at = case when p_fully_refunded then coalesce(refunded_at, now()) else refunded_at end
  where stripe_payment_intent_id = p_payment_intent_id
  returning id into v_purchase_id;

  if v_purchase_id is not null and p_fully_refunded then
    update public.diagnostic_basic
    set status = 'revoked'
    where purchase_id = v_purchase_id and status = 'in_progress';
  end if;

  return v_purchase_id;
end;
$$;


--
-- Name: register_analysis(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_analysis(p_client_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return public.bf_register_analysis_for(_uid, p_client_id, 'app');
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: diagnostic_basic; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostic_basic (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status public.diagnostic_basic_status DEFAULT 'in_progress'::public.diagnostic_basic_status NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    completed_at timestamp with time zone,
    s1_sessions_count integer DEFAULT 0 NOT NULL,
    s1_positions_count integer DEFAULT 0 NOT NULL,
    s2_sessions_count integer DEFAULT 0 NOT NULL,
    best_s2_id uuid,
    aero_zone text,
    stability_zone text,
    recommendation_key text,
    best_s1_position_id uuid,
    purchase_id uuid,
    CONSTRAINT diagnostic_basic_aero_zone_check CHECK ((aero_zone = ANY (ARRAY['low'::text, 'mid'::text, 'high'::text]))),
    CONSTRAINT diagnostic_basic_s1_positions_count_check CHECK (((s1_positions_count >= 0) AND (s1_positions_count <= 10))),
    CONSTRAINT diagnostic_basic_s1_sessions_count_check CHECK (((s1_sessions_count >= 0) AND (s1_sessions_count <= 4))),
    CONSTRAINT diagnostic_basic_s2_sessions_count_check CHECK (((s2_sessions_count >= 0) AND (s2_sessions_count <= 4))),
    CONSTRAINT diagnostic_basic_stability_zone_check CHECK (((stability_zone IS NULL) OR (stability_zone = ANY (ARRAY['low'::text, 'mid'::text, 'high'::text]))))
);


--
-- Name: TABLE diagnostic_basic; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.diagnostic_basic IS 'Diagnostic AeroX Basic. 1 diagnostic = ≤4 sessions S1 (10 positions max) + ≤4 sessions S2. 3 semaines pour finaliser.';


--
-- Name: COLUMN diagnostic_basic.purchase_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic.purchase_id IS 'Achat qui a ouvert ce diagnostic. Un « Recommencer » crée un nouveau diagnostic sur le même achat, avec la même échéance.';


--
-- Name: restart_diagnostic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restart_diagnostic() RETURNS public.diagnostic_basic
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
  v_old public.diagnostic_basic;
  v_new public.diagnostic_basic;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_old
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at > now()
  for update;
  if not found then
    raise exception 'no_active_diagnostic' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic set status = 'archived' where id = v_old.id;

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_old.purchase_id, now(), v_old.expires_at)
  returning * into v_new;

  return v_new;
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: start_diagnostic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_diagnostic() RETURNS public.diagnostic_basic
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
  v_diag public.diagnostic_basic;
  v_purchase_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_diag
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at > now()
  for update;
  if found then
    return v_diag;
  end if;

  select id into v_purchase_id
  from public.diagnostic_purchases
  where user_id = v_uid and consumed_at is null and refunded_at is null
  order by paid_at
  limit 1
  for update;
  if v_purchase_id is null then
    raise exception 'no_diagnostic_entitlement' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic
  set status = 'expired'
  where user_id = v_uid and status = 'in_progress' and expires_at <= now();

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_purchase_id, now(), now() + interval '30 days')
  returning * into v_diag;

  update public.diagnostic_purchases
  set consumed_at = now()
  where id = v_purchase_id;

  return v_diag;
end;
$$;


--
-- Name: bf_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_analyses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid,
    counted_at timestamp with time zone DEFAULT now() NOT NULL,
    billing_mode text NOT NULL,
    credit_id uuid,
    stripe_meter_event_identifier text,
    meter_reported_at timestamp with time zone,
    meter_last_error text,
    origin text DEFAULT 'app'::text NOT NULL,
    meter_claimed_at timestamp with time zone,
    CONSTRAINT bf_analyses_billing_mode_check CHECK ((billing_mode = ANY (ARRAY['trial'::text, 'pack'::text, 'payg'::text, 'studio'::text, 'essential'::text, 'unlimited'::text, 'unlimited_launch'::text, 'legacy'::text, 'uncredited'::text]))),
    CONSTRAINT bf_analyses_origin_check CHECK ((origin = ANY (ARRAY['app'::text, 'session_backstop'::text])))
);


--
-- Name: TABLE bf_analyses; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_analyses IS '[BikeFit] Analyses comptées (1 par client par fenêtre glissante de 30 jours).';


--
-- Name: bf_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_billing (
    user_id uuid NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    plan text DEFAULT 'trial'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    grace_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trial_state text DEFAULT 'needs_business_id'::text NOT NULL,
    offer text,
    cancel_at timestamp with time zone,
    scheduled_offer text,
    scheduled_at timestamp with time zone,
    unpaid_invoice_id text,
    unpaid_amount integer,
    unpaid_invoice_url text,
    unpaid_since timestamp with time zone,
    unpaid_reminders integer DEFAULT 0 NOT NULL,
    trial_ends_at timestamp with time zone,
    CONSTRAINT bf_billing_offer_check CHECK ((offer = ANY (ARRAY['payg'::text, 'studio'::text, 'essential'::text, 'unlimited'::text, 'unlimited_annual'::text, 'unlimited_launch'::text, 'unlimited_launch_annual'::text]))),
    CONSTRAINT bf_billing_plan_check CHECK ((plan = ANY (ARRAY['trial'::text, 'pack'::text, 'payg'::text, 'studio'::text, 'essential'::text, 'unlimited'::text, 'unlimited_launch'::text, 'legacy'::text]))),
    CONSTRAINT bf_billing_scheduled_offer_check CHECK ((scheduled_offer = ANY (ARRAY['payg'::text, 'studio'::text, 'essential'::text, 'unlimited'::text, 'unlimited_annual'::text, 'unlimited_launch'::text, 'unlimited_launch_annual'::text]))),
    CONSTRAINT bf_billing_status_check CHECK ((status = ANY (ARRAY['active'::text, 'past_due'::text, 'read_only'::text]))),
    CONSTRAINT bf_billing_trial_state_check CHECK ((trial_state = ANY (ARRAY['needs_business_id'::text, 'pending_review'::text, 'business_id_used'::text, 'granted'::text, 'needs_card'::text, 'card_already_used'::text]))),
    CONSTRAINT bf_billing_unpaid_amount_check CHECK ((unpaid_amount > 0))
);


--
-- Name: TABLE bf_billing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_billing IS '[BikeFit] Offre et statut de facturation d''un bike fitter. Écriture : service_role uniquement.';


--
-- Name: bf_business_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_business_ids (
    id_key text NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    country text,
    legal_name text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    website text,
    email_domain_match boolean,
    CONSTRAINT bf_business_ids_kind_check CHECK ((kind = ANY (ARRAY['siren'::text, 'eu_vat'::text, 'website'::text, 'other'::text]))),
    CONSTRAINT bf_business_ids_status_check CHECK ((status = ANY (ARRAY['verified'::text, 'pending_review'::text])))
);


--
-- Name: TABLE bf_business_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_business_ids IS '[BikeFit] Identifiant d''entreprise ayant ouvert les analyses offertes (un par compte, un compte par identifiant). service_role uniquement.';


--
-- Name: bf_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bf_user_id uuid NOT NULL,
    linked_user_id uuid,
    firstname text NOT NULL,
    lastname text NOT NULL,
    email text,
    phone text,
    weight double precision,
    height integer,
    age integer,
    ftp integer,
    hr_max integer,
    hr_rest integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE bf_clients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_clients IS '[BikeFit] Clients d''un bike fitter (données physiques, notes)';


--
-- Name: bf_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    granted integer NOT NULL,
    remaining integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bf_credits_granted_check CHECK ((granted > 0)),
    CONSTRAINT bf_credits_remaining_check CHECK ((remaining >= 0)),
    CONSTRAINT bf_credits_remaining_le_granted CHECK ((remaining <= granted))
);


--
-- Name: TABLE bf_credits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_credits IS '[BikeFit] Crédits d''analyses (pack payé ou essai). Décrémentés par register_analysis.';


--
-- Name: bf_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    studio_name text,
    city text,
    website text,
    specialties text,
    experience_years integer,
    bio text,
    certifications text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE bf_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_profiles IS '[BikeFit] Profils bike fitter (studio, certifications, spécialités)';


--
-- Name: bf_trial_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bf_trial_cards (
    fingerprint text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE bf_trial_cards; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bf_trial_cards IS '[BikeFit] Empreintes de cartes ayant déjà ouvert un essai (une carte = un essai). service_role uniquement.';


--
-- Name: calibration_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calibration_telemetry (
    session_id uuid,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lcintre_m double precision,
    cam_distance_m double precision,
    pixel_p1 jsonb,
    pixel_p2 jsonb,
    cintre_pix_640 double precision,
    echelle_m_per_px double precision,
    proportionality_coef double precision,
    mask_height_px integer,
    mask_width_px integer,
    shape_frame jsonb,
    roi jsonb,
    camera_used jsonb,
    ht_connected jsonb,
    hrm_connected jsonb,
    webcams_detected jsonb DEFAULT '[]'::jsonb,
    hts_detected jsonb DEFAULT '[]'::jsonb,
    hrms_detected jsonb DEFAULT '[]'::jsonb,
    recalibration_count integer DEFAULT 0 NOT NULL,
    saddle_distance_m double precision,
    facteur_correctif_surface double precision,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    setup_correction double precision,
    f_px double precision,
    f_px_gap_pct double precision,
    check_status text,
    check_ratio double precision,
    check_gap_pct double precision,
    check_k_hat double precision,
    check_framing jsonb,
    check_degraded boolean
);


--
-- Name: TABLE calibration_telemetry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.calibration_telemetry IS 'feat-calibration-telemetry: per-session calibration + hardware audit metadata. 1 row per session, parent of calibration_telemetry_samples. Distinct from AeroX product mode "Diagnostique".';


--
-- Name: COLUMN calibration_telemetry.session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calibration_telemetry.session_id IS 'Soft reference to public.sessions(id). Nullable: filled at session save time. Calibration rows can exist before the session is saved (or even started).';


--
-- Name: COLUMN calibration_telemetry.f_px; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calibration_telemetry.f_px IS 'Focale caméra en pixels = cintre_pix_640 × cam_distance_m / lcintre_m. Constante matérielle : sa dérive à caméra identique signale une saisie fausse ou une caméra déplacée.';


--
-- Name: COLUMN calibration_telemetry.check_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calibration_telemetry.check_status IS 'feat-double-calibration-geo-morpho : issue du contrôle morpho de début de séance. NULL = aucun contrôle reçu pour cette ligne.';


--
-- Name: COLUMN calibration_telemetry.check_framing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calibration_telemetry.check_framing IS 'Cadrage observé pendant le contrôle {top_cut, bottom_cut}. top_cut est bloquant (casque hors champ), bottom_cut est un avertissement.';


--
-- Name: calibration_telemetry_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calibration_telemetry_samples (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid,
    user_id uuid NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    slot_index smallint NOT NULL,
    trigger_type text NOT NULL,
    surface_m2 double precision,
    cda double precision,
    mask_png_url text,
    mask_height_px integer,
    mask_width_px integer,
    echelle_m_per_px double precision,
    power_w integer,
    elapsed_s double precision,
    frame_filename text,
    parent_id uuid,
    CONSTRAINT calibration_telemetry_samples_slot_index_check CHECK (((slot_index >= 0) AND (slot_index <= 6))),
    CONSTRAINT calibration_telemetry_samples_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['auto'::text, 'surface_bucket'::text, 'on_demand'::text])))
);


--
-- Name: TABLE calibration_telemetry_samples; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.calibration_telemetry_samples IS 'feat-calibration-telemetry: mask + surface samples paired with FrameCollector JPEG captures. Mask PNG stored in bucket calibration-telemetry-private/{user_id}/{session_id}/{sample_id}.png.';


--
-- Name: COLUMN calibration_telemetry_samples.parent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calibration_telemetry_samples.parent_id IS 'FK to calibration_telemetry(id) — the active calibration row at the time of the sample capture.';


--
-- Name: cda_tool_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cda_tool_events (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    lang text NOT NULL,
    bike text,
    CONSTRAINT cda_tool_events_bike_check CHECK ((bike = ANY (ARRAY['road'::text, 'tt'::text]))),
    CONSTRAINT cda_tool_events_bike_only_for_analyze CHECK (((kind = 'analyze'::text) = (bike IS NOT NULL))),
    CONSTRAINT cda_tool_events_kind_check CHECK ((kind = ANY (ARRAY['calc'::text, 'analyze'::text]))),
    CONSTRAINT cda_tool_events_lang_check CHECK ((lang = ANY (ARRAY['fr'::text, 'en'::text, 'pt'::text, 'es'::text, 'it'::text, 'de'::text, 'nl'::text, 'ja'::text, 'tr'::text])))
);


--
-- Name: cda_tool_activity_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cda_tool_activity_daily WITH (security_invoker='true') AS
 SELECT ((cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text))::date AS day,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'calc'::text)) AS calculations,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'analyze'::text)) AS analyses,
    count(*) FILTER (WHERE ((cda_tool_events.kind = 'analyze'::text) AND (cda_tool_events.bike = 'road'::text))) AS analyses_road,
    count(*) FILTER (WHERE ((cda_tool_events.kind = 'analyze'::text) AND (cda_tool_events.bike = 'tt'::text))) AS analyses_tt
   FROM public.cda_tool_events
  GROUP BY (((cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text))::date)
  ORDER BY (((cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text))::date) DESC;


--
-- Name: cda_tool_activity_monthly; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cda_tool_activity_monthly WITH (security_invoker='true') AS
 SELECT (date_trunc('month'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date AS month,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'calc'::text)) AS calculations,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'analyze'::text)) AS analyses
   FROM public.cda_tool_events
  GROUP BY ((date_trunc('month'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date)
  ORDER BY ((date_trunc('month'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date) DESC;


--
-- Name: cda_tool_activity_weekly; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cda_tool_activity_weekly WITH (security_invoker='true') AS
 SELECT (date_trunc('week'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date AS week_start,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'calc'::text)) AS calculations,
    count(*) FILTER (WHERE (cda_tool_events.kind = 'analyze'::text)) AS analyses
   FROM public.cda_tool_events
  GROUP BY ((date_trunc('week'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date)
  ORDER BY ((date_trunc('week'::text, (cda_tool_events.created_at AT TIME ZONE 'Europe/Paris'::text)))::date) DESC;


--
-- Name: cda_tool_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cda_tool_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cda_tool_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: challenge_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    info text,
    plan_id uuid,
    session_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    thumbnail_url text,
    total_duration smallint,
    "Live Comments" jsonb
);


--
-- Name: TABLE challenge_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.challenge_sessions IS '[Training] Sessions challenge / défis';


--
-- Name: COLUMN challenge_sessions."Live Comments"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.challenge_sessions."Live Comments" IS 'Commentaires à afficher à l''utilisateur';


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    user_name text NOT NULL,
    user_id uuid NOT NULL,
    phone_number text,
    comment_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: TABLE comments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.comments IS '[Auth] Commentaires / feedback utilisateurs';


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.user_name;


--
-- Name: competition_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    best_watts_per_m2_30s integer,
    best_speed_30s double precision,
    best_cda_300s double precision,
    created_by uuid
);


--
-- Name: competition_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    first_name text NOT NULL,
    last_name text NOT NULL,
    age smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    height_cm smallint,
    weight_kg smallint,
    ftp smallint,
    CONSTRAINT competition_users_age_check CHECK (((age >= 5) AND (age <= 99))),
    CONSTRAINT competition_users_ftp_check CHECK (((ftp >= 50) AND (ftp <= 800))),
    CONSTRAINT competition_users_height_cm_check CHECK (((height_cm >= 100) AND (height_cm <= 220))),
    CONSTRAINT competition_users_weight_kg_check CHECK (((weight_kg >= 25) AND (weight_kg <= 200)))
);


--
-- Name: competition_leaderboard_aero; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.competition_leaderboard_aero AS
 SELECT DISTINCT ON (r.user_id) r.user_id,
    u.first_name,
    u.last_name,
    r.best_cda_300s,
    r.ended_at
   FROM (public.competition_runs r
     JOIN public.competition_users u ON ((u.id = r.user_id)))
  WHERE (r.best_cda_300s IS NOT NULL)
  ORDER BY r.user_id, r.best_cda_300s;


--
-- Name: VIEW competition_leaderboard_aero; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.competition_leaderboard_aero IS 'Public leaderboard view (CdA). Voir competition_leaderboard_perf pour la justification SECURITY DEFINER.';


--
-- Name: competition_leaderboard_perf; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.competition_leaderboard_perf AS
 SELECT DISTINCT ON (r.user_id) r.user_id,
    u.first_name,
    u.last_name,
    r.best_watts_per_m2_30s,
    r.best_speed_30s,
    r.ended_at
   FROM (public.competition_runs r
     JOIN public.competition_users u ON ((u.id = r.user_id)))
  WHERE (r.best_watts_per_m2_30s IS NOT NULL)
  ORDER BY r.user_id, r.best_watts_per_m2_30s DESC;


--
-- Name: VIEW competition_leaderboard_perf; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.competition_leaderboard_perf IS 'Public leaderboard view. SECURITY DEFINER intentionnel : la vue bypasse RLS pour permettre l''accès anon mais ne sélectionne QUE des colonnes sanitized (first_name, last_name, metrics). Pas d''email.';


--
-- Name: competition_live_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_live_state (
    id boolean DEFAULT true NOT NULL,
    competition_user_id uuid,
    first_name text,
    last_name text,
    is_active boolean DEFAULT false NOT NULL,
    current_speed_kmh double precision,
    current_watts_per_m2 integer,
    current_surface_m2 double precision,
    current_aero_score double precision,
    current_cda double precision,
    current_power double precision,
    elapsed_seconds integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competition_live_state_id_check CHECK ((id = true))
);


--
-- Name: crm_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    email_alt text DEFAULT ''::text NOT NULL,
    company text DEFAULT ''::text NOT NULL,
    country text DEFAULT ''::text NOT NULL,
    lang text DEFAULT 'fr'::text NOT NULL,
    segment text DEFAULT 'bf'::text NOT NULL,
    stage text DEFAULT 'lead'::text NOT NULL,
    priority boolean DEFAULT false NOT NULL,
    next_action text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    equipment text DEFAULT ''::text NOT NULL,
    pricing text DEFAULT ''::text NOT NULL,
    issue text DEFAULT ''::text NOT NULL,
    ml_note text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_contacts_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT crm_contacts_segment_check CHECK ((segment = ANY (ARRAY['bf'::text, 'cycliste'::text, 'coach'::text, 'evenement'::text, 'industrie'::text]))),
    CONSTRAINT crm_contacts_stage_check CHECK ((stage = ANY (ARRAY['lead'::text, 'demo'::text, 'test'::text, 'client'::text, 'partenaire'::text, 'froid'::text])))
);


--
-- Name: crm_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    occurred_on date NOT NULL,
    direction text NOT NULL,
    summary text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_events_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT crm_events_summary_check CHECK ((length(TRIM(BOTH FROM summary)) > 0))
);


--
-- Name: crm_contacts_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.crm_contacts_view WITH (security_invoker='true') AS
 SELECT c.id,
    c.slug,
    c.name,
    c.email,
    c.email_alt,
    c.company,
    c.country,
    c.lang,
    c.segment,
    c.stage,
    c.priority,
    c.next_action,
    c.notes,
    c.equipment,
    c.pricing,
    c.issue,
    c.ml_note,
    c.version,
    c.created_at,
    c.updated_at,
    c.updated_by,
    last.occurred_on AS last_on,
    last.direction AS last_direction,
    COALESCE(cnt.n, 0) AS events_count
   FROM ((public.crm_contacts c
     LEFT JOIN LATERAL ( SELECT e.occurred_on,
            e.direction
           FROM public.crm_events e
          WHERE (e.contact_id = c.id)
          ORDER BY e.occurred_on DESC, e.created_at DESC
         LIMIT 1) last ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS n
           FROM public.crm_events e
          WHERE (e.contact_id = c.id)) cnt ON (true));


--
-- Name: crm_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_members (
    user_id uuid NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id text,
    trigger text NOT NULL,
    log_content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    diagnostic_events text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: diagnostic_basic_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostic_basic_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    diagnostic_id uuid NOT NULL,
    s1_session_index integer NOT NULL,
    name text NOT NULL,
    cda double precision,
    surface_m2 double precision,
    aero_score double precision,
    mask_png bytea NOT NULL,
    mask_url text,
    note text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    comfort_score integer,
    CONSTRAINT diagnostic_basic_positions_comfort_score_check CHECK (((comfort_score >= 1) AND (comfort_score <= 5))),
    CONSTRAINT diagnostic_basic_positions_s1_session_index_check CHECK (((s1_session_index >= 1) AND (s1_session_index <= 4)))
);


--
-- Name: TABLE diagnostic_basic_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.diagnostic_basic_positions IS 'Positions capturées en S1. CASCADE delete via diagnostic_id.';


--
-- Name: COLUMN diagnostic_basic_positions.comfort_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic_positions.comfort_score IS 'Ressenti du rider sur cette position, 1 (tres inconfortable) a 5 (tres confortable). NULL = non renseigne. Saisi au dialogue post-capture.';


--
-- Name: diagnostic_basic_s2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostic_basic_s2 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    diagnostic_id uuid NOT NULL,
    session_index integer NOT NULL,
    duration_s integer NOT NULL,
    stability_score double precision NOT NULL,
    avg_surface_m2 double precision,
    avg_aero_score double precision,
    time_series_5s jsonb,
    validated boolean NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    s1_position_id uuid,
    comfort_score integer,
    std_surface_m2 double precision,
    stability_blocks jsonb,
    warnings jsonb,
    best_a_5min_m2 double precision,
    a_ref_min1_m2 double precision,
    aptitude_badges text[],
    stop_reason text,
    CONSTRAINT diagnostic_basic_s2_comfort_score_check CHECK (((comfort_score >= 1) AND (comfort_score <= 5))),
    CONSTRAINT diagnostic_basic_s2_session_index_check CHECK (((session_index >= 1) AND (session_index <= 4))),
    CONSTRAINT diagnostic_basic_s2_stop_reason_check CHECK (((stop_reason IS NULL) OR (stop_reason = ANY (ARRAY['user_stop'::text, 'warning_timeout'::text, 'warnings_exceeded'::text, 'im_completed'::text, 'block1_incomplete'::text]))))
);


--
-- Name: TABLE diagnostic_basic_s2; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.diagnostic_basic_s2 IS 'Sessions S2 (stabilité). ≤4 par diagnostic. Validée si durée ≥ 25 min (1500 s).';


--
-- Name: COLUMN diagnostic_basic_s2.stability_blocks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic_s2.stability_blocks IS 'Array of {index, duration_s, validated, warnings_count, mean_surface_m2} — one entry per block';


--
-- Name: COLUMN diagnostic_basic_s2.warnings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic_s2.warnings IS 'Array of {triggered_at_s, resolved_at_s, peak_delta_pct, block_index} — chronological warnings log';


--
-- Name: COLUMN diagnostic_basic_s2.aptitude_badges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic_s2.aptitude_badges IS 'Ordered subset of [clm_court, 40km, 70_3, im] — badges earned during the session';


--
-- Name: COLUMN diagnostic_basic_s2.stop_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_basic_s2.stop_reason IS 'Why the session ended: user_stop, warning_timeout, warnings_exceeded, im_completed, block1_incomplete';


--
-- Name: diagnostic_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnostic_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    stripe_checkout_session_id text NOT NULL,
    stripe_payment_intent_id text,
    amount_total integer NOT NULL,
    currency text NOT NULL,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    withdrawal_waiver_at timestamp with time zone,
    consumed_at timestamp with time zone,
    amount_refunded integer DEFAULT 0 NOT NULL,
    refunded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_admin_test boolean DEFAULT false NOT NULL,
    CONSTRAINT diagnostic_purchases_amount_refunded_check CHECK ((amount_refunded >= 0)),
    CONSTRAINT diagnostic_purchases_amount_total_check CHECK ((amount_total >= 0)),
    CONSTRAINT diagnostic_purchases_refund_le_total CHECK ((amount_refunded <= amount_total))
);


--
-- Name: TABLE diagnostic_purchases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.diagnostic_purchases IS '[Diagnostic] Un achat Stripe du Diagnostic AeroX. Écriture : webhook (service_role) et fonctions SECURITY DEFINER uniquement.';


--
-- Name: COLUMN diagnostic_purchases.is_admin_test; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.diagnostic_purchases.is_admin_test IS 'Droit de test créé par admin_set_my_diagnostic (0 €, hors Stripe). Exclu du suivi des achats.';


--
-- Name: diagnostic_purchase_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.diagnostic_purchase_status WITH (security_invoker='true') AS
 SELECT p.id,
    p.user_id,
    p.stripe_checkout_session_id,
    p.stripe_payment_intent_id,
    p.amount_total,
    p.amount_refunded,
    p.currency,
    p.paid_at,
    p.withdrawal_waiver_at,
    p.consumed_at,
    p.refunded_at,
    x.session_done,
        CASE
            WHEN (p.refunded_at IS NOT NULL) THEN 'refunded'::text
            WHEN x.session_done THEN 'session_done'::text
            WHEN (p.paid_at < (now() - '14 days'::interval)) THEN 'withdrawal_period_over'::text
            ELSE 'refundable'::text
        END AS refund_eligibility
   FROM (public.diagnostic_purchases p
     CROSS JOIN LATERAL ( SELECT (EXISTS ( SELECT 1
                   FROM public.diagnostic_basic d
                  WHERE ((d.purchase_id = p.id) AND ((EXISTS ( SELECT 1
                           FROM public.diagnostic_basic_positions pos
                          WHERE (pos.diagnostic_id = d.id))) OR (EXISTS ( SELECT 1
                           FROM public.diagnostic_basic_s2 s2
                          WHERE (s2.diagnostic_id = d.id))))))) AS session_done) x)
  WHERE (NOT p.is_admin_test);


--
-- Name: VIEW diagnostic_purchase_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.diagnostic_purchase_status IS '[Diagnostic] Achats et droit au remboursement : refundable (14 j, aucune séance), session_done, withdrawal_period_over, refunded.';


--
-- Name: ftp_aerox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ftp_aerox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    ftp_aerox integer NOT NULL,
    best_1min_wpm2 integer NOT NULL,
    avg_power integer NOT NULL,
    avg_surface real NOT NULL,
    training_session_id uuid
);


--
-- Name: gpx_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gpx_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_path text NOT NULL,
    thumbnail_path text,
    name text NOT NULL,
    description text,
    distance_km double precision,
    elevation_gain_m double precision,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    json_compressed_base64 text
);


--
-- Name: TABLE gpx_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.gpx_metadata IS '[GPX] Métadonnées des traces GPX (distance, dénivelé, tracé compressé)';


--
-- Name: COLUMN gpx_metadata.json_compressed_base64; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gpx_metadata.json_compressed_base64 IS 'traces gpx parsées et compressées';


--
-- Name: gpx_usages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gpx_usages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    gpx_id uuid NOT NULL,
    efforts_count integer DEFAULT 0,
    best_time_seconds integer,
    best_time_date timestamp with time zone,
    last_used_at timestamp with time zone
);


--
-- Name: TABLE gpx_usages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.gpx_usages IS '[GPX] Statistiques d''utilisation d''une trace par utilisateur';


--
-- Name: COLUMN gpx_usages.last_used_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.gpx_usages.last_used_at IS 'dernière fois que cette trace a été utilisée';


--
-- Name: plan_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plan_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_id uuid NOT NULL,
    training_session_id uuid NOT NULL,
    week_number integer NOT NULL,
    session_number integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: session_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    timestamp_ms bigint NOT NULL,
    aero_score double precision,
    cda double precision,
    surface_m2 double precision,
    mask_png bytea,
    created_at timestamp with time zone DEFAULT now(),
    rider_id uuid,
    note text,
    is_reference boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE session_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.session_positions IS '[Aéro] Positions sauvegardées pendant une session (CdA, surface, mask)';


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid,
    session_type text DEFAULT 'training'::text NOT NULL,
    duration_s integer,
    notes text,
    avg_power double precision,
    avg_speed double precision,
    avg_surface double precision,
    avg_cda double precision,
    distance_km double precision,
    best_power jsonb,
    best_cda jsonb,
    time_series jsonb,
    created_at timestamp with time zone DEFAULT now(),
    rider_id uuid,
    best_speed jsonb,
    normalized_power real,
    intensity_factor real,
    tss real,
    avg_aero_score real,
    stability_score real,
    time_series_5s jsonb,
    best_surface jsonb,
    best_watts_per_m2 jsonb DEFAULT '[]'::jsonb,
    avg_watts_per_m2 double precision DEFAULT 0,
    best_aero_score jsonb DEFAULT '[]'::jsonb,
    min_surface_m2 double precision,
    aero_qualified_s integer DEFAULT 0,
    detection_rate double precision,
    app_version text,
    CONSTRAINT sessions_session_type_check CHECK ((session_type = ANY (ARRAY['fitting'::text, 'diag'::text, 'training'::text, 'free'::text])))
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sessions IS '[Aéro] Sessions enregistrées (métriques CdA, puissance, vitesse, time series)';


--
-- Name: COLUMN sessions.best_aero_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.best_aero_score IS 'Best aero_score per 13 time windows : [[window_s, score_float], ...]';


--
-- Name: COLUMN sessions.min_surface_m2; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.min_surface_m2 IS 'Minimum surface_m2 over entire session (used for FTP-based W/m2 potential calc)';


--
-- Name: COLUMN sessions.aero_qualified_s; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.aero_qualified_s IS 'Seconds with aero_score > 0.5 (accumulates all-time via RiderProgressionService)';


--
-- Name: COLUMN sessions.detection_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.detection_rate IS 'Part des frames d''inference ou le cycliste a ete detecte (0..1), calculee par le backend Rust. Indicateur de confiance : en dessous de ~0.9 les moyennes de la seance reposent en partie sur une fenetre glissante figee pendant les frames non detectees et ne sont pas comparables. NULL pour les seances anterieures a l''instrumentation (2026-09-14).';


--
-- Name: COLUMN sessions.app_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.app_version IS 'Version du binaire desktop ayant produit la seance, format "1.4.0+4". L''app n''est pas mise a jour automatiquement : la date de commit d''un correctif ne dit rien de la date a laquelle il atteint le terrain (cas observe : un bike-fitter fige 3 mois sur un build du 10-21/05/2026). Indispensable a toute analyse chronologique. NULL pour les seances anterieures a l''instrumentation (2026-09-14).';


--
-- Name: setup_correction_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_correction_history (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    camera_name text NOT NULL,
    k double precision NOT NULL,
    source text NOT NULL,
    gap_pct double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_id uuid,
    CONSTRAINT setup_correction_history_k_check CHECK (((k >= (0.5)::double precision) AND (k <= (2.0)::double precision))),
    CONSTRAINT setup_correction_history_source_check CHECK ((source = ANY (ARRAY['calibration'::text, 'session_ok'::text, 'session_corrected'::text, 'bf_reference'::text])))
);


--
-- Name: TABLE setup_correction_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.setup_correction_history IS 'feat-k-history : k mesurés par caméra (calibration + débuts de séance). k appliqué = médiane des 5 derniers de la caméra.';


--
-- Name: setup_correction_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.setup_correction_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.setup_correction_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stripe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_events (
    id text NOT NULL,
    type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: TABLE stripe_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.stripe_events IS '[Billing] Événements Stripe déjà traités par le webhook (idempotence). service_role uniquement.';


--
-- Name: training_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    description text,
    level text,
    created_at timestamp with time zone DEFAULT now(),
    name_key text,
    description_key text,
    objective_key text,
    duration_weeks integer DEFAULT 8 NOT NULL,
    difficulty text NOT NULL,
    thumbnail_url text,
    is_active boolean DEFAULT true NOT NULL,
    translations_json jsonb,
    plan_type text,
    target_distance text,
    sessions_per_week integer DEFAULT 3 NOT NULL,
    CONSTRAINT training_plans_difficulty_check CHECK ((difficulty = ANY (ARRAY['beginner'::text, 'intermediate'::text, 'advanced'::text]))),
    CONSTRAINT training_plans_plan_type_check CHECK (((plan_type IS NULL) OR (plan_type = ANY (ARRAY['training'::text, 'diagnostic'::text, 'fitting'::text])))),
    CONSTRAINT training_plans_sessions_per_week_check CHECK (((sessions_per_week >= 1) AND (sessions_per_week <= 7))),
    CONSTRAINT training_plans_target_distance_check CHECK (((target_distance IS NULL) OR (target_distance = ANY (ARRAY['short_medium'::text, 'long'::text]))))
);


--
-- Name: TABLE training_plans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.training_plans IS '[Training] Plans d''entraînement structurés';


--
-- Name: COLUMN training_plans.target_distance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.training_plans.target_distance IS 'Target race distance bucket: short_medium (crit, CR, sprint/olympic tri) or long (half/full tri, long gravel, ultra). Nullable until seeded plans are tagged.';


--
-- Name: COLUMN training_plans.sessions_per_week; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.training_plans.sessions_per_week IS 'Default number of weekly session cells rendered in the plan builder grid. The UI may still show extra "+" cells per week so admins can add more sessions on specific weeks without raising the global default.';


--
-- Name: training_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    info text,
    plan_id uuid,
    session_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    thumbnail_url text,
    total_duration smallint,
    is_test boolean DEFAULT false,
    live_comments jsonb DEFAULT '[]'::jsonb,
    translations_json jsonb,
    objectif text,
    aero_duration_sec integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE training_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.training_sessions IS '[Training] Séances d''entraînement (blocs, durée, commentaires live)';


--
-- Name: COLUMN training_sessions.aero_duration_sec; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.training_sessions.aero_duration_sec IS 'Cumulative duration (seconds) spent in aero positions (prolongateurs + drops_aggro), including FRAC work + recup phases. Computed client-side on save.';


--
-- Name: user_bests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_bests (
    user_id uuid NOT NULL,
    best_power jsonb,
    best_cda jsonb,
    best_speed jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    best_watts_per_m2 jsonb DEFAULT '[]'::jsonb,
    best_surface jsonb,
    best_aero_score jsonb DEFAULT '[]'::jsonb
);


--
-- Name: TABLE user_bests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_bests IS '[Aéro] Records personnels (best power, CdA, speed)';


--
-- Name: user_onboarding_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_onboarding_answers (
    user_id uuid NOT NULL,
    answered_at timestamp with time zone DEFAULT now() NOT NULL,
    objective text NOT NULL,
    time_budget text NOT NULL,
    pain_severity text NOT NULL,
    pain_zones text[] DEFAULT '{}'::text[] NOT NULL,
    recommended_primary text,
    recommended_premium text,
    chosen text,
    CONSTRAINT user_onboarding_answers_objective_check CHECK ((objective = ANY (ARRAY['training'::text, 'competition'::text, 'evaluation'::text]))),
    CONSTRAINT user_onboarding_answers_pain_severity_check CHECK ((pain_severity = ANY (ARRAY['none'::text, 'light'::text, 'severe'::text]))),
    CONSTRAINT user_onboarding_answers_time_budget_check CHECK ((time_budget = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))
);


--
-- Name: user_plan_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_plan_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true NOT NULL,
    completed_sessions jsonb DEFAULT '[]'::jsonb NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    name text NOT NULL,
    info text,
    session_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    thumbnail_url text,
    total_duration integer,
    CONSTRAINT name_not_empty CHECK ((char_length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: TABLE user_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_sessions IS '[Training] Séances créées par l''utilisateur (custom)';


--
-- Name: COLUMN user_sessions.total_duration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_sessions.total_duration IS 'durée de séance';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text,
    firstname text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    profile_picture text,
    bio text,
    role text DEFAULT 'user'::text,
    preferences jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    banned_until timestamp without time zone,
    login_attempts integer DEFAULT 0,
    device_ids jsonb DEFAULT '[]'::jsonb,
    height integer,
    weight numeric(5,1),
    ftp double precision,
    hr_max integer,
    hr_rest integer,
    licencetype text,
    "Cd" jsonb,
    phonenumber text,
    age smallint,
    last_login_at_ timestamp with time zone,
    birthdate date,
    massvelo numeric DEFAULT '7'::numeric,
    onboarding_completed boolean DEFAULT false,
    studio_name text,
    website text,
    lang text DEFAULT 'fr'::text,
    first_session_completed boolean DEFAULT false NOT NULL,
    weight_updated_at timestamp with time zone,
    setup_correction double precision,
    setup_anchor jsonb
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS '[Auth] Profils utilisateurs (données physiques, préférences, licence)';


--
-- Name: COLUMN users."Cd"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users."Cd" IS 'coefficient aero en fonction de la position';


--
-- Name: COLUMN users.phonenumber; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.phonenumber IS 'num de téléphone';


--
-- Name: COLUMN users.age; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.age IS 'age';


--
-- Name: COLUMN users.birthdate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.birthdate IS 'date de naissance';


--
-- Name: COLUMN users.weight_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.weight_updated_at IS 'Dernière màj utilisateur du poids. Utilisé par feat-calibration-morpho-rider pour décider quand redemander confirmation (> 15 jours).';


--
-- Name: COLUMN users.setup_correction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.setup_correction IS 'feat-double-calibration-geo-morpho : correction multiplicative du setup caméra (1.0 = neutre). NULL = jamais ancrée. Appliquée côté Rust dans recalculer_facteur, jamais ailleurs.';


--
-- Name: COLUMN users.setup_anchor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.setup_anchor IS 'feat-double-calibration-geo-morpho : contexte de l''ancrage {camera_name, d_m, f_px, anchored_at}.';


--
-- Name: version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.version (
    latest text NOT NULL,
    min_required text NOT NULL,
    expiration_date date
);


--
-- Name: TABLE version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.version IS '[Config] Versioning app principale (latest, min_required, expiration)';


--
-- Name: version_elite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.version_elite (
    latest text NOT NULL,
    min_required text NOT NULL,
    expiration_date date
);


--
-- Name: TABLE version_elite; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.version_elite IS '[Config] Versioning app Elite HT';


--
-- Name: webapp_session_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webapp_session_state (
    user_id uuid NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    is_paused boolean DEFAULT false NOT NULL,
    session_id uuid,
    session_type text,
    started_at timestamp with time zone,
    current_cda double precision,
    current_surface double precision,
    current_watts double precision,
    current_speed double precision,
    current_aero_score double precision,
    cadence integer,
    saved_power double precision,
    earned_speed double precision,
    ftp double precision,
    current_block text,
    updated_at timestamp with time zone DEFAULT now(),
    session_time_s integer,
    session_state text DEFAULT 'idle'::text,
    save_position_countdown integer DEFAULT 0 NOT NULL,
    ref_power integer DEFAULT 200 NOT NULL,
    live_positions jsonb DEFAULT '[]'::jsonb NOT NULL,
    guided_state jsonb,
    diagnostic_phase text
);


--
-- Name: TABLE webapp_session_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.webapp_session_state IS '[Aéro] État temps réel de la session webapp (live metrics)';


--
-- Name: COLUMN webapp_session_state.save_position_countdown; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.webapp_session_state.save_position_countdown IS 'Countdown (s) avant capture de position fitting, 0/5/10. Partagé entre desktop et webapp via realtime postgres_changes.';


--
-- Name: COLUMN webapp_session_state.ref_power; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.webapp_session_state.ref_power IS 'Puissance de référence (W) pour calcul vitesse en mode fitting. Slider desktop (100-500W step 10). Partagé desktop/webapp via realtime postgres_changes.';


--
-- Name: COLUMN webapp_session_state.live_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.webapp_session_state.live_positions IS 'Array of [{timestamp_ms, name, cda, surface_m2, aero_score, note}] partagé live entre desktop et webapp. Edit name/note depuis webapp via command update_position.';


--
-- Name: COLUMN webapp_session_state.guided_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.webapp_session_state.guided_state IS 'Etat guide synchronise desktop <-> mycompanion pour les consignes S1 diagnostic. Structure: {intro_shown: bool, intro_texts: {title,body_1,body_2,url,cta}|null, live_hint_text: string|null, reference_pending: {position_id,mask_url,created_at}|null, reference_response: "validate"|"retake"|null}. Les strings sont resolues cote desktop (i18n desktop) pour eviter la duplication de dictionnaires entre les 2 apps. Les libelles boutons webapp restent en i18n webapp.';


--
-- Name: COLUMN webapp_session_state.diagnostic_phase; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.webapp_session_state.diagnostic_phase IS 'Phase diagnostic pour session_type=''diagnostic_basic'' — valeurs ''s1'' | ''s2'' | NULL. Poussé par le desktop depuis SessionModeProvider.diagnosticPhase pour permettre à la webapp de différencier l''UI S1 (fitting-like) de l''UI S2.';


--
-- Name: widgetbook_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.widgetbook_samples (
    id integer NOT NULL,
    slot text NOT NULL,
    name text NOT NULL,
    cda double precision NOT NULL,
    surface_m2 double precision NOT NULL,
    aero_score double precision,
    mask_png bytea NOT NULL
);


--
-- Name: widgetbook_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.widgetbook_samples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: widgetbook_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.widgetbook_samples_id_seq OWNED BY public.widgetbook_samples.id;


--
-- Name: widgetbook_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widgetbook_samples ALTER COLUMN id SET DEFAULT nextval('public.widgetbook_samples_id_seq'::regclass);


--
-- Name: bf_analyses bf_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_analyses
    ADD CONSTRAINT bf_analyses_pkey PRIMARY KEY (id);


--
-- Name: bf_analyses bf_analyses_stripe_meter_event_identifier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_analyses
    ADD CONSTRAINT bf_analyses_stripe_meter_event_identifier_key UNIQUE (stripe_meter_event_identifier);


--
-- Name: bf_billing bf_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_billing
    ADD CONSTRAINT bf_billing_pkey PRIMARY KEY (user_id);


--
-- Name: bf_billing bf_billing_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_billing
    ADD CONSTRAINT bf_billing_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: bf_billing bf_billing_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_billing
    ADD CONSTRAINT bf_billing_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: bf_business_ids bf_business_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_business_ids
    ADD CONSTRAINT bf_business_ids_pkey PRIMARY KEY (id_key);


--
-- Name: bf_business_ids bf_business_ids_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_business_ids
    ADD CONSTRAINT bf_business_ids_user_id_key UNIQUE (user_id);


--
-- Name: bf_clients bf_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_clients
    ADD CONSTRAINT bf_clients_pkey PRIMARY KEY (id);


--
-- Name: bf_credits bf_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_credits
    ADD CONSTRAINT bf_credits_pkey PRIMARY KEY (id);


--
-- Name: bf_credits bf_credits_user_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_credits
    ADD CONSTRAINT bf_credits_user_source_key UNIQUE (user_id, source);


--
-- Name: bf_profiles bf_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_profiles
    ADD CONSTRAINT bf_profiles_pkey PRIMARY KEY (id);


--
-- Name: bf_profiles bf_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_profiles
    ADD CONSTRAINT bf_profiles_user_id_key UNIQUE (user_id);


--
-- Name: bf_trial_cards bf_trial_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_trial_cards
    ADD CONSTRAINT bf_trial_cards_pkey PRIMARY KEY (fingerprint);


--
-- Name: calibration_telemetry calibration_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_telemetry
    ADD CONSTRAINT calibration_telemetry_pkey PRIMARY KEY (id);


--
-- Name: calibration_telemetry_samples calibration_telemetry_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_telemetry_samples
    ADD CONSTRAINT calibration_telemetry_samples_pkey PRIMARY KEY (id);


--
-- Name: cda_tool_events cda_tool_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cda_tool_events
    ADD CONSTRAINT cda_tool_events_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: competition_live_state competition_live_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_live_state
    ADD CONSTRAINT competition_live_state_pkey PRIMARY KEY (id);


--
-- Name: competition_runs competition_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_runs
    ADD CONSTRAINT competition_runs_pkey PRIMARY KEY (id);


--
-- Name: competition_users competition_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_users
    ADD CONSTRAINT competition_users_pkey PRIMARY KEY (id);


--
-- Name: crm_contacts crm_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_contacts crm_contacts_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_slug_key UNIQUE (slug);


--
-- Name: crm_events crm_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_pkey PRIMARY KEY (id);


--
-- Name: crm_members crm_members_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_members
    ADD CONSTRAINT crm_members_email_key UNIQUE (email);


--
-- Name: crm_members crm_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_members
    ADD CONSTRAINT crm_members_pkey PRIMARY KEY (user_id);


--
-- Name: device_logs device_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_logs
    ADD CONSTRAINT device_logs_pkey PRIMARY KEY (id);


--
-- Name: device_logs device_logs_user_trigger_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_logs
    ADD CONSTRAINT device_logs_user_trigger_unique UNIQUE (user_id, trigger);


--
-- Name: diagnostic_basic diagnostic_basic_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic
    ADD CONSTRAINT diagnostic_basic_pkey PRIMARY KEY (id);


--
-- Name: diagnostic_basic_positions diagnostic_basic_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic_positions
    ADD CONSTRAINT diagnostic_basic_positions_pkey PRIMARY KEY (id);


--
-- Name: diagnostic_basic_s2 diagnostic_basic_s2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic_s2
    ADD CONSTRAINT diagnostic_basic_s2_pkey PRIMARY KEY (id);


--
-- Name: diagnostic_purchases diagnostic_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_purchases
    ADD CONSTRAINT diagnostic_purchases_pkey PRIMARY KEY (id);


--
-- Name: diagnostic_purchases diagnostic_purchases_stripe_checkout_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_purchases
    ADD CONSTRAINT diagnostic_purchases_stripe_checkout_session_id_key UNIQUE (stripe_checkout_session_id);


--
-- Name: diagnostic_purchases diagnostic_purchases_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_purchases
    ADD CONSTRAINT diagnostic_purchases_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: ftp_aerox ftp_aerox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ftp_aerox
    ADD CONSTRAINT ftp_aerox_pkey PRIMARY KEY (id);


--
-- Name: gpx_metadata gpx_metadata_file_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_metadata
    ADD CONSTRAINT gpx_metadata_file_path_key UNIQUE (file_path);


--
-- Name: gpx_metadata gpx_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_metadata
    ADD CONSTRAINT gpx_metadata_pkey PRIMARY KEY (id);


--
-- Name: gpx_usages gpx_usages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_usages
    ADD CONSTRAINT gpx_usages_pkey PRIMARY KEY (id);


--
-- Name: plan_sessions plan_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_sessions
    ADD CONSTRAINT plan_sessions_pkey PRIMARY KEY (id);


--
-- Name: plan_sessions plan_sessions_plan_id_week_number_session_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_sessions
    ADD CONSTRAINT plan_sessions_plan_id_week_number_session_number_key UNIQUE (plan_id, week_number, session_number);


--
-- Name: session_positions session_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_positions
    ADD CONSTRAINT session_positions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: setup_correction_history setup_correction_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correction_history
    ADD CONSTRAINT setup_correction_history_pkey PRIMARY KEY (id);


--
-- Name: stripe_events stripe_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_events
    ADD CONSTRAINT stripe_events_pkey PRIMARY KEY (id);


--
-- Name: training_plans training_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_pkey PRIMARY KEY (id);


--
-- Name: challenge_sessions training_sessions_duplicate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_sessions
    ADD CONSTRAINT training_sessions_duplicate_pkey PRIMARY KEY (id);


--
-- Name: training_sessions training_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_sessions
    ADD CONSTRAINT training_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions unique_user_session_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT unique_user_session_name UNIQUE (user_id, name);


--
-- Name: user_bests user_bests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bests
    ADD CONSTRAINT user_bests_pkey PRIMARY KEY (user_id);


--
-- Name: user_onboarding_answers user_onboarding_answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_onboarding_answers
    ADD CONSTRAINT user_onboarding_answers_pkey PRIMARY KEY (user_id);


--
-- Name: user_plan_progress user_plan_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_plan_progress
    ADD CONSTRAINT user_plan_progress_pkey PRIMARY KEY (id);


--
-- Name: user_plan_progress user_plan_progress_user_id_plan_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_plan_progress
    ADD CONSTRAINT user_plan_progress_user_id_plan_id_key UNIQUE (user_id, plan_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: version_elite version_elite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.version_elite
    ADD CONSTRAINT version_elite_pkey PRIMARY KEY (latest);


--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (latest);


--
-- Name: webapp_session_state webapp_session_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webapp_session_state
    ADD CONSTRAINT webapp_session_state_pkey PRIMARY KEY (user_id);


--
-- Name: widgetbook_samples widgetbook_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widgetbook_samples
    ADD CONSTRAINT widgetbook_samples_pkey PRIMARY KEY (id);


--
-- Name: widgetbook_samples widgetbook_samples_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widgetbook_samples
    ADD CONSTRAINT widgetbook_samples_slot_key UNIQUE (slot);


--
-- Name: bf_analyses_client_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bf_analyses_client_recent_idx ON public.bf_analyses USING btree (client_id, counted_at DESC);


--
-- Name: bf_analyses_credit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bf_analyses_credit_idx ON public.bf_analyses USING btree (credit_id);


--
-- Name: bf_analyses_meter_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bf_analyses_meter_pending_idx ON public.bf_analyses USING btree (counted_at) WHERE ((billing_mode = ANY (ARRAY['studio'::text, 'payg'::text, 'essential'::text])) AND (meter_reported_at IS NULL));


--
-- Name: bf_analyses_user_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bf_analyses_user_recent_idx ON public.bf_analyses USING btree (user_id, counted_at DESC);


--
-- Name: bf_credits_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bf_credits_available_idx ON public.bf_credits USING btree (user_id, expires_at) WHERE (remaining > 0);


--
-- Name: calibration_telemetry_samples_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calibration_telemetry_samples_parent_idx ON public.calibration_telemetry_samples USING btree (parent_id);


--
-- Name: calibration_telemetry_samples_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calibration_telemetry_samples_session_idx ON public.calibration_telemetry_samples USING btree (session_id, captured_at);


--
-- Name: calibration_telemetry_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calibration_telemetry_session_idx ON public.calibration_telemetry USING btree (session_id) WHERE (session_id IS NOT NULL);


--
-- Name: calibration_telemetry_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calibration_telemetry_user_idx ON public.calibration_telemetry USING btree (user_id, created_at DESC);


--
-- Name: cda_tool_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cda_tool_events_created_at_idx ON public.cda_tool_events USING btree (created_at);


--
-- Name: competition_runs_aero_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competition_runs_aero_idx ON public.competition_runs USING btree (best_cda_300s);


--
-- Name: competition_runs_perf_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competition_runs_perf_idx ON public.competition_runs USING btree (best_watts_per_m2_30s DESC NULLS LAST);


--
-- Name: competition_runs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competition_runs_user_id_idx ON public.competition_runs USING btree (user_id);


--
-- Name: competition_users_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competition_users_created_at_idx ON public.competition_users USING btree (created_at DESC);


--
-- Name: competition_users_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competition_users_email_idx ON public.competition_users USING btree (email);


--
-- Name: crm_contacts_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_contacts_email_key ON public.crm_contacts USING btree (lower(email)) WHERE (email <> ''::text);


--
-- Name: crm_events_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_events_contact_idx ON public.crm_events USING btree (contact_id, occurred_on DESC);


--
-- Name: diagnostic_basic_purchase_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX diagnostic_basic_purchase_idx ON public.diagnostic_basic USING btree (purchase_id);


--
-- Name: diagnostic_purchases_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX diagnostic_purchases_user_idx ON public.diagnostic_purchases USING btree (user_id);


--
-- Name: idx_bf_clients_bf_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bf_clients_bf_user_id ON public.bf_clients USING btree (bf_user_id);


--
-- Name: idx_diag_s2_badges; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diag_s2_badges ON public.diagnostic_basic_s2 USING gin (aptitude_badges);


--
-- Name: idx_diag_s2_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diag_s2_position ON public.diagnostic_basic_s2 USING btree (diagnostic_id, s1_position_id);


--
-- Name: idx_diagnostic_basic_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_basic_expires ON public.diagnostic_basic USING btree (expires_at) WHERE (status = 'in_progress'::public.diagnostic_basic_status);


--
-- Name: idx_diagnostic_basic_positions_diagnostic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_basic_positions_diagnostic ON public.diagnostic_basic_positions USING btree (diagnostic_id);


--
-- Name: idx_diagnostic_basic_s2_diagnostic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_basic_s2_diagnostic ON public.diagnostic_basic_s2 USING btree (diagnostic_id);


--
-- Name: idx_diagnostic_basic_s2_stability; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_basic_s2_stability ON public.diagnostic_basic_s2 USING btree (diagnostic_id, stability_score DESC);


--
-- Name: idx_diagnostic_basic_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnostic_basic_user_status ON public.diagnostic_basic USING btree (user_id, status);


--
-- Name: idx_gpx_metadata_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gpx_metadata_created_at ON public.gpx_metadata USING btree (created_at);


--
-- Name: idx_plan_sessions_training_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plan_sessions_training_session_id ON public.plan_sessions USING btree (training_session_id);


--
-- Name: idx_session_positions_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_positions_session_id ON public.session_positions USING btree (session_id);


--
-- Name: idx_session_positions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_positions_user_id ON public.session_positions USING btree (user_id);


--
-- Name: idx_sessions_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_client_id ON public.sessions USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_sessions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_created_at ON public.sessions USING btree (created_at);


--
-- Name: idx_sessions_rider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_rider_id ON public.sessions USING btree (rider_id) WHERE (rider_id IS NOT NULL);


--
-- Name: idx_sessions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_type ON public.sessions USING btree (session_type);


--
-- Name: idx_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);


--
-- Name: idx_user_gpx_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_gpx_unique ON public.gpx_usages USING btree (user_id, gpx_id);


--
-- Name: idx_user_plan_progress_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_plan_progress_user_id ON public.user_plan_progress USING btree (user_id);


--
-- Name: setup_correction_history_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX setup_correction_history_client_idx ON public.setup_correction_history USING btree (user_id, camera_name, client_id, created_at DESC) WHERE (client_id IS NOT NULL);


--
-- Name: setup_correction_history_user_camera_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX setup_correction_history_user_camera_idx ON public.setup_correction_history USING btree (user_id, camera_name, created_at DESC);


--
-- Name: uniq_diagnostic_basic_in_progress; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_diagnostic_basic_in_progress ON public.diagnostic_basic USING btree (user_id) WHERE (status = 'in_progress'::public.diagnostic_basic_status);


--
-- Name: bf_analyses trg_bf_analysis_meter_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bf_analysis_meter_notify AFTER INSERT ON public.bf_analyses REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION public.bf_analysis_meter_notify();


--
-- Name: bf_billing trg_bf_billing_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bf_billing_set_updated_at BEFORE UPDATE ON public.bf_billing FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sessions trg_bf_count_session_backstop; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bf_count_session_backstop AFTER INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.bf_count_session_backstop();


--
-- Name: bf_business_ids trg_bf_notify_business_review; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bf_notify_business_review AFTER INSERT OR UPDATE OF status ON public.bf_business_ids FOR EACH ROW EXECUTE FUNCTION public.bf_notify_business_review();


--
-- Name: bf_billing trg_bf_unpaid_reset; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bf_unpaid_reset BEFORE UPDATE OF unpaid_invoice_id ON public.bf_billing FOR EACH ROW EXECUTE FUNCTION public.bf_unpaid_reset();


--
-- Name: users trg_crm_bf_signup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_crm_bf_signup AFTER INSERT OR UPDATE OF role ON public.users FOR EACH ROW EXECUTE FUNCTION public.crm_on_bf_signup();


--
-- Name: crm_contacts trg_crm_contacts_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_crm_contacts_touch BEFORE UPDATE ON public.crm_contacts FOR EACH ROW EXECUTE FUNCTION public.crm_contacts_touch();


--
-- Name: crm_events trg_crm_events_author; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_crm_events_author BEFORE INSERT ON public.crm_events FOR EACH ROW EXECUTE FUNCTION public.crm_events_author();


--
-- Name: device_logs trg_device_logs_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_device_logs_set_updated_at BEFORE UPDATE ON public.device_logs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: diagnostic_basic trg_diagnostic_basic_guard_client_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_diagnostic_basic_guard_client_update BEFORE UPDATE ON public.diagnostic_basic FOR EACH ROW EXECUTE FUNCTION public.diagnostic_basic_guard_client_update();


--
-- Name: users trg_notify_admin_new_bf; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_admin_new_bf AFTER INSERT OR UPDATE OF role ON public.users FOR EACH ROW EXECUTE FUNCTION public.notify_admin_new_bf();


--
-- Name: users trg_notify_admin_pending_bf; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_admin_pending_bf AFTER INSERT OR UPDATE OF role ON public.users FOR EACH ROW EXECUTE FUNCTION public.notify_admin_pending_bf();


--
-- Name: sessions trg_notify_client_post_fitting; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notify_client_post_fitting AFTER INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.notify_client_post_fitting();


--
-- Name: diagnostic_basic_positions trg_recompute_best_s1; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recompute_best_s1 AFTER INSERT OR DELETE OR UPDATE OF aero_score ON public.diagnostic_basic_positions FOR EACH ROW EXECUTE FUNCTION public.recompute_diagnostic_basic_best_s1();


--
-- Name: diagnostic_basic_s2 trg_recompute_best_s2; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recompute_best_s2 AFTER INSERT OR UPDATE OF stability_score, validated ON public.diagnostic_basic_s2 FOR EACH ROW EXECUTE FUNCTION public.recompute_diagnostic_basic_best_s2();


--
-- Name: diagnostic_basic_positions trg_recompute_s1_counts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recompute_s1_counts AFTER INSERT OR DELETE ON public.diagnostic_basic_positions FOR EACH ROW EXECUTE FUNCTION public.recompute_diagnostic_basic_s1_counts();


--
-- Name: diagnostic_basic_s2 trg_recompute_s2_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recompute_s2_count AFTER INSERT OR DELETE ON public.diagnostic_basic_s2 FOR EACH ROW EXECUTE FUNCTION public.recompute_diagnostic_basic_s2_count();


--
-- Name: bf_analyses bf_analyses_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_analyses
    ADD CONSTRAINT bf_analyses_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.bf_clients(id) ON DELETE SET NULL;


--
-- Name: bf_analyses bf_analyses_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_analyses
    ADD CONSTRAINT bf_analyses_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.bf_credits(id) ON DELETE SET NULL;


--
-- Name: bf_analyses bf_analyses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_analyses
    ADD CONSTRAINT bf_analyses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_billing bf_billing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_billing
    ADD CONSTRAINT bf_billing_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_business_ids bf_business_ids_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_business_ids
    ADD CONSTRAINT bf_business_ids_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_clients bf_clients_bf_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_clients
    ADD CONSTRAINT bf_clients_bf_user_id_fkey FOREIGN KEY (bf_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_clients bf_clients_linked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_clients
    ADD CONSTRAINT bf_clients_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: bf_credits bf_credits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_credits
    ADD CONSTRAINT bf_credits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_profiles bf_profiles_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_profiles
    ADD CONSTRAINT bf_profiles_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_profiles bf_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_profiles
    ADD CONSTRAINT bf_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bf_trial_cards bf_trial_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bf_trial_cards
    ADD CONSTRAINT bf_trial_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: calibration_telemetry_samples calibration_telemetry_samples_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_telemetry_samples
    ADD CONSTRAINT calibration_telemetry_samples_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.calibration_telemetry(id) ON DELETE CASCADE;


--
-- Name: calibration_telemetry_samples calibration_telemetry_samples_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_telemetry_samples
    ADD CONSTRAINT calibration_telemetry_samples_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: calibration_telemetry calibration_telemetry_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_telemetry
    ADD CONSTRAINT calibration_telemetry_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: competition_live_state competition_live_state_competition_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_live_state
    ADD CONSTRAINT competition_live_state_competition_user_id_fkey FOREIGN KEY (competition_user_id) REFERENCES public.competition_users(id) ON DELETE SET NULL;


--
-- Name: competition_runs competition_runs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_runs
    ADD CONSTRAINT competition_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: competition_runs competition_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_runs
    ADD CONSTRAINT competition_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.competition_users(id) ON DELETE CASCADE;


--
-- Name: competition_users competition_users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_users
    ADD CONSTRAINT competition_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: crm_contacts crm_contacts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: crm_events crm_events_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE CASCADE;


--
-- Name: crm_events crm_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: crm_members crm_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_members
    ADD CONSTRAINT crm_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: device_logs device_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_logs
    ADD CONSTRAINT device_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: diagnostic_basic diagnostic_basic_best_s1_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic
    ADD CONSTRAINT diagnostic_basic_best_s1_fk FOREIGN KEY (best_s1_position_id) REFERENCES public.diagnostic_basic_positions(id) ON DELETE SET NULL;


--
-- Name: diagnostic_basic diagnostic_basic_best_s2_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic
    ADD CONSTRAINT diagnostic_basic_best_s2_fk FOREIGN KEY (best_s2_id) REFERENCES public.diagnostic_basic_s2(id) ON DELETE SET NULL;


--
-- Name: diagnostic_basic_positions diagnostic_basic_positions_diagnostic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic_positions
    ADD CONSTRAINT diagnostic_basic_positions_diagnostic_id_fkey FOREIGN KEY (diagnostic_id) REFERENCES public.diagnostic_basic(id) ON DELETE CASCADE;


--
-- Name: diagnostic_basic diagnostic_basic_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic
    ADD CONSTRAINT diagnostic_basic_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.diagnostic_purchases(id) ON DELETE CASCADE;


--
-- Name: diagnostic_basic_s2 diagnostic_basic_s2_diagnostic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic_s2
    ADD CONSTRAINT diagnostic_basic_s2_diagnostic_id_fkey FOREIGN KEY (diagnostic_id) REFERENCES public.diagnostic_basic(id) ON DELETE CASCADE;


--
-- Name: diagnostic_basic_s2 diagnostic_basic_s2_s1_position_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic_s2
    ADD CONSTRAINT diagnostic_basic_s2_s1_position_id_fkey FOREIGN KEY (s1_position_id) REFERENCES public.diagnostic_basic_positions(id) ON DELETE SET NULL;


--
-- Name: diagnostic_basic diagnostic_basic_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_basic
    ADD CONSTRAINT diagnostic_basic_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: diagnostic_purchases diagnostic_purchases_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnostic_purchases
    ADD CONSTRAINT diagnostic_purchases_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ftp_aerox ftp_aerox_training_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ftp_aerox
    ADD CONSTRAINT ftp_aerox_training_session_id_fkey FOREIGN KEY (training_session_id) REFERENCES public.training_sessions(id);


--
-- Name: ftp_aerox ftp_aerox_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ftp_aerox
    ADD CONSTRAINT ftp_aerox_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: gpx_usages gpx_usages_gpx_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_usages
    ADD CONSTRAINT gpx_usages_gpx_id_fkey FOREIGN KEY (gpx_id) REFERENCES public.gpx_metadata(id) ON DELETE CASCADE;


--
-- Name: gpx_usages gpx_usages_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_usages
    ADD CONSTRAINT gpx_usages_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: gpx_usages gpx_usages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpx_usages
    ADD CONSTRAINT gpx_usages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plan_sessions plan_sessions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_sessions
    ADD CONSTRAINT plan_sessions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.training_plans(id) ON DELETE CASCADE;


--
-- Name: plan_sessions plan_sessions_training_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plan_sessions
    ADD CONSTRAINT plan_sessions_training_session_id_fkey FOREIGN KEY (training_session_id) REFERENCES public.training_sessions(id) ON DELETE CASCADE;


--
-- Name: session_positions session_positions_rider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_positions
    ADD CONSTRAINT session_positions_rider_id_fkey FOREIGN KEY (rider_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: session_positions session_positions_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_positions
    ADD CONSTRAINT session_positions_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: CONSTRAINT session_positions_session_fk ON session_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT session_positions_session_fk ON public.session_positions IS 'Rend les orphelins physiquement impossibles. CASCADE : delete session → delete positions.';


--
-- Name: session_positions session_positions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_positions
    ADD CONSTRAINT session_positions_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: session_positions session_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_positions
    ADD CONSTRAINT session_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: sessions sessions_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.bf_clients(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_rider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_rider_id_fkey FOREIGN KEY (rider_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: setup_correction_history setup_correction_history_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correction_history
    ADD CONSTRAINT setup_correction_history_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.bf_clients(id) ON DELETE CASCADE;


--
-- Name: setup_correction_history setup_correction_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correction_history
    ADD CONSTRAINT setup_correction_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: challenge_sessions training_sessions_duplicate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_sessions
    ADD CONSTRAINT training_sessions_duplicate_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.training_plans(id) ON DELETE SET NULL;


--
-- Name: training_sessions training_sessions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_sessions
    ADD CONSTRAINT training_sessions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.training_plans(id) ON DELETE SET NULL;


--
-- Name: user_bests user_bests_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bests
    ADD CONSTRAINT user_bests_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_bests user_bests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bests
    ADD CONSTRAINT user_bests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_onboarding_answers user_onboarding_answers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_onboarding_answers
    ADD CONSTRAINT user_onboarding_answers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_plan_progress user_plan_progress_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_plan_progress
    ADD CONSTRAINT user_plan_progress_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.training_plans(id);


--
-- Name: user_plan_progress user_plan_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_plan_progress
    ADD CONSTRAINT user_plan_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: users users_auth_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_auth_fk FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webapp_session_state webapp_session_state_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webapp_session_state
    ADD CONSTRAINT webapp_session_state_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webapp_session_state webapp_session_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webapp_session_state
    ADD CONSTRAINT webapp_session_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plan_sessions Admin manages plan sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin manages plan sessions" ON public.plan_sessions USING ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text)) WITH CHECK ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text));


--
-- Name: training_plans Admin manages plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin manages plans" ON public.training_plans USING ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text)) WITH CHECK ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text));


--
-- Name: training_sessions Admin manages training sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin manages training sessions" ON public.training_sessions USING ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text)) WITH CHECK ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text));


--
-- Name: gpx_usages Allow delete for owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow delete for owner" ON public.gpx_usages FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: gpx_metadata Allow insert for authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert for authenticated" ON public.gpx_metadata FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: users Allow insert for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert for authenticated users" ON public.users FOR INSERT TO authenticated WITH CHECK (((auth.uid() = id) AND ((role IS NULL) OR (role = ANY (ARRAY['user'::text, 'rider'::text, 'pending_bf'::text])))));


--
-- Name: gpx_usages Allow insert if authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert if authenticated" ON public.gpx_usages FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: gpx_metadata Allow read for all authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read for all authenticated users" ON public.gpx_metadata FOR SELECT TO authenticated USING (true);


--
-- Name: gpx_usages Allow select to authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow select to authenticated" ON public.gpx_usages FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: gpx_usages Allow update for owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow update for owner" ON public.gpx_usages FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: gpx_metadata Authenticated read GPX metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated read GPX metadata" ON public.gpx_metadata FOR SELECT TO authenticated USING (true);


--
-- Name: challenge_sessions Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.challenge_sessions FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: users Every user read their row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Every user read their row" ON public.users FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: training_plans Everyone can read training_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Everyone can read training_plans" ON public.training_plans FOR SELECT TO authenticated USING (true);


--
-- Name: training_sessions Everyone can read training_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Everyone can read training_sessions" ON public.training_sessions FOR SELECT TO authenticated USING (true);


--
-- Name: version Public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read access" ON public.version FOR SELECT USING (true);


--
-- Name: version_elite Public read access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read access" ON public.version_elite FOR SELECT USING (true);


--
-- Name: training_plans Read active plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read active plans" ON public.training_plans FOR SELECT USING ((is_active = true));


--
-- Name: plan_sessions Read plan sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read plan sessions" ON public.plan_sessions FOR SELECT USING (true);


--
-- Name: training_sessions Read training sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read training sessions" ON public.training_sessions FOR SELECT USING (true);


--
-- Name: challenge_sessions Select by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Select by authenticated" ON public.challenge_sessions FOR SELECT TO authenticated USING (true);


--
-- Name: gpx_usages User can insert own usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User can insert own usage" ON public.gpx_usages FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: gpx_usages User can read own usages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User can read own usages" ON public.gpx_usages FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: gpx_usages User can update own usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User can update own usage" ON public.gpx_usages FOR UPDATE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: ftp_aerox User manages own ftp_aerox; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User manages own ftp_aerox" ON public.ftp_aerox USING ((auth.uid() = user_id));


--
-- Name: user_plan_progress User manages own progress; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User manages own progress" ON public.user_plan_progress USING ((auth.uid() = user_id));


--
-- Name: sessions Users can delete own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own sessions" ON public.sessions FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: session_positions Users can delete positions of own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete positions of own sessions" ON public.session_positions FOR DELETE USING ((session_id IN ( SELECT sessions.id
   FROM public.sessions
  WHERE (sessions.user_id = auth.uid()))));


--
-- Name: user_sessions Users can delete their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own sessions" ON public.user_sessions FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_sessions Users can insert their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own sessions" ON public.user_sessions FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_sessions Users can update their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own sessions" ON public.user_sessions FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: user_sessions Users can view their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own sessions" ON public.user_sessions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: webapp_session_state Users read own state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read own state" ON public.webapp_session_state FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: webapp_session_state Users update own state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own state" ON public.webapp_session_state TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: competition_live_state admin_all_competition_live_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_competition_live_state ON public.competition_live_state USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: competition_runs admin_all_competition_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_competition_runs ON public.competition_runs USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: competition_users admin_all_competition_users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_competition_users ON public.competition_users USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: bf_clients admin_read_all_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_clients ON public.bf_clients FOR SELECT USING (public.is_admin());


--
-- Name: diagnostic_basic admin_read_all_diag; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_diag ON public.diagnostic_basic FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: diagnostic_basic_positions admin_read_all_diag_pos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_diag_pos ON public.diagnostic_basic_positions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: diagnostic_basic_s2 admin_read_all_diag_s2; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_diag_s2 ON public.diagnostic_basic_s2 FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: device_logs admin_read_all_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_logs ON public.device_logs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.role = 'admin'::text)))));


--
-- Name: session_positions admin_read_all_positions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_positions ON public.session_positions FOR SELECT USING (public.is_admin());


--
-- Name: sessions admin_read_all_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_sessions ON public.sessions FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (rider_id = auth.uid()) OR public.is_admin()));


--
-- Name: calibration_telemetry admin_read_all_telemetry; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_telemetry ON public.calibration_telemetry FOR SELECT USING ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text));


--
-- Name: calibration_telemetry_samples admin_read_all_telemetry_samples; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_telemetry_samples ON public.calibration_telemetry_samples FOR SELECT USING ((( SELECT users.role
   FROM public.users
  WHERE (users.id = auth.uid())) = 'admin'::text));


--
-- Name: users admin_read_all_users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_all_users ON public.users FOR SELECT TO authenticated USING (((id = auth.uid()) OR public.is_admin()));


--
-- Name: users admin_update_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_update_role ON public.users FOR UPDATE USING ((public.get_my_role() = 'admin'::text)) WITH CHECK ((public.get_my_role() = 'admin'::text));


--
-- Name: bf_analyses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_analyses ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_analyses bf_analyses_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_analyses_select_own ON public.bf_analyses FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: bf_billing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_billing ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_billing bf_billing_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_billing_select_own ON public.bf_billing FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: bf_business_ids; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_business_ids ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_credits ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_credits bf_credits_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_credits_select_own ON public.bf_credits FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: bf_clients bf_delete_own_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_delete_own_clients ON public.bf_clients FOR DELETE USING (((bf_user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_profiles bf_delete_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_delete_own_profile ON public.bf_profiles FOR DELETE USING (((user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_clients bf_insert_own_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_insert_own_clients ON public.bf_clients FOR INSERT WITH CHECK (((bf_user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_profiles bf_insert_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_insert_own_profile ON public.bf_profiles FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_clients bf_select_own_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_select_own_clients ON public.bf_clients FOR SELECT USING (((bf_user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_profiles bf_select_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_select_own_profile ON public.bf_profiles FOR SELECT USING (((user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text]))));


--
-- Name: bf_trial_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bf_trial_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: bf_clients bf_update_own_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_update_own_clients ON public.bf_clients FOR UPDATE USING (((bf_user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text])))) WITH CHECK ((bf_user_id = auth.uid()));


--
-- Name: bf_profiles bf_update_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bf_update_own_profile ON public.bf_profiles FOR UPDATE USING (((user_id = auth.uid()) AND (public.get_my_role() = ANY (ARRAY['bike-fitter'::text, 'admin'::text])))) WITH CHECK ((user_id = auth.uid()));


--
-- Name: calibration_telemetry; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calibration_telemetry ENABLE ROW LEVEL SECURITY;

--
-- Name: calibration_telemetry_samples; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calibration_telemetry_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: cda_tool_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cda_tool_events ENABLE ROW LEVEL SECURITY;

--
-- Name: cda_tool_events cda_tool_events_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cda_tool_events_admin_read ON public.cda_tool_events FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: challenge_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.challenge_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

--
-- Name: comments comments_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comments_insert_own ON public.comments FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: comments comments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comments_select ON public.comments FOR SELECT TO authenticated USING (true);


--
-- Name: competition_live_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competition_live_state ENABLE ROW LEVEL SECURITY;

--
-- Name: competition_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competition_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: competition_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competition_users ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_contacts crm_contacts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_contacts_insert ON public.crm_contacts FOR INSERT TO authenticated WITH CHECK (public.crm_is_member());


--
-- Name: crm_contacts crm_contacts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_contacts_read ON public.crm_contacts FOR SELECT TO authenticated USING (public.crm_is_member());


--
-- Name: crm_contacts crm_contacts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_contacts_update ON public.crm_contacts FOR UPDATE TO authenticated USING (public.crm_is_member()) WITH CHECK (public.crm_is_member());


--
-- Name: crm_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_events crm_events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_events_insert ON public.crm_events FOR INSERT TO authenticated WITH CHECK (public.crm_is_member());


--
-- Name: crm_events crm_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_events_read ON public.crm_events FOR SELECT TO authenticated USING (public.crm_is_member());


--
-- Name: crm_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_members ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_members crm_members_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_members_read ON public.crm_members FOR SELECT TO authenticated USING (public.crm_is_member());


--
-- Name: device_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.diagnostic_basic ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic_positions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.diagnostic_basic_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic_s2; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.diagnostic_basic_s2 ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.diagnostic_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_purchases diagnostic_purchases_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY diagnostic_purchases_select_own ON public.diagnostic_purchases FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: ftp_aerox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ftp_aerox ENABLE ROW LEVEL SECURITY;

--
-- Name: gpx_metadata; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gpx_metadata ENABLE ROW LEVEL SECURITY;

--
-- Name: gpx_usages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gpx_usages ENABLE ROW LEVEL SECURITY;

--
-- Name: session_positions insert_own_positions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_positions ON public.session_positions FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: user_bests own_bests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_bests ON public.user_bests USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: setup_correction_history own_delete_k_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_delete_k_history ON public.setup_correction_history FOR DELETE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: setup_correction_history own_insert_k_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_insert_k_history ON public.setup_correction_history FOR INSERT WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((client_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.bf_clients c
  WHERE ((c.id = setup_correction_history.client_id) AND (c.bf_user_id = ( SELECT auth.uid() AS uid))))))));


--
-- Name: session_positions own_positions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_positions ON public.session_positions USING (((user_id = auth.uid()) OR (rider_id = auth.uid()))) WITH CHECK ((user_id = auth.uid()));


--
-- Name: setup_correction_history own_select_k_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_select_k_history ON public.setup_correction_history FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: sessions own_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_sessions ON public.sessions USING (((user_id = auth.uid()) OR (client_id = auth.uid()))) WITH CHECK ((user_id = auth.uid()));


--
-- Name: plan_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plan_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: widgetbook_samples public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.widgetbook_samples FOR SELECT USING (true);


--
-- Name: competition_live_state public_read_competition_live_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_competition_live_state ON public.competition_live_state FOR SELECT TO authenticated, anon USING (true);


--
-- Name: competition_runs public_read_competition_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_competition_runs ON public.competition_runs FOR SELECT TO authenticated, anon USING (true);


--
-- Name: user_onboarding_answers rider_can_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rider_can_insert_own ON public.user_onboarding_answers FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_onboarding_answers rider_can_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rider_can_read_own ON public.user_onboarding_answers FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_onboarding_answers rider_can_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rider_can_update_own ON public.user_onboarding_answers FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: session_positions select_own_positions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_positions ON public.session_positions FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: session_positions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.session_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: setup_correction_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.setup_correction_history ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

--
-- Name: training_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: training_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_bests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_bests ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic_positions user_delete_own_diag_pos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_delete_own_diag_pos ON public.diagnostic_basic_positions FOR DELETE TO authenticated USING (public.diagnostic_is_writable(diagnostic_id));


--
-- Name: diagnostic_basic_positions user_insert_own_diag_pos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_diag_pos ON public.diagnostic_basic_positions FOR INSERT TO authenticated WITH CHECK (public.diagnostic_is_writable(diagnostic_id));


--
-- Name: diagnostic_basic_s2 user_insert_own_diag_s2; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_diag_s2 ON public.diagnostic_basic_s2 FOR INSERT TO authenticated WITH CHECK (public.diagnostic_is_writable(diagnostic_id));


--
-- Name: device_logs user_insert_own_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_logs ON public.device_logs FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: calibration_telemetry user_insert_own_telemetry; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_telemetry ON public.calibration_telemetry FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: calibration_telemetry_samples user_insert_own_telemetry_samples; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_telemetry_samples ON public.calibration_telemetry_samples FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_onboarding_answers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_onboarding_answers ENABLE ROW LEVEL SECURITY;

--
-- Name: user_plan_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_plan_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic user_read_own_diag; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_read_own_diag ON public.diagnostic_basic FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: diagnostic_basic_positions user_read_own_diag_pos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_read_own_diag_pos ON public.diagnostic_basic_positions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.diagnostic_basic
  WHERE ((diagnostic_basic.id = diagnostic_basic_positions.diagnostic_id) AND (diagnostic_basic.user_id = auth.uid())))));


--
-- Name: diagnostic_basic_s2 user_read_own_diag_s2; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_read_own_diag_s2 ON public.diagnostic_basic_s2 FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.diagnostic_basic
  WHERE ((diagnostic_basic.id = diagnostic_basic_s2.diagnostic_id) AND (diagnostic_basic.user_id = auth.uid())))));


--
-- Name: device_logs user_select_own_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_select_own_logs ON public.device_logs FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: calibration_telemetry user_select_own_telemetry; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_select_own_telemetry ON public.calibration_telemetry FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: calibration_telemetry_samples user_select_own_telemetry_samples; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_select_own_telemetry_samples ON public.calibration_telemetry_samples FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: diagnostic_basic user_update_own_diag; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_diag ON public.diagnostic_basic FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: diagnostic_basic_positions user_update_own_diag_pos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_diag_pos ON public.diagnostic_basic_positions FOR UPDATE TO authenticated USING (public.diagnostic_is_writable(diagnostic_id)) WITH CHECK (public.diagnostic_is_writable(diagnostic_id));


--
-- Name: diagnostic_basic_s2 user_update_own_diag_s2; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_diag_s2 ON public.diagnostic_basic_s2 FOR UPDATE TO authenticated USING (public.diagnostic_is_writable(diagnostic_id)) WITH CHECK (public.diagnostic_is_writable(diagnostic_id));


--
-- Name: device_logs user_update_own_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_logs ON public.device_logs FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: users user_update_own_row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_row ON public.users FOR UPDATE TO authenticated USING ((auth.uid() = id)) WITH CHECK (((auth.uid() = id) AND ((NOT (role IS DISTINCT FROM public.get_my_role())) OR ((public.get_my_role() IS NULL) AND (role = ANY (ARRAY['rider'::text, 'pending_bf'::text]))))));


--
-- Name: calibration_telemetry user_update_own_telemetry; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_update_own_telemetry ON public.calibration_telemetry FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_select ON public.users FOR SELECT TO authenticated USING (((id = auth.uid()) OR (public.get_my_role() = 'admin'::text) OR ((public.get_my_role() = 'bike-fitter'::text) AND (id IN ( SELECT bf_clients.linked_user_id
   FROM public.bf_clients
  WHERE ((bf_clients.bf_user_id = auth.uid()) AND (bf_clients.linked_user_id IS NOT NULL)))))));


--
-- Name: version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.version ENABLE ROW LEVEL SECURITY;

--
-- Name: version_elite; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.version_elite ENABLE ROW LEVEL SECURITY;

--
-- Name: webapp_session_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webapp_session_state ENABLE ROW LEVEL SECURITY;

--
-- Name: widgetbook_samples; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.widgetbook_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION admin_set_my_diagnostic(p_action text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_my_diagnostic(p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_my_diagnostic(p_action text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_my_diagnostic(p_action text) TO service_role;


--
-- Name: FUNCTION bf_access_level(p_status text, p_grace_until timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bf_access_level(p_status text, p_grace_until timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.bf_access_level(p_status text, p_grace_until timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.bf_access_level(p_status text, p_grace_until timestamp with time zone) TO service_role;


--
-- Name: FUNCTION bf_analysis_meter_notify(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_analysis_meter_notify() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_analysis_meter_notify() TO service_role;


--
-- Name: FUNCTION bf_approve_business_id(p_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_approve_business_id(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_approve_business_id(p_user uuid) TO service_role;


--
-- Name: FUNCTION bf_claim_meter_batch(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_claim_meter_batch(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_claim_meter_batch(p_limit integer) TO service_role;


--
-- Name: FUNCTION bf_count_session_backstop(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_count_session_backstop() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_count_session_backstop() TO service_role;


--
-- Name: FUNCTION bf_find_user_by_email(_email text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_find_user_by_email(_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_find_user_by_email(_email text) TO anon;
GRANT ALL ON FUNCTION public.bf_find_user_by_email(_email text) TO authenticated;
GRANT ALL ON FUNCTION public.bf_find_user_by_email(_email text) TO service_role;


--
-- Name: FUNCTION bf_grant_credits(p_user uuid, p_amount integer, p_expires_at timestamp with time zone, p_source text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_grant_credits(p_user uuid, p_amount integer, p_expires_at timestamp with time zone, p_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_grant_credits(p_user uuid, p_amount integer, p_expires_at timestamp with time zone, p_source text) TO service_role;


--
-- Name: FUNCTION bf_grant_trial(p_user uuid, p_fingerprint text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_grant_trial(p_user uuid, p_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_grant_trial(p_user uuid, p_fingerprint text) TO service_role;


--
-- Name: FUNCTION bf_launch_seats_remaining(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_launch_seats_remaining() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_launch_seats_remaining() TO anon;
GRANT ALL ON FUNCTION public.bf_launch_seats_remaining() TO authenticated;
GRANT ALL ON FUNCTION public.bf_launch_seats_remaining() TO service_role;


--
-- Name: FUNCTION bf_mark_meter_reported(p_id uuid, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_mark_meter_reported(p_id uuid, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_mark_meter_reported(p_id uuid, p_error text) TO service_role;


--
-- Name: FUNCTION bf_notify_business_review(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_notify_business_review() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_notify_business_review() TO service_role;


--
-- Name: FUNCTION bf_open_trial_credits(p_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_open_trial_credits(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_open_trial_credits(p_user uuid) TO service_role;


--
-- Name: FUNCTION bf_ping_usage_reporter(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_ping_usage_reporter() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_ping_usage_reporter() TO service_role;


--
-- Name: FUNCTION bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_register_analysis_for(p_uid uuid, p_client_id uuid, p_origin text) TO service_role;


--
-- Name: FUNCTION bf_register_business_id(p_user uuid, p_key text, p_kind text, p_country text, p_name text, p_verified boolean, p_website text, p_email_match boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_register_business_id(p_user uuid, p_key text, p_kind text, p_country text, p_name text, p_verified boolean, p_website text, p_email_match boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_register_business_id(p_user uuid, p_key text, p_kind text, p_country text, p_name text, p_verified boolean, p_website text, p_email_match boolean) TO service_role;


--
-- Name: FUNCTION bf_send_unpaid_reminders(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_send_unpaid_reminders() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_send_unpaid_reminders() TO service_role;


--
-- Name: FUNCTION bf_start_trial(p_user uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_start_trial(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_start_trial(p_user uuid) TO service_role;


--
-- Name: FUNCTION bf_unpaid_reset(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_unpaid_reset() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_unpaid_reset() TO service_role;


--
-- Name: FUNCTION bf_usage_summary(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bf_usage_summary() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bf_usage_summary() TO authenticated;
GRANT ALL ON FUNCTION public.bf_usage_summary() TO service_role;


--
-- Name: FUNCTION cleanup_position_masks_orphans(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_position_masks_orphans() TO anon;
GRANT ALL ON FUNCTION public.cleanup_position_masks_orphans() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_position_masks_orphans() TO service_role;


--
-- Name: FUNCTION crm_account_status(p_emails text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_account_status(p_emails text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_account_status(p_emails text[]) TO authenticated;
GRANT ALL ON FUNCTION public.crm_account_status(p_emails text[]) TO service_role;


--
-- Name: FUNCTION crm_contacts_touch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.crm_contacts_touch() TO anon;
GRANT ALL ON FUNCTION public.crm_contacts_touch() TO authenticated;
GRANT ALL ON FUNCTION public.crm_contacts_touch() TO service_role;


--
-- Name: FUNCTION crm_events_author(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.crm_events_author() TO anon;
GRANT ALL ON FUNCTION public.crm_events_author() TO authenticated;
GRANT ALL ON FUNCTION public.crm_events_author() TO service_role;


--
-- Name: FUNCTION crm_is_member(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_is_member() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_is_member() TO authenticated;
GRANT ALL ON FUNCTION public.crm_is_member() TO service_role;


--
-- Name: FUNCTION crm_login_allowed(p_email text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_login_allowed(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_login_allowed(p_email text) TO anon;
GRANT ALL ON FUNCTION public.crm_login_allowed(p_email text) TO authenticated;
GRANT ALL ON FUNCTION public.crm_login_allowed(p_email text) TO service_role;


--
-- Name: FUNCTION crm_on_bf_signup(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_on_bf_signup() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_on_bf_signup() TO service_role;


--
-- Name: FUNCTION diagnostic_basic_guard_client_update(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.diagnostic_basic_guard_client_update() TO anon;
GRANT ALL ON FUNCTION public.diagnostic_basic_guard_client_update() TO authenticated;
GRANT ALL ON FUNCTION public.diagnostic_basic_guard_client_update() TO service_role;


--
-- Name: FUNCTION diagnostic_is_writable(p_diagnostic_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.diagnostic_is_writable(p_diagnostic_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.diagnostic_is_writable(p_diagnostic_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.diagnostic_is_writable(p_diagnostic_id uuid) TO service_role;


--
-- Name: FUNCTION expire_stale_diagnostic_basic(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.expire_stale_diagnostic_basic() TO anon;
GRANT ALL ON FUNCTION public.expire_stale_diagnostic_basic() TO authenticated;
GRANT ALL ON FUNCTION public.expire_stale_diagnostic_basic() TO service_role;


--
-- Name: FUNCTION get_my_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_role() TO anon;
GRANT ALL ON FUNCTION public.get_my_role() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_role() TO service_role;


--
-- Name: FUNCTION handle_email_confirmed(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.handle_email_confirmed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_email_confirmed() TO service_role;


--
-- Name: FUNCTION has_diagnostic_entitlement(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.has_diagnostic_entitlement() FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_diagnostic_entitlement() TO authenticated;
GRANT ALL ON FUNCTION public.has_diagnostic_entitlement() TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION notify_admin_new_bf(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.notify_admin_new_bf() FROM PUBLIC;
GRANT ALL ON FUNCTION public.notify_admin_new_bf() TO service_role;


--
-- Name: FUNCTION notify_admin_pending_bf(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_admin_pending_bf() TO anon;
GRANT ALL ON FUNCTION public.notify_admin_pending_bf() TO authenticated;
GRANT ALL ON FUNCTION public.notify_admin_pending_bf() TO service_role;


--
-- Name: FUNCTION notify_client_post_fitting(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_client_post_fitting() TO anon;
GRANT ALL ON FUNCTION public.notify_client_post_fitting() TO authenticated;
GRANT ALL ON FUNCTION public.notify_client_post_fitting() TO service_role;


--
-- Name: FUNCTION recompute_diagnostic_basic_best_s1(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recompute_diagnostic_basic_best_s1() FROM PUBLIC;
GRANT ALL ON FUNCTION public.recompute_diagnostic_basic_best_s1() TO service_role;


--
-- Name: FUNCTION recompute_diagnostic_basic_best_s2(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recompute_diagnostic_basic_best_s2() FROM PUBLIC;
GRANT ALL ON FUNCTION public.recompute_diagnostic_basic_best_s2() TO service_role;


--
-- Name: FUNCTION recompute_diagnostic_basic_s1_counts(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recompute_diagnostic_basic_s1_counts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.recompute_diagnostic_basic_s1_counts() TO service_role;


--
-- Name: FUNCTION recompute_diagnostic_basic_s2_count(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recompute_diagnostic_basic_s2_count() FROM PUBLIC;
GRANT ALL ON FUNCTION public.recompute_diagnostic_basic_s2_count() TO service_role;


--
-- Name: FUNCTION record_diagnostic_refund(p_payment_intent_id text, p_amount_refunded integer, p_fully_refunded boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_diagnostic_refund(p_payment_intent_id text, p_amount_refunded integer, p_fully_refunded boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_diagnostic_refund(p_payment_intent_id text, p_amount_refunded integer, p_fully_refunded boolean) TO service_role;


--
-- Name: FUNCTION register_analysis(p_client_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_analysis(p_client_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_analysis(p_client_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.register_analysis(p_client_id uuid) TO service_role;


--
-- Name: TABLE diagnostic_basic; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.diagnostic_basic TO anon;
GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.diagnostic_basic TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_basic TO service_role;


--
-- Name: COLUMN diagnostic_basic.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.diagnostic_basic TO authenticated;


--
-- Name: COLUMN diagnostic_basic.completed_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(completed_at) ON TABLE public.diagnostic_basic TO authenticated;


--
-- Name: COLUMN diagnostic_basic.aero_zone; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(aero_zone) ON TABLE public.diagnostic_basic TO authenticated;


--
-- Name: COLUMN diagnostic_basic.stability_zone; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(stability_zone) ON TABLE public.diagnostic_basic TO authenticated;


--
-- Name: COLUMN diagnostic_basic.recommendation_key; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(recommendation_key) ON TABLE public.diagnostic_basic TO authenticated;


--
-- Name: FUNCTION restart_diagnostic(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.restart_diagnostic() FROM PUBLIC;
GRANT ALL ON FUNCTION public.restart_diagnostic() TO authenticated;
GRANT ALL ON FUNCTION public.restart_diagnostic() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION start_diagnostic(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.start_diagnostic() FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_diagnostic() TO authenticated;
GRANT ALL ON FUNCTION public.start_diagnostic() TO service_role;


--
-- Name: TABLE bf_analyses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.bf_analyses TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_analyses TO service_role;


--
-- Name: TABLE bf_billing; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.bf_billing TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_billing TO service_role;


--
-- Name: TABLE bf_business_ids; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_business_ids TO service_role;


--
-- Name: TABLE bf_clients; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_clients TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_clients TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_clients TO service_role;


--
-- Name: TABLE bf_credits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.bf_credits TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_credits TO service_role;


--
-- Name: TABLE bf_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_profiles TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_profiles TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_profiles TO service_role;


--
-- Name: TABLE bf_trial_cards; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.bf_trial_cards TO service_role;


--
-- Name: TABLE calibration_telemetry; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry TO service_role;


--
-- Name: TABLE calibration_telemetry_samples; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry_samples TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry_samples TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.calibration_telemetry_samples TO service_role;


--
-- Name: TABLE cda_tool_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cda_tool_events TO service_role;
GRANT SELECT ON TABLE public.cda_tool_events TO authenticated;


--
-- Name: TABLE cda_tool_activity_daily; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cda_tool_activity_daily TO service_role;
GRANT SELECT ON TABLE public.cda_tool_activity_daily TO authenticated;


--
-- Name: TABLE cda_tool_activity_monthly; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cda_tool_activity_monthly TO service_role;
GRANT SELECT ON TABLE public.cda_tool_activity_monthly TO authenticated;


--
-- Name: TABLE cda_tool_activity_weekly; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.cda_tool_activity_weekly TO service_role;
GRANT SELECT ON TABLE public.cda_tool_activity_weekly TO authenticated;


--
-- Name: SEQUENCE cda_tool_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cda_tool_events_id_seq TO anon;
GRANT ALL ON SEQUENCE public.cda_tool_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cda_tool_events_id_seq TO service_role;


--
-- Name: TABLE challenge_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.challenge_sessions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.challenge_sessions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.challenge_sessions TO service_role;


--
-- Name: TABLE comments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.comments TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.comments TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.comments TO service_role;


--
-- Name: SEQUENCE comments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.comments_id_seq TO anon;
GRANT ALL ON SEQUENCE public.comments_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.comments_id_seq TO service_role;


--
-- Name: TABLE competition_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_runs TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_runs TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_runs TO service_role;


--
-- Name: TABLE competition_users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_users TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_users TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_users TO service_role;


--
-- Name: TABLE competition_leaderboard_aero; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_aero TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_aero TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_aero TO service_role;


--
-- Name: TABLE competition_leaderboard_perf; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_perf TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_perf TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_leaderboard_perf TO service_role;


--
-- Name: TABLE competition_live_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_live_state TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_live_state TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.competition_live_state TO service_role;


--
-- Name: TABLE crm_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.crm_contacts TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.crm_contacts TO authenticated;


--
-- Name: TABLE crm_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.crm_events TO service_role;
GRANT SELECT,INSERT ON TABLE public.crm_events TO authenticated;


--
-- Name: TABLE crm_contacts_view; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.crm_contacts_view TO service_role;
GRANT SELECT ON TABLE public.crm_contacts_view TO authenticated;


--
-- Name: TABLE crm_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.crm_members TO service_role;
GRANT SELECT ON TABLE public.crm_members TO authenticated;


--
-- Name: TABLE device_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.device_logs TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.device_logs TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.device_logs TO service_role;


--
-- Name: TABLE diagnostic_basic_positions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_basic_positions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_basic_positions TO service_role;


--
-- Name: TABLE diagnostic_basic_s2; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_basic_s2 TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_basic_s2 TO service_role;


--
-- Name: TABLE diagnostic_purchases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.diagnostic_purchases TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_purchases TO service_role;


--
-- Name: TABLE diagnostic_purchase_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_purchase_status TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.diagnostic_purchase_status TO service_role;


--
-- Name: TABLE ftp_aerox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ftp_aerox TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ftp_aerox TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.ftp_aerox TO service_role;


--
-- Name: TABLE gpx_metadata; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_metadata TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_metadata TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_metadata TO service_role;


--
-- Name: TABLE gpx_usages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_usages TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_usages TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.gpx_usages TO service_role;


--
-- Name: TABLE plan_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plan_sessions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plan_sessions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plan_sessions TO service_role;


--
-- Name: TABLE session_positions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.session_positions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.session_positions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.session_positions TO service_role;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.sessions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.sessions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.sessions TO service_role;


--
-- Name: TABLE setup_correction_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER ON TABLE public.setup_correction_history TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.setup_correction_history TO service_role;


--
-- Name: SEQUENCE setup_correction_history_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.setup_correction_history_id_seq TO anon;
GRANT ALL ON SEQUENCE public.setup_correction_history_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.setup_correction_history_id_seq TO service_role;


--
-- Name: TABLE stripe_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.stripe_events TO service_role;


--
-- Name: TABLE training_plans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_plans TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_plans TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_plans TO service_role;


--
-- Name: TABLE training_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_sessions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_sessions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.training_sessions TO service_role;


--
-- Name: TABLE user_bests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_bests TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_bests TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_bests TO service_role;


--
-- Name: TABLE user_onboarding_answers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_onboarding_answers TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_onboarding_answers TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_onboarding_answers TO service_role;


--
-- Name: TABLE user_plan_progress; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_plan_progress TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_plan_progress TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_plan_progress TO service_role;


--
-- Name: TABLE user_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_sessions TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_sessions TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.user_sessions TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public.users TO anon;
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE ON TABLE public.users TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.users TO service_role;


--
-- Name: COLUMN users.id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(id),UPDATE(id) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.email; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(email),UPDATE(email) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.name; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(name),UPDATE(name) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.firstname; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(firstname),UPDATE(firstname) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(created_at) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(updated_at),UPDATE(updated_at) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.profile_picture; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(profile_picture),UPDATE(profile_picture) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.bio; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(bio),UPDATE(bio) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.role; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(role),UPDATE(role) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.preferences; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(preferences),UPDATE(preferences) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.device_ids; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(device_ids),UPDATE(device_ids) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.height; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(height),UPDATE(height) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.weight; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(weight),UPDATE(weight) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.ftp; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(ftp),UPDATE(ftp) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.hr_max; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(hr_max),UPDATE(hr_max) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.hr_rest; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(hr_rest),UPDATE(hr_rest) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.licencetype; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(licencetype),UPDATE(licencetype) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users."Cd"; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT("Cd"),UPDATE("Cd") ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.phonenumber; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(phonenumber),UPDATE(phonenumber) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.age; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(age),UPDATE(age) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.last_login_at_; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(last_login_at_),UPDATE(last_login_at_) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.birthdate; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(birthdate),UPDATE(birthdate) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.massvelo; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(massvelo),UPDATE(massvelo) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.onboarding_completed; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(onboarding_completed),UPDATE(onboarding_completed) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.studio_name; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(studio_name),UPDATE(studio_name) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.website; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(website),UPDATE(website) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.lang; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(lang),UPDATE(lang) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.first_session_completed; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(first_session_completed),UPDATE(first_session_completed) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.weight_updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(weight_updated_at),UPDATE(weight_updated_at) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.setup_correction; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(setup_correction),UPDATE(setup_correction) ON TABLE public.users TO authenticated;


--
-- Name: COLUMN users.setup_anchor; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(setup_anchor),UPDATE(setup_anchor) ON TABLE public.users TO authenticated;


--
-- Name: TABLE version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version TO service_role;


--
-- Name: TABLE version_elite; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version_elite TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version_elite TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.version_elite TO service_role;


--
-- Name: TABLE webapp_session_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.webapp_session_state TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.webapp_session_state TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.webapp_session_state TO service_role;


--
-- Name: TABLE widgetbook_samples; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.widgetbook_samples TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.widgetbook_samples TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.widgetbook_samples TO service_role;


--
-- Name: SEQUENCE widgetbook_samples_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.widgetbook_samples_id_seq TO anon;
GRANT ALL ON SEQUENCE public.widgetbook_samples_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.widgetbook_samples_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

