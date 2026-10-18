-- Facturation bike fitter : offre choisie en attente de l'installation.
--
-- Premier abonnement : le bike fitter choisit son offre et n'enregistre que
-- sa carte (Checkout en mode `setup`). Aucun abonnement Stripe n'existe
-- avant l'installation du setup ; le bouton admin « Installation faite »
-- (/api/billing/start-trial/) le crée avec 14 jours d'essai.
--
--  - `pending_offer` : offre choisie, en attente de l'installation. Écrit par
--    le webhook (`checkout.session.completed` en mode setup) et par
--    /api/billing/manage/ (changer d'offre, annuler) ; effacé à la création
--    de l'abonnement.
--  - `pending_since` : date du choix (souscription avant le 31/12/2026 pour
--    les offres de lancement) et clé d'idempotence de la création.
--  - Places de lancement : une offre de lancement en attente réserve sa place.
--  - `bf_usage_summary` renvoie `pending_offer` et `pending_since`.

alter table public.bf_billing
  add column if not exists pending_offer text check (
    pending_offer in (
      'essential', 'unlimited', 'unlimited_annual', 'unlimited_launch',
      'unlimited_launch_annual', 'unlimited_partner', 'unlimited_partner_annual'
    )
  ),
  add column if not exists pending_since timestamptz;

create or replace function public.bf_launch_seats_remaining()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    0,
    20 - (
      select count(*)::integer from public.bf_billing
      where (
          plan = 'unlimited_launch'
          and (
            status = 'active'
            or (status = 'past_due' and (stripe_subscription_id is not null or grace_until > now()))
          )
        )
        or (
          stripe_subscription_id is null
          and pending_offer in ('unlimited_launch', 'unlimited_launch_annual')
        )
    )
  );
$$;

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
    'installed_at', (select installed_at from b),
    'partner_offer', (select partner_offer from b),
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
