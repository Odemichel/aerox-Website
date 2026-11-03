-- Fiche studio du bike fitter : `bf_profiles` devient la source unique
-- (décision du 2026-11-03). `users` garde l'identité commune à tous les
-- comptes (nom, prénom, e-mail, téléphone, rôle, langue) ; tout ce qui ne
-- concerne que le studio vit ici : nom, adresse, site, spécialités,
-- expérience, certifications, bio. Le logo reste `studio-logos/<id>/logo`.
--
-- Pourquoi une table à part : l'annuaire « trouver un bike fitter » (site et
-- app) et l'affichage du studio chez ses clients pourront ouvrir la lecture
-- de la fiche studio sans jamais exposer la ligne `users` (téléphone, date de
-- naissance, données physiques).
--
-- Phase 1 (ce fichier) : colonnes, recopie, règles d'accès, fonctions
-- serveur. Les colonnes studio de `users` sont retirées par la migration
-- suivante, une fois le site, le desktop et My Companion passés sur
-- `bf_profiles`.

-- 1. Colonnes ------------------------------------------------------------
alter table public.bf_profiles add column if not exists studio_address text;
-- `city` remplacée par l'adresse : table vide à la bascule (0 ligne).
alter table public.bf_profiles drop column if exists city;
-- Clé étrangère en double (même définition que bf_profiles_user_id_fkey).
alter table public.bf_profiles drop constraint if exists bf_profiles_user_fk;

alter table public.bf_profiles drop constraint if exists bf_profiles_fields_check;
alter table public.bf_profiles add constraint bf_profiles_fields_check check (
  (studio_name is null or char_length(studio_name) <= 120)
  and (studio_address is null or char_length(studio_address) <= 300)
  and (website is null or char_length(website) <= 200)
  and (specialties is null or char_length(specialties) <= 500)
  and (certifications is null or char_length(certifications) <= 500)
  and (bio is null or char_length(bio) <= 2000)
  and (experience_years is null or experience_years between 0 and 80)
);

drop trigger if exists bf_profiles_updated_at on public.bf_profiles;
create trigger bf_profiles_updated_at before update on public.bf_profiles
  for each row execute function public.set_updated_at();

-- 2. Recopie depuis users (nom du studio et site saisis à l'inscription) --
insert into public.bf_profiles
  (user_id, studio_name, website, studio_address, specialties, experience_years, certifications)
select u.id,
       nullif(trim(u.studio_name), ''),
       nullif(trim(u.website), ''),
       nullif(trim(u.studio_address), ''),
       nullif(trim(u.specialties), ''),
       u.experience_years,
       nullif(trim(u.certifications), '')
from public.users u
where u.role in ('bike-fitter', 'pending_bf')
   or nullif(trim(u.studio_name), '') is not null
   or nullif(trim(u.website), '') is not null
on conflict (user_id) do update set
  studio_name      = coalesce(public.bf_profiles.studio_name, excluded.studio_name),
  website          = coalesce(public.bf_profiles.website, excluded.website),
  studio_address   = coalesce(public.bf_profiles.studio_address, excluded.studio_address),
  specialties      = coalesce(public.bf_profiles.specialties, excluded.specialties),
  experience_years = coalesce(public.bf_profiles.experience_years, excluded.experience_years),
  certifications   = coalesce(public.bf_profiles.certifications, excluded.certifications);

-- 3. Règles d'accès ------------------------------------------------------
-- Lecture : sa fiche, ou toutes pour l'admin (panneaux admin desktop et
-- My Companion). Écriture : sa fiche, bike fitter actif ou en attente.
-- L'annuaire public ajoutera sa propre règle de lecture (fiches publiées).
revoke all on public.bf_profiles from anon;
revoke delete, truncate, references, trigger on public.bf_profiles from authenticated;

drop policy if exists bf_select_own_profile on public.bf_profiles;
drop policy if exists bf_insert_own_profile on public.bf_profiles;
drop policy if exists bf_update_own_profile on public.bf_profiles;
drop policy if exists bf_delete_own_profile on public.bf_profiles;

create policy bf_profiles_select on public.bf_profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy bf_profiles_insert on public.bf_profiles
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.get_my_role()) in ('bike-fitter', 'pending_bf', 'admin')
  );

create policy bf_profiles_update on public.bf_profiles
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and (select public.get_my_role()) in ('bike-fitter', 'pending_bf', 'admin')
  )
  with check (user_id = (select auth.uid()));

-- 4. Fonctions serveur ---------------------------------------------------

-- Inscription confirmée : la fiche studio est créée AVANT la ligne users,
-- pour que les déclencheurs de users (notification admin) lisent déjà le
-- nom du studio.
create or replace function public.handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _profile_type text := coalesce(new.raw_user_meta_data ->> 'profile_type', '');
  _is_bf boolean := _profile_type = 'bike-fitter';
  _confirmed_now boolean :=
    new.email_confirmed_at is not null
    and (tg_op = 'INSERT' or old.email_confirmed_at is null);
begin
  if _confirmed_now and _profile_type <> 'crm' then
    if _is_bf then
      insert into public.bf_profiles (user_id, studio_name)
      values (new.id, left(nullif(trim(new.raw_user_meta_data ->> 'studio_name'), ''), 120))
      on conflict (user_id) do nothing;
    end if;

    insert into public.users (id, email, phonenumber, role, is_active, onboarding_completed)
    values (
      new.id,
      new.email,
      new.raw_user_meta_data ->> 'phone',
      case when _is_bf then 'bike-fitter' else 'rider' end,
      _is_bf,
      false
    )
    on conflict (id) do nothing;

    if _is_bf then
      begin
        perform public.bf_start_trial(new.id);
      exception when others then
        raise warning 'handle_email_confirmed: bf_start_trial(%) a échoué : %', new.id, sqlerrm;
      end;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.notify_admin_new_bf()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _secret text;
begin
  if new.role <> 'bike-fitter' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.role in ('bike-fitter', 'pending_bf') then
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
      'studio_name', (select p.studio_name from public.bf_profiles p where p.user_id = new.id),
      'lang', new.lang, 'created_at', new.created_at
    )),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', _secret)
  );
  return new;
end;
$function$;

create or replace function public.bf_notify_business_review()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
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
  select u.id, u.email, u.firstname, u.name, p.studio_name, u.lang, u.created_at into _u
  from public.users u
  left join public.bf_profiles p on p.user_id = u.id
  where u.id = new.user_id;
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
$function$;

create or replace function public.bf_send_unpaid_reminders()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
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
    returning b.user_id, u.email, u.firstname,
      (select p.studio_name from public.bf_profiles p where p.user_id = b.user_id) as studio_name,
      u.lang, b.unpaid_amount, b.unpaid_invoice_url, b.unpaid_reminders
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
$function$;

-- 5. Plus d'écriture des colonnes studio de users (retirées ensuite) ------
revoke update (studio_name, website, studio_address, specialties, experience_years, certifications)
  on public.users from authenticated;

comment on table public.bf_profiles is
  'Fiche studio du bike fitter, source unique depuis le 2026-11-03 (nom, adresse, site, spécialités, expérience, certifications, bio). Identité dans public.users, logo dans storage studio-logos/<user_id>/logo.';
