-- supabase/migrations/20260924_diagnostic_purchases.sql
-- Droit au Diagnostic AeroX : un achat Stripe = un diagnostic. Voir le fichier du dépôt veloaero pour le commentaire complet.

create table public.diagnostic_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text unique,
  amount_total integer not null check (amount_total >= 0),
  currency text not null,
  paid_at timestamptz not null default now(),
  withdrawal_waiver_at timestamptz,
  consumed_at timestamptz,
  amount_refunded integer not null default 0 check (amount_refunded >= 0),
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint diagnostic_purchases_refund_le_total check (amount_refunded <= amount_total)
);

create index diagnostic_purchases_user_idx on public.diagnostic_purchases (user_id);

comment on table public.diagnostic_purchases is
  '[Diagnostic] Un achat Stripe du Diagnostic AeroX. Écriture : webhook (service_role) et fonctions SECURITY DEFINER uniquement.';

alter table public.diagnostic_purchases enable row level security;

create policy diagnostic_purchases_select_own on public.diagnostic_purchases
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

revoke all on public.diagnostic_purchases from anon;
revoke insert, update, delete, truncate on public.diagnostic_purchases from authenticated;

alter type public.diagnostic_basic_status add value if not exists 'revoked';

alter table public.diagnostic_basic
  add column purchase_id uuid references public.diagnostic_purchases (id) on delete cascade;

create index diagnostic_basic_purchase_idx on public.diagnostic_basic (purchase_id);

alter table public.diagnostic_basic
  alter column expires_at set default (now() + interval '30 days');

comment on column public.diagnostic_basic.purchase_id is
  'Achat qui a ouvert ce diagnostic. Un « Recommencer » crée un nouveau diagnostic sur le même achat, avec la même échéance.';

drop policy if exists user_insert_own_diag on public.diagnostic_basic;
revoke insert on public.diagnostic_basic from anon, authenticated;

revoke update on public.diagnostic_basic from anon, authenticated;
grant update (status, completed_at, aero_zone, stability_zone, recommendation_key)
  on public.diagnostic_basic to authenticated;

drop policy if exists user_update_own_diag on public.diagnostic_basic;
create policy user_update_own_diag on public.diagnostic_basic
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke delete, truncate on public.diagnostic_basic from anon, authenticated;

create or replace function public.diagnostic_basic_guard_client_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status <> 'in_progress' or old.expires_at <= now() then
    raise exception 'diagnostic_closed' using errcode = '42501';
  end if;
  if new.status not in ('in_progress', 'completed') then
    raise exception 'diagnostic_status_forbidden' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_diagnostic_basic_guard_client_update
  before update on public.diagnostic_basic
  for each row execute function public.diagnostic_basic_guard_client_update();

alter function public.recompute_diagnostic_basic_s1_counts() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_s2_count() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_best_s1() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_best_s2() security definer set search_path = '';

create or replace function public.diagnostic_is_writable(p_diagnostic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.diagnostic_basic d
    where d.id = p_diagnostic_id
      and d.user_id = auth.uid()
      and d.status = 'in_progress'
      and d.expires_at + interval '6 hours' > now()
  );
$$;

revoke execute on function public.diagnostic_is_writable(uuid) from public, anon;
grant execute on function public.diagnostic_is_writable(uuid) to authenticated;

drop policy if exists user_insert_own_diag_pos on public.diagnostic_basic_positions;
create policy user_insert_own_diag_pos on public.diagnostic_basic_positions
  for insert to authenticated
  with check (public.diagnostic_is_writable(diagnostic_id));

drop policy if exists user_update_own_diag_pos on public.diagnostic_basic_positions;
create policy user_update_own_diag_pos on public.diagnostic_basic_positions
  for update to authenticated
  using (public.diagnostic_is_writable(diagnostic_id))
  with check (public.diagnostic_is_writable(diagnostic_id));

drop policy if exists user_delete_own_diag_pos on public.diagnostic_basic_positions;
create policy user_delete_own_diag_pos on public.diagnostic_basic_positions
  for delete to authenticated
  using (public.diagnostic_is_writable(diagnostic_id));

drop policy if exists user_insert_own_diag_s2 on public.diagnostic_basic_s2;
create policy user_insert_own_diag_s2 on public.diagnostic_basic_s2
  for insert to authenticated
  with check (public.diagnostic_is_writable(diagnostic_id));

drop policy if exists user_update_own_diag_s2 on public.diagnostic_basic_s2;
create policy user_update_own_diag_s2 on public.diagnostic_basic_s2
  for update to authenticated
  using (public.diagnostic_is_writable(diagnostic_id))
  with check (public.diagnostic_is_writable(diagnostic_id));

revoke all on public.diagnostic_basic_positions, public.diagnostic_basic_s2 from anon;

create or replace function public.has_diagnostic_entitlement()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    public.is_admin()
    or exists (
      select 1 from public.diagnostic_purchases
      where user_id = auth.uid() and consumed_at is null and refunded_at is null
    )
    or exists (
      select 1 from public.diagnostic_basic
      where user_id = auth.uid() and status = 'in_progress' and expires_at > now()
    )
  );
$$;

revoke execute on function public.has_diagnostic_entitlement() from public, anon;
grant execute on function public.has_diagnostic_entitlement() to authenticated;

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
  if v_purchase_id is null and not public.is_admin() then
    raise exception 'no_diagnostic_entitlement' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic
  set status = 'expired'
  where user_id = v_uid and status = 'in_progress' and expires_at <= now();

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_purchase_id, now(), now() + interval '30 days')
  returning * into v_diag;

  if v_purchase_id is not null then
    update public.diagnostic_purchases
    set consumed_at = now()
    where id = v_purchase_id;
  end if;

  return v_diag;
end;
$$;

revoke execute on function public.start_diagnostic() from public, anon;
grant execute on function public.start_diagnostic() to authenticated;

create or replace function public.restart_diagnostic()
returns public.diagnostic_basic
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_old public.diagnostic_basic;
  v_new public.diagnostic_basic;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_old
  from public.diagnostic_basic
  where user_id = v_uid and status = 'in_progress' and expires_at > now()
  for update;
  if not found then
    raise exception 'no_active_diagnostic' using errcode = 'P0001';
  end if;

  update public.diagnostic_basic set status = 'archived' where id = v_old.id;

  insert into public.diagnostic_basic (user_id, purchase_id, started_at, expires_at)
  values (v_uid, v_old.purchase_id, now(), v_old.expires_at)
  returning * into v_new;

  return v_new;
end;
$$;

revoke execute on function public.restart_diagnostic() from public, anon;
grant execute on function public.restart_diagnostic() to authenticated;

create or replace function public.record_diagnostic_refund(
  p_payment_intent_id text,
  p_amount_refunded integer,
  p_fully_refunded boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purchase_id uuid;
begin
  update public.diagnostic_purchases
  set amount_refunded = greatest(amount_refunded, p_amount_refunded),
      refunded_at = case when p_fully_refunded then coalesce(refunded_at, now()) else refunded_at end
  where stripe_payment_intent_id = p_payment_intent_id
  returning id into v_purchase_id;

  if v_purchase_id is not null and p_fully_refunded then
    update public.diagnostic_basic
    set status = 'revoked'
    where purchase_id = v_purchase_id and status = 'in_progress';
  end if;

  return v_purchase_id;
end;
$$;

revoke execute on function public.record_diagnostic_refund(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.record_diagnostic_refund(text, integer, boolean) to service_role;

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
) x;

comment on view public.diagnostic_purchase_status is
  '[Diagnostic] Achats et droit au remboursement : refundable (14 j, aucune séance), session_done, withdrawal_period_over, refunded.';

revoke all on public.diagnostic_purchase_status from anon;
grant select on public.diagnostic_purchase_status to authenticated;

revoke insert, update, delete, truncate on public.users from anon;
revoke insert, update on public.users from authenticated;

grant update (
  id, email, name, firstname, updated_at, profile_picture, bio, role,
  preferences, device_ids, height, weight, ftp, hr_max, hr_rest, licencetype,
  "Cd", phonenumber, age, last_login_at_, birthdate, massvelo,
  onboarding_completed, studio_name, website, lang, first_session_completed,
  weight_updated_at, setup_correction, setup_anchor
) on public.users to authenticated;

grant insert (
  id, email, name, firstname, created_at, updated_at, profile_picture, bio,
  role, preferences, device_ids, height, weight, ftp, hr_max, hr_rest,
  licencetype, "Cd", phonenumber, age, last_login_at_, birthdate, massvelo,
  onboarding_completed, studio_name, website, lang, first_session_completed,
  weight_updated_at, setup_correction, setup_anchor
) on public.users to authenticated;
