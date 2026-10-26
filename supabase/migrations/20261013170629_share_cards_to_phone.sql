-- Carte de partage envoyée du desktop vers My Companion : l'app desktop
-- rend la carte (PNG 1080×1920), la dépose dans `share-cards` sous le
-- dossier de l'utilisateur, puis publie son chemin dans
-- `webapp_session_state`. Le téléphone, abonné en temps réel, la télécharge
-- et ouvre le partage natif (Story Instagram, TikTok…), impossible depuis
-- un ordinateur.
--
-- Bucket privé : la carte montre la silhouette du client du bike fitter.
-- Seul le compte qui l'a déposée la lit (même compte desktop et téléphone).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('share-cards', 'share-cards', false, 5242880, array['image/png'])
on conflict (id) do nothing;

create policy user_owns_share_cards on storage.objects
  for all to authenticated
  using (bucket_id = 'share-cards' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'share-cards' and (storage.foldername(name))[1] = auth.uid()::text);

alter table public.webapp_session_state
  add column if not exists share_card_path text,
  add column if not exists share_card_at timestamptz;

comment on column public.webapp_session_state.share_card_path is
  'Chemin dans le bucket share-cards de la dernière carte envoyée au téléphone.';
comment on column public.webapp_session_state.share_card_at is
  'Date d''envoi de la carte : chaque nouvel envoi rouvre le partage sur le téléphone.';

-- Les cartes servent le temps du partage : purge à 7 jours.
create or replace function public.cleanup_share_cards()
returns integer
language plpgsql
security definer
set search_path to 'public', 'storage'
as $$
declare
  deleted_count integer;
begin
  with deleted as (
    delete from storage.objects
    where bucket_id = 'share-cards'
      and created_at < now() - interval '7 days'
    returning id
  )
  select count(*) into deleted_count from deleted;
  return deleted_count;
end;
$$;

revoke execute on function public.cleanup_share_cards() from public, anon, authenticated;

select cron.schedule('cleanup-share-cards', '15 3 * * *', 'select public.cleanup_share_cards()');
