-- Outils de test admin du diagnostic (spec feat-diagnostic-admin-test-controls).
--
-- L'admin n'a plus de passe-droit sur le diagnostic : il le vit comme un
-- rider (page d'offre, paywall, « Commencer », « Reprendre »). Depuis sa page
-- de profil, `admin_set_my_diagnostic` lui permet de débloquer, bloquer ou
-- réinitialiser son propre diagnostic sans payer. Le droit de test est une
-- ligne `diagnostic_purchases` à 0 € marquée `is_admin_test`, consommée au
-- démarrage comme un achat réel.


-- ---------------------------------------------------------------------------
-- 1. is_admin() : table qualifiée, search_path figé
-- ---------------------------------------------------------------------------
-- Elle lisait `users` sans schéma ni search_path : appelée depuis une
-- fonction à `search_path = ''` (has_diagnostic_entitlement,
-- start_diagnostic), elle levait « relation users does not exist » pour tout
-- le monde, rider payant compris. Les politiques RLS qui l'utilisent gardent
-- la même logique.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'admin'
  );
$$;


-- ---------------------------------------------------------------------------
-- 2. Droit de test
-- ---------------------------------------------------------------------------

alter table public.diagnostic_purchases
  add column is_admin_test boolean not null default false;

comment on column public.diagnostic_purchases.is_admin_test is
  'Droit de test créé par admin_set_my_diagnostic (0 €, hors Stripe). Exclu du suivi des achats.';


-- ---------------------------------------------------------------------------
-- 3. Plus de passe-droit admin dans le droit au diagnostic
-- ---------------------------------------------------------------------------

-- Le rider a droit à un diagnostic : un achat (réel ou de test) ni consommé
-- ni remboursé, ou un diagnostic ouvert. Seule source de vérité pour
-- l'application, qui ne recalcule rien de son côté.
create or replace function public.has_diagnostic_entitlement()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.diagnostic_purchases
      where user_id = auth.uid() and consumed_at is null and refunded_at is null
    )
    or exists (
      select 1 from public.diagnostic_basic
      where user_id = auth.uid() and status = 'in_progress' and expires_at > now()
    )
  );
$$;

-- Renvoie le diagnostic ouvert du rider, ou en ouvre un sur son plus ancien
-- achat non consommé (30 jours à partir de maintenant). Lève
-- `no_diagnostic_entitlement` sinon.
create or replace function public.start_diagnostic()
returns public.diagnostic_basic
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_diag public.diagnostic_basic;
  v_purchase_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_diag
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at > now()
  for update;
  if found then
    return v_diag;
  end if;

  -- Verrou sur l'achat : deux appels simultanés ne consomment pas deux
  -- achats, et ne consomment pas deux fois le même.
  select id into v_purchase_id
  from public.diagnostic_purchases
  where user_id = v_uid and consumed_at is null and refunded_at is null
  order by paid_at
  limit 1
  for update;
  if v_purchase_id is null then
    raise exception 'no_diagnostic_entitlement' using errcode = 'P0001';
  end if;

  -- Un diagnostic échu que le cron n'a pas encore clos bloquerait l'index
  -- unique « un seul in_progress par rider ».
  update public.diagnostic_basic
  set status = 'expired'
  where user_id = v_uid and status = 'in_progress' and expires_at <= now();

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_purchase_id, now(), now() + interval '30 days')
  returning * into v_diag;

  update public.diagnostic_purchases
  set consumed_at = now()
  where id = v_purchase_id;

  return v_diag;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Suivi des achats : sans les droits de test
-- ---------------------------------------------------------------------------

create or replace view public.diagnostic_purchase_status
with (security_invoker = true)
as
select
  p.id,
  p.user_id,
  p.stripe_checkout_session_id,
  p.stripe_payment_intent_id,
  p.amount_total,
  p.amount_refunded,
  p.currency,
  p.paid_at,
  p.withdrawal_waiver_at,
  p.consumed_at,
  p.refunded_at,
  x.session_done,
  case
    when p.refunded_at is not null then 'refunded'
    when x.session_done then 'session_done'
    when p.paid_at < now() - interval '14 days' then 'withdrawal_period_over'
    else 'refundable'
  end as refund_eligibility
from public.diagnostic_purchases p
cross join lateral (
  -- Une séance compte dès qu'elle a laissé une trace : une position S1 ou un
  -- test S2, dans n'importe quel diagnostic ouvert avec cet achat.
  select exists (
    select 1
    from public.diagnostic_basic d
    where d.purchase_id = p.id
      and (
        exists (select 1 from public.diagnostic_basic_positions pos where pos.diagnostic_id = d.id)
        or exists (select 1 from public.diagnostic_basic_s2 s2 where s2.diagnostic_id = d.id)
      )
  ) as session_done
) x
where not p.is_admin_test;


-- ---------------------------------------------------------------------------
-- 5. Débloquer, bloquer, réinitialiser (admin, son propre compte)
-- ---------------------------------------------------------------------------
-- - unlock : crée un droit de test, sauf si un droit ou un diagnostic est
--   déjà ouvert (idempotent).
-- - block  : le diagnostic ouvert passe « révoqué » (données gardées), les
--   droits de test non consommés sont retirés.
-- - reset  : supprime tous les diagnostics du compte (positions et S2 en
--   cascade) et tous ses droits de test. Les achats réels ne sont jamais
--   supprimés.
create or replace function public.admin_set_my_diagnostic(p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  case p_action
    when 'unlock' then
      if not public.has_diagnostic_entitlement() then
        insert into public.diagnostic_purchases
          (user_id, stripe_checkout_session_id, amount_total, currency, is_admin_test)
        values
          (v_uid, 'admin_test_' || gen_random_uuid(), 0, 'eur', true);
      end if;

    when 'block' then
      update public.diagnostic_basic
      set status = 'revoked'
      where user_id = v_uid and status = 'in_progress';

      delete from public.diagnostic_purchases
      where user_id = v_uid and is_admin_test and consumed_at is null;

    when 'reset' then
      delete from public.diagnostic_basic where user_id = v_uid;
      delete from public.diagnostic_purchases where user_id = v_uid and is_admin_test;

    else
      raise exception 'invalid_action' using errcode = '22023';
  end case;
end;
$$;

revoke execute on function public.admin_set_my_diagnostic(text) from public, anon;
grant execute on function public.admin_set_my_diagnostic(text) to authenticated;
