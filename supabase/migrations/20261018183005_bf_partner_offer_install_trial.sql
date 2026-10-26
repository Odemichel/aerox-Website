-- Facturation bike fitter : offre partenaire et essai démarré à l'installation.
--
--  - `partner_offer` : le bike fitter a ouvert l'offre partenaire (59 €/mois
--    ou 590 €/an pendant 12 mois) avec le lien privé. Écrit seulement par le
--    serveur (/api/billing/partner/, service_role) ; /api/billing/checkout/
--    refuse les offres partenaire sans lui.
--  - `installed_at` : installation du setup faite par l'admin
--    (/api/billing/start-trial/). L'essai de 14 jours démarre à cette date ;
--    avant, l'abonnement attend l'installation sans jamais être prélevé.
--    Recopié de la métadonnée Stripe `aerox_installed_at` par le webhook.
--  - Offres `unlimited_partner` / `unlimited_partner_annual` (plan
--    `unlimited` : même accès, pas de place de lancement).
--  - `bf_usage_summary` renvoie les deux colonnes (espace BF, app desktop).
--
-- Lecture : politiques existantes de bf_billing (soi-même, admin). Aucune
-- écriture client.

alter table public.bf_billing
  add column if not exists partner_offer boolean not null default false,
  add column if not exists installed_at timestamptz;

alter table public.bf_billing drop constraint if exists bf_billing_offer_check;
alter table public.bf_billing add constraint bf_billing_offer_check check (
  offer in (
    'payg', 'studio', 'essential', 'unlimited', 'unlimited_annual', 'unlimited_launch',
    'unlimited_launch_annual', 'unlimited_partner', 'unlimited_partner_annual'
  )
);

alter table public.bf_billing drop constraint if exists bf_billing_scheduled_offer_check;
alter table public.bf_billing add constraint bf_billing_scheduled_offer_check check (
  scheduled_offer in (
    'payg', 'studio', 'essential', 'unlimited', 'unlimited_annual', 'unlimited_launch',
    'unlimited_launch_annual', 'unlimited_partner', 'unlimited_partner_annual'
  )
);

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
