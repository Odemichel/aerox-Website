-- supabase/migrations/20261117091114_drop_bf_business_id.sql
--
-- Retrait de la vérification d'entreprise des bike fitters (SIREN, TVA, site
-- internet). Hors parcours depuis le 2026-10-18 : le bike fitter choisit son
-- offre et enregistre sa carte, l'essai démarre à l'installation, le studio
-- est vu sur place. Restaient la table (vide), les fonctions d'enregistrement
-- et de validation, la notification de vérification et l'état
-- `bf_billing.trial_state` (valeur par défaut `needs_business_id`, lue par
-- personne).
--
-- 1. Table bf_business_ids (0 ligne), son trigger et ses fonctions.
-- 2. Ancien essai à crédits débloqué par l'identifiant ou la carte
--    (bf_open_trial_credits, bf_grant_trial) : plus appelé.
-- 3. Colonne bf_billing.trial_state.
-- 4. bf_start_trial, bf_usage_summary, crm_account_status sans ces champs ;
--    le CRM (aerox-crm, mis à jour en même temps) lit à la place l'offre
--    choisie (`pending_offer`) : offre et carte à choisir, en attente de
--    l'installation, essai en cours.

-- 1. ----------------------------------------------------------------------------
drop trigger if exists trg_bf_notify_business_review on public.bf_business_ids;
drop function if exists public.bf_notify_business_review();
drop function if exists public.bf_register_business_id(uuid, text, text, text, text, boolean, text, boolean);
drop function if exists public.bf_approve_business_id(uuid);
drop table if exists public.bf_business_ids;

-- 2. ----------------------------------------------------------------------------
drop function if exists public.bf_open_trial_credits(uuid);
drop function if exists public.bf_grant_trial(uuid, text);

-- 3. et 4. ----------------------------------------------------------------------
create or replace function public.bf_start_trial(p_user uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.bf_billing (user_id, plan, status)
  values (p_user, 'trial', 'active')
  on conflict (user_id) do nothing;
end;
$function$;

create or replace function public.bf_usage_summary()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with b as (
    select * from public.bf_billing where user_id = (select auth.uid())
  ),
  window_start as (
    select coalesce((select current_period_start from b), date_trunc('month', now())) as ts
  )
  select jsonb_build_object(
    'plan', (select plan from b),
    'offer', (select offer from b),
    'trial_ends_at', (select trial_ends_at from b),
    'installed_at', (select installed_at from b),
    'partner_offer', (select partner_offer and coalesce(partner_offer_expires_at > now(), false) from b),
    'partner_offer_expires_at', (select partner_offer_expires_at from b),
    'pending_offer', (select pending_offer from b),
    'pending_since', (select pending_since from b),
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
$function$;

-- Type de retour modifié : suppression puis recréation, droits remis à
-- l'identique (authenticated, l'accès est filtré par crm_is_member()).
drop function if exists public.crm_account_status(text[]);
create function public.crm_account_status(p_emails text[])
returns table (
  email text,
  user_id uuid,
  role text,
  is_active boolean,
  account_created_at timestamptz,
  last_sign_in_at timestamptz,
  plan text,
  billing_status text,
  trial_ends_at timestamptz,
  pending_offer text,
  analyses_count integer
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
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
    b.trial_ends_at,
    b.pending_offer,
    (select count(*)::int from public.bf_analyses a where a.user_id = u.id)
  from auth.users u
  left join public.users pu on pu.id = u.id
  left join public.bf_billing b on b.user_id = u.id
  where lower(u.email) = any (select lower(x) from unnest(p_emails) x);
end;
$function$;

revoke all on function public.crm_account_status(text[]) from public, anon;
grant execute on function public.crm_account_status(text[]) to authenticated, service_role;

alter table public.bf_billing drop column trial_state;
