-- supabase/migrations/20261002100000_cda_tool_events.sql
--
-- Compteur d'usage du calculateur de CdA du site (/{lang}/cda/calculator/) :
-- un événement par calcul de CdA (`calc`) et par analyse d'efficacité aéro
-- (`analyze`). Aucune donnée personnelle (ni IP, ni identifiant).
--
-- Écriture : uniquement la route serveur /api/cda-event/ (clé service_role).
-- Lecture : tableau de bord Supabase, via les vues ci-dessous. RLS active
-- sans politique : ni anon ni authenticated ne lisent ou n'écrivent.

create table public.cda_tool_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('calc', 'analyze')),
  lang text not null check (lang in ('fr', 'en', 'pt', 'es', 'it', 'de', 'nl', 'ja', 'tr')),
  bike text check (bike in ('road', 'tt')),
  constraint cda_tool_events_bike_only_for_analyze check ((kind = 'analyze') = (bike is not null))
);

create index cda_tool_events_created_at_idx on public.cda_tool_events (created_at);

alter table public.cda_tool_events enable row level security;
revoke all on public.cda_tool_events from anon, authenticated;

-- Agrégats par jour, semaine (lundi) et mois, heure de Paris.
-- security_invoker : la vue applique les droits de l'appelant, donc la RLS de
-- la table ; elle n'expose rien à l'API publique.
create view public.cda_tool_activity_daily with (security_invoker = true) as
select
  (created_at at time zone 'Europe/Paris')::date as day,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses,
  count(*) filter (where kind = 'analyze' and bike = 'road') as analyses_road,
  count(*) filter (where kind = 'analyze' and bike = 'tt') as analyses_tt
from public.cda_tool_events
group by 1
order by 1 desc;

create view public.cda_tool_activity_weekly with (security_invoker = true) as
select
  date_trunc('week', created_at at time zone 'Europe/Paris')::date as week_start,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses
from public.cda_tool_events
group by 1
order by 1 desc;

create view public.cda_tool_activity_monthly with (security_invoker = true) as
select
  date_trunc('month', created_at at time zone 'Europe/Paris')::date as month,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'analyze') as analyses
from public.cda_tool_events
group by 1
order by 1 desc;

revoke all on public.cda_tool_activity_daily, public.cda_tool_activity_weekly, public.cda_tool_activity_monthly
  from anon, authenticated;
