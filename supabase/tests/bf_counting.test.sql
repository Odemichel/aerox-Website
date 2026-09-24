-- supabase/tests/bf_counting.test.sql — filet de sécurité et meter Studio.
create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false);
$$;
create function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'ÉCHEC : %', msg; end if; end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'bfd@example.com', '{"profile_type":"bike-fitter"}');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000d1';
insert into bf_clients (id, bf_user_id) select ('00000000-0000-0000-0000-0000000004' || lpad(i::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-0000000000d1' from generate_series(1, 6) i;
delete from net.calls;

-- Séance sans appel préalable : comptée par le filet (crédit d'essai consommé).
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000401');
select pg_temp.check((select origin from bf_analyses where client_id = '00000000-0000-0000-0000-000000000401') = 'session_backstop', 'filet : compté');
select pg_temp.check((select remaining from bf_credits where user_id = '00000000-0000-0000-0000-0000000000d1') = 2, 'filet : crédit consommé');

-- Appel de l'app puis séance : une seule analyse.
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000402') ->> 'status' = 'counted', 'app : compté');
reset role;
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000402');
select pg_temp.check((select count(*) from bf_analyses where client_id = '00000000-0000-0000-0000-000000000402') = 1, 'app + séance : 1 seule analyse');

-- Plus de crédit : la séance est tracée « uncredited », une seule fois par fenêtre.
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000403');
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000404');
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000404');
select pg_temp.check((select billing_mode from bf_analyses where client_id = '00000000-0000-0000-0000-000000000404') = 'uncredited', 'sans crédit : uncredited');
select pg_temp.check((select count(*) from bf_analyses where client_id = '00000000-0000-0000-0000-000000000404') = 1, 'uncredited : une fois par fenêtre');
select pg_temp.check((select count(*) from net.calls) = 0, 'aucun ping hors Studio');

-- Séance sans client : rien.
insert into sessions (user_id) values ('00000000-0000-0000-0000-0000000000d1');
select pg_temp.check((select count(*) from bf_analyses where user_id = '00000000-0000-0000-0000-0000000000d1') = 4, 'séance sans client ignorée');

-- Studio : ping de la route de report, avec le secret.
insert into vault.decrypted_secrets values ('billing_hook_secret', 'hook');
update bf_billing set plan = 'studio' where user_id = '00000000-0000-0000-0000-0000000000d1';
set role authenticated;
select pg_temp.check(register_analysis('00000000-0000-0000-0000-000000000405') ->> 'meter_pending' = 'true', 'studio : meter en attente');
reset role;
select pg_temp.check((select count(*) from net.calls where url like '%/api/billing/report-usage/'
  and headers ->> 'x-billing-hook-secret' = 'hook') = 1, 'studio : route de report appelée');
select bf_mark_meter_reported((select id from bf_analyses where client_id = '00000000-0000-0000-0000-000000000405'), null);
select pg_temp.check((select meter_reported_at is not null from bf_analyses where client_id = '00000000-0000-0000-0000-000000000405'), 'meter marqué envoyé');
select pg_temp.check((select count(*) from cron.jobs where name = 'bf-report-usage') = 1, 'job de rejeu planifié');

-- Droits : le filet n'est pas appelable par un client.
set role authenticated;
do $$ begin
  perform bf_register_analysis_for('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000406', 'app');
  raise exception 'ÉCHEC : bf_register_analysis_for appelable par authenticated';
exception when insufficient_privilege then null; end $$;
reset role;

-- Une erreur de comptage ne bloque jamais l'enregistrement de la séance.
alter table bf_analyses add constraint test_force_failure check (origin <> 'session_backstop') not valid;
insert into sessions (user_id, client_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000406');
select pg_temp.check((select count(*) from sessions where client_id = '00000000-0000-0000-0000-000000000406') = 1, 'séance enregistrée malgré l’échec du comptage');
alter table bf_analyses drop constraint test_force_failure;

-- Réservation des envois Studio : deux appels concurrents ne se chevauchent pas.
insert into bf_clients (id, bf_user_id) values
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select register_analysis('00000000-0000-0000-0000-000000000501');
select register_analysis('00000000-0000-0000-0000-000000000502');
reset role;
create temp table claim1 as select * from bf_claim_meter_batch(1);
create temp table claim2 as select * from bf_claim_meter_batch(10);
select pg_temp.check((select count(*) from claim1) = 1, 'réservation : lot de 1');
select pg_temp.check(not exists (select 1 from claim1 join claim2 using (id)), 'réservations disjointes');
select pg_temp.check((select count(*) from bf_claim_meter_batch(10)) = 0, 'rien de libre tant que les lots sont réservés');
-- Échec : la réservation est levée, la ligne redevient disponible.
select bf_mark_meter_reported((select id from claim1), 'boom');
select pg_temp.check((select count(*) from bf_claim_meter_batch(10)) = 1, 'échec : ligne de nouveau disponible');
-- Succès puis échec tardif : la ligne reste envoyée, sans erreur.
select bf_mark_meter_reported((select id from claim2 limit 1), null);
select bf_mark_meter_reported((select id from claim2 limit 1), 'tardif');
select pg_temp.check((select meter_reported_at is not null and meter_last_error is null from bf_analyses
  where id = (select id from claim2 limit 1)), 'une ligne envoyée n’est jamais repassée en erreur');
