-- supabase/migrations/20261008100000_cda_tool_events_email.sql
--
-- Calculateur de CdA : nouvel événement `email`, une demande des résultats
-- par email depuis l'encart sous les gains. L'adresse n'est pas stockée ici
-- (elle va à MailerLite) : la table reste sans donnée personnelle.

alter table public.cda_tool_events drop constraint cda_tool_events_kind_check;
alter table public.cda_tool_events
  add constraint cda_tool_events_kind_check check (kind in ('calc', 'analyze', 'email'));

create or replace view public.cda_tool_activity_daily with (security_invoker = true) as
select
  (created_at at time zone 'Europe/Paris')::date as day,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses,
  count(*) filter (where kind = 'analyze' and bike = 'road') as analyses_road,
  count(*) filter (where kind = 'analyze' and bike = 'tt') as analyses_tt,
  count(*) filter (where kind = 'email') as emails
from public.cda_tool_events
group by 1
order by 1 desc;

create or replace view public.cda_tool_activity_weekly with (security_invoker = true) as
select
  date_trunc('week', created_at at time zone 'Europe/Paris')::date as week_start,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses,
  count(*) filter (where kind = 'email') as emails
from public.cda_tool_events
group by 1
order by 1 desc;

create or replace view public.cda_tool_activity_monthly with (security_invoker = true) as
select
  date_trunc('month', created_at at time zone 'Europe/Paris')::date as month,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses,
  count(*) filter (where kind = 'email') as emails
from public.cda_tool_events
group by 1
order by 1 desc;

-- Pas de grant/revoke : `create or replace view` conserve les droits posés par
-- 20261002100000 et 20261002110000 (lecture admin).
