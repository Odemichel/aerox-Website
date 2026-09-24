-- supabase/tests/bf_billing.test.sql — scénarios de la migration bf_billing.
-- Chaque bloc lève une exception (et fait échouer run.sh) si une attente
-- n'est pas tenue.

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false);
$$;
create function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'ÉCHEC : %', msg; end if; end $$;

-- Existant : legacy seedé, pending_bf ignoré.
select pg_temp.check((select plan from bf_billing where user_id = '00000000-0000-0000-0000-00000000a001') = 'legacy',
  'le bike fitter existant passe en legacy');
select pg_temp.check(not exists (select 1 from bf_billing where user_id = '00000000-0000-0000-0000-00000000a002'),
  'pending_bf non touché');

-- Inscription BF sans secret Vault : actif + essai, pas d'appel réseau.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'bf1@example.com', '{"profile_type":"bike-fitter","studio_name":"Studio 1"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'bf2@example.com', '{"profile_type":"bike-fitter"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'rider@example.com', '{"profile_type":"rider"}');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.check((select role from users where id = '00000000-0000-0000-0000-0000000000b1') = 'bike-fitter', 'BF actif immédiatement');
select pg_temp.check((select is_active from users where id = '00000000-0000-0000-0000-0000000000b1'), 'BF is_active');
select pg_temp.check((select studio_name from users where id = '00000000-0000-0000-0000-0000000000b1') = 'Studio 1', 'studio_name repris');
select pg_temp.check((select plan from bf_billing where user_id = '00000000-0000-0000-0000-0000000000b1') = 'trial', 'plan trial');
select pg_temp.check(not exists (select 1 from bf_credits where user_id = '00000000-0000-0000-0000-0000000000b1'), 'essai : aucun crédit avant la carte');
select pg_temp.check((select trial_state from bf_billing where user_id = '00000000-0000-0000-0000-0000000000b1') = 'needs_card', 'essai : en attente de carte');
select pg_temp.check((select count(*) from net.calls) = 0, 'pas de notification sans secret');

-- Avec secret : notification « nouveau BF ».
insert into vault.decrypted_secrets values ('bf_notify_secret', 's3cret');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.check((select count(*) from net.calls where url like '%/notify-admin-new-bf'
  and headers ->> 'x-hook-secret' = 's3cret' and body -> 'record' ->> 'email' = 'bf2@example.com') = 1, 'notification nouveau BF');

-- Cycliste : inchangé.
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000c1';
select pg_temp.check((select role from users where id = '00000000-0000-0000-0000-0000000000c1') = 'rider', 'rider inchangé');
select pg_temp.check(not exists (select 1 from bf_billing where user_id = '00000000-0000-0000-0000-0000000000c1'), 'rider sans facturation');

-- Clients de test.
insert into bf_clients (id, bf_user_id) select ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-0000000000b1' from generate_series(1, 15) i;
insert into bf_clients (id, bf_user_id) values ('00000000-0000-0000-0000-000000000299', '00000000-0000-0000-0000-0000000000b2');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'reason' = 'needs_card', 'essai sans carte : refus needs_card');
reset role;

-- Carte enregistrée : 2 analyses sur 20 jours. Une carte = un essai.
select pg_temp.check(bf_grant_trial('00000000-0000-0000-0000-0000000000b1', 'fp_card_1') = 'granted', 'carte : essai ouvert');
select pg_temp.check((select remaining = 2 and expires_at between now() + interval '19 days 23 hours' and now() + interval '20 days 1 hour'
  from bf_credits where user_id = '00000000-0000-0000-0000-0000000000b1' and source = 'trial'), '2 crédits sur 20 jours');
select pg_temp.check(bf_grant_trial('00000000-0000-0000-0000-0000000000b1', 'fp_card_1') = 'already_granted', 'rejeu : pas de second essai');
select pg_temp.check(bf_grant_trial('00000000-0000-0000-0000-0000000000b2', 'fp_card_1') = 'card_already_used', 'même carte, autre compte : refusé');
select pg_temp.check((select trial_state from bf_billing where user_id = '00000000-0000-0000-0000-0000000000b2') = 'card_already_used', 'état card_already_used');
select pg_temp.check(not exists (select 1 from bf_credits where user_id = '00000000-0000-0000-0000-0000000000b2'), 'aucun crédit pour la carte réutilisée');

set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');

-- Essai : 2 clients comptés, re-tests gratuits, 3e refusé.
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'status' = 'counted', 'essai 1');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'status' = 'already_counted', 're-test 1');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'status' = 'already_counted', 're-test 2');
select pg_temp.check((register_analysis('00000000-0000-0000-0000-000000000102') ->> 'credits_remaining')::int = 0, 'essai 2, plus de crédit');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000103') ->> 'reason' = 'no_credits', '3e refusé');
select pg_temp.check((select count(*) from bf_analyses) = 2, '2 analyses visibles, re-tests non comptés');
do $$ begin
  perform bf_grant_trial('00000000-0000-0000-0000-0000000000b1', 'x');
  raise exception 'ÉCHEC : bf_grant_trial appelable par authenticated';
exception when insufficient_privilege then null; end $$;

-- Client d'un autre bike fitter.
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000299') ->> 'reason' = 'client_not_found', 'client étranger refusé');

-- RLS : aucune écriture directe, lecture limitée à soi.
do $$ begin
  insert into bf_credits (user_id, granted, remaining, expires_at, source)
  values ('00000000-0000-0000-0000-0000000000b1', 99, 99, now() + interval '1 year', 'hack');
  raise exception 'ÉCHEC : insertion directe acceptée';
exception when insufficient_privilege then null; end $$;
select pg_temp.check((select count(*) from bf_credits) = 1, 'lecture limitée à ses crédits');
do $$ begin
  perform bf_grant_credits('00000000-0000-0000-0000-0000000000b1', 10, now() + interval '1 year', 'x');
  raise exception 'ÉCHEC : bf_grant_credits appelable par authenticated';
exception when insufficient_privilege then null; end $$;

-- Places de lancement (lisible par anon).
reset role;
set role anon;
select pg_temp.check(bf_launch_seats_remaining() = 20, '20 places');
reset role;

-- Pack : 10 crédits (idempotent), 11e refusée. Le crédit d'essai expiré n'est pas utilisé.
select pg_temp.check(bf_grant_credits('00000000-0000-0000-0000-0000000000b1', 10, now() + interval '12 months', 'cs_test_1'), 'pack crédité');
select pg_temp.check(not bf_grant_credits('00000000-0000-0000-0000-0000000000b1', 10, now() + interval '12 months', 'cs_test_1'), 'rejeu sans double crédit');
update bf_billing set plan = 'pack' where user_id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
select pg_temp.check(count(*) = 10, 'pack : 10 analyses') from (
  select register_analysis(('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid) r from generate_series(3, 12) i
) t where r ->> 'status' = 'counted';
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000114') ->> 'reason' = 'no_credits', 'pack : 11e refusée');
reset role;

-- Crédits expirés ignorés.
update bf_credits set remaining = 5, expires_at = now() - interval '1 day' where source = 'cs_test_1';
set role authenticated;
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000114') ->> 'reason' = 'no_credits', 'crédits expirés ignorés');
reset role;

-- Studio : analyse comptée avec identifiant de meter event.
update bf_billing set plan = 'studio', status = 'active' where user_id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
select pg_temp.check((select r ->> 'meter_pending' = 'true' from (select register_analysis('00000000-0000-0000-0000-000000000114') r) t), 'studio : meter en attente');
reset role;
select pg_temp.check((select stripe_meter_event_identifier = id::text from bf_analyses
  where client_id = '00000000-0000-0000-0000-000000000114'), 'identifiant meter = id analyse');

-- Échec de paiement : accès pendant la grâce, puis lecture seule.
update bf_billing set status = 'past_due', grace_until = now() + interval '7 days', plan = 'unlimited'
  where user_id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000115') ->> 'status' = 'counted', 'grâce : accès maintenu');
reset role;
update bf_billing set grace_until = now() - interval '1 minute' where user_id = '00000000-0000-0000-0000-0000000000b1';
update bf_analyses set counted_at = now() - interval '31 days' where client_id = '00000000-0000-0000-0000-000000000101';
set role authenticated;
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'reason' = 'read_only', 'grâce dépassée : lecture seule');
reset role;

-- Fenêtre glissante : après 30 jours, le même client compte à nouveau.
update bf_billing set status = 'active', grace_until = null where user_id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000101') ->> 'status' = 'counted', 'après 30 jours : recompté');
select pg_temp.check((bf_usage_summary() ->> 'plan') = 'unlimited', 'résumé : plan');
reset role;

-- Places de lancement décomptées.
update bf_billing set plan = 'unlimited_launch' where user_id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.check(bf_launch_seats_remaining() = 19, '19 places');

-- BF activé à la main sans ligne de facturation : essai ouvert à la volée.
update users set role = 'bike-fitter' where id = '00000000-0000-0000-0000-00000000a002';
insert into bf_clients (id, bf_user_id) values ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-00000000a002');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00000000a002');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000301') ->> 'plan' = 'trial', 'essai ouvert à la volée');
select pg_temp.as_user(null);
do $$ begin
  perform register_analysis('00000000-0000-0000-0000-000000000301');
  raise exception 'ÉCHEC : appel anonyme accepté';
exception when invalid_authorization_specification then null; end $$;
reset role;

-- Résumé : présence d'un abonnement Stripe.
update bf_billing set stripe_subscription_id = 'sub_test' where user_id = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.check((bf_usage_summary() ->> 'has_subscription')::boolean, 'résumé : abonnement en cours');
reset role;
