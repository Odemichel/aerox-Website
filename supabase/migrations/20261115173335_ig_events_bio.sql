-- supabase/migrations/20261115173335_ig_events_bio.sql
--
-- ig_dm_events compte aussi les arrivées par le lien de la bio Instagram
-- (?utm_source=instagram&utm_medium=bio) : colonne `medium` ('dm' ou 'bio',
-- 'dm' pour les lignes existantes) et ressource 'bio' quand le lien n'en précise
-- pas. Toujours aucune donnée personnelle.

alter table public.ig_dm_events
  add column medium text not null default 'dm' check (medium in ('dm', 'bio'));

alter table public.ig_dm_events drop constraint ig_dm_events_campaign_check;
alter table public.ig_dm_events
  add constraint ig_dm_events_campaign_check check (campaign in ('calculator', 'guide', 'signup', 'bio'));

-- `medium` ajouté en dernière colonne (create or replace n'accepte que l'ajout en fin)
create or replace view public.ig_dm_by_reel with (security_invoker = true) as
select
  content as reel,
  campaign,
  count(*) filter (where kind = 'visit') as visits,
  count(*) filter (where kind = 'calc') as calculations,
  count(*) filter (where kind = 'book') as books,
  count(*) filter (where kind = 'signup') as signups,
  min(created_at) as first_at,
  max(created_at) as last_at,
  medium
from public.ig_dm_events
group by content, campaign, medium
order by visits desc;
