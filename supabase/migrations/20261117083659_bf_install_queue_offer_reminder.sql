-- supabase/migrations/20261117083659_bf_install_queue_offer_reminder.sql
--
-- Liste d'installation admin (app desktop, onglet Installations de
-- mycompanion) étendue aux bike fitters inscrits qui n'ont pas encore choisi
-- d'offre ni enregistré de carte, avec un bouton « Relancer » qui leur envoie
-- un e-mail vers l'onglet Abonnement de leur espace.
--
-- 1. bf_billing.offer_reminded_at / offer_reminders : dernière relance et
--    nombre de relances.
-- 2. bf_install_queue() : bike fitters en essai, sans abonnement ni
--    installation ; `has_card` = offre choisie (carte enregistrée par le
--    Checkout en mode setup, seule condition de « Installation faite »).
-- 3. bf_send_offer_reminder(user) : une relance au plus toutes les 24 h, e-mail
--    envoyé par l'Edge Function notify-bf-offer-reminder (pg_net + secret du
--    Vault, comme bf_send_unpaid_reminders).
--
-- Les deux fonctions sont réservées aux admins (is_admin(), revérifié ici).

alter table public.bf_billing
  add column offer_reminded_at timestamptz,
  add column offer_reminders integer not null default 0;

-- 2. Liste d'installation ----------------------------------------------------
create or replace function public.bf_install_queue()
returns table (
  user_id uuid,
  display_name text,
  email text,
  signed_up_at timestamptz,
  has_card boolean,
  pending_offer text,
  pending_since timestamptz,
  offer_reminded_at timestamptz,
  offer_reminders integer
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
  select
    u.id,
    coalesce(
      nullif(trim(p.studio_name), ''),
      nullif(trim(concat_ws(' ', u.firstname, u.name)), ''),
      u.email
    ),
    u.email,
    u.created_at::timestamptz,
    b.pending_offer is not null,
    b.pending_offer,
    b.pending_since,
    b.offer_reminded_at,
    coalesce(b.offer_reminders, 0)
  from public.users u
  left join public.bf_billing b on b.user_id = u.id
  left join public.bf_profiles p on p.user_id = u.id
  where u.role = 'bike-fitter'
    and (
      b.user_id is null
      or (b.plan = 'trial' and b.stripe_subscription_id is null and b.installed_at is null)
    )
  order by (b.pending_offer is not null) desc, coalesce(b.pending_since, u.created_at::timestamptz);
end;
$function$;

revoke all on function public.bf_install_queue() from public, anon;
grant execute on function public.bf_install_queue() to authenticated;

-- 3. Relance ------------------------------------------------------------------
create or replace function public.bf_send_offer_reminder(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _secret text;
  _base text;
  _billing public.bf_billing%rowtype;
  _user record;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select u.id, u.email, u.firstname, u.lang,
         (select p.studio_name from public.bf_profiles p where p.user_id = u.id) as studio_name
    into _user
  from public.users u
  where u.id = p_user and u.role = 'bike-fitter';
  if not found or _user.email is null then
    return jsonb_build_object('status', 'refused', 'reason', 'not_bike_fitter');
  end if;

  select * into _billing from public.bf_billing where user_id = p_user for update;
  if not found then
    perform public.bf_start_trial(p_user);
    select * into _billing from public.bf_billing where user_id = p_user for update;
  end if;

  if _billing.pending_offer is not null then
    return jsonb_build_object('status', 'refused', 'reason', 'has_card');
  end if;
  if _billing.plan <> 'trial' or _billing.stripe_subscription_id is not null or _billing.installed_at is not null then
    return jsonb_build_object('status', 'refused', 'reason', 'not_awaiting');
  end if;
  if _billing.offer_reminded_at > now() - interval '24 hours' then
    return jsonb_build_object('status', 'refused', 'reason', 'too_soon', 'reminded_at', _billing.offer_reminded_at);
  end if;

  select decrypted_secret into _secret from vault.decrypted_secrets where name = 'bf_notify_secret' limit 1;
  if _secret is null then
    raise warning 'bf_send_offer_reminder: secret bf_notify_secret absent du Vault';
    return jsonb_build_object('status', 'refused', 'reason', 'not_configured');
  end if;
  select decrypted_secret into _base from vault.decrypted_secrets where name = 'bf_functions_url' limit 1;

  update public.bf_billing
  set offer_reminded_at = now(), offer_reminders = offer_reminders + 1
  where user_id = p_user
  returning * into _billing;

  perform net.http_post(
    url := coalesce(_base, 'https://agvksgrjqskpetokudda.supabase.co/functions/v1') || '/notify-bf-offer-reminder',
    body := jsonb_build_object(
      'email', _user.email,
      'firstname', _user.firstname,
      'studio_name', _user.studio_name,
      'lang', _user.lang
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );

  return jsonb_build_object(
    'status', 'sent',
    'reminded_at', _billing.offer_reminded_at,
    'reminders', _billing.offer_reminders
  );
end;
$function$;

revoke all on function public.bf_send_offer_reminder(uuid) from public, anon;
grant execute on function public.bf_send_offer_reminder(uuid) to authenticated;
