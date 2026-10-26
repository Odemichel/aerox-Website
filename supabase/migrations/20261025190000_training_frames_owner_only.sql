-- training-frames : images caméra des cyclistes lisibles par TOUT compte
-- connecté (policy `bucket_id = 'training-frames'` seule), chemins
-- `date/...` sans identifiant. Désormais le premier dossier est l'uid
-- (`<uid>/<date>/<séance>_<slot>_<id>.jpg`, app desktop ≥ commit lot S) :
-- chacun ne lit / n'écrit que ses images, l'admin lit tout.
-- Les anciens fichiers `date/...` ne sont plus lisibles que par l'admin.
-- (audit sécurité Flutter 2026-10-25)
--
-- Déploiement : appliquer AVEC la version desktop qui écrit sous `<uid>/`.
-- Une ancienne version continue d'écrire sous `date/...` → INSERT refusé
-- (télémétrie best-effort, l'erreur est seulement journalisée).

DROP POLICY IF EXISTS "Authenticated users can upload training frames" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read training frames" ON storage.objects;

CREATE POLICY "training_frames_insert_own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'training-frames'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- upsert: true côté client → UPDATE nécessaire sur ses propres objets
CREATE POLICY "training_frames_update_own"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'training-frames'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'training-frames'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE POLICY "training_frames_select_own_or_admin"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'training-frames'
    AND (
      (storage.foldername(name))[1] = (SELECT auth.uid())::text
      OR public.is_admin()
    )
  );
