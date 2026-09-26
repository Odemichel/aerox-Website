-- supabase/migrations/20260926120000_bf_business_id.sql
--
-- Analyses offertes aux bike fitters : ouvertes par l'identifiant de
-- l'entreprise (SIREN / SIRET, n° de TVA intracommunautaire), vérifié par un
-- registre officiel (voir src/lib/billing/businessId.ts), au lieu d'une carte
-- bancaire. Un identifiant ne sert qu'à un compte. Hors registre vérifiable,
-- l'identifiant part en vérification manuelle (notification admin) et
-- l'admin valide avec `bf_approve_business_id(user_id)`.
--
-- La table des cartes (`bf_trial_cards`) reste pour l'historique.
--
-- Compatibilité avec l'application desktop : `register_analysis` continue de
-- répondre `needs_card` tant que les analyses offertes ne sont pas ouvertes
-- (l'application bloque la séance et renvoie vers l'espace bike fitter).

alter table public.bf_billing drop constraint bf_billing_trial_state_check;
update public.bf_billing set trial_state = 'needs_business_id' where trial_state = 'needs_card';
alter table public.bf_billing alter column trial_state set default 'needs_business_id';
alter table public.bf_billing add constraint bf_billing_trial_state_check
  check (trial_state in ('needs_business_id', 'pending_review', 'business_id_used', 'granted',
                         'needs_card', 'card_already_used'));

create table public.bf_business_ids (
  -- Clé normalisée : FR:<SIREN> (SIREN, SIRET et TVA française confondus),
  -- <préfixe TVA>:<numéro> pour l'UE, OTHER:<saisie> sinon.
  id_key text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  kind text not null check (kind in ('siren', 'eu_vat', 'other')),
  country text,
  legal_name text,
  status text not null check (status in ('verified', 'pending_review')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

comment on table public.bf_business_ids is
  '[BikeFit] Identifiant d''entreprise ayant ouvert les analyses offertes (un par compte, un compte par identifiant). service_role uniquement.';

alter table public.bf_business_ids enable row level security;
revoke all on public.bf_business_ids from anon, authenticated;

create or replace function public.bf_start_trial(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.bf_billing (user_id, plan, status, trial_state)
  values (p_user, 'trial', 'active', 'needs_business_id')
  on conflict (user_id) do nothing;
end;
$$;

revoke execute on function public.bf_start_trial(uuid) from public, anon, authenticated;
grant execute on function public.bf_start_trial(uuid) to service_role;

-- Ouvre les 2 analyses offertes (20 jours) d'un compte. Interne.
create or replace function public.bf_open_trial_credits(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.bf_credits (user_id, granted, remaining, expires_at, source)
  values (p_user, 2, 2, now() + interval '20 days', 'trial')
  on conflict (user_id, source) do nothing;
  update public.bf_billing set trial_state = 'granted' where user_id = p_user;
end;
$$;

revoke execute on function public.bf_open_trial_credits(uuid) from public, anon, authenticated;

-- Appelée par /api/billing/business-id/ (service_role) après la consultation
-- du registre. Renvoie 'granted', 'pending_review', 'already_used' ou
-- 'already_granted'.
create or replace function public.bf_register_business_id(
  p_user uuid,
  p_key text,
  p_kind text,
  p_country text,
  p_name text,
  p_verified boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  _owner uuid;
begin
  if exists (select 1 from public.bf_credits where user_id = p_user and source = 'trial') then
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
  insert into public.bf_business_ids (id_key, user_id, kind, country, legal_name, status, verified_at)
  values (p_key, p_user, p_kind, p_country, nullif(p_name, ''),
          case when p_verified then 'verified' else 'pending_review' end,
          case when p_verified then now() end)
  on conflict (id_key) do update
    set legal_name = excluded.legal_name,
        status = excluded.status,
        verified_at = excluded.verified_at;

  if p_verified then
    perform public.bf_open_trial_credits(p_user);
    return 'granted';
  end if;
  update public.bf_billing set trial_state = 'pending_review' where user_id = p_user;
  return 'pending_review';
end;
$$;

revoke execute on function public.bf_register_business_id(uuid, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.bf_register_business_id(uuid, text, text, text, text, boolean) to service_role;

-- Validation manuelle par l'admin : lien signé de l'e-mail de notification
-- (/api/billing/approve-business/), ou SQL editor :
--   select public.bf_approve_business_id('<user_id>');
create or replace function public.bf_approve_business_id(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
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

revoke execute on function public.bf_approve_business_id(uuid) from public, anon, authenticated;
grant execute on function public.bf_approve_business_id(uuid) to service_role;

-- Notification admin : identifiant à vérifier à la main (fonction Edge
-- notify-admin-new-bf, même secret que l'inscription).
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
      'review', jsonb_build_object('business_id', substr(new.id_key, 7), 'approve_url', _approve)
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
  return new;
end;
$$;

revoke execute on function public.bf_notify_business_review() from public, anon, authenticated;

create trigger trg_bf_notify_business_review
  after insert or update of status on public.bf_business_ids
  for each row execute function public.bf_notify_business_review();

-- Refus au démarrage d'une analyse : code `needs_card` conservé pour
-- l'application (voir en-tête), pour tout compte d'essai sans analyses
-- offertes ouvertes.
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
      -- Analyses offertes pas encore ouvertes (identifiant d'entreprise à
      -- renseigner ou en vérification) : l'application renvoie vers l'espace.
      if _billing.plan = 'trial'
         and _billing.trial_state in ('needs_business_id', 'pending_review', 'business_id_used', 'needs_card') then
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
