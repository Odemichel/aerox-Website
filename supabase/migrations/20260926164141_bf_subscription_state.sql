-- supabase/migrations/20260926100000_bf_subscription_state.sql
--
-- État de l'abonnement lisible par l'espace bike fitter, écrit par le webhook
-- (et par /api/billing/manage/ juste après une action) :
--   - `offer` : l'offre exacte. `plan` ne distingue pas Illimité mensuel et
--     annuel (ni le lancement mensuel de l'annuel à 690 €), et la durée de la période ne le peut pas non plus pendant la
--     période d'essai Stripe (tout s'arrête au 1er novembre 2026) ;
--   - `cancel_at` : résiliation programmée (fin de période) ;
--   - `scheduled_offer` / `scheduled_at` : descente d'offre programmée ;
--   - `unpaid_*` : facture restée impayée à la fin d'un abonnement (créance
--     conservée, réglable depuis l'espace BF, relancée par e-mail à J+0,
--     J+7 et J+21 par la fonction Edge `notify-bf-unpaid`).
--
-- Places de lancement : un abonnement résilié par Stripe pour impayé garde son
-- offre pendant la grâce (status `past_due`, sans abonnement). Une fois la
-- grâce passée, la place est libérée.

alter table public.bf_billing
  add column offer text check (offer in ('payg', 'studio', 'unlimited', 'unlimited_annual', 'unlimited_launch', 'unlimited_launch_annual')),
  add column cancel_at timestamptz,
  add column scheduled_offer text
    check (scheduled_offer in ('payg', 'studio', 'unlimited', 'unlimited_annual', 'unlimited_launch', 'unlimited_launch_annual')),
  add column scheduled_at timestamptz,
  add column unpaid_invoice_id text,
  add column unpaid_amount integer check (unpaid_amount > 0),
  add column unpaid_invoice_url text,
  add column unpaid_since timestamptz,
  add column unpaid_reminders integer not null default 0;

-- Abonnements existants : l'offre se déduit du plan, sauf l'annuel (aucun
-- abonnement BF en production à la date de cette migration). Le webhook
-- réécrit la valeur exacte au prochain événement.
update public.bf_billing set offer = plan
where stripe_subscription_id is not null and plan in ('payg', 'studio', 'unlimited', 'unlimited_launch');

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
      where plan = 'unlimited_launch'
        and (
          status = 'active'
          -- Impayé : la place reste prise tant que Stripe relance
          -- (abonnement en cours) ou que la grâce court.
          or (status = 'past_due' and (stripe_subscription_id is not null or grace_until > now()))
        )
    )
  );
$$;

revoke execute on function public.bf_launch_seats_remaining() from public;
grant execute on function public.bf_launch_seats_remaining() to anon, authenticated, service_role;

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
    'offer', (select offer from b),
    'trial_state', (select trial_state from b),
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

-- ---------------------------------------------------------------------------
-- Créance : date d'ouverture et compteur de relances, remis à zéro quand la
-- facture impayée change (nouvelle créance) ou disparaît (réglée).
-- ---------------------------------------------------------------------------

create or replace function public.bf_unpaid_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.unpaid_invoice_id is distinct from old.unpaid_invoice_id then
    new.unpaid_since := case when new.unpaid_invoice_id is null then null else now() end;
    new.unpaid_reminders := 0;
  end if;
  return new;
end;
$$;

revoke execute on function public.bf_unpaid_reset() from public, anon, authenticated;

create trigger trg_bf_unpaid_reset
  before update of unpaid_invoice_id on public.bf_billing
  for each row execute function public.bf_unpaid_reset();

-- Relances : 1re dès l'ouverture de la créance, puis à J+7 et J+21 (trois au
-- plus). Appelée toutes les heures par pg_cron ; chaque envoi est compté
-- avant l'appel HTTP, un échec d'envoi ne produit donc jamais de doublon (au
-- pire une relance manquée, visible dans les journaux de la fonction Edge).
create or replace function public.bf_send_unpaid_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
  -- URL surchargeable (tests locaux) ; projet de production par défaut.
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

revoke execute on function public.bf_send_unpaid_reminders() from public, anon, authenticated;

select cron.schedule('bf-unpaid-reminders', '17 * * * *', $$ select public.bf_send_unpaid_reminders() $$);
