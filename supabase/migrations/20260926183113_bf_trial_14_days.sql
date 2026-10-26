-- supabase/migrations/20260926150000_bf_trial_14_days.sql
--
-- Essai bike fitter : 14 jours d'analyses illimitées (au lieu de 2 analyses
-- sur 20 jours), ouverts par l'identifiant de l'entreprise :
--   - SIREN / SIRET, TVA intracommunautaire : vérifiés par le registre
--     officiel, essai ouvert aussitôt ;
--   - sinon le site internet du studio : vérification manuelle par l'admin
--     (e-mail avec le lien du site et un lien de validation signé).
-- Un identifiant (ou un domaine) ne sert qu'à un compte.
--
-- Fin de l'essai sans offre : `register_analysis` répond `no_credits` (code
-- déjà connu de l'application desktop : blocage et renvoi vers les offres).

alter table public.bf_billing add column trial_ends_at timestamptz;

-- Essais déjà ouverts avec l'ancien modèle (crédits) : 14 jours à compter
-- de leur ouverture, si c'est plus favorable.
update public.bf_billing b set trial_ends_at = c.created_at + interval '14 days'
from public.bf_credits c
where c.user_id = b.user_id and c.source = 'trial' and b.trial_state = 'granted' and b.plan = 'trial';

alter table public.bf_business_ids drop constraint bf_business_ids_kind_check;
alter table public.bf_business_ids add constraint bf_business_ids_kind_check
  check (kind in ('siren', 'eu_vat', 'website', 'other'));
alter table public.bf_business_ids
  add column website text,
  add column email_domain_match boolean;

-- Ouvre l'essai de 14 jours d'un compte (une seule fois). Interne.
create or replace function public.bf_open_trial_credits(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bf_billing
  set trial_state = 'granted',
      trial_ends_at = coalesce(trial_ends_at, now() + interval '14 days')
  where user_id = p_user;
end;
$$;

revoke execute on function public.bf_open_trial_credits(uuid) from public, anon, authenticated;

drop function public.bf_register_business_id(uuid, text, text, text, text, boolean);

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
  if exists (select 1 from public.bf_billing where user_id = p_user and trial_ends_at is not null) then
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

-- Notification admin : site internet (ou identifiant) à vérifier, avec ce
-- qu'il faut contrôler.
create or replace function public.bf_notify_business_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  -- Lien de validation signé (HMAC du compte avec le secret partagé avec
  -- Vercel, BILLING_HOOK_SECRET) : un clic ouvre une page de confirmation.
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

revoke execute on function public.bf_notify_business_review() from public, anon, authenticated;

-- Comptage : pendant l'essai (14 jours), analyses illimitées ; ensuite,
-- refus jusqu'à une offre. Les crédits (`pack`, anciens essais) restent
-- consommés comme avant quand il n'y a pas d'essai en cours.
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

  if _billing.plan in ('trial', 'pack') then
    -- Essai de 14 jours en cours : analyses illimitées.
    if _billing.plan = 'trial' and _billing.trial_ends_at is not null and _billing.trial_ends_at > now() then
      insert into public.bf_analyses (user_id, client_id, billing_mode, origin)
      values (p_uid, p_client_id, 'trial', p_origin)
      returning id into _analysis_id;
      return jsonb_build_object(
        'status', 'counted', 'analysis_id', _analysis_id, 'plan', 'trial', 'trial_ends_at', _billing.trial_ends_at
      );
    end if;

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
      -- Essai pas encore ouvert (identifiant à renseigner ou en
      -- vérification) : code `needs_card`, lu par l'application.
      if _billing.plan = 'trial'
         and _billing.trial_state in ('needs_business_id', 'pending_review', 'business_id_used', 'needs_card') then
        return jsonb_build_object('status', 'refused', 'reason', 'needs_card', 'plan', _billing.plan);
      end if;
      -- Essai terminé, sans offre.
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

  if _billing.plan in ('studio', 'payg') then
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

-- Résumé de l'espace : fin d'essai et identifiant de l'entreprise.
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
