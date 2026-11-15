-- supabase/migrations/20261115133121_ig_dm_events.sql
--
-- Attribution des DM Instagram : chaque lien envoyé en DM par AeroX Studio
-- porte ?utm_source=instagram&utm_medium=dm&utm_campaign=<ressource>&utm_content=<reel>.
-- Le site enregistre l'arrivée (`visit`) puis, s'il a lieu, un calcul de CdA
-- (`calc`), une demande du livre (`book`) ou une inscription (`signup`), avec
-- le reel et la ressource d'origine. Aucune donnée personnelle (ni IP, ni
-- identifiant, ni adresse) : comme cda_tool_events, un compteur.
--
-- Écriture : uniquement la route serveur /api/ig-event/ (clé service_role).
-- Lecture : admins (RLS), vues ci-dessous.

create table public.ig_dm_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('visit', 'calc', 'book', 'signup')),
  campaign text not null check (campaign in ('calculator', 'guide', 'signup')),
  content text not null check (content ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

create index ig_dm_events_created_at_idx on public.ig_dm_events (created_at);
create index ig_dm_events_content_idx on public.ig_dm_events (content);

alter table public.ig_dm_events enable row level security;
revoke all on public.ig_dm_events from anon, authenticated;

grant select on public.ig_dm_events to authenticated;
create policy ig_dm_events_admin_read on public.ig_dm_events
  for select to authenticated
  using ((select public.is_admin()));

-- Par reel : arrivées et conversions (security_invoker : la RLS de la table s'applique).
create view public.ig_dm_by_reel with (security_invoker = true) as
select
  content as reel,
  campaign,
  count(*) filter (where kind = 'visit') as visits,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'book') as books,
  count(*) filter (where kind = 'signup') as signups,
  min(created_at) as first_at,
  max(created_at) as last_at
from public.ig_dm_events
group by 1, 2
order by visits desc;

revoke all on public.ig_dm_by_reel from anon;
grant select on public.ig_dm_by_reel to authenticated;
