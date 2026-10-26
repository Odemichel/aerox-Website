-- Outils de test admin du diagnostic (spec feat-diagnostic-admin-test-controls).

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

alter table public.diagnostic_purchases
  add column is_admin_test boolean not null default false;

comment on column public.diagnostic_purchases.is_admin_test is
  'Droit de test créé par admin_set_my_diagnostic (0 €, hors Stripe). Exclu du suivi des achats.';

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

  select id into v_purchase_id
  from public.diagnostic_purchases
  where user_id = v_uid and consumed_at is null and refunded_at is null
  order by paid_at
  limit 1
  for update;
  if v_purchase_id is null then
    raise exception 'no_diagnostic_entitlement' using errcode = 'P0001';
  end if;

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
