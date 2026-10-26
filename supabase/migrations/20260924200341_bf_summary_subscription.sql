-- supabase/migrations/20260925110000_bf_summary_subscription.sql
--
-- Résumé de l'espace bike fitter : indique si un abonnement Stripe est en
-- cours. Un abonnement résilié par Stripe pour impayé garde son offre pendant
-- la grâce, sans abonnement : l'espace propose alors de se réabonner.

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
  window_start as (
    select coalesce((select current_period_start from b), date_trunc('month', now())) as ts
  )
  select jsonb_build_object(
    'plan', (select plan from b),
    'trial_state', (select trial_state from b),
    'status', (select status from b),
    'access', (select public.bf_access_level(status, grace_until) from b),
    'grace_until', (select grace_until from b),
    'current_period_start', (select ts from window_start),
    'current_period_end', (select current_period_end from b),
    'has_stripe_customer', (select stripe_customer_id is not null from b),
    'has_subscription', (select stripe_subscription_id is not null from b),
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
