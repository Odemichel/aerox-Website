-- Logo du studio d'un bike fitter : affiché sur les cartes de partage
-- (desktop, My Companion, y compris celles que partage son client) et dans
-- le PDF du rapport de séance. Un fichier par bike fitter,
-- `<bf_user_id>/logo`, remplacé à chaque envoi.
--
-- Bucket public : un logo est fait pour être vu, et le client doit le
-- lire sans accès à la fiche de son bike fitter (URL déduite de
-- sessions.user_id). Seul le bike fitter écrit dans son dossier.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('studio-logos', 'studio-logos', true, 1048576,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy bf_writes_own_studio_logo on storage.objects
  for insert to authenticated
  with check (bucket_id = 'studio-logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy bf_updates_own_studio_logo on storage.objects
  for update to authenticated
  using (bucket_id = 'studio-logos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'studio-logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy bf_deletes_own_studio_logo on storage.objects
  for delete to authenticated
  using (bucket_id = 'studio-logos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Upsert : l'API Storage relit l'objet existant avant de le remplacer.
create policy bf_reads_own_studio_logo on storage.objects
  for select to authenticated
  using (bucket_id = 'studio-logos' and (storage.foldername(name))[1] = auth.uid()::text);
