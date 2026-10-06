-- supabase/tests/diagnostic_purchases/diagnostic_purchases.test.sql
--
-- Scénarios d'usage et d'attaque sur le droit au diagnostic. Chaque bloc
-- échoue (et arrête `run.sh`) si le comportement attendu n'est pas obtenu.

\set ON_ERROR_STOP 1

-- Deux riders, un admin.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@test'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@test'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@test');
insert into public.users (id, email, role) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@test', 'rider'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@test', 'rider'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@test', 'admin');

-- Échoue si `sql` réussit, ou si l'erreur ne contient pas `expected`.
create function pg_temp.expect_error(sql text, expected text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'ATTENDU UN ÉCHEC (%), obtenu un succès : %', expected, sql;
exception when others then
  if sqlerrm like 'ATTENDU UN ÉCHEC%' then raise; end if;
  if position(expected in sqlerrm) = 0 then
    raise exception 'ÉCHEC INATTENDU pour % : « % » (attendu « % »)', sql, sqlerrm, expected;
  end if;
end $$;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated, service_role;

create function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'KO : %', label; end if;
end $$;
grant execute on function pg_temp.check(boolean, text) to anon, authenticated, service_role;

-- ─── 1. Ligne users : le rider ne touche plus à ses accès ──────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select pg_temp.expect_error(
  $$update public.users set login_attempts = 0 where id = auth.uid()$$,
  'permission denied');
-- L'ancien drapeau d'achat n'existe plus : rien à s'attribuer.
select pg_temp.expect_error(
  $$update public.users set diagnostic_basic_paid = true where id = auth.uid()$$,
  'does not exist');
select pg_temp.expect_error(
  $$update public.users set banned_until = null, is_active = true where id = auth.uid()$$,
  'permission denied');
select pg_temp.expect_error(
  $$update public.users set created_at = '2020-01-01' where id = auth.uid()$$,
  'permission denied');

-- Profil : toujours modifiable (desktop UserSettings, calibration, langue).
update public.users set name = 'Alice', ftp = 280, weight = 62,
  weight_updated_at = now(), setup_correction = 1.02, setup_anchor = '{}'::jsonb,
  lang = 'en', onboarding_completed = true, first_session_completed = true
where id = auth.uid();
-- Upsert de la webapp mycompanion (signup_profile_screen).
insert into public.users (id, email, firstname, name, weight, height, onboarding_completed, updated_at, ftp)
values (auth.uid(), 'alice@test', 'Alice', 'A', 62, 170, true, now(), 280)
on conflict (id) do update set email = excluded.email, firstname = excluded.firstname,
  name = excluded.name, weight = excluded.weight, height = excluded.height,
  onboarding_completed = excluded.onboarding_completed, updated_at = excluded.updated_at,
  ftp = excluded.ftp;
select pg_temp.check((select ftp = 280 from public.users where id = auth.uid()), 'profil modifiable');

-- Auto-promotion admin : toujours bloquée par la policy existante.
select pg_temp.expect_error(
  $$update public.users set role = 'admin' where id = auth.uid()$$,
  'row-level security');

reset role;
set role anon;
select pg_temp.expect_error(
  $$update public.users set name = 'x'$$, 'permission denied');
reset role;

-- ─── 2. Pas d'achat : rien ne s'ouvre ──────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select pg_temp.expect_error(
  $$insert into public.diagnostic_basic (user_id) values (auth.uid())$$,
  'permission denied');
select pg_temp.expect_error(
  $$insert into public.diagnostic_purchases (user_id, stripe_checkout_session_id, amount_total, currency)
    values (auth.uid(), 'cs_fake', 0, 'eur')$$,
  'permission denied');
select pg_temp.expect_error($$select public.start_diagnostic()$$, 'no_diagnostic_entitlement');
select pg_temp.expect_error(
  $$select public.record_diagnostic_refund('pi_x', 0, true)$$, 'permission denied');
reset role;

-- ─── 3. Achat (webhook, service_role) puis démarrage ───────────────────────
set role service_role;
insert into public.diagnostic_purchases
  (user_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_total, currency, withdrawal_waiver_at)
values ('00000000-0000-0000-0000-00000000000a', 'cs_alice_1', 'pi_alice_1', 4900, 'eur', now());
-- Rejeu du webhook : idempotent.
insert into public.diagnostic_purchases
  (user_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_total, currency)
values ('00000000-0000-0000-0000-00000000000a', 'cs_alice_1', 'pi_alice_1', 4900, 'eur')
on conflict (stripe_checkout_session_id) do nothing;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select pg_temp.check(
  (select refund_eligibility = 'refundable' and not session_done from public.diagnostic_purchase_status),
  'achat neuf remboursable');

create temp table t_diag as select * from public.start_diagnostic();
grant select on t_diag to authenticated;
select pg_temp.check(
  (select expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour' from t_diag),
  '30 jours à partir du démarrage');
select pg_temp.check(
  (select consumed_at is not null from public.diagnostic_purchases), 'achat consommé');
-- Deuxième appel : même diagnostic, rien de plus consommé.
select pg_temp.check(
  (select id from public.start_diagnostic()) = (select id from t_diag), 'start idempotent');

-- Colonnes hors d'atteinte du rider.
select pg_temp.expect_error(
  $$update public.diagnostic_basic set expires_at = now() + interval '1 year'$$, 'permission denied');
select pg_temp.expect_error(
  $$update public.diagnostic_basic set purchase_id = null$$, 'permission denied');
select pg_temp.expect_error(
  $$update public.diagnostic_basic set s1_positions_count = 0$$, 'permission denied');
select pg_temp.expect_error(
  $$delete from public.diagnostic_basic$$, 'permission denied');

-- ─── 4. Séances : compteurs à jour, remboursement fermé ────────────────────
insert into public.diagnostic_basic_positions (diagnostic_id, s1_session_index, name, aero_score, mask_png)
select id, 1, 'P1', 71.5, '\x00' from t_diag;
insert into public.diagnostic_basic_s2 (diagnostic_id, session_index, duration_s, stability_score, validated)
select id, 1, 1800, 82, true from t_diag;
select pg_temp.check(
  (select s1_positions_count = 1 and s1_sessions_count = 1 and s2_sessions_count = 1
     and best_s1_position_id is not null and best_s2_id is not null
   from public.diagnostic_basic where id = (select id from t_diag)),
  'compteurs recalculés par les triggers');
select pg_temp.check(
  (select refund_eligibility = 'session_done' and session_done from public.diagnostic_purchase_status),
  'séance réalisée : plus remboursable');

-- ─── 5. Recommencer : même achat, même échéance ────────────────────────────
create temp table t_diag2 as select * from public.restart_diagnostic();
grant select on t_diag2 to authenticated;
select pg_temp.check(
  (select d2.expires_at = d1.expires_at and d2.purchase_id = d1.purchase_id and d2.id <> d1.id
   from t_diag d1, t_diag2 d2), 'recommencer garde achat et échéance');
select pg_temp.check(
  (select status = 'archived' from public.diagnostic_basic where id = (select id from t_diag)),
  'ancien diagnostic archivé');
select pg_temp.check(
  (select count(*) = 1 from public.diagnostic_purchases), 'aucun achat supplémentaire');
-- L'archivé est figé.
select pg_temp.expect_error(
  $$update public.diagnostic_basic set status = 'in_progress' where id = (select id from t_diag)$$,
  'diagnostic_closed');
select pg_temp.expect_error(
  $$insert into public.diagnostic_basic_positions (diagnostic_id, s1_session_index, name, mask_png)
    select id, 1, 'P', '\x00' from t_diag$$,
  'row-level security');

-- ─── 6. Le rider termine : diagnostic figé, achat épuisé ───────────────────
update public.diagnostic_basic set status = 'completed', completed_at = now(),
  aero_zone = 'high', stability_zone = 'mid', recommendation_key = 'k'
where id = (select id from t_diag2);
select pg_temp.expect_error(
  $$update public.diagnostic_basic set status = 'in_progress' where id = (select id from t_diag2)$$,
  'diagnostic_closed');
select pg_temp.expect_error(
  $$insert into public.diagnostic_basic_s2 (diagnostic_id, session_index, duration_s, stability_score, validated)
    select id, 2, 60, 10, false from t_diag2$$,
  'row-level security');
select pg_temp.expect_error($$select public.start_diagnostic()$$, 'no_diagnostic_entitlement');
select pg_temp.expect_error($$select public.restart_diagnostic()$$, 'no_active_diagnostic');
-- Un statut interdit au client.
reset role;

-- ─── 7. Isolation entre riders ─────────────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check((select count(*) = 0 from public.diagnostic_purchases), 'Bob ne voit pas les achats d''Alice');
select pg_temp.check((select count(*) = 0 from public.diagnostic_purchase_status), 'vue isolée');
select pg_temp.check((select count(*) = 0 from public.diagnostic_basic), 'Bob ne voit pas les diagnostics d''Alice');
select pg_temp.expect_error($$select public.start_diagnostic()$$, 'no_diagnostic_entitlement');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
select pg_temp.check((select count(*) = 1 from public.diagnostic_purchase_status), 'l''admin voit tous les achats');
reset role;

-- ─── 8. Remboursement : accès retiré, trace conservée ──────────────────────
set role service_role;
insert into public.diagnostic_purchases
  (user_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_total, currency)
values ('00000000-0000-0000-0000-00000000000b', 'cs_bob_1', 'pi_bob_1', 4900, 'eur');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
create temp table t_bob as select * from public.start_diagnostic();
grant select on t_bob to service_role;
reset role;

set role service_role;
-- Remboursement partiel : tracé, accès conservé.
select pg_temp.check(public.record_diagnostic_refund('pi_bob_1', 1000, false) is not null, 'partiel tracé');
select pg_temp.check(
  (select status = 'in_progress' from public.diagnostic_basic where id = (select id from t_bob)),
  'partiel : accès conservé');
-- Remboursement total (rejoué deux fois : idempotent).
select public.record_diagnostic_refund('pi_bob_1', 4900, true);
select public.record_diagnostic_refund('pi_bob_1', 4900, true);
select pg_temp.check(
  (select status = 'revoked' from public.diagnostic_basic where id = (select id from t_bob)),
  'total : diagnostic révoqué');
select pg_temp.check(
  (select refunded_at is not null and amount_refunded = 4900 from public.diagnostic_purchases where stripe_payment_intent_id = 'pi_bob_1'),
  'total : remboursement tracé');
-- Paiement étranger au diagnostic (livre, BF) : ignoré.
select pg_temp.check(public.record_diagnostic_refund('pi_livre', 2900, true) is null, 'PaymentIntent inconnu ignoré');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.expect_error($$select public.start_diagnostic()$$, 'no_diagnostic_entitlement');
select pg_temp.expect_error(
  $$insert into public.diagnostic_basic_positions (diagnostic_id, s1_session_index, name, mask_png)
    select id, 1, 'P', '\x00' from public.diagnostic_basic$$,
  'row-level security');
select pg_temp.check(
  (select refund_eligibility = 'refunded' from public.diagnostic_purchase_status), 'suivi : remboursé');
reset role;

-- ─── 9. Expiration : 30 jours passés, plus d'écriture ──────────────────────
set role service_role;
insert into public.diagnostic_purchases
  (user_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_total, currency)
values ('00000000-0000-0000-0000-00000000000b', 'cs_bob_2', 'pi_bob_2', 4900, 'eur');
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
create temp table t_bob2 as select * from public.start_diagnostic();
reset role;
-- Le temps passe (écriture directe en propriétaire, comme le ferait l'horloge).
update public.diagnostic_basic set expires_at = now() - interval '7 hours' where id = (select id from t_bob2);

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.expect_error(
  $$insert into public.diagnostic_basic_positions (diagnostic_id, s1_session_index, name, mask_png)
    select id, 1, 'P', '\x00' from t_bob2$$,
  'row-level security');
select pg_temp.expect_error(
  $$update public.diagnostic_basic set status = 'completed' where id = (select id from t_bob2)$$,
  'diagnostic_closed');
reset role;
-- Grâce de 6 h : une séance finie juste après l'échéance s'enregistre.
update public.diagnostic_basic set expires_at = now() - interval '1 hour' where id = (select id from t_bob2);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
insert into public.diagnostic_basic_s2 (diagnostic_id, session_index, duration_s, stability_score, validated)
select id, 1, 1800, 70, true from t_bob2;
reset role;
-- Le cron passe : expiré.
select public.expire_stale_diagnostic_basic();
select pg_temp.check(
  (select status = 'expired' from public.diagnostic_basic where id = (select id from t_bob2)), 'cron : expiré');

-- ─── 10. Droit calculé par la base, mode test admin ────────────────────────
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check(not public.has_diagnostic_entitlement(), 'Bob remboursé puis expiré : aucun droit');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select pg_temp.check(not public.has_diagnostic_entitlement(), 'Alice a terminé : aucun droit');
-- Un rider ne peut pas se déclarer admin pour contourner le paiement.
select pg_temp.expect_error(
  $$update public.users set role = 'admin' where id = auth.uid()$$, 'row-level security');
-- Un rider n'a pas accès aux outils de test admin.
select pg_temp.expect_error($$select public.admin_set_my_diagnostic('unlock')$$, 'forbidden');

-- L'admin n'a plus de passe-droit : il vit le paywall comme un rider.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
select pg_temp.check(not public.has_diagnostic_entitlement(), 'admin sans droit de test : paywall');
select pg_temp.expect_error($$select public.start_diagnostic()$$, 'no_diagnostic_entitlement');
select pg_temp.expect_error($$select public.admin_set_my_diagnostic('open_all')$$, 'invalid_action');

-- Débloquer : un droit de test à 0 €, idempotent, invisible dans le suivi.
select public.admin_set_my_diagnostic('unlock');
select public.admin_set_my_diagnostic('unlock');
select pg_temp.check(public.has_diagnostic_entitlement(), 'admin débloqué : droit ouvert');
select pg_temp.check((select count(*) = 1 and bool_and(is_admin_test and amount_total = 0)
  from public.diagnostic_purchases where user_id = auth.uid()), 'admin : un seul droit de test à 0 €');
select pg_temp.check((select count(*) = 0 from public.diagnostic_purchase_status where user_id = auth.uid()),
  'droit de test absent du suivi des achats');

-- Commencer : le droit de test est consommé comme un achat réel.
create temp table t_admin as select * from public.start_diagnostic();
select pg_temp.check((select p.consumed_at is not null from public.diagnostic_purchases p
  join t_admin d on d.purchase_id = p.id where p.is_admin_test), 'admin : droit de test consommé au démarrage');
insert into public.diagnostic_basic_positions (diagnostic_id, s1_session_index, name, mask_png)
select id, 1, 'P', '\x00' from t_admin;
select pg_temp.check((select purchase_id = (select purchase_id from t_admin) from public.restart_diagnostic()),
  'admin : recommencer sur le même droit de test');

-- Bloquer : diagnostic révoqué, données gardées, paywall.
select public.admin_set_my_diagnostic('block');
select pg_temp.check(not public.has_diagnostic_entitlement(), 'admin bloqué : paywall');
select pg_temp.check((select count(*) = 0 from public.diagnostic_basic
  where user_id = auth.uid() and status = 'in_progress'), 'admin bloqué : plus de diagnostic ouvert');
select pg_temp.check((select count(*) >= 1 from public.diagnostic_basic
  where user_id = auth.uid() and status = 'revoked'), 'admin bloqué : diagnostic révoqué gardé');
-- Bloquer un droit pas encore utilisé le retire.
select public.admin_set_my_diagnostic('unlock');
select public.admin_set_my_diagnostic('block');
select pg_temp.check(not public.has_diagnostic_entitlement(), 'droit de test non utilisé retiré au blocage');

-- Réinitialiser : diagnostics et droits de test effacés, achats réels intacts.
reset role;
insert into public.diagnostic_purchases (user_id, stripe_checkout_session_id, amount_total, currency)
values ('00000000-0000-0000-0000-0000000000ad', 'cs_admin_real', 4900, 'eur');
create temp table t_others as
  select count(*) n from public.diagnostic_basic where user_id <> '00000000-0000-0000-0000-0000000000ad';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
select public.admin_set_my_diagnostic('reset');
reset role;
select pg_temp.check((select count(*) = 0 from public.diagnostic_basic
  where user_id = '00000000-0000-0000-0000-0000000000ad'), 'reset : diagnostics admin effacés');
select pg_temp.check((select count(*) = 0 from public.diagnostic_basic_positions pos
  where pos.diagnostic_id = (select id from t_admin)), 'reset : positions effacées');
select pg_temp.check((select count(*) = 0 from public.diagnostic_purchases
  where user_id = '00000000-0000-0000-0000-0000000000ad' and is_admin_test), 'reset : droits de test effacés');
select pg_temp.check((select count(*) = 1 from public.diagnostic_purchases
  where stripe_checkout_session_id = 'cs_admin_real'), 'reset : achat réel de l''admin intact');
select pg_temp.check((select count(*) = (select n from t_others) from public.diagnostic_basic
  where user_id <> '00000000-0000-0000-0000-0000000000ad'), 'reset : diagnostics des autres intacts');
reset role;
set role anon;
select pg_temp.expect_error($$select public.has_diagnostic_entitlement()$$, 'permission denied');
reset role;

\echo 'OK — diagnostic_purchases : tous les scénarios passent'
