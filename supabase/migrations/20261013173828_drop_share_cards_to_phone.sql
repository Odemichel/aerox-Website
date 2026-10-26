-- Annule 20261013200000_share_cards_to_phone : la carte de partage est
-- finalement produite sur le téléphone (My Companion) à partir des données
-- de la séance, plus envoyée en PNG par le desktop. Rien n'avait été déposé.
select cron.unschedule('cleanup-share-cards');
drop function if exists public.cleanup_share_cards();

alter table public.webapp_session_state
  drop column if exists share_card_path,
  drop column if exists share_card_at;

drop policy if exists user_owns_share_cards on storage.objects;

-- Le bucket `share-cards` (vide) ne se supprime pas en SQL
-- (storage.protect_delete) : supprimé par l'API Storage le 2026-10-13.
