-- Offre partenaire : 24 heures pour la prendre, par bike fitter.
--
--  - `partner_offer_expires_at` : posé à la première ouverture du lien privé
--    (/api/billing/partner/), 24 h plus tard ; rouvrir le lien ne le
--    repousse pas. Passé ce délai, /api/billing/checkout/ et
--    /api/billing/manage/ refusent les offres partenaire (`E_PARTNER`). Une
--    offre partenaire déjà choisie (carte enregistrée) reste acquise jusqu'à
--    l'installation.
--  - Comptes ayant déjà ouvert l'offre : 24 h à partir de cette migration.
--  - `bf_usage_summary` : `partner_offer` vrai seulement pendant les 24 h,
--    plus `partner_offer_expires_at` (compte à rebours de l'espace BF).

alter table public.bf_billing
  add column if not exists partner_offer_expires_at timestamptz;

update public.bf_billing
set partner_offer_expires_at = now() + interval '24 hours'
where partner_offer and partner_offer_expires_at is null;

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
