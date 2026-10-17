-- Traces GPX publiques (app desktop, `feat-gpx-simulation-mode`) :
-- lecture pour tous les connectés, ajout / modification / suppression
-- réservés aux admins (`public.is_admin()`).
--
-- Avant : tout connecté pouvait ajouter une trace, personne ne pouvait la
-- modifier ni la supprimer (aucune règle UPDATE / DELETE sur gpx_metadata :
-- les boutons de l'app ne faisaient rien, sans erreur), et les fichiers ne
-- pouvaient être modifiés / supprimés que par celui qui les avait envoyés.
--
-- gpx_usages suit la suppression (clé étrangère ON DELETE CASCADE existante).

begin;

-- Table gpx_metadata
drop policy if exists "Allow insert for authenticated" on public.gpx_metadata;
-- Doublon de "Allow read for all authenticated users".
drop policy if exists "Authenticated read GPX metadata" on public.gpx_metadata;

create policy "gpx_metadata_insert_admin" on public.gpx_metadata
  for insert to authenticated
  with check (public.is_admin());

create policy "gpx_metadata_update_admin" on public.gpx_metadata
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "gpx_metadata_delete_admin" on public.gpx_metadata
  for delete to authenticated
  using (public.is_admin());

-- Fichiers : buckets public-gpx-traces (GPX) et public-gpx-thumbnails
-- (miniatures). Les règles de lecture existantes sont gardées.
drop policy if exists "Insert 1hi08g9_0" on storage.objects;
drop policy if exists "Update owner only 1y831xs_1" on storage.objects;
drop policy if exists "Delete owner only 1y831xs_2" on storage.objects;
drop policy if exists "Insert public (owner registered) 1hi08g9_0" on storage.objects;
drop policy if exists "Update owner only 1hi08g9_0" on storage.objects;
drop policy if exists "Delete owner only 1hi08g9_0" on storage.objects;

create policy "gpx_files_insert_admin" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('public-gpx-traces', 'public-gpx-thumbnails')
    and public.is_admin()
  );

create policy "gpx_files_update_admin" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('public-gpx-traces', 'public-gpx-thumbnails')
    and public.is_admin()
  )
  with check (
    bucket_id in ('public-gpx-traces', 'public-gpx-thumbnails')
    and public.is_admin()
  );

create policy "gpx_files_delete_admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('public-gpx-traces', 'public-gpx-thumbnails')
    and public.is_admin()
  );

commit;
