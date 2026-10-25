-- position-masks : la policy `public_reads_position_masks` (rôle public,
-- SELECT sur tout le bucket) permettait à n'importe qui, sans compte, de
-- LISTER le bucket pendant une séance (UUID des utilisateurs + silhouettes).
--
-- Le bucket reste public : mycompanion affiche les masques via l'URL
-- publique partagée dans `webapp_session_state.live_positions[].mask_url`
-- (Image.network), et l'URL publique d'un bucket public ne passe pas par
-- la RLS. Seuls l'API de liste et le téléchargement authentifié sont
-- concernés : le propriétaire garde tout via `user_writes_own_position_masks`.
-- Les noms d'objets (`<uid>/<timestamp_ms>.png`) ne sont plus énumérables.
-- (audit sécurité Flutter 2026-10-25)

DROP POLICY IF EXISTS "public_reads_position_masks" ON storage.objects;
