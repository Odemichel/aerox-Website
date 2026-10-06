-- supabase/migrations/20260924_diagnostic_purchases.sql
--
-- Droit au Diagnostic AeroX : un achat Stripe = un diagnostic.
--
-- Avant : un drapeau `users.diagnostic_basic_paid` que le rider pouvait
-- s'attribuer lui-même (UPDATE autorisé sur toute sa ligne), jamais consommé
-- (« Recommencer » et l'expiration recréaient un diagnostic gratuit), jamais
-- retiré après un remboursement, et aucun garde-fou en base : le paywall
-- n'existait que dans l'application.
--
-- Principe, calqué sur la facturation bike fitter (`bf_billing`) : le client
-- ne fait que LIRE ses achats. Les écritures passent par
--   - le webhook Stripe du site (service_role) : enregistre l'achat, le
--     remboursement ;
--   - des fonctions SECURITY DEFINER appelées par l'application :
--     `has_diagnostic_entitlement`, `start_diagnostic`, `restart_diagnostic`.
--
-- Admin : pour tester le parcours sans payer, un admin (rôle réel en base,
-- quelle que soit la vue simulée dans l'application) a toujours droit à un
-- diagnostic. Le sien n'est rattaché à aucun achat (`purchase_id` null) :
-- repérable, et sans effet sur le suivi des ventes.
--
-- Cycle de vie :
--   achat (paid_at) → démarrage du diagnostic (consumed_at, +30 jours)
--   → fin : le rider termine (status completed) ou les 30 jours passent
--   (status expired, cron quotidien). Un remboursement total révoque le
--   diagnostic en cours (status revoked).
--
-- Remboursement : droit de rétractation de 14 jours tant qu'aucune séance n'a
-- été réalisée. Le rider y renonce au checkout (case obligatoire Stripe,
-- tracée dans `withdrawal_waiver_at`) pour la suite de l'exécution — Code de
-- la consommation, art. L221-28 13°. La vue `diagnostic_purchase_status` dit
-- pour chaque achat s'il reste remboursable.
--
-- Les colonnes `users.diagnostic_basic_paid*` sont gelées ici (plus aucune
-- écriture client) puis supprimées par une migration séparée, une fois le
-- webhook du site déployé sur la nouvelle table.


-- ---------------------------------------------------------------------------
-- 1. Achats
-- ---------------------------------------------------------------------------

create table public.diagnostic_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Clé d'idempotence du webhook : Stripe peut livrer plusieurs fois
  -- `checkout.session.completed` et `async_payment_succeeded` pour un même
  -- paiement.
  stripe_checkout_session_id text not null unique,
  -- Clé de rapprochement des remboursements (`charge.refunded` porte le
  -- PaymentIntent, pas la session Checkout).
  stripe_payment_intent_id text unique,
  amount_total integer not null check (amount_total >= 0),
  currency text not null,
  paid_at timestamptz not null default now(),
  -- Case « je renonce à mon droit de rétractation dès la première séance »
  -- cochée au checkout (`session.consent.terms_of_service = 'accepted'`).
  withdrawal_waiver_at timestamptz,
  -- Diagnostic démarré avec cet achat : l'achat n'ouvre plus rien d'autre.
  consumed_at timestamptz,
  amount_refunded integer not null default 0 check (amount_refunded >= 0),
  -- Posé au remboursement total : l'accès est retiré.
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


-- ---------------------------------------------------------------------------
-- 2. Diagnostic : rattachement à l'achat, 30 jours, statut « révoqué »
-- ---------------------------------------------------------------------------

alter type public.diagnostic_basic_status add value if not exists 'revoked';

alter table public.diagnostic_basic
  add column purchase_id uuid references public.diagnostic_purchases (id) on delete cascade;

create index diagnostic_basic_purchase_idx on public.diagnostic_basic (purchase_id);

alter table public.diagnostic_basic
  alter column expires_at set default (now() + interval '30 days');

comment on column public.diagnostic_basic.purchase_id is
  'Achat qui a ouvert ce diagnostic. Un « Recommencer » crée un nouveau diagnostic sur le même achat, avec la même échéance.';


-- ---------------------------------------------------------------------------
-- 3. Diagnostic : plus de création directe, mises à jour bornées
-- ---------------------------------------------------------------------------

-- Création uniquement via `start_diagnostic` / `restart_diagnostic`.
drop policy if exists user_insert_own_diag on public.diagnostic_basic;
revoke insert on public.diagnostic_basic from anon, authenticated;

-- Le client ne peut toucher que le résultat du diagnostic. `user_id`,
-- `purchase_id`, `started_at`, `expires_at` et les compteurs lui échappent.
revoke update on public.diagnostic_basic from anon, authenticated;
grant update (status, completed_at, aero_zone, stability_zone, recommendation_key)
  on public.diagnostic_basic to authenticated;

drop policy if exists user_update_own_diag on public.diagnostic_basic;
create policy user_update_own_diag on public.diagnostic_basic
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke delete, truncate on public.diagnostic_basic from anon, authenticated;

-- Seule transition permise au client : clore un diagnostic ouvert
-- (in_progress → completed). Un diagnostic terminé, expiré, archivé ou
-- révoqué ne se rouvre pas. Les fonctions SECURITY DEFINER, le cron
-- d'expiration et le service_role ne sont pas concernés.
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

-- Les compteurs dénormalisés sont recalculés par des triggers déclenchés par
-- les écritures du rider sur les positions et les tests de stabilité. Ils
-- tournaient avec les droits du rider : ils doivent désormais écrire des
-- colonnes qu'il ne peut plus modifier, d'où SECURITY DEFINER. Leur corps ne
-- lit que des identifiants issus de la ligne déclenchante, déjà contrôlée
-- par les policies ci-dessous.
alter function public.recompute_diagnostic_basic_s1_counts() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_s2_count() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_best_s1() security definer set search_path = '';
alter function public.recompute_diagnostic_basic_best_s2() security definer set search_path = '';
-- Triggers uniquement, jamais d'endpoint /rpc (le droit d'exécution n'est
-- vérifié qu'à la création du trigger, pas à son déclenchement).
revoke execute on function public.recompute_diagnostic_basic_s1_counts() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_s2_count() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_best_s1() from public, anon, authenticated;
revoke execute on function public.recompute_diagnostic_basic_best_s2() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Positions S1 et tests S2 : seulement dans un diagnostic ouvert
-- ---------------------------------------------------------------------------

-- Une séance se termine parfois après l'échéance : 6 h de grâce pour
-- l'enregistrer. Au-delà (ou après le passage du cron), plus d'écriture.
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


-- ---------------------------------------------------------------------------
-- 5. Démarrer, recommencer
-- ---------------------------------------------------------------------------

-- Le rider a droit à un diagnostic : un achat ni consommé ni remboursé, un
-- diagnostic ouvert, ou le rôle admin (tests). Seule source de vérité pour
-- l'application, qui ne recalcule rien de son côté.
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

-- Renvoie le diagnostic ouvert du rider, ou en ouvre un sur son plus ancien
-- achat non consommé (30 jours à partir de maintenant). Un admin sans achat
-- en ouvre un de test, rattaché à aucun achat. Lève
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
  if v_purchase_id is null and not public.is_admin() then
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

-- Archive le diagnostic ouvert et en ouvre un vierge sur le même achat, sans
-- repousser l'échéance : recommencer ne rallonge pas les 30 jours et ne
-- consomme pas d'achat.
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


-- ---------------------------------------------------------------------------
-- 6. Remboursement (webhook, service_role)
-- ---------------------------------------------------------------------------

-- Trace le montant remboursé. Au remboursement total, retire l'accès :
-- l'achat ne peut plus ouvrir de diagnostic et le diagnostic en cours est
-- révoqué. Renvoie l'id de l'achat, `null` si le PaymentIntent n'est pas un
-- achat de diagnostic (livre, offre bike fitter…). Idempotent.
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


-- ---------------------------------------------------------------------------
-- 7. Suivi : état de chaque achat et droit au remboursement
-- ---------------------------------------------------------------------------

-- `security_invoker` : la vue applique les RLS de l'appelant (un rider voit
-- ses achats, un admin tous).
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
) x;

comment on view public.diagnostic_purchase_status is
  '[Diagnostic] Achats et droit au remboursement : refundable (14 j, aucune séance), session_done, withdrawal_period_over, refunded.';

revoke all on public.diagnostic_purchase_status from anon;
grant select on public.diagnostic_purchase_status to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Ligne `users` : le rider n'écrit plus que son profil
-- ---------------------------------------------------------------------------

-- Liste blanche : toute colonne absente est hors d'atteinte du client, y
-- compris les colonnes ajoutées plus tard. Ajouter une colonne de profil
-- modifiable par l'application = l'ajouter ici par une migration.
-- Hors liste : created_at, is_active, banned_until, login_attempts,
-- diagnostic_basic_paid, diagnostic_basic_paid_at.
-- `id` reste listé parce que l'upsert de la webapp le renvoie ; la policy
-- (auth.uid() = id) interdit d'en changer la valeur. `role` reste gardé par
-- la policy `user_update_own_row`.
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
